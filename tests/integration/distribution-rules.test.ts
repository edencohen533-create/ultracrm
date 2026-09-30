/**
 * Lead distribution + distribution rules (real DB; no calls, no messages to customers):
 *  • round robin with many leads arriving at once: each agent gets an equal share, no lead twice, pointer kept,
 *    leads that already had an owner never move; every assignment records why;
 *  • availability: offline agents are skipped; nobody online → unassigned (or "anyone eligible");
 *  • free text → structured rule (the example from the spec) with the right questions;
 *  • a draft does nothing; after the owner activates: small sample → nothing; condition met → ONE request a day
 *    (repeated checks do nothing), through manager → agent approval, then exactly N extra leads, then back to normal;
 *  • conflicting rules: only the stronger one fires; the day resets by the business's time zone;
 *  • an unavailable agent gets nothing; preview writes nothing; owner-only + isolation (API).
 */
import crypto from "node:crypto";
import { NextRequest } from "next/server";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { db } from "@/lib/db";
import { withBusiness } from "@/lib/tenant";
import { signSession, type SessionUser } from "@/lib/auth";
import { createBusiness, destroyBusiness } from "./helpers";
import { createContact } from "@/lib/crm/contacts";
import { createLead } from "@/lib/crm/pipeline";
import { processDomainEvents, waitForEvents } from "@/lib/events";
import { getBusinessSettings } from "@/lib/settings";
import { businessDayStart, zonedParts } from "@/lib/business-day";
import { interpretRule } from "@/server/ops/rules";
import { evaluateDistributionRules, simulateDistribution, conflictsOf } from "@/server/ops/distribution";
import { managerDecision, agentDecision } from "@/server/ops/engine";
import { GET as distGET } from "@/app/api/distribution/route";
import { POST as rulesPOST } from "@/app/api/distribution/rules/route";
import { PATCH as rulePATCH } from "@/app/api/distribution/rules/[id]/route";
import { PATCH as opsRulePATCH } from "@/app/api/ops/rules/[id]/route";

process.env.ENCRYPTION_KEY ||= crypto.randomBytes(32).toString("hex");
const TZ = "Asia/Jerusalem";
type Biz = Awaited<ReturnType<typeof createBusiness>>;
let A: Biz, B: Biz; let avi: SessionUser, dana: SessionUser, yossi: SessionUser, manager: SessionUser;
const accounts: string[] = [];
const run = <T,>(u: SessionUser, fn: () => Promise<T>) => withBusiness(u.businessId, fn, u);
const req = async (u: SessionUser, url: string, method: string, body?: unknown) => new NextRequest(`http://localhost${url}`, { method, body: body === undefined ? undefined : JSON.stringify(body), headers: { "content-type": "application/json", origin: "http://localhost", cookie: `ultracrm_session=${await signSession(u)}` } });
const api = async (u: SessionUser, fn: (r: NextRequest, c: { params: Promise<Record<string, string>> }) => Promise<Response>, url: string, method: string, body?: unknown, params: Record<string, string> = {}) =>
  withBusiness(u.businessId, async () => { const r = await fn(await req(u, url, method, body), { params: Promise.resolve(params) }); return { status: r.status, body: await r.json() }; }, u);
let seq = 0;
const newLeads = async (n: number) => Promise.all(Array.from({ length: n }, async () => { seq++; const c = await run(A.session, () => createContact(A.session, { fullName: `ליד ${seq}`, phone: `05277${String(10000 + seq * 13 + (Date.now() % 997)).slice(-5)}` })); return run(A.session, () => createLead(A.session, { contactId: c.id, title: `ליד ${seq}` })); }));
const drain = async () => { await Promise.all([1, 2, 3, 4].map(() => processDomainEvents({ businessId: A.business.id }))); await waitForEvents(A.business.id); };
const ownerOf = async (ids: string[]) => (await db.lead.findMany({ where: { id: { in: ids } }, select: { id: true, ownerUserId: true } }));
const setPolicy = async (la: Record<string, unknown>, extra: Record<string, unknown> = {}) => {
  const biz = await db.business.findUniqueOrThrow({ where: { id: A.business.id }, select: { settings: true } });
  const s = (biz.settings ?? {}) as Record<string, unknown>;
  await db.business.update({ where: { id: A.business.id }, data: { settings: { ...s, ...extra, leadAssignment: { ...((s.leadAssignment as object) ?? {}), ...la } } as object } });
};
const releaseAll = () => db.lead.updateMany({ where: { businessId: A.business.id, ownerUserId: { not: null } }, data: { status: "lost" } }); // open counts → 0 between tests

describe("lead distribution + distribution rules", { timeout: 900_000 }, () => {
  beforeAll(async () => {
    A = await createBusiness("dist-rules-a", { modules: { crm: true, telephony: true } });
    B = await createBusiness("dist-rules-b", { modules: { crm: true, telephony: true } });
    accounts.push(A.account.id, B.account.id);
    await db.business.update({ where: { id: A.business.id }, data: { timezone: TZ } });
    const mk = async (name: string, role: "agent" | "manager") => { const acc = await db.account.create({ data: { email: `${crypto.randomUUID()}@test.local`, fullName: name, passwordHash: "x", claimedAt: new Date() } }); accounts.push(acc.id); const u = await db.user.create({ data: { businessId: A.business.id, accountId: acc.id, email: acc.email, fullName: name, role } }); return { id: u.id, accountId: acc.id, businessId: A.business.id, email: acc.email, fullName: name, role, teamId: null } as SessionUser; };
    avi = await mk("אבי לוי", "agent"); dana = await mk("דנה", "agent"); yossi = await mk("יוסי", "agent");
    manager = await mk("מנהלת", "manager");
    await setPolicy({ mode: "round_robin", maxOpenLeadsPerAgent: 0, agentIds: [avi.id, dana.id, yossi.id], perAgentMax: {}, lastAssignedUserId: null });
  }, 300_000);
  afterAll(async () => { for (const b of [A, B]) if (b) { await db.opsRecommendation.deleteMany({ where: { businessId: b.business.id } }); await db.assignmentOverride.deleteMany({ where: { businessId: b.business.id } }); await destroyBusiness(b.business.id); } await db.account.deleteMany({ where: { id: { in: accounts } } }); }, 300_000);

  it("round robin, 12 leads at once: 4 each, never twice, pointer kept, existing owners untouched, reason recorded", async () => {
    const c = await run(A.session, () => createContact(A.session, { fullName: "של דנה", phone: "0527799001" }));
    const owned = await run(A.session, () => createLead(A.session, { contactId: c.id, ownerUserId: dana.id }));
    const leads = await newLeads(12);
    await drain();
    const rows = await ownerOf(leads.map((l) => l.id));
    const tally = rows.reduce<Record<string, number>>((m, r) => { m[r.ownerUserId ?? "none"] = (m[r.ownerUserId ?? "none"] ?? 0) + 1; return m; }, {});
    expect(tally).toEqual({ [avi.id]: 4, [dana.id]: 4, [yossi.id]: 4 });
    expect((await db.lead.findUniqueOrThrow({ where: { id: owned.id } })).ownerUserId).toBe(dana.id);
    const last = (await getBusinessSettings(A.business.id)).leadAssignment.lastAssignedUserId;
    expect([avi.id, dana.id, yossi.id]).toContain(last);
    const reasons = await db.auditLog.findMany({ where: { businessId: A.business.id, action: "lead.assigned", entityId: { in: leads.map((l) => l.id) } } });
    expect(reasons).toHaveLength(12);
    expect((reasons[0].payload as { policy: string }).policy).toBe("round_robin");
    await releaseAll();
  });

  it("availability: offline agents are skipped; nobody online → unassigned, or anyone eligible when chosen", async () => {
    await setPolicy({ requireOnline: true, whenNoneOnline: "unassigned" });
    await db.dialerSession.create({ data: { businessId: A.business.id, userId: dana.id, mode: "preview", browserSessionId: "d1", status: "active", lastHeartbeatAt: new Date() } as never });
    let leads = await newLeads(3); await drain();
    expect((await ownerOf(leads.map((l) => l.id))).every((r) => r.ownerUserId === dana.id)).toBe(true);
    await db.dialerSession.updateMany({ where: { userId: dana.id }, data: { status: "ended" } });
    leads = await newLeads(2); await drain();
    expect((await ownerOf(leads.map((l) => l.id))).every((r) => r.ownerUserId === null)).toBe(true);
    expect(await db.auditLog.count({ where: { action: "lead.unassigned", entityId: { in: leads.map((l) => l.id) } } })).toBe(2);
    await setPolicy({ whenNoneOnline: "any_eligible" });
    leads = await newLeads(1); await drain();
    expect((await ownerOf(leads.map((l) => l.id)))[0].ownerUserId).not.toBeNull();
    await setPolicy({ requireOnline: false, whenNoneOnline: "unassigned" });
    await db.lead.updateMany({ where: { businessId: A.business.id, ownerUserId: null }, data: { status: "lost" } });
    await releaseAll();
  });

  it("free text → structured rule with the questions that change its meaning", async () => {
    const agents = [{ id: avi.id, fullName: avi.fullName }, { id: dana.id, fullName: dana.fullName }];
    const r = await interpretRule("חלק לידים בצורה שווה לכולם, אבל אם יחס הסגירה של אבי היום עולה על 17%, תן לו 7 לידים נוספים על חשבון החלוקה הרגילה.", { agents });
    expect(r.kind).toBe("performance_bonus");
    expect(r.config).toMatchObject({ agentId: avi.id, threshold: 0.17, bonusCount: 7 });
    expect(r.policyHint).toBe("round_robin");
    expect(r.questions.map((q) => q.field).sort()).toEqual(["frequency", "minHandled"]);
    expect(r.summary?.conditions).toContain("עסקאות שנסגרו");
    expect(r.summary?.action).toContain("על חשבון החלוקה הרגילה");
    const unknown = await interpretRule("אם יחס הסגירה של משה היום מעל 20%, תן לו 5 לידים נוספים", { agents });
    expect(unknown.questions.find((q) => q.field === "agentId")?.options?.length).toBe(2);
  });

  it("draft → owner activates; small sample → nothing; condition met → one request a day through the approvals → exactly N extra leads → back to normal", async () => {
    const hour = Number(zonedParts(TZ, new Date()).time.slice(0, 2));
    if (hour < 2 || hour >= 22) return; // capacity needs a working hour behind and a shift ahead (business time)
    // Avi: shift all day; 12 contacts really dialed today (the first ~70 min ago), 3 won deals → 25% > 17%.
    await setPolicy({}, { aiOps: { enabled: false, notifyWhatsApp: false, maxAlertsPerDay: 8, cooldownMinutes: 120, shifts: { [avi.id]: { start: "00:00", end: "23:59", days: [0, 1, 2, 3, 4, 5, 6] } } } });
    const dayStart = businessDayStart(TZ);
    const dial = async (i: number, at: Date) => { const c = await db.contact.create({ data: { businessId: A.business.id, fullName: `חויג ${i}`, phoneE164: `+97253${String(2000000 + i + seq * 50).slice(-7)}`, phoneRaw: "x" } }); await db.call.create({ data: { businessId: A.business.id, userId: avi.id, contactId: c.id, mode: "manual", provider: "mock", idempotencyKey: crypto.randomUUID(), toE164: c.phoneE164, fromE164: "x", direction: "outbound", leadDialedAt: at, createdAt: at, status: "ended", endedAt: at } as never }); return c; };
    const firstAt = new Date(Math.max(dayStart.getTime() + 60_000, Date.now() - 70 * 60_000));
    const dialed = [];
    for (let i = 0; i < 4; i++) dialed.push(await dial(i, new Date(firstAt.getTime() + i * 60_000)));
    const created = await api(A.session, rulesPOST, "/api/distribution/rules", "POST", { name: "אבי 17%", config: { agentId: avi.id, threshold: 0.17, minHandled: 10, bonusCount: 7 } });
    expect(created.status).toBe(201); expect(created.body.data.status).toBe("draft");
    const ruleId = created.body.data.id as string;
    // Draft: nothing happens.
    expect((await run(A.session, () => evaluateDistributionRules(A.business.id))).results).toHaveLength(0);
    expect((await api(A.session, rulePATCH, `/api/distribution/rules/${ruleId}`, "PATCH", { status: "active" }, { id: ruleId })).status).toBe(200);
    // 4 handled, 1 win (25%) – sample too small.
    await db.deal.create({ data: { businessId: A.business.id, contactId: dialed[0].id, title: "w", stage: "won", status: "won", ownerUserId: avi.id, closedAt: new Date() } });
    let ev = await run(A.session, () => evaluateDistributionRules(A.business.id));
    expect(ev.results[0]).toMatchObject({ state: "insufficient_sample" });
    for (let i = 4; i < 12; i++) dialed.push(await dial(i, new Date(firstAt.getTime() + i * 60_000)));
    for (const i of [1, 2]) await db.deal.create({ data: { businessId: A.business.id, contactId: dialed[i].id, title: "w", stage: "won", status: "won", ownerUserId: avi.id, closedAt: new Date() } });
    ev = await run(A.session, () => evaluateDistributionRules(A.business.id));
    expect(ev.results[0]).toMatchObject({ state: "fired" });
    // The check runs again (condition still true) → nothing new.
    for (let i = 0; i < 3; i++) expect((await run(A.session, () => evaluateDistributionRules(A.business.id))).results[0]).toMatchObject({ state: "done_today" });
    const rec = await db.opsRecommendation.findFirstOrThrow({ where: { businessId: A.business.id, kind: "performance_bonus", status: { not: "insight" } } });
    expect(rec.status).toBe("pending_manager"); // default approval policy: manager approves assignment changes
    const n = rec.requestedCount!;
    expect(n).toBeGreaterThan(0); expect(n).toBeLessThanOrEqual(7);
    await run(manager, () => managerDecision(manager, rec.id, { action: "approve", via: "app" }));
    expect((await db.opsRecommendation.findUniqueOrThrow({ where: { id: rec.id } })).status).toBe("pending_agent"); // the agent is asked – not bypassed
    await run(avi, () => agentDecision(avi, rec.id, { kind: "yes", count: null }, "app"));
    const ov = await db.assignmentOverride.findFirstOrThrow({ where: { recommendationId: rec.id } });
    expect(ov).toMatchObject({ mode: "extra", leadLimit: n, agentId: avi.id, status: "active" });
    // The next N+3 new leads: the first N to Avi (extra), then the regular rotation again.
    const leads = await newLeads(n + 3);
    for (const l of leads) { void l; }
    await drain();
    const owners = await ownerOf(leads.map((l) => l.id));
    expect(owners.filter((o) => o.ownerUserId === avi.id).length).toBeGreaterThanOrEqual(n);
    expect((await db.assignmentOverride.findUniqueOrThrow({ where: { id: ov.id } })).status).toBe("completed");
    expect(await db.auditLog.count({ where: { action: "ai_ops.lead_allocated", payload: { path: ["recommendationId"], equals: rec.id } } })).toBe(n);

    // Conflicting rule on the same agent: never a second bonus the same day; reported as a conflict.
    const second = await api(A.session, rulesPOST, "/api/distribution/rules", "POST", { name: "אבי 10%", config: { agentId: avi.id, threshold: 0.1, minHandled: 5, bonusCount: 5 }, priority: 200 });
    const act = await api(A.session, rulePATCH, `/api/distribution/rules/${second.body.data.id}`, "PATCH", { status: "active" }, { id: second.body.data.id });
    expect(act.body.data.conflicts.length).toBe(1);
    const again = await run(A.session, () => evaluateDistributionRules(A.business.id));
    expect(again.created).toBe(0);
    expect(await db.opsRecommendation.count({ where: { businessId: A.business.id, kind: "performance_bonus", status: { not: "insight" } } })).toBe(1);

    // Day reset (business time zone): yesterday's bonus doesn't block today – the key is the business-local date.
    const today = zonedParts(TZ, new Date()).date;
    expect(rec.dedupeKey).toBe(`bonus:${avi.id}:${today}`);
    await db.opsRecommendation.update({ where: { id: rec.id }, data: { dedupeKey: `bonus:${avi.id}:2000-01-01`, status: "completed" } });
    await db.opsRule.update({ where: { id: second.body.data.id }, data: { status: "paused" } });
    await db.lead.updateMany({ where: { businessId: A.business.id, ownerUserId: avi.id }, data: { status: "lost" } }); // free capacity again
    expect((await run(A.session, () => evaluateDistributionRules(A.business.id))).created).toBe(1);

    // Unavailable agent (inactive): no request.
    await db.opsRecommendation.deleteMany({ where: { businessId: A.business.id, kind: "performance_bonus" } });
    await db.user.update({ where: { id: avi.id }, data: { isActive: false } });
    expect((await run(A.session, () => evaluateDistributionRules(A.business.id))).results[0]).toMatchObject({ state: "agent_unavailable" });
    await db.user.update({ where: { id: avi.id }, data: { isActive: true } });
  });

  it("conflicts are detected before activation (unit)", () => {
    const now = new Date();
    const c = conflictsOf([{ id: "a", name: "א", priority: 10, createdAt: now, config: { agentId: "x" } }, { id: "b", name: "ב", priority: 20, createdAt: now, config: { agentId: "x" } }, { id: "c", name: "ג", priority: 5, createdAt: now, config: { agentId: "y" } }]);
    expect(Object.keys(c)).toEqual(["b"]);
  });

  it("preview writes nothing and shows the extra leads, then the rotation", async () => {
    await db.assignmentOverride.updateMany({ where: { businessId: A.business.id }, data: { status: "cancelled" } });
    const beforeLeads = await db.lead.count({ where: { businessId: A.business.id } });
    const sim = await run(A.session, () => simulateDistribution(A.business.id, { count: 10, rule: { config: { agentId: dana.id, threshold: 0.17, minHandled: 10, bonusCount: 3 } }, assumeConditionMet: true }));
    expect(sim.rows.slice(0, 3).every((r) => r.agentId === dana.id)).toBe(true);
    expect(sim.rows[0].why).toContain("תוספת");
    expect(new Set(sim.rows.slice(3).map((r) => r.agentId)).size).toBeGreaterThan(1);
    expect(await db.lead.count({ where: { businessId: A.business.id } })).toBe(beforeLeads);
    expect(await db.assignmentOverride.count({ where: { businessId: A.business.id, status: "active" } })).toBe(0);
  });

  it("owner only (API) and isolated per business", async () => {
    expect((await api(manager, distGET, "/api/distribution", "GET")).status).toBe(403);
    expect((await api(dana, distGET, "/api/distribution", "GET")).status).toBe(403);
    const mine = await api(A.session, distGET, "/api/distribution", "GET");
    expect(mine.status).toBe(200);
    const ruleId = mine.body.data.rules[0]?.id as string;
    expect(ruleId).toBeTruthy();
    // Another business can't see or touch it; a manager can't reach it through the "מנהל AI" rules API either.
    const other = await api(B.session, distGET, "/api/distribution", "GET");
    expect(other.body.data.rules).toHaveLength(0);
    expect((await api(B.session, rulePATCH, `/api/distribution/rules/${ruleId}`, "PATCH", { status: "paused" }, { id: ruleId })).status).toBe(404);
    expect((await api(manager, opsRulePATCH, `/api/ops/rules/${ruleId}`, "PATCH", { status: "paused" }, { id: ruleId })).status).toBe(404);
  });
});
