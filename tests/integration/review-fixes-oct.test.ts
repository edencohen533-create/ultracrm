/**
 * Regressions from the production log + code review (Oct 2026):
 * the sales-coach cron outside a tenant context, a duplicate event inside a transaction, every activation path
 * through the publish checks, status triggers by id or meaning, deleted contacts leave journeys, version backfill,
 * recordings deleted mid-processing, retry cap, unassigned deals in the agent report.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { db } from "@/lib/db";
import { withBusiness } from "@/lib/tenant";
import type { SessionUser } from "@/lib/auth";
import { createBusiness, destroyBusiness } from "./helpers";

process.env.ENCRYPTION_KEY ||= crypto.randomBytes(32).toString("hex");
process.env.COACH_PROVIDER = "mock";
const sales = await import("@/server/coach/sales");
const { saveSequence, sequenceSchema, startSequencesForEvent, processDueSequenceRuns } = await import("@/server/services/sequence-service");
const { saveDraft, publish, setJourneyStatus } = await import("@/server/automations/journeys");
const { updateDeal } = await import("@/lib/crm/pipeline");
const { emitEvent } = await import("@/lib/events");
const { deleteContacts } = await import("@/server/services/contact-bulk");

describe("review fixes", { timeout: 300_000 }, () => {
  let a: Awaited<ReturnType<typeof createBusiness>>;
  let contactId: string; let tpl: string;
  const run = <T,>(fn: () => Promise<T>, s: SessionUser = a.session) => withBusiness(s.businessId, fn, s);
  const send = (templateId: string, channel = "whatsapp") => ({ action: "send", channel, templateId, waitMinutes: 0, variables: {}, condition: { requireNoReply: false } });
  beforeAll(async () => {
    a = await createBusiness("review-fixes", { modules: { crm: true, telephony: true, messaging: true } });
    await db.business.update({ where: { id: a.business.id }, data: { settings: { marketing: { window: { start: "00:00", end: "23:59", days: [0, 1, 2, 3, 4, 5, 6] } } } } });
    tpl = (await db.template.create({ data: { businessId: a.business.id, channel: "whatsapp", name: "rf_tpl", language: "he", category: "MARKETING", body: "היי", status: "APPROVED" } })).id;
    contactId = (await db.contact.create({ data: { businessId: a.business.id, fullName: "בדיקה", phoneE164: "+972501230001", phoneRaw: "x", consentStatus: "OPTED_IN" } })).id;
  });
  afterAll(async () => { await destroyBusiness(a.business.id, [a.account.id]); });

  it("the sales-coach cron runs without a tenant context (it failed every 2 minutes in production)", async () => {
    await expect(sales.runSalesCoachJob({ deadline: Date.now() + 5_000 })).resolves.toBeDefined();
  });

  it("a duplicate event inside a transaction no longer rolls the transaction back: a deal won → reopened → won again is saved", async () => {
    const deal = await db.deal.create({ data: { businessId: a.business.id, contactId, title: "re-win", stage: "negotiation", status: "open" } });
    await run(() => updateDeal(a.session, deal.id, { stage: "won" } as never));
    await run(() => updateDeal(a.session, deal.id, { stage: "negotiation" } as never));
    await run(() => updateDeal(a.session, deal.id, { stage: "won" } as never));
    expect((await db.deal.findUniqueOrThrow({ where: { id: deal.id } })).status).toBe("won");
    expect(await db.domainEvent.count({ where: { businessId: a.business.id, type: "deal.won", payload: { path: ["dealId"], equals: deal.id } } })).toBe(2);
    // the same dedupe key twice inside one transaction: the second is skipped, the transaction still commits
    const t = await db.$transaction(async (tx) => { await emitEvent(tx, { businessId: a.business.id, type: "deal.lost", dedupeKey: "rf:dup" }); const second = await emitEvent(tx, { businessId: a.business.id, type: "deal.lost", dedupeKey: "rf:dup" }); await tx.deal.update({ where: { id: deal.id }, data: { notes: "after duplicate" } }); return second; });
    expect(t).toBeNull();
    expect((await db.deal.findUniqueOrThrow({ where: { id: deal.id } })).notes).toBe("after duplicate");
  });

  it("every activation path passes the checks: legacy save, resume from the list, AI executors keep status in sync", async () => {
    // no WhatsApp connection in this business → activation must be refused
    const input = sequenceSchema.parse({ name: "legacy", trigger: "CONTACT_CREATED", isActive: true, steps: [send(tpl)] });
    await expect(run(() => saveSequence(a.session, input))).rejects.toMatchObject({ code: "checks_failed" });
    const paused = await run(() => saveSequence(a.session, { ...input, isActive: false }));
    expect(paused).toMatchObject({ isActive: false });
    await expect(run(() => setJourneyStatus(a.session, paused.id, "active"))).rejects.toMatchObject({ code: "checks_failed" });
    // with a connection it goes live, and status + isActive move together
    await db.providerCredential.create({ data: { businessId: a.business.id, channel: "whatsapp", provider: "mock", isActive: true, isDefault: true, config: {} } });
    await run(() => setJourneyStatus(a.session, paused.id, "active"));
    expect(await db.marketingSequence.findUniqueOrThrow({ where: { id: paused.id } })).toMatchObject({ isActive: true, status: "active" });
    // a legacy save keeps a draft someone is editing
    await run(() => saveDraft(a.session, { name: "draft text", trigger: "CONTACT_CREATED", steps: [] }, paused.id));
    await run(() => saveSequence(a.session, { ...input, name: "legacy v2" }, paused.id));
    expect((await db.marketingSequence.findUniqueOrThrow({ where: { id: paused.id } })).draft).toBeTruthy();
    await db.marketingSequence.update({ where: { id: paused.id }, data: { isActive: false, status: "paused" } });
  });

  it("a CRM-status trigger fires for a custom status (by id) and for a system meaning even when the event carries the status id", async () => {
    const custom = await db.leadStatusDef.create({ data: { businessId: a.business.id, kind: "follow_up", label: "חזרה מותאם", sortOrder: 99 } });
    const byId = await run(() => saveDraft(a.session, { name: "by id", trigger: "LEAD_STATUS_CHANGED", triggerConfig: { leadStatus: custom.id }, stopOn: [], steps: [{ action: "task", channel: "email", waitMinutes: 60, variables: {}, condition: { requireNoReply: false }, taskTitle: "x" }] }));
    await run(() => publish(a.session, byId.id));
    const byKind = await run(() => saveDraft(a.session, { name: "by kind", trigger: "LEAD_STATUS_CHANGED", triggerConfig: { leadStatus: "follow_up" }, stopOn: [], steps: [{ action: "task", channel: "email", waitMinutes: 60, variables: {}, condition: { requireNoReply: false }, taskTitle: "y" }] }));
    await run(() => publish(a.session, byKind.id));
    const ev = { id: crypto.randomUUID(), businessId: a.business.id, type: "lead.status_changed", contactId, payload: { to: "follow_up", toStatusId: custom.id }, depth: 0 };
    const r = await run(() => startSequencesForEvent(ev as never));
    expect(r.started).toBe(2);
    // an unknown status id can't be published
    const bad = await run(() => saveDraft(a.session, { name: "bad", trigger: "LEAD_STATUS_CHANGED", triggerConfig: { leadStatus: "lsd_does_not_exist" }, stopOn: [], steps: [{ action: "task", channel: "email", waitMinutes: 0, variables: {}, condition: { requireNoReply: false }, taskTitle: "z" }] }));
    await expect(run(() => publish(a.session, bad.id))).rejects.toMatchObject({ code: "checks_failed" });
    for (const id of [byId.id, byKind.id]) await db.marketingSequence.update({ where: { id }, data: { isActive: false, status: "paused" } });
  });

  it("deleting a contact stops their journey runs (and the engine never continues a run of a deleted contact)", async () => {
    const c2 = await db.contact.create({ data: { businessId: a.business.id, fullName: "למחיקה", phoneE164: "+972501230002", phoneRaw: "x" } });
    const seq = await run(() => saveSequence(a.session, sequenceSchema.parse({ name: "del", trigger: "CONTACT_CREATED", isActive: true, stopOn: [], steps: [{ action: "task", channel: "email", waitMinutes: 60, taskTitle: "t" }] })));
    const r1 = await db.sequenceRun.create({ data: { businessId: a.business.id, sequenceId: seq.id, contactId: c2.id, sourceKey: "rf-del", nextAt: new Date(Date.now() + 3600_000) } });
    await run(() => deleteContacts(a.session, { ids: [c2.id], confirm: "1" } as never));
    expect((await db.sequenceRun.findUniqueOrThrow({ where: { id: r1.id } })).status).toBe("STOPPED");
    // backstop: a run that is still pending for a deleted contact is stopped by the engine
    const c3 = await db.contact.create({ data: { businessId: a.business.id, fullName: "נמחק בעבר", phoneE164: "+972501230003", phoneRaw: "x", deletedAt: new Date() } });
    const r2 = await db.sequenceRun.create({ data: { businessId: a.business.id, sequenceId: seq.id, contactId: c3.id, sourceKey: "rf-del2", nextAt: new Date(0) } });
    await run(() => processDueSequenceRuns());
    expect(await db.sequenceRun.findUniqueOrThrow({ where: { id: r2.id } })).toMatchObject({ status: "STOPPED", stopReason: "איש הקשר נמחק" });
    await db.marketingSequence.update({ where: { id: seq.id }, data: { isActive: false, status: "paused" } });
  });

  it("migration backfill: a pre-versioning journey gets its version row and in-flight runs are pinned", async () => {
    const seq = await db.marketingSequence.create({ data: { businessId: a.business.id, name: "old", trigger: "CONTACT_CREATED", isActive: false, status: "paused", version: 1, createdById: a.user.id } });
    await db.sequenceStep.create({ data: { sequenceId: seq.id, position: 0, action: "task", channel: "email", waitMinutes: 5, variables: { __taskTitle: "old step" }, condition: {} } });
    const r = await db.sequenceRun.create({ data: { businessId: a.business.id, sequenceId: seq.id, contactId, sourceKey: "rf-old", nextAt: new Date(Date.now() + 3600_000) } });
    const sql = fs.readFileSync("prisma/migrations/20261013090000_journey_version_backfill/migration.sql", "utf8");
    for (const stmt of sql.split(/;\s*\n/).map((x) => x.replace(/^--.*$/gm, "").trim()).filter(Boolean)) await db.$executeRawUnsafe(stmt);
    const v = await db.sequenceVersion.findFirstOrThrow({ where: { sequenceId: seq.id, version: 1 } });
    expect((v.definition as { steps: Array<{ variables: Record<string, string> }> }).steps[0].variables.__taskTitle).toBe("old step");
    expect((await db.sequenceRun.findUniqueOrThrow({ where: { id: r.id } })).versionId).toBe(v.id);
  });

  it("sales coach: a recording deleted mid-processing stays deleted; a crashing row is retried at most 3 times", async () => {
    const rec = await db.salesRecording.create({ data: { businessId: a.business.id, source: "upload", title: "x", status: "processing", lockedAt: new Date(), attempts: 1, mimeType: "audio/mpeg", sizeBytes: 10 } });
    await db.salesRecordingChunk.create({ data: { recordingId: rec.id, businessId: a.business.id, idx: 0, data: new Uint8Array(Buffer.from("ID3\u0004\u0000\n#TRANSCRIPT\n0|agent: היי, יש לך דקה?\n")) } });
    // deleted by a manager while the worker is between transcription and saving
    await db.salesRecording.update({ where: { id: rec.id }, data: { status: "deleted", deletedAt: new Date() } });
    const out = await run(() => sales.processRecording(rec.id));
    expect(out).not.toBe("ready");
    expect((await db.salesRecording.findUniqueOrThrow({ where: { id: rec.id } })).status).toBe("deleted");
    expect(await db.salesInsight.count({ where: { recordingId: rec.id } })).toBe(0);
    const stuck = await db.salesRecording.create({ data: { businessId: a.business.id, source: "upload", title: "stuck", status: "processing", lockedAt: new Date(Date.now() - 60 * 60_000), attempts: 3, mimeType: "audio/mpeg", sizeBytes: 10 } });
    await run(() => sales.processNextRecording(a.business.id));
    expect((await db.salesRecording.findUniqueOrThrow({ where: { id: stuck.id } })).status).toBe("failed");
  });
});
