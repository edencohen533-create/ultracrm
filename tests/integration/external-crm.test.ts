/**
 * External CRM connectors – acceptance on a real DB with the TEST SIMULATOR connector (an in-memory fake CRM) and
 * simulated telephony. No real CRM, no real call, no message to anyone.
 *
 * Main flow: lead created in the source → initial sync (paging, rate limit, resume) → assigned to the mapped agent →
 * enters the explicit queue → test call → outcome + AI summary written back (late summary updates the same activity)
 * → exactly one follow-up. Plus: an updated lead, a person with two opportunities, agent change while queued,
 * duplicate / old events, a status change coming back without a loop, a block during an outage, "failed after the
 * vendor did it" without a duplicate, two businesses with the same source ids, a dialer + WhatsApp business WITHOUT
 * the CRM module, disconnect / reconnect with gap fill, fuzzy match review, and the general integration API.
 */
import crypto from "node:crypto";
import { NextRequest } from "next/server";
import { beforeAll, afterAll, it, expect, describe, vi } from "vitest";
import { db } from "@/lib/db";
import { withBusiness } from "@/lib/tenant";
import { signSession, type SessionUser } from "@/lib/auth";
import { createBusiness, destroyBusiness } from "./helpers";
import { claimNextLead } from "@/lib/dialer/queue";
import { startCall, reconcileCall, saveOutcome } from "@/lib/dialer/calls";
import { processDomainEvents, emitEvent } from "@/lib/events";
import { suppressContact, callBlockReason } from "@/lib/suppression";
import * as crm from "@/server/crm-sync/connections";
import { syncConnectionStep } from "@/server/crm-sync/runner";
import { processCrmOutbox } from "@/server/crm-sync/outbox";
import { simStore, simSign } from "@/server/crm-sync/connectors/simulator";
import { POST as webhookPOST } from "@/app/api/crm-webhooks/[connectionId]/route";
import { PUT as contactPUT } from "@/app/api/v1/crm/contacts/[externalId]/route";
import { PUT as leadPUT } from "@/app/api/v1/crm/leads/[externalId]/route";
import { POST as blockPOST } from "@/app/api/v1/crm/blocks/route";
import { GET as eventsGET } from "@/app/api/v1/crm/events/route";
import { GET as leadsGET } from "@/app/api/leads/route";
import { GET as contactGET } from "@/app/api/contacts/[id]/route";
import { GET as crmListGET } from "@/app/api/integrations/crm/route";
import { createApiKey } from "@/server/services/integrations";

type Biz = Awaited<ReturnType<typeof createBusiness>>;
let A: Biz, B: Biz;
let x: SessionUser, y: SessionUser;
let connA = "", hookSecretA = "", listA = "";
const accounts: string[] = [];
const run = <T,>(u: SessionUser, fn: () => Promise<T>) => withBusiness(u.businessId, fn, u);
const ctx = (p: Record<string, string> = {}) => ({ params: Promise.resolve(p) });
const iso = (minsAgo = 0) => new Date(Date.now() - minsAgo * 60_000).toISOString();
const sim = () => simStore("acctA");
async function cookieReq(u: SessionUser, url: string) { return new NextRequest(`http://localhost${url}`, { headers: { cookie: `ultracrm_session=${await signSession(u)}` } }); }
async function syncUntilIdle(id: string) {
  for (let i = 0; i < 40; i++) {
    await db.crmConnection.update({ where: { id }, data: { nextSyncAt: null } });
    await run(A.session, () => syncConnectionStep(id, Date.now() + 10_000));
    const st = (await db.crmConnection.findUniqueOrThrow({ where: { id } })).syncState as { phase?: string };
    if (st.phase === "idle") return;
  }
  throw new Error("sync did not finish");
}
async function forcePoll(id: string) { const c = await db.crmConnection.findUniqueOrThrow({ where: { id } }); await db.crmConnection.update({ where: { id }, data: { syncState: { ...(c.syncState as object), phase: "idle", lastPollAt: iso(60), lastReconcileAt: iso(1) } } }); await syncUntilIdle(id); }
const endCall = async (callId: string) => { for (let i = 0; i < 40; i++) { const c = await run(A.session, () => reconcileCall(callId)); if (c?.endedAt) return c; await new Promise((r) => setTimeout(r, 1000)); } throw new Error("call did not end"); };
function hook(id: string, secret: string, events: unknown[], tsOverride?: string) {
  const body = JSON.stringify({ events }); const ts = tsOverride ?? String(Math.floor(Date.now() / 1000));
  return webhookPOST(new Request(`http://localhost/api/crm-webhooks/${id}`, { method: "POST", body, headers: { "x-sim-timestamp": ts, "x-sim-signature": simSign(secret, ts, body) } }), { params: Promise.resolve({ connectionId: id }) });
}
/** Background event processing (kicked by the app) may hold an event for a moment – process until the condition holds. */
async function settle(cond: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 20; i++) {
    await run(A.session, () => processDomainEvents({ businessId: A.business.id }));
    await run(A.session, () => processCrmOutbox(A.business.id));
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 500));
  }
}
const contactOf = async (biz: Biz, ext: string) => (await db.externalRecordLink.findFirstOrThrow({ where: { businessId: biz.business.id, recordType: "contact", externalId: ext } })).localId!;
const leadOf = async (biz: Biz, ext: string) => (await db.externalRecordLink.findFirstOrThrow({ where: { businessId: biz.business.id, recordType: "lead", externalId: ext } })).localId!;
let phoneSeq = 0;
const phone = (end = "1") => `+97252${String(3000000 + ++phoneSeq * 7).slice(-6)}${end}`;

describe("external CRM connectors", { timeout: 1_800_000 }, () => {
  beforeAll(async () => {
    vi.stubEnv("ENCRYPTION_KEY", "b".repeat(64));
    // Business A: dialer + WhatsApp WITHOUT the CRM module (keeps its own CRM).
    A = await createBusiness("xcrm-a", { modules: { crm: false, telephony: true, whatsapp: true } });
    B = await createBusiness("xcrm-b", { modules: { crm: true, telephony: true } });
    accounts.push(A.account.id, B.account.id);
    const mk = async (name: string) => { const acc = await db.account.create({ data: { email: `${crypto.randomUUID()}@test.local`, fullName: name, passwordHash: "x", claimedAt: new Date() } }); accounts.push(acc.id); const u = await db.user.create({ data: { businessId: A.business.id, accountId: acc.id, email: acc.email, fullName: name, role: "agent" } }); return { id: u.id, accountId: acc.id, businessId: A.business.id, email: acc.email, fullName: name, role: "agent", teamId: null } as SessionUser; };
    x = await mk("נציג X"); y = await mk("נציג Y");
    await db.phoneNumber.create({ data: { businessId: A.business.id, e164: `+9727${String(Date.now()).slice(-8)}`, provider: "mock" } });
    listA = (await db.dialList.create({ data: { businessId: A.business.id, name: "מה-CRM החיצוני" } as never })).id;
    const s = sim(); s.users.push({ externalId: "u-100", name: "X בחוץ" }, { externalId: "u-200", name: "Y בחוץ" }); s.pageSize = 1;
  }, 900_000);
  afterAll(async () => {
    vi.unstubAllEnvs();
    for (const b of [A, B]) if (b) { await db.call.deleteMany({ where: { businessId: b.business.id } }); await destroyBusiness(b.business.id).catch(() => undefined); }
    await db.account.deleteMany({ where: { id: { in: accounts } } });
  }, 900_000);

  it("setup: only the owner manages it; 'active' only after a real test; secrets never returned", async () => {
    await expect(run(x, () => crm.createConnection(x, { connectorKey: "simulator", name: "Sim", auth: { account: "acctA", apiKey: "sim-valid" } }))).rejects.toMatchObject({ status: 403 });
    const created = await run(A.session, () => crm.createConnection(A.session, { connectorKey: "simulator", name: "Sim", auth: { account: "acctA", apiKey: "sim-bad" } }));
    connA = created.connection.id; hookSecretA = created.secretsOnce.webhookSecret!;
    expect(created.connection.status).toBe("setup");
    const bad = await run(A.session, () => crm.testConnection(A.session, connA));
    expect(bad.ok).toBe(false); expect(bad.connection.status).toBe("setup");
    await run(A.session, () => crm.updateAuth(A.session, connA, { auth: { apiKey: "sim-valid" } }));
    const good = await run(A.session, () => crm.testConnection(A.session, connA));
    expect(good.ok).toBe(true); expect(good.connection.status).toBe("active");
    const listed = await (await crmListGET(await cookieReq(A.session, "/api/integrations/crm"), ctx())).json();
    expect(JSON.stringify(listed)).not.toContain("sim-valid"); expect(JSON.stringify(listed)).not.toContain(hookSecretA);
    expect((await db.crmConnection.findUniqueOrThrow({ where: { id: connA } })).authConfig).toMatchObject({ apiKey: expect.stringMatching(/^enc:v1:/) });
    await run(A.session, () => crm.saveSettings(A.session, connA, {
      userMap: { "u-100": x.id, "u-200": y.id }, statusMap: { new: "new", follow_up: "follow_up", won: "converted", lost: "lost" }, statusOutMap: { converted: "won", lost: "lost" },
      directions: { status: "both", followUp: "in" }, selection: { statuses: ["new", "follow_up"] }, queue: { enabled: true, listId: listA },
      writeback: { calls: true, aiSummary: true, detailsLink: true, followUpTasks: true, status: true, blocks: true }, freshnessMinutes: 60,
    }));
  });

  it("main flow: source lead → initial sync → right agent → queue → call → result + summary back → one follow-up", async () => {
    const s = sim(); const p1 = phone("1");
    s.contacts.set("c-1", { externalId: "c-1", name: "דנה מהמקור", phones: [p1], ownerExternalId: "u-100", updatedAt: iso(30), version: "1" });
    s.leads.set("l-1", { externalId: "l-1", contactExternalId: "c-1", title: "פנייה", status: "new", ownerExternalId: "u-100", updatedAt: iso(30), version: "1" });
    s.contacts.set("c-2", { externalId: "c-2", name: "אחר", phones: [phone("1")], ownerExternalId: "u-200", updatedAt: iso(30), version: "1" });
    const pv = await run(A.session, () => crm.preview(A.session, connA));
    expect(pv).toMatchObject({ supported: true, contacts: 2, leads: 1, unmappedOwners: [] });
    s.rateLimitNext = 1; // the first page of the import is rate limited – the sync waits and resumes
    await run(A.session, () => crm.startInitialSync(A.session, connA));
    await syncUntilIdle(connA);
    const cId = await contactOf(A, "c-1"); const lId = await leadOf(A, "l-1");
    const lead = await db.lead.findUniqueOrThrow({ where: { id: lId } });
    expect(lead).toMatchObject({ ownerUserId: x.id, status: "new", reviewReason: null });
    expect(await db.domainEvent.count({ where: { businessId: A.business.id, type: "lead.created" } })).toBe(0); // no "new lead" automations
    expect(await db.listLead.count({ where: { listId: listA, contactId: cId } })).toBe(1);
    expect(await db.listLead.count({ where: { listId: listA, contactId: await contactOf(A, "c-2") } })).toBe(0); // contact without a selected lead
    // The agent works it from the queue (simulated telephony).
    const session = await db.dialerSession.create({ data: { businessId: A.business.id, userId: x.id, listId: listA, mode: "preview", browserSessionId: "b1" } });
    const claimed = await run(x, () => claimNextLead(A.business.id, x.id, listA));
    expect(claimed?.contactId).toBe(cId);
    const call = await run(x, () => startCall(x, { idempotencyKey: crypto.randomUUID(), mode: "preview", sessionId: session.id, browserSessionId: "b1", leadId: claimed!.id, lockToken: claimed!.lockToken! }));
    await endCall(call.id);
    await run(x, () => saveOutcome(x, { callId: call.id, outcome: "callback", callbackAt: new Date(Date.now() + 2 * 3600_000), note: "ביקשה לחזור מחר" }));
    await settle(() => s.activities.size >= 1 && s.tasks.size >= 1);
    expect(s.activities.size).toBe(1);
    const act = [...s.activities.values()][0];
    expect(act.data).toMatchObject({ contactExternalId: "c-1", leadExternalId: "l-1", note: "ביקשה לחזור מחר" });
    expect(String(act.data.detailsUrl)).toContain(`/calling/history?call=${call.id}`); // a link that needs sign-in, not a public recording
    expect(s.tasks.size).toBe(1);
    // Retry / reprocess never creates a second activity or follow-up.
    await db.crmOutbox.updateMany({ where: { connectionId: connA }, data: { status: "pending", nextAttemptAt: new Date(), attempts: 0 } });
    await run(A.session, () => processCrmOutbox(A.business.id));
    expect(s.activities.size).toBe(1); expect(s.tasks.size).toBe(1);
    // A late AI summary updates the same activity.
    await db.coachSession.create({ data: { businessId: A.business.id, callId: call.id, userId: x.id, contactId: cId, documentation: { summary: "הלקוחה מעוניינת, לחזור מחר" }, documentationStatus: "done", documentedAt: new Date() } as never });
    await run(A.session, () => emitEvent(db, { businessId: A.business.id, type: "call.summary_ready", contactId: cId, source: "system", dedupeKey: `sum:${call.id}`, payload: { callId: call.id } }));
    await run(A.session, () => processDomainEvents({ businessId: A.business.id }));
    await run(A.session, () => processCrmOutbox(A.business.id));
    expect(s.activities.size).toBe(1);
    expect([...s.activities.values()][0].data.aiSummary).toBe("הלקוחה מעוניינת, לחזור מחר");
  });

  it("updated lead applies; an older / duplicate event does not; two opportunities stay two leads", async () => {
    const s = sim(); const lId = await leadOf(A, "l-1");
    s.leads.set("l-1", { ...s.leads.get("l-1")!, status: "follow_up", updatedAt: iso(5), version: "2" });
    s.leads.set("l-2", { externalId: "l-2", contactExternalId: "c-1", title: "הזדמנות שנייה", status: "new", ownerExternalId: "u-100", updatedAt: iso(5), version: "1" });
    await forcePoll(connA);
    expect((await db.lead.findUniqueOrThrow({ where: { id: lId } })).status).toBe("follow_up");
    const l2 = await leadOf(A, "l-2");
    expect(l2).not.toBe(lId);
    expect(await db.lead.count({ where: { businessId: A.business.id, contactId: await contactOf(A, "c-1") } })).toBe(2);
    // Old event (version 1) after version 2 → stale; the same event id twice → duplicate.
    const old = { id: "evt-old", type: "lead", at: iso(20), data: { externalId: "l-1", contactExternalId: "c-1", status: "lost", ownerExternalId: "u-100", updatedAt: iso(20), version: "1" } };
    expect((await (await hook(connA, hookSecretA, [old])).json()).results).toEqual(["skipped_stale"]);
    const fresh = { id: "evt-2", type: "lead", at: iso(1), data: { externalId: "l-2", contactExternalId: "c-1", title: "הזדמנות שנייה – עודכן", status: "new", ownerExternalId: "u-100", updatedAt: iso(1), version: "2" } };
    expect((await (await hook(connA, hookSecretA, [fresh])).json()).results).toEqual(["applied"]);
    expect((await (await hook(connA, hookSecretA, [fresh])).json()).results).toEqual(["skipped_duplicate"]);
    expect((await db.lead.findUniqueOrThrow({ where: { id: lId } })).status).toBe("follow_up");
    // Signature / replay protection.
    const body = JSON.stringify({ events: [fresh] });
    expect((await webhookPOST(new Request("http://localhost/x", { method: "POST", body, headers: { "x-sim-timestamp": String(Math.floor(Date.now() / 1000)), "x-sim-signature": "0".repeat(64) } }), { params: Promise.resolve({ connectionId: connA }) })).status).toBe(401);
    expect((await hook(connA, hookSecretA, [{ ...fresh, id: "evt-replay" }], String(Math.floor(Date.now() / 1000) - 3600))).status).toBe(401);
  });

  it("agent changed in the source while queued: the lead moves; the old agent can no longer take it", async () => {
    const s = sim(); const cId = await contactOf(A, "c-1");
    await db.listLead.updateMany({ where: { listId: listA, contactId: cId }, data: { status: "pending", nextAttemptAt: null, lockedByUserId: null } });
    await db.task.updateMany({ where: { businessId: A.business.id, contactId: cId }, data: { status: "done" } });
    for (const id of ["l-1", "l-2"]) s.leads.set(id, { ...s.leads.get(id)!, status: "new", ownerExternalId: "u-200", updatedAt: iso(0.5), version: "5" });
    await forcePoll(connA);
    expect((await db.lead.findMany({ where: { businessId: A.business.id, contactId: cId } })).every((l) => l.ownerUserId === y.id)).toBe(true);
    expect(await run(x, () => claimNextLead(A.business.id, x.id, listA))).toBeNull();
    const byY = await run(y, () => claimNextLead(A.business.id, y.id, listA));
    expect(byY?.contactId).toBe(cId);
    await db.listLead.updateMany({ where: { id: byY!.id }, data: { status: "pending", lockedByUserId: null, lockExpiresAt: null } });
  });

  it("our status change goes out once and its webhook echo is not re-applied (no loop)", async () => {
    const s = sim(); const lId = await leadOf(A, "l-2");
    const writes = s.statusWrites.length;
    await db.lead.update({ where: { id: lId }, data: { status: "converted" } });
    const c1 = await contactOf(A, "c-1");
    await run(A.session, () => emitEvent(db, { businessId: A.business.id, type: "lead.status_changed", contactId: c1, source: "user", dedupeKey: `st:${lId}:conv`, payload: { leadId: lId, from: "new", to: "converted" } }));
    await run(A.session, () => processDomainEvents({ businessId: A.business.id }));
    await run(A.session, () => processCrmOutbox(A.business.id));
    expect(s.statusWrites.slice(writes)).toEqual([{ leadExternalId: "l-2", status: "won" }]);
    const echo = { id: "evt-echo", type: "lead", at: iso(0), data: { externalId: "l-2", contactExternalId: "c-1", status: "won", ownerExternalId: "u-200", updatedAt: new Date().toISOString(), version: "9" } };
    expect((await (await hook(connA, hookSecretA, [echo])).json()).results).toEqual(["skipped_echo"]);
    await run(A.session, () => processDomainEvents({ businessId: A.business.id })); await run(A.session, () => processCrmOutbox(A.business.id));
    expect(s.statusWrites.length).toBe(writes + 1);
    expect(await db.crmReviewItem.count({ where: { connectionId: connA, kind: "conflict" } })).toBe(0);
  });

  it("a block is enforced at once during an outage and reaches the source once it is back", async () => {
    const s = sim(); const cId = await contactOf(A, "c-2"); const ph = (await db.contact.findUniqueOrThrow({ where: { id: cId } })).phoneE164;
    s.down = true;
    await run(A.session, () => suppressContact({ businessId: A.business.id, contactId: cId, scope: "all", source: "manual", kind: "do_not_call", reason: "ביקש להסיר", actorId: A.user.id }));
    expect(await run(A.session, () => callBlockReason(A.business.id, ph))).toBeTruthy(); // local enforcement does not wait for the source
    await run(A.session, () => processDomainEvents({ businessId: A.business.id }));
    await run(A.session, () => processCrmOutbox(A.business.id));
    expect(s.blocks).toHaveLength(0);
    expect((await db.crmOutbox.findFirstOrThrow({ where: { connectionId: connA, action: "request_block" } })).status).toBe("failed");
    s.down = false;
    await db.crmOutbox.updateMany({ where: { connectionId: connA, action: "request_block" }, data: { nextAttemptAt: new Date() } });
    await run(A.session, () => processCrmOutbox(A.business.id));
    expect(s.blocks).toEqual([{ contactExternalId: "c-2", reason: "ביקש להסיר" }]);
    // An ordinary external update never lifts the block.
    s.contacts.set("c-2", { ...s.contacts.get("c-2")!, name: "שם חדש", updatedAt: iso(0.2), version: "3" });
    await forcePoll(connA);
    expect(await run(A.session, () => callBlockReason(A.business.id, ph))).toBeTruthy();
  });

  it("the source did it but the answer failed: the retry finds it by correlation id – no duplicate", async () => {
    const s = sim(); const cId = await contactOf(A, "c-1");
    const call = await db.call.create({ data: { businessId: A.business.id, userId: y.id, contactId: cId, mode: "manual", provider: "mock", idempotencyKey: crypto.randomUUID(), toE164: "+972500000000", fromE164: "+97230000000", status: "ended", endedAt: new Date(), outcome: "answered_interested" } as never });
    s.failAfterWriteNext = 1;
    const before = s.activities.size;
    await run(A.session, () => emitEvent(db, { businessId: A.business.id, type: "call.outcome_saved", contactId: cId, source: "user", dedupeKey: `oc:${call.id}`, payload: { callId: call.id, outcome: "answered_interested" } }));
    await run(A.session, () => processDomainEvents({ businessId: A.business.id }));
    await run(A.session, () => processCrmOutbox(A.business.id));
    const row = await db.crmOutbox.findFirstOrThrow({ where: { connectionId: connA, dedupeKey: `call:${call.id}` } });
    expect(row.status).toBe("failed"); expect(row.lastError).toContain("[ambiguous]");
    await db.crmOutbox.update({ where: { id: row.id }, data: { nextAttemptAt: new Date() } });
    await run(A.session, () => processCrmOutbox(A.business.id));
    expect(s.activities.size).toBe(before + 1);
    expect((await db.crmOutbox.findUniqueOrThrow({ where: { id: row.id } })).status).toBe("sent");
  });

  it("same source ids in two businesses stay separate", async () => {
    const created = await run(B.session, () => crm.createConnection(B.session, { connectorKey: "simulator", name: "Sim B", auth: { account: "acctB", apiKey: "sim-valid" } }));
    const connB = created.connection.id;
    await run(B.session, () => crm.testConnection(B.session, connB));
    const sb = simStore("acctB"); sb.contacts.set("c-1", { externalId: "c-1", name: "לקוח של B", phones: [phone("3")], updatedAt: iso(1), version: "1" });
    await run(B.session, () => crm.startInitialSync(B.session, connB));
    for (let i = 0; i < 10; i++) { await db.crmConnection.update({ where: { id: connB }, data: { nextSyncAt: null } }); await run(B.session, () => syncConnectionStep(connB, Date.now() + 10_000)); }
    const bc = await contactOf(B, "c-1"); const ac = await contactOf(A, "c-1");
    expect(bc).not.toBe(ac);
    expect((await db.contact.findUniqueOrThrow({ where: { id: ac } })).fullName).toBe("דנה מהמקור");
    await expect(run(B.session, () => crm.connectionStatus(B.session, connA))).rejects.toMatchObject({ status: 404 });
  });

  it("dialer + WhatsApp without the CRM module: the call card works, CRM screens don't", async () => {
    const cId = await contactOf(A, "c-1");
    expect((await leadsGET(await cookieReq(y, "/api/leads"), ctx())).status).toBe(403);
    expect((await contactGET(await cookieReq(y, `/api/contacts/${cId}`), ctx({ id: cId }))).status).toBe(200); // Y handles c-1 now
  });

  it("fuzzy match goes to review (never merged blindly); unmapped agent waits for a person", async () => {
    const s = sim(); const shared = phone("5");
    await db.contact.create({ data: { businessId: A.business.id, fullName: "משה (כרטיס מקומי)", phoneE164: shared, phoneRaw: shared } });
    s.contacts.set("c-9", { externalId: "c-9", name: "רחל – אותו טלפון", phones: [shared], ownerExternalId: "u-999", updatedAt: iso(0.1), version: "1" });
    await forcePoll(connA);
    const item = await db.crmReviewItem.findFirstOrThrow({ where: { connectionId: connA, externalId: "c-9", kind: "fuzzy_match" } });
    expect((await db.externalRecordLink.findFirstOrThrow({ where: { connectionId: connA, externalId: "c-9" } })).localId).toBeNull();
    expect(await db.contact.count({ where: { businessId: A.business.id, phoneE164: shared } })).toBe(1);
    const local = await db.contact.findFirstOrThrow({ where: { businessId: A.business.id, phoneE164: shared } });
    await run(A.session, () => crm.resolveReview(A.session, connA, item.id, { action: "link", contactId: local.id }));
    expect(await contactOf(A, "c-9")).toBe(local.id);
    expect(await db.crmReviewItem.count({ where: { connectionId: connA, externalId: "c-9", kind: "unmapped_owner", status: "open" } })).toBe(1);
    s.leads.set("l-9", { externalId: "l-9", contactExternalId: "c-9", status: "new", ownerExternalId: "u-999", updatedAt: iso(0.05), version: "1" });
    await forcePoll(connA);
    const l9 = await db.lead.findUniqueOrThrow({ where: { id: await leadOf(A, "l-9") } });
    expect(l9).toMatchObject({ ownerUserId: null, reviewReason: "external_owner_unmapped" });
    await run(A.session, () => processDomainEvents({ businessId: A.business.id }));
    expect((await db.lead.findUniqueOrThrow({ where: { id: l9.id } })).ownerUserId).toBeNull(); // never a random agent
  });

  it("disconnect stops sync, write-back and automatic dialing (data kept); reconnect fills the gap", async () => {
    const s = sim(); const cId = await contactOf(A, "c-1");
    await run(A.session, () => crm.disconnect(A.session, connA));
    expect((await db.contact.findUnique({ where: { id: cId } }))).not.toBeNull();
    await db.listLead.updateMany({ where: { listId: listA, contactId: cId }, data: { status: "pending", lockedByUserId: null, nextAttemptAt: null } });
    expect(await run(y, () => claimNextLead(A.business.id, y.id, listA))).toBeNull();
    const { assertDialAllowed } = await import("@/lib/crm/lead-ops");
    await expect(run(y, () => assertDialAllowed(y, cId, true, listA))).rejects.toMatchObject({ code: "crm_stale" });
    // During the disconnection the source changes and a write-back is queued: nothing moves.
    s.leads.set("l-1", { ...s.leads.get("l-1")!, title: "עודכן בזמן הניתוק", updatedAt: iso(0.01), version: "6" });
    const call = await db.call.create({ data: { businessId: A.business.id, userId: y.id, contactId: cId, mode: "manual", provider: "mock", idempotencyKey: crypto.randomUUID(), toE164: "+972500000001", fromE164: "+97230000000", status: "ended", endedAt: new Date(), outcome: "no_answer" } as never });
    await run(A.session, () => emitEvent(db, { businessId: A.business.id, type: "call.outcome_saved", contactId: cId, source: "user", dedupeKey: `oc2:${call.id}`, payload: { callId: call.id } }));
    await run(A.session, () => processDomainEvents({ businessId: A.business.id }));
    const acts = s.activities.size;
    await run(A.session, () => processCrmOutbox(A.business.id));
    expect(s.activities.size).toBe(acts);
    expect(await run(A.session, () => syncConnectionStep(connA, Date.now() + 5000))).toEqual({ skipped: "disconnected" });
    const r = await run(A.session, () => crm.reconnect(A.session, connA));
    expect(r.status).toBe("active");
    await syncUntilIdle(connA);
    expect((await db.lead.findUniqueOrThrow({ where: { id: await leadOf(A, "l-1") } })).title).toBe("עודכן בזמן הניתוק");
    await run(A.session, () => processCrmOutbox(A.business.id));
    expect(s.activities.size).toBe(acts + 1);
    expect(await run(y, () => claimNextLead(A.business.id, y.id, listA))).not.toBeNull();
  });

  it("general integration API: scoped keys, idempotency, validation, rate limit, block, events; SSRF refused", async () => {
    await expect(run(A.session, () => crm.createConnection(A.session, { connectorKey: "generic_api", name: "Gen", auth: { callbackUrl: "https://127.0.0.1/cb" } }))).rejects.toMatchObject({ status: 400 });
    await expect(run(A.session, () => crm.createConnection(A.session, { connectorKey: "generic_api", name: "Gen", auth: { callbackUrl: "http://example.com/cb" } }))).rejects.toMatchObject({ status: 400 });
    const g = await run(A.session, () => crm.createConnection(A.session, { connectorKey: "generic_api", name: "Gen", auth: {} }));
    const gid = g.connection.id;
    expect((await run(A.session, () => crm.testConnection(A.session, gid))).ok).toBe(true);
    await run(A.session, () => crm.saveSettings(A.session, gid, { userMap: { "rep-1": x.id }, statusMap: { open: "new" } }));
    const { createIntegrationKey } = await import("@/server/services/integrations");
    const k = await run(A.session, () => createIntegrationKey(A.session, { name: "k", connectionId: gid, scopes: ["contacts:write", "leads:write", "events:read", "blocks:write"] }));
    const readOnly = await run(A.session, () => createIntegrationKey(A.session, { name: "ro", connectionId: gid, scopes: ["events:read"] }));
    const legacy = await run(A.session, () => createApiKey(A.session, "legacy"));
    const req = (key: string, url: string, method: string, body?: unknown, h: Record<string, string> = {}) => new Request(`http://localhost${url}`, { method, headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", ...h }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    const P = (ext: string) => ({ params: Promise.resolve({ externalId: ext }) });
    const ph = phone("7");
    const r1 = await contactPUT(req(k.key, "/api/v1/crm/contacts/ext-1", "PUT", { name: "מה-API", phones: [ph], ownerExternalId: "rep-1", updatedAt: iso(1) }, { "Idempotency-Key": "idem-1" }), P("ext-1"));
    expect(r1.status).toBe(200); expect(r1.headers.get("X-API-Version")).toBe("1");
    const j1 = await r1.json();
    const r2 = await contactPUT(req(k.key, "/api/v1/crm/contacts/ext-1", "PUT", { name: "מה-API", phones: [ph], ownerExternalId: "rep-1", updatedAt: iso(1) }, { "Idempotency-Key": "idem-1" }), P("ext-1"));
    expect((await r2.json()).data).toMatchObject({ status: "skipped_duplicate", localId: j1.data.localId });
    expect((await contactPUT(req(readOnly.key, "/api/v1/crm/contacts/ext-2", "PUT", { name: "x", phones: [phone()] }), P("ext-2"))).status).toBe(403);
    expect((await contactPUT(req(legacy.key, "/api/v1/crm/contacts/ext-2", "PUT", { name: "x", phones: [phone()] }), P("ext-2"))).status).toBe(403);
    expect((await contactPUT(req(k.key, "/api/v1/crm/contacts/ext-3", "PUT", { phones: "not-an-array" }), P("ext-3"))).status).toBe(400);
    const lr = await leadPUT(req(k.key, "/api/v1/crm/leads/opp-1", "PUT", { contactExternalId: "ext-1", status: "open", ownerExternalId: "rep-1", followUpAt: new Date(Date.now() + 86400_000).toISOString(), timezone: "Asia/Jerusalem" }), P("opp-1"));
    expect((await lr.json()).data.status).toBe("applied");
    const localLead = await db.lead.findFirstOrThrow({ where: { id: (await db.externalRecordLink.findFirstOrThrow({ where: { connectionId: gid, externalId: "opp-1" } })).localId! } });
    expect(localLead).toMatchObject({ ownerUserId: x.id, status: "new" });
    expect(await db.task.count({ where: { businessId: A.business.id, requestKey: `crm:${gid}:opp-1:followup` } })).toBe(1);
    // Block request from the external system → enforced here.
    const br = await blockPOST(req(k.key, "/api/v1/crm/blocks", "POST", { contactExternalId: "ext-1", reason: "unsubscribe" }));
    expect(br.status).toBe(200); expect(await run(A.session, () => callBlockReason(A.business.id, ph))).toBeTruthy();
    // Events for this connection's records only (no message bodies).
    const call = await db.call.create({ data: { businessId: A.business.id, userId: x.id, contactId: j1.data.localId, mode: "manual", provider: "mock", idempotencyKey: crypto.randomUUID(), toE164: ph, fromE164: "+97230000000", status: "ended", outcome: "answered" } as never });
    await run(A.session, () => emitEvent(db, { businessId: A.business.id, type: "call.outcome_saved", contactId: j1.data.localId, source: "user", dedupeKey: `ev:${call.id}`, payload: { callId: call.id, outcome: "answered", note: "secret text" } }));
    const ev = await (await eventsGET(req(k.key, "/api/v1/crm/events?limit=50", "GET"))).json();
    const mine = ev.data.items.find((e: { data: { callId?: string } }) => e.data.callId === call.id);
    expect(mine).toMatchObject({ type: "call.outcome_saved", contactExternalId: "ext-1" });
    expect(JSON.stringify(ev)).not.toContain("secret text");
    expect(JSON.stringify(ev)).not.toContain(await contactOf(A, "c-2")); // not linked to this connection
    // Rate limit (per key, per minute).
    await db.apiKey.update({ where: { id: k.id }, data: { windowStart: new Date(), windowCount: 500 } });
    expect((await eventsGET(req(k.key, "/api/v1/crm/events", "GET"))).status).toBe(429);
    // Rotation: the new key works at once; the old one until its grace period ends.
    const { rotateApiKey } = await import("@/server/services/integrations");
    const rot = await run(A.session, () => rotateApiKey(A.session, readOnly.id));
    expect((await eventsGET(req(rot.key, "/api/v1/crm/events", "GET"))).status).toBe(200);
    await db.apiKey.update({ where: { id: readOnly.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await eventsGET(req(readOnly.key, "/api/v1/crm/events", "GET"))).status).toBe(401);
  });
});
