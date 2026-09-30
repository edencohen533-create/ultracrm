/**
 * Journey builder: drafts vs. published versions, pre-activation checks, pause/resume, simulation and the shared
 * free-text translator (rule-based path – the model is never required and never trusted as-is).
 */
import crypto from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { db } from "@/lib/db";
import { withBusiness } from "@/lib/tenant";
import { createBusiness, destroyBusiness } from "./helpers";

process.env.ENCRYPTION_KEY ||= crypto.randomBytes(32).toString("hex");
delete process.env.ANTHROPIC_API_KEY; // rule-based translator – deterministic, no network
const { saveDraft, publish, publishChecks, setJourneyStatus, simulate } = await import("@/server/automations/journeys");
const { interpret } = await import("@/server/automations/translate");
const { startSequencesForEvent, processDueSequenceRuns } = await import("@/server/services/sequence-service");
const { createContact } = await import("@/lib/crm/contacts");

describe("journey builder – drafts, publish, checks, AI", () => {
  let a: Awaited<ReturnType<typeof createBusiness>>;
  let tplA: string; let tplB: string; let smsTpl: string; let contactId: string;
  const run = <T,>(fn: () => Promise<T>) => withBusiness(a.business.id, fn, a.session);
  const ev = (type: string, extra: Record<string, unknown> = {}) => ({ id: crypto.randomUUID(), businessId: a.business.id, type, contactId, payload: {}, depth: 0, createdAt: new Date(), ...extra }) as never;
  const def = (steps: unknown[], more: Record<string, unknown> = {}) => ({ name: "מסע QA", trigger: "CONTACT_CREATED", triggerConfig: {}, stopOn: ["reply"], steps, ...more });
  const send = (templateId: string, waitMinutes = 0, channel = "whatsapp") => ({ action: "send", channel, templateId, waitMinutes, variables: {}, condition: { requireNoReply: false } });

  beforeAll(async () => {
    a = await createBusiness("journey-ai", { modules: { messaging: true } });
    await db.providerCredential.create({ data: { businessId: a.business.id, channel: "whatsapp", provider: "mock", isActive: true, isDefault: true, config: {} } });
    tplA = (await db.template.create({ data: { businessId: a.business.id, channel: "whatsapp", name: "no_answer_a", language: "he", category: "MARKETING", body: "היי A", status: "APPROVED" } })).id;
    tplB = (await db.template.create({ data: { businessId: a.business.id, channel: "whatsapp", name: "no_answer_b", language: "he", category: "MARKETING", body: "היי B", status: "APPROVED" } })).id;
    smsTpl = (await db.template.create({ data: { businessId: a.business.id, channel: "sms", name: "sms_x", language: "he", category: "MARKETING", body: "SMS", status: "APPROVED" } })).id;
    await db.business.update({ where: { id: a.business.id }, data: { settings: { marketing: { window: { start: "00:00", end: "23:59", days: [0, 1, 2, 3, 4, 5, 6] } } } } });
    contactId = (await run(() => createContact(a.session, { fullName: "בדיקת מסע", phone: "0503100001" }))).id;
    await db.contact.update({ where: { id: contactId }, data: { consentStatus: "OPTED_IN" } });
  });
  afterAll(async () => { await destroyBusiness(a.business.id, [a.account.id]); });

  it("save of a new journey creates a draft that never runs", async () => {
    const d = await run(() => saveDraft(a.session, def([send(tplA)])));
    const seq = await db.marketingSequence.findUniqueOrThrow({ where: { id: d.id } });
    expect(seq).toMatchObject({ status: "draft", isActive: false, version: 0 });
    expect(await db.sequenceStep.count({ where: { sequenceId: d.id } })).toBe(0);
    expect((await run(() => startSequencesForEvent(ev("contact.created")))).started).toBe(0);
    await expect(run(() => setJourneyStatus(a.session, d.id, "active"))).rejects.toThrow(/עוד לא פורסם/);
    await db.marketingSequence.delete({ where: { id: d.id } });
  });

  it("editing an active journey saves a draft; the live version keeps running; runs stay on their version", async () => {
    const d = await run(() => saveDraft(a.session, def([send(tplA)])));
    const p1 = await run(() => publish(a.session, d.id));
    expect(p1.version).toBe(1);
    const r1 = await run(() => startSequencesForEvent(ev("contact.created")));
    expect(r1.started).toBe(1);
    const runRow = await db.sequenceRun.findFirstOrThrow({ where: { sequenceId: d.id } });
    // Edit → "שמירה": draft only.
    await run(() => saveDraft(a.session, def([send(tplB, 120)], { name: "מסע QA v2" }), d.id));
    let seq = await db.marketingSequence.findUniqueOrThrow({ where: { id: d.id }, include: { steps: true } });
    expect(seq).toMatchObject({ status: "active", isActive: true, version: 1, name: "מסע QA" });
    expect(seq.steps[0].templateId).toBe(tplA);
    expect(seq.draft).toBeTruthy();
    // Publish v2 → new version, draft cleared; the in-flight run still uses v1 (template A, no wait).
    const p2 = await run(() => publish(a.session, d.id));
    expect(p2.version).toBe(2);
    seq = await db.marketingSequence.findUniqueOrThrow({ where: { id: d.id }, include: { steps: true } });
    expect(seq.steps[0].templateId).toBe(tplB);
    expect(seq.draft).toBeNull();
    expect(await db.sequenceVersion.count({ where: { sequenceId: d.id } })).toBe(2);
    await db.sequenceRun.update({ where: { id: runRow.id }, data: { nextAt: new Date(0) } });
    await run(() => processDueSequenceRuns());
    const sent = await db.message.findFirst({ where: { requestKey: { startsWith: `seq:${runRow.id}` } }, select: { templateId: true } });
    expect(sent?.templateId).toBe(tplA);
    // Pause from the list, then resume.
    await run(() => setJourneyStatus(a.session, d.id, "paused"));
    expect((await db.marketingSequence.findUniqueOrThrow({ where: { id: d.id } })).isActive).toBe(false);
    await run(() => setJourneyStatus(a.session, d.id, "active"));
    await db.marketingSequence.update({ where: { id: d.id }, data: { isActive: false, status: "paused" } });
  });

  it("activation is blocked when a channel connection is missing", async () => {
    const d = await run(() => saveDraft(a.session, def([send(smsTpl, 0, "sms")])));
    const c = await run(() => publishChecks(a.session, def([send(smsTpl, 0, "sms")])));
    const ch = c.checks.find((x) => x.key === "channel:sms")!;
    expect(ch.ok).toBe(false);
    await expect(run(() => publish(a.session, d.id))).rejects.toMatchObject({ code: "checks_failed" });
    expect((await db.marketingSequence.findUniqueOrThrow({ where: { id: d.id } })).status).toBe("draft");
    await db.marketingSequence.delete({ where: { id: d.id } });
  });

  it("a loop (tag trigger re-adding its own tag) and a double send are blocked", async () => {
    const loop = await run(() => publishChecks(a.session, def([{ action: "add_tag", channel: "email", waitMinutes: 0, variables: {}, condition: { requireNoReply: false }, actionTag: "חם" }], { trigger: "TAG_ADDED", triggerConfig: { tagName: "חם" } })));
    expect(loop.checks.find((x) => x.key === "loops")!.ok).toBe(false);
    const dup = await run(() => publishChecks(a.session, def([send(tplA), send(tplA, 10)])));
    expect(dup.checks.find((x) => x.key === "duplicates")!.ok).toBe(false);
    const ok = await run(() => publishChecks(a.session, def([send(tplA), send(tplA, 120)])));
    expect(ok.checks.every((x) => x.ok || !x.blocking)).toBe(true);
    expect(ok.summary!.external[0]).toMatch(/WhatsApp/);
    expect(ok.summary!.running).toMatch(/לפי הגרסה/);
  });

  it("a duplicate event starts one run only", async () => {
    const d = await run(() => saveDraft(a.session, def([send(tplA, 60)], { name: "כפילות" })));
    await run(() => publish(a.session, d.id));
    const e = ev("contact.created");
    expect((await run(() => startSequencesForEvent(e))).started).toBeGreaterThanOrEqual(1);
    await run(() => startSequencesForEvent(e));
    expect(await db.sequenceRun.count({ where: { sequenceId: d.id } })).toBe(1);
    await db.marketingSequence.update({ where: { id: d.id }, data: { isActive: false, status: "paused" } });
  });

  it("simulation explains each decision and sends nothing", async () => {
    const before = await db.message.count({ where: { businessId: a.business.id } });
    const s = await run(() => simulate(a.session, def([
      { action: "condition", channel: "email", waitMinutes: 0, variables: {}, condition: { requireNoReply: false, tagName: "VIP" } },
      send(tplA, 30),
    ]), { data: { tags: [] } }));
    expect(s.steps[0]).toMatchObject({ result: "stop" });
    expect(s.steps[0].why).toMatch(/אין תגית VIP/);
    const s2 = await run(() => simulate(a.session, def([{ action: "condition", channel: "email", waitMinutes: 0, variables: {}, condition: { requireNoReply: false, tagName: "VIP" } }, send(tplA, 30)]), { data: { tags: ["VIP"], consent: "OPTED_OUT" } }));
    expect(s2.steps.map((x) => x.result)).toEqual(["done", "skipped"]);
    expect(s2.steps[1].why).toMatch(/הסיר/);
    expect(await db.message.count({ where: { businessId: a.business.id } })).toBe(before);
  });

  it("free text: supported parts become the draft; assignment / 'available now' are existing settings; unsupported is never a node", async () => {
    const r = await run(() => interpret("כשנכנס ליד חדש, הקצה אותו לנציג. אם לא ענה לשיחה, שלח וואטסאפ. אם כתב שהוא פנוי עכשיו, קדם אותו בתור החיוג.", "journey"));
    expect(r.analyzer).toBe("rules");
    expect(r.definition!.trigger).toBe("CALL_UNANSWERED");
    expect(r.definition!.steps.map((s) => s.action)).toEqual(["send"]);
    expect(r.definition!.steps[0].templateId).toBeUndefined(); // two WhatsApp templates → a question, not a guess
    expect(r.questions.some((q) => q.field.startsWith("template:whatsapp") && q.options!.length === 2)).toBe(true);
    expect(r.related.map((x) => x.title).join(" ")).toMatch(/הקצאת ליד/);
    expect(r.related.map((x) => x.title).join(" ")).toMatch(/פנוי עכשיו/);
    const bad = await run(() => interpret("כשנכנס ליד חדש תענה לו אוטומטית עם בינה מלאכותית", "journey"));
    expect(bad.unsupported.length).toBeGreaterThan(0);
    expect((bad.definition?.steps ?? []).some((s) => !["send", "wait", "condition", "task", "add_tag", "remove_tag", "add_to_list", "remove_from_list", "webhook"].includes(s.action))).toBe(false);
    // Correction keeps the rest of the current draft.
    const cur = { ...r.definition!, steps: [{ ...r.definition!.steps[0], templateId: tplA }] };
    const fix = await run(() => interpret("אחרי 2 שעות שלח SMS", "journey", cur));
    expect(fix.definition!.trigger).toBe("CALL_UNANSWERED");
    expect(fix.definition!.steps[0]).toMatchObject({ action: "send", channel: "sms", waitMinutes: 120, templateId: smsTpl });
  });
});
