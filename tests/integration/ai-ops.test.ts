/**
 * "מנהל AI" end to end (real DB, no model – everything must work without one):
 *  momentum detection with thresholds (small sample / overloaded / unknown shift never recommend) → manager approval
 *  (ceiling, nothing assigned) → agent confirmation (≤ ceiling, free text, ambiguous → ask) → re-check → temporary
 *  allocation on the real distribution (pickOwner via lead.created) → back to the regular policy; double approvals,
 *  expiry, capacity change while waiting, WhatsApp "כן" with several open requests, free-text rules, load cap,
 *  business isolation.
 */
import crypto from "node:crypto";
import { beforeAll, afterAll, it, expect, describe } from "vitest";
import { db } from "@/lib/db";
import { withBusiness } from "@/lib/tenant";
import type { SessionUser } from "@/lib/auth";
import { createBusiness, destroyBusiness } from "./helpers";
import { businessDayStart } from "@/lib/business-day";
import { emitEvent, waitForEvents } from "@/lib/events";
import { agentSnapshots, agentCapacity } from "@/server/ops/metrics";
import { assessMomentum, evaluateMomentum, managerDecision, agentDecision, parseAgentAnswer, opsWhatsAppReply, runOpsTick, cancelRecommendation } from "@/server/ops/engine";
import { interpretRule, parseConfig, ensureDefaultRules } from "@/server/ops/rules";

const TZ = "Asia/Jerusalem";
let a: Awaited<ReturnType<typeof createBusiness>>, b: Awaited<ReturnType<typeof createBusiness>>;
let owner: SessionUser, dana: SessionUser, yossi: SessionUser, avi: SessionUser;
const accounts: string[] = [];
const run = <T,>(u: SessionUser, fn: () => Promise<T>) => withBusiness(u.businessId, fn, u);
const sys = <T,>(fn: () => Promise<T>) => withBusiness(a.business.id, fn);
let seq = 0;

async function mkUser(name: string): Promise<SessionUser> {
  const acc = await db.account.create({ data: { email: `${crypto.randomUUID()}@test.local`, fullName: name, passwordHash: "x" } }); accounts.push(acc.id);
  const u = await db.user.create({ data: { businessId: a.business.id, accountId: acc.id, email: acc.email, fullName: name, role: "agent" } });
  return { id: u.id, accountId: acc.id, businessId: a.business.id, email: acc.email, fullName: name, role: "agent", teamId: null };
}
async function contactLead(ownerId: string | null, opts: { source?: string; status?: "new" | "contacted"; createdAt?: Date } = {}) {
  seq++;
  const c = await db.contact.create({ data: { businessId: a.business.id, fullName: `ליד ${seq}`, phoneE164: `+97255${String(1000000 + seq)}`, phoneRaw: "x", ownerUserId: ownerId } });
  const l = await db.lead.create({ data: { businessId: a.business.id, contactId: c.id, ownerUserId: ownerId, status: opts.status ?? "contacted", source: opts.source ?? "facebook", createdAt: opts.createdAt ?? new Date(Date.now() - 2 * 86400_000) } });
  return { c, l };
}
/** `handled` dialed leads for the agent at `at`, `wins` of them closed as won deals. */
async function history(u: SessionUser, handled: number, wins: number, at: (i: number) => Date, source = "facebook") {
  for (let i = 0; i < handled; i++) {
    const { c } = await contactLead(u.id, { source });
    await db.call.create({ data: { businessId: a.business.id, userId: u.id, contactId: c.id, mode: "power", provider: "mock", direction: "outbound", idempotencyKey: crypto.randomUUID(), toE164: c.phoneE164, fromE164: "x", status: "ended", telephonyResult: i < wins ? "answered" : "no_answer", answeredAt: i < wins ? at(i) : null, leadDialedAt: at(i), endedAt: at(i), createdAt: at(i) } });
    if (i < wins) await db.deal.create({ data: { businessId: a.business.id, contactId: c.id, title: "עסקה", status: "won", ownerUserId: u.id, amount: 1000, closedAt: at(i) } });
  }
}
const dayStart = () => businessDayStart(TZ, new Date());
const todayAt = (i: number) => new Date(Math.min(Date.now() - 60_000, dayStart().getTime() + 60_000 + i * 60_000));
const pastAt = (i: number) => new Date(dayStart().getTime() - (1 + (i % 9)) * 86400_000 + 10 * 3600_000);
const setOps = async (patch: Record<string, unknown>) => { const x = await db.business.findUniqueOrThrow({ where: { id: a.business.id } }); const s = x.settings as Record<string, unknown>; await db.business.update({ where: { id: a.business.id }, data: { settings: { ...s, aiOps: { ...((s.aiOps as object) ?? {}), ...patch } } as object } }); };
const allDay = { start: "00:00", end: "23:59", days: [0, 1, 2, 3, 4, 5, 6] };
/** A new unassigned lead through the real path (lead.created → pickOwner). */
async function incoming(source = "facebook") {
  const { c, l } = await contactLead(null, { source, status: "new", createdAt: new Date() });
  await emitEvent(db, { businessId: a.business.id, type: "lead.created", contactId: c.id, source: "system", dedupeKey: `lead.created:${l.id}`, payload: { leadId: l.id, ownerUserId: null, source } });
  await waitForEvents(a.business.id, 60_000);
  return (await db.lead.findUniqueOrThrow({ where: { id: l.id } })).ownerUserId;
}
const openRec = (agentId: string) => db.opsRecommendation.findFirst({ where: { businessId: a.business.id, agentId, kind: "momentum", status: { in: ["pending_manager", "pending_agent", "active", "insight"] } }, orderBy: { createdAt: "desc" } });
// Between scenarios: no allocations/recommendations, and the leads handed out so far count as worked (no load).
const reset = async () => { await db.assignmentOverride.deleteMany({ where: { businessId: a.business.id } }); await db.opsRecommendation.deleteMany({ where: { businessId: a.business.id } }); await db.lead.updateMany({ where: { businessId: a.business.id, status: "new" }, data: { status: "contacted" } }); };

describe("מנהל AI – momentum → manager → agent → temporary allocation", { timeout: 1_800_000 }, () => {
  beforeAll(async () => {
    delete process.env.ANTHROPIC_API_KEY;
    a = await createBusiness("ai-ops", { modules: { crm: true, telephony: true, whatsapp: true } });
    b = await createBusiness("ai-ops-b", { modules: { crm: true, telephony: true, whatsapp: true } });
    accounts.push(a.account.id, b.account.id);
    owner = a.session;
    dana = await mkUser("דנה כהן"); yossi = await mkUser("יוסי לוי"); avi = await mkUser("אבי מזרחי");
    const x = await db.business.findUniqueOrThrow({ where: { id: a.business.id } });
    await db.business.update({ where: { id: a.business.id }, data: { settings: { ...(x.settings as object), timezone: TZ, leadAssignment: { mode: "round_robin", agentIds: [], perAgentMax: {}, maxOpenLeadsPerAgent: 0 }, aiOps: { enabled: true, notifyWhatsApp: true, maxAlertsPerDay: 50, cooldownMinutes: 10, shifts: { [dana.id]: allDay, [yossi.id]: allDay, [avi.id]: allDay } } } as object } });
    // Dana: 10% over the previous days, 30% today (6/20). Yossi: similar leads today, 1/15. Avi: 2/3 today (tiny sample).
    await history(dana, 40, 4, pastAt); await history(dana, 20, 6, todayAt);
    await history(yossi, 40, 4, pastAt); await history(yossi, 15, 1, todayAt);
    await history(avi, 40, 4, pastAt); await history(avi, 3, 2, todayAt);
    await sys(() => ensureDefaultRules(a.business.id));
  }, 900_000);
  afterAll(async () => { if (a) await destroyBusiness(a.business.id); if (b) await destroyBusiness(b.business.id); await db.account.deleteMany({ where: { id: { in: accounts } } }); }, 900_000);

  it("numbers are computed in code; a small sample is never 'hot'; the hot agent is detected with capacity", async () => {
    const { agents } = await sys(() => agentSnapshots(a.business.id));
    const d = agents.find((x) => x.id === dana.id)!, av = agents.find((x) => x.id === avi.id)!;
    expect(d.today).toMatchObject({ handled: 20, wins: 6 });
    expect(d.baseline).toMatchObject({ handled: 40, wins: 4 });
    const cfg = parseConfig("momentum", {});
    expect(assessMomentum(d, cfg).state).toBe("momentum");
    expect(assessMomentum(av, cfg)).toMatchObject({ state: "insufficient_data" }); // 2/3 = 67% but only 3 leads
    expect(assessMomentum(agents.find((x) => x.id === yossi.id)!, cfg).state).not.toBe("momentum"); // 1/15
    const cap = await sys(() => agentCapacity(a.business.id, d));
    expect(cap.known).toBe(true);
    expect(cap.spare).toBeGreaterThan(0);
  });

  it("unknown shift → no allocation recommendation (information only); overloaded agent → nothing", async () => {
    await reset();
    await setOps({ shifts: { [yossi.id]: allDay, [avi.id]: allDay } }); // Dana's shift unknown
    await sys(() => evaluateMomentum(a.business.id));
    const r = await openRec(dana.id);
    expect(r?.status).toBe("insight");
    expect(r?.explanation).toContain("שעות העבודה");
    await setOps({ shifts: { [dana.id]: allDay, [yossi.id]: allDay, [avi.id]: allDay } });
    await reset();
    // 6 untouched new leads ≥ maxUntouched (5) → overloaded, no recommendation at all.
    const extra = []; for (let i = 0; i < 6; i++) extra.push((await contactLead(dana.id, { status: "new" })).l.id);
    await sys(() => evaluateMomentum(a.business.id));
    expect(await openRec(dana.id)).toBeNull();
    expect(await openRec(avi.id)).toBeNull();
    await db.lead.updateMany({ where: { id: { in: extra } }, data: { status: "lost" } });
  });

  it("FULL FLOW: recommendation → manager approves 5 extra → agent confirms 3 → 3 extra leads on top of round robin → back to regular", async () => {
    await reset();
    await sys(() => evaluateMomentum(a.business.id));
    const rec = await openRec(dana.id);
    expect(rec).toMatchObject({ status: "pending_manager", requestedCount: expect.any(Number) });
    expect(rec!.title).toContain("סגר 6 מתוך 20");
    expect((rec!.evidence as { capacity: { known: boolean } }).capacity.known).toBe(true);
    // Manager approval = ceiling only; nothing assigned yet, regular distribution unaffected.
    const m = await run(owner, () => managerDecision(owner, rec!.id, { action: "approve", edits: { mode: "extra", count: 5 }, via: "app" }));
    expect(m.status).toBe("pending_agent");
    expect(await db.assignmentOverride.count({ where: { businessId: a.business.id } })).toBe(0);
    const before = await incoming();
    expect(before).not.toBeNull();
    // Ambiguous answer → ask again, assign nothing.
    expect(parseAgentAnswer("אוכל לטפל בכמות קטנה יותר")).toMatchObject({ kind: "unclear" });
    expect((await run(dana, () => agentDecision(dana, rec!.id, parseAgentAnswer("אולי"), "app")))).toMatchObject({ status: "unclear" });
    expect(await db.assignmentOverride.count({ where: { businessId: a.business.id } })).toBe(0);
    // Dana: "רק 3" → allocation of 3 extra leads (≤ 5 approved).
    const r = await run(dana, () => agentDecision(dana, rec!.id, parseAgentAnswer("רק 3"), "app"));
    expect(r.status).toBe("active");
    const ov = await db.assignmentOverride.findFirstOrThrow({ where: { businessId: a.business.id, recommendationId: rec!.id } });
    expect(ov).toMatchObject({ mode: "extra", leadLimit: 3, status: "active" });
    expect(await db.opsRecommendation.findUniqueOrThrow({ where: { id: rec!.id } })).toMatchObject({ status: "active", managerApprovedCount: 5, agentApprovedCount: 3 });
    // 6 new leads: Dana gets her regular turns + 3 extra; the others keep theirs.
    const owners: string[] = []; for (let i = 0; i < 6; i++) owners.push((await incoming())!);
    const toDana = owners.filter((x) => x === dana.id).length;
    expect(toDana).toBeGreaterThanOrEqual(4);
    expect(await db.assignmentOverride.findUniqueOrThrow({ where: { id: ov.id } })).toMatchObject({ status: "completed", assigned: 3 });
    expect(await db.auditLog.count({ where: { businessId: a.business.id, action: "ai_ops.lead_allocated" } })).toBe(3);
    await sys(() => runOpsTick(a.business.id));
    expect((await db.opsRecommendation.findUniqueOrThrow({ where: { id: rec!.id } })).status).toBe("completed");
    // Back to the regular round robin: 3 leads → 3 different agents.
    const after: string[] = []; for (let i = 0; i < 3; i++) after.push((await incoming())!);
    expect(new Set(after).size).toBe(3);
  });

  it("double approval executes once (manager twice, agent twice in parallel)", async () => {
    await reset();
    await sys(() => evaluateMomentum(a.business.id));
    const rec = (await openRec(dana.id))!;
    const two = await Promise.allSettled([run(owner, () => managerDecision(owner, rec.id, { action: "approve", edits: { count: 2 }, via: "app" })), run(owner, () => managerDecision(owner, rec.id, { action: "approve", edits: { count: 2 }, via: "whatsapp" }))]);
    expect(two.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    const yes = await Promise.allSettled([run(dana, () => agentDecision(dana, rec.id, { kind: "yes", count: null }, "app")), run(dana, () => agentDecision(dana, rec.id, { kind: "yes", count: null }, "whatsapp"))]);
    expect(yes.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    expect(await db.assignmentOverride.count({ where: { businessId: a.business.id, recommendationId: rec.id } })).toBe(1);
    // An agent cannot answer someone else's request; another business cannot see it.
    await expect(run(yossi, () => agentDecision(yossi, rec.id, { kind: "yes", count: null }, "app"))).rejects.toMatchObject({ status: 404 });
    await expect(run(b.session, () => managerDecision(b.session, rec.id, { action: "reject", via: "app" }))).rejects.toMatchObject({ status: 404 });
    // An expired allocation stops affecting distribution at once; cancel keeps assigned leads.
    await db.assignmentOverride.updateMany({ where: { recommendationId: rec.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const next: string[] = []; for (let i = 0; i < 3; i++) next.push((await incoming())!);
    expect(new Set(next).size).toBe(3);
    expect((await db.assignmentOverride.findFirstOrThrow({ where: { recommendationId: rec.id } })).status).toBe("expired");
  });

  it("capacity changed while waiting → needs adjustment, nothing assigned; no reply → expired, nothing assigned", async () => {
    await reset();
    await sys(() => evaluateMomentum(a.business.id));
    const rec = (await openRec(dana.id))!;
    await run(owner, () => managerDecision(owner, rec.id, { action: "approve", edits: { count: 4 }, via: "app" }));
    // Meanwhile Dana's shift is almost over → spare < 4.
    const almost = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(Date.now() + 2 * 60_000));
    await setOps({ shifts: { [dana.id]: { start: "00:00", end: almost, days: allDay.days }, [yossi.id]: allDay, [avi.id]: allDay } });
    const r = await run(dana, () => agentDecision(dana, rec.id, { kind: "yes", count: null }, "app"));
    expect(r.status).toBe("needs_adjustment");
    expect(await db.assignmentOverride.count({ where: { recommendationId: rec.id } })).toBe(0);
    await setOps({ shifts: { [dana.id]: allDay, [yossi.id]: allDay, [avi.id]: allDay } });
    // No reply: expired by the tick, nothing assigned.
    await reset();
    await sys(() => evaluateMomentum(a.business.id));
    const rec2 = (await openRec(dana.id))!;
    await run(owner, () => managerDecision(owner, rec2.id, { action: "approve", via: "app" }));
    await db.opsRecommendation.update({ where: { id: rec2.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    await sys(() => runOpsTick(a.business.id));
    expect((await db.opsRecommendation.findUniqueOrThrow({ where: { id: rec2.id } })).status).toBe("expired");
    expect(await db.assignmentOverride.count({ where: { recommendationId: rec2.id } })).toBe(0);
  });

  it("WhatsApp: 'כן' with two open recommendations never acts; 'אשר <code>' does; agent 'כן' → allocation", async () => {
    await reset();
    const mk = async (agentId: string, code: string) => db.opsRecommendation.create({ data: { businessId: a.business.id, kind: "momentum", agentId, status: "pending_manager", code, title: `המלצה ${code}`, explanation: "x", evidence: {}, proposal: { mode: "extra", count: 2, sharePct: 60, source: null, listId: null, fromUnassigned: false, until: new Date(Date.now() + 6 * 3600_000).toISOString() }, requestedCount: 2, dedupeKey: `t:${code}`, expiresAt: new Date(Date.now() + 3600_000) } });
    const r1 = await mk(dana.id, "4821"); await mk(yossi.id, "5530");
    const amb = await run(owner, () => opsWhatsAppReply(owner, "כן"));
    expect(amb).toContain("לא מבצע בלי מספר");
    expect((await db.opsRecommendation.findUniqueOrThrow({ where: { id: r1.id } })).status).toBe("pending_manager");
    expect(await run(owner, () => opsWhatsAppReply(owner, "אשר 4821"))).toContain("אושר");
    expect((await db.opsRecommendation.findUniqueOrThrow({ where: { id: r1.id } })).status).toBe("pending_agent");
    // Dana answers on WhatsApp (single open request → tied to it); more than approved is capped.
    expect(await run(dana, () => opsWhatsAppReply(dana, "אפשר גם 7"))).toBe("");
    expect(await db.opsRecommendation.findUniqueOrThrow({ where: { id: r1.id } })).toMatchObject({ status: "active", agentApprovedCount: 2 });
    await run(owner, () => cancelRecommendation(owner, r1.id));
    expect((await db.assignmentOverride.findFirstOrThrow({ where: { recommendationId: r1.id } })).status).toBe("cancelled");
  });

  it("free-text rules → structured, vague words become questions; load cap rule stops assignment to an overloaded agent", async () => {
    const r1 = await interpretRule("אם נציג סוגר היום מעל הממוצע שלו ויש לו פחות מחמישה לידים ממתינים, תציע לי לתת לו יותר לידים חדשים.");
    expect(r1).toMatchObject({ kind: "momentum", autonomy: "recommend" });
    expect(r1.config).toMatchObject({ maxUntouched: 5 });
    expect(r1.questions.some((q) => q.field === "liftFactor")).toBe(true);
    const r2 = await interpretRule("כשלקוחה כותבת שהיא זמינה עכשיו, תקדם אותה לראש התור של הנציג שלה לעשר דקות.");
    expect(r2).toMatchObject({ kind: "availability", config: { ttlMinutes: 10 } });
    const r3 = await interpretRule("אם לנציג יש יותר מ־15 לידים שטרם טופלו, עצור הקצאת לידים חדשים אליו עד שהעומס יורד.");
    expect(r3).toMatchObject({ kind: "load_cap", config: { maxUntouched: 15 }, autonomy: "auto" });
    const r4 = await interpretRule("אל תשנה חלוקת לידים בלי אישור שלי.");
    expect(r4).toMatchObject({ kind: "approval_policy" });
    const r5 = await interpretRule("כשאני מאשר לתת לנציג לידים נוספים, שאל אותו בוואטסאפ אם יספיק לטפל בהם היום. הקצה רק אם אישר, ועד הכמות שאישרתי.");
    expect(r5).toMatchObject({ kind: "extra_leads_policy", config: { askAgent: true } });
    const r6 = await interpretRule("אם נציג חזק היום תן לו הרבה לידים");
    expect(r6.questions.length).toBeGreaterThan(0);
    // Load cap in force: Yossi with 2 untouched leads (cap 2) is skipped by the distribution.
    await reset();
    await db.opsRule.create({ data: { businessId: a.business.id, kind: "load_cap", name: "עומס", config: { maxUntouched: 2 }, autonomy: "auto" } });
    for (let i = 0; i < 2; i++) await contactLead(yossi.id, { status: "new", createdAt: new Date() });
    const got: string[] = []; for (let i = 0; i < 4; i++) got.push((await incoming())!);
    expect(got).not.toContain(yossi.id);
    await db.opsRule.deleteMany({ where: { businessId: a.business.id, kind: "load_cap" } });
  });
});
