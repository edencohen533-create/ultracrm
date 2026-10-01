/**
 * The old "אנליטיקה" tab merged into "ביצועי נציגים" + "שיווק ומכירות ← ביצועי דיוור":
 *  • WhatsApp period metrics (inbound / agent outbound / handled x of y / first response) and "open now" as a state;
 *  • per-agent WhatsApp attribution (first replier, else assignee) whose rows add up to the page's figures;
 *  • agent filter: inbound is null (not attributable), never 0; campaign filter through the contact;
 *  • a channel the business doesn't have → null, not 0; telephony-less business still gets the report;
 *  • delivery table per sender: the same numbers as the old Analytics formula, SMS read = null ("לא זמין");
 *  • permissions and business isolation (agent / team manager / other business).
 */
import crypto from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { withBusiness } from "@/lib/tenant";
import { signSession, type SessionUser } from "@/lib/auth";
import { createBusiness, destroyBusiness } from "./helpers";
import { addDays } from "@/lib/reports/compare";
import { zonedParts } from "@/lib/business-day";
import { getBusinessSettings } from "@/lib/settings";
import { invalidateEntitlements } from "@/lib/modules";

process.env.ENCRYPTION_KEY ||= crypto.randomBytes(32).toString("hex");
const agentsRoute = await import("@/app/api/reports/agents/route");
const comparisonRoute = await import("@/app/api/reports/comparison/route");
const messagingRoute = await import("@/app/api/reports/messaging/route");
const { comparisonReport } = await import("@/server/reports/comparison");
const { messagingPerformance } = await import("@/server/reports/messaging");

type Biz = Awaited<ReturnType<typeof createBusiness>>;
const ctx = () => ({ params: Promise.resolve({}) });
const req = async (who: SessionUser, url: string) => new NextRequest(`http://localhost${url}`, { headers: { cookie: `ultracrm_session=${await signSession(who)}` } });
const metric = (r: { metrics: Array<{ id: string; change: { current: number | null } }> }, id: string) => r.metrics.find((m) => m.id === id)!.change.current;

describe("reports merge: analytics → agent performance / messaging performance", () => {
  let A: Biz, B: Biz, NoWa: Biz;
  let a1: SessionUser, a2: SessionUser, teamMgr: SessionUser;
  let from = "", to = "", listId = "";
  const accounts: string[] = [];
  const mins = (n: number) => new Date(Date.now() - n * 60_000);

  beforeAll(async () => {
    A = await createBusiness("rep-merge", { modules: { crm: true, telephony: true, whatsapp: true, sms: true } });
    B = await createBusiness("rep-merge-b", { modules: { crm: true, telephony: true, whatsapp: true, sms: true } });
    NoWa = await createBusiness("rep-merge-nowa", { modules: { crm: true, telephony: true, whatsapp: false } }); // modules default to on unless false
    const tz = (await getBusinessSettings(A.business.id)).timezone;
    to = zonedParts(tz, new Date()).date; from = addDays(to, -6);
    const mk = async (biz: Biz, name: string, role: "agent" | "manager") => {
      const acc = await db.account.create({ data: { email: `${crypto.randomUUID()}@test.local`, fullName: name, passwordHash: "x" } }); accounts.push(acc.id);
      const u = await db.user.create({ data: { businessId: biz.business.id, accountId: acc.id, email: acc.email, fullName: name, role } });
      return { id: u.id, accountId: acc.id, businessId: biz.business.id, email: acc.email, fullName: name, role, teamId: null } as SessionUser;
    };
    a1 = await mk(A, "נציג א", "agent"); a2 = await mk(A, "נציג ב", "agent"); teamMgr = await mk(A, "מנהל צוות", "manager");
    await db.business.update({ where: { id: A.business.id }, data: { settings: { permissions: { managerScope: "team" } } } });

    const wa = await db.providerCredential.create({ data: { businessId: A.business.id, channel: "whatsapp", provider: "mock", label: "WA ראשי", isActive: true, isDefault: true, config: {} } });
    const sms = await db.providerCredential.create({ data: { businessId: A.business.id, channel: "sms", provider: "mock", label: "SMS", isActive: true, isDefault: true, config: {} } });
    const contact = (biz: Biz, n: number) => db.contact.create({ data: { businessId: biz.business.id, fullName: `לקוח ${n}`, phoneE164: `+97250123${String(n).padStart(4, "0")}`, phoneRaw: "x" } });
    const [c1, c2, c3, c4] = await Promise.all([contact(A, 1), contact(A, 2), contact(A, 3), contact(A, 4)]);
    const list = await db.dialList.create({ data: { businessId: A.business.id, name: "קמפיין QA" } }); listId = list.id;
    await db.listLead.create({ data: { listId: list.id, contactId: c1.id, businessId: A.business.id } as never });
    const conv = (c: { id: string }, extra: Record<string, unknown> = {}) => db.conversation.create({ data: { businessId: A.business.id, contactId: c.id, providerCredentialId: wa.id, channel: "whatsapp", ...extra } });
    const k1 = await conv(c1, { status: "CLOSED" });                     // answered by a1 after 10 min
    const k2 = await conv(c2, { assignedAgentId: a2.id, status: "OPEN" }); // assigned to a2, unanswered → a2's, not handled
    const k3 = await conv(c3, { status: "OPEN" });                       // automatic reply only → nobody's, not handled
    const k4 = await conv(c4, { isSpam: true });                         // spam – excluded everywhere
    const msg = (k: { id: string }, direction: "INBOUND" | "OUTBOUND", at: Date, extra: Record<string, unknown> = {}) => ({ businessId: A.business.id, conversationId: k.id, channel: "whatsapp" as const, direction, type: "TEXT" as const, body: "x", createdAt: at, ...(direction === "OUTBOUND" ? { providerCredentialId: wa.id } : {}), ...extra });
    await db.message.createMany({ data: [
      msg(k1, "INBOUND", mins(120)), msg(k1, "OUTBOUND", mins(110), { sentByUserId: a1.id, status: "READ" }), msg(k1, "OUTBOUND", mins(100), { sentByUserId: a1.id, status: "DELIVERED" }),
      msg(k2, "INBOUND", mins(90)),
      msg(k3, "INBOUND", mins(80)), msg(k3, "OUTBOUND", mins(79), { status: "SENT" }),              // automation (no sender user)
      msg(k4, "INBOUND", mins(70)),
      msg(k3, "OUTBOUND", mins(60), { status: "FAILED" }), msg(k3, "OUTBOUND", mins(59), { status: "UNKNOWN" }),
    ] });
    // An SMS conversation with delivery receipts (no read receipts exist for SMS)
    const ks = await db.conversation.create({ data: { businessId: A.business.id, contactId: c1.id, providerCredentialId: sms.id, channel: "sms" } });
    await db.message.createMany({ data: [
      { businessId: A.business.id, conversationId: ks.id, channel: "sms", direction: "OUTBOUND", type: "TEXT", body: "s", providerCredentialId: sms.id, status: "DELIVERED", createdAt: mins(50) },
      { businessId: A.business.id, conversationId: ks.id, channel: "sms", direction: "OUTBOUND", type: "TEXT", body: "s", providerCredentialId: sms.id, status: "SENT", createdAt: mins(49) },
    ] });
    // Business B: its own WhatsApp traffic must never leak into A
    const wb = await db.providerCredential.create({ data: { businessId: B.business.id, channel: "whatsapp", provider: "mock", isActive: true, isDefault: true, config: {} } });
    const cb = await contact(B, 9);
    const kb = await db.conversation.create({ data: { businessId: B.business.id, contactId: cb.id, providerCredentialId: wb.id, channel: "whatsapp" } });
    await db.message.createMany({ data: [
      { businessId: B.business.id, conversationId: kb.id, channel: "whatsapp", direction: "INBOUND", type: "TEXT", body: "b", createdAt: mins(30) },
      { businessId: B.business.id, conversationId: kb.id, channel: "whatsapp", direction: "OUTBOUND", type: "TEXT", body: "b", providerCredentialId: wb.id, status: "READ", createdAt: mins(29) },
    ] });
  });
  afterAll(async () => {
    await db.listLead.deleteMany({ where: { listId } }).catch(() => undefined);
    for (const biz of [A, B, NoWa]) if (biz) await destroyBusiness(biz.business.id, [biz.account.id]);
    await db.account.deleteMany({ where: { id: { in: accounts } } });
  });

  it("WhatsApp period metrics, handled x of y, first response, open now as a state", async () => {
    const r = await withBusiness(A.business.id, () => comparisonReport(A.session, { from, to, compare: "none" }), A.session);
    expect(r.channels).toEqual({ telephony: true, whatsapp: true });
    expect(metric(r, "waInbound")).toBe(3);            // k1, k2, k3 – spam excluded
    expect(metric(r, "waOutbound")).toBe(2);           // only agent-sent messages
    expect(r.counts.current).toEqual({ waConversations: 3, waHandled: 1 });
    expect(metric(r, "waHandledRate")).toBeCloseTo(1 / 3);
    expect(metric(r, "waFirstResponse")).toBe(10);
    expect(r.state.waOpenNow).toBe(2);                 // k2 + k3 (k1 closed, k4 spam)
    // Daily series sums equal the totals (no join multiplication)
    expect(r.series.current.reduce((t, d) => t + d.waOutbound, 0)).toBe(2);
    expect(r.series.current.reduce((t, d) => t + d.waInbound, 0)).toBe(3);
  });

  it("agent filter: inbound is not attributable (null, not 0); handled follows replier, else assignee", async () => {
    const r1 = await withBusiness(A.business.id, () => comparisonReport(A.session, { from, to, compare: "none", userId: a1.id }), A.session);
    expect(metric(r1, "waInbound")).toBeNull();
    expect(metric(r1, "waOutbound")).toBe(2);
    expect(r1.counts.current).toEqual({ waConversations: 1, waHandled: 1 });
    const r2 = await withBusiness(A.business.id, () => comparisonReport(A.session, { from, to, compare: "none", userId: a2.id }), A.session);
    expect(r2.counts.current).toEqual({ waConversations: 1, waHandled: 0 });
    expect(metric(r2, "waHandledRate")).toBe(0);       // a real 0% (1 conversation, none handled)
    expect(metric(r2, "waFirstResponse")).toBeNull();  // no reply → no time, not 0
    expect(r2.state.waOpenNow).toBe(1);
  });

  it("campaign filter applies to WhatsApp through the contact", async () => {
    const r = await withBusiness(A.business.id, () => comparisonReport(A.session, { from, to, compare: "none", listId }), A.session);
    expect(metric(r, "waInbound")).toBe(1);
    expect(r.counts.current).toEqual({ waConversations: 1, waHandled: 1 });
  });

  it("agent table: WhatsApp per agent adds up to the page figures (explicit row for unattributed)", async () => {
    const res = await agentsRoute.GET(await req(A.session, `/api/reports/agents?from=${from}&to=${to}`), ctx());
    expect(res.status).toBe(200);
    const { data } = await res.json();
    const row = (id: string) => data.rows.find((x: { id: string }) => x.id === id);
    expect(row(a1.id).wa).toMatchObject({ outbound: 2, conversations: 1, handled: 1, firstResponse: 10, openNow: 0 });
    expect(row(a2.id).wa).toMatchObject({ outbound: 0, conversations: 1, handled: 0, firstResponse: null, openNow: 1 });
    const total = (k: "conversations" | "handled" | "outbound") => data.rows.reduce((t: number, x: { wa: Record<string, number> }) => t + x.wa[k], 0);
    expect(total("conversations")).toBe(3); expect(total("handled")).toBe(1); expect(total("outbound")).toBe(2);
    expect(row("__unassigned").wa.conversations).toBe(1); // k3 – no agent replied, not assigned
    expect(data.channels).toEqual({ telephony: true, whatsapp: true });
  });

  it("a channel the business doesn't have is null (not 0); a business without telephony still gets the report", async () => {
    const r = await withBusiness(NoWa.business.id, () => comparisonReport(NoWa.session, { from, to, compare: "none" }), NoWa.session);
    expect(r.channels.whatsapp).toBe(false);
    expect(metric(r, "waInbound")).toBeNull(); expect(metric(r, "waOutbound")).toBeNull(); expect(r.state.waOpenNow).toBeNull();
    const res = await agentsRoute.GET(await req(NoWa.session, `/api/reports/agents?from=${from}&to=${to}`), ctx());
    expect((await res.json()).data.rows.every((x: { wa: unknown }) => x.wa === null)).toBe(true);
    await db.business.update({ where: { id: NoWa.business.id }, data: { modules: { crm: true, whatsapp: true, telephony: false } } });
    invalidateEntitlements(NoWa.business.id);
    const res2 = await comparisonRoute.GET(await req(NoWa.session, `/api/reports/comparison?from=${from}&to=${to}&compare=none`), ctx());
    expect(res2.status).toBe(200);
    const body = (await res2.json()).data;
    expect(body.channels.telephony).toBe(false);
    expect(metric(body, "outbound")).toBeNull();         // no telephony → "לא זמין", not 0
  });

  it("delivery per sender = the old Analytics formula; SMS read is null; other business never included", async () => {
    const r = await withBusiness(A.business.id, () => messagingPerformance(A.session, { from, to }), A.session);
    // Old Analytics: groupBy(providerCredentialId, status) over outbound messages in range
    const old = await db.message.groupBy({ by: ["providerCredentialId", "status"], where: { businessId: A.business.id, direction: "OUTBOUND", createdAt: { gte: new Date(Date.now() - 8 * 86400000) }, providerCredentialId: { not: null } }, _count: { _all: true } });
    for (const row of r.rows) {
      const rows = old.filter((o) => o.providerCredentialId === row.id);
      const c = (s: string[]) => rows.filter((o) => s.includes(o.status)).reduce((t, o) => t + o._count._all, 0);
      expect(row.sent).toBe(c(["ACCEPTED", "SENT", "DELIVERED", "READ"]));
      expect(row.failed).toBe(c(["FAILED", "BOUNCED"]));
      expect(row.unknown).toBe(c(["UNKNOWN"]));
      if (row.channel === "whatsapp") { expect(row.delivered).toBe(c(["DELIVERED", "READ"])); expect(row.read).toBe(c(["READ"])); }
      else { expect(row.read).toBeNull(); expect(row.delivered).toBe(c(["DELIVERED", "READ"])); }
    }
    const waRow = r.rows.find((x) => x.channel === "whatsapp")!;
    expect(waRow).toMatchObject({ sent: 3, delivered: 2, read: 1, failed: 1, unknown: 1 });
    expect(r.rows.find((x) => x.channel === "sms")).toMatchObject({ sent: 2, delivered: 1, read: null });
    expect(r.rows.length).toBe(2); // business B's sender is not here
  });

  it("permissions: agent / team manager can't open the delivery table; a team manager can't open another team's agent", async () => {
    expect((await messagingRoute.GET(await req(a1, `/api/reports/messaging?from=${from}&to=${to}`), ctx())).status).toBe(403);
    expect((await messagingRoute.GET(await req(teamMgr, `/api/reports/messaging?from=${from}&to=${to}`), ctx())).status).toBe(403);
    expect((await messagingRoute.GET(await req(A.session, `/api/reports/messaging?from=${from}&to=${to}`), ctx())).status).toBe(200);
    expect((await agentsRoute.GET(await req(a1, `/api/reports/agents?from=${from}&to=${to}`), ctx())).status).toBe(403);
    expect((await agentsRoute.GET(await req(teamMgr, `/api/reports/agents?from=${from}&to=${to}&userId=${a1.id}`), ctx())).status).toBe(403);
    expect((await comparisonRoute.GET(await req(teamMgr, `/api/reports/comparison?from=${from}&to=${to}&compare=none&userId=${a1.id}`), ctx())).status).toBe(403);
    // A campaign of another business → 404, and B's owner sees only B's traffic
    expect((await agentsRoute.GET(await req(B.session, `/api/reports/agents?from=${from}&to=${to}&listId=${listId}`), ctx())).status).toBe(404);
    const rb = await withBusiness(B.business.id, () => comparisonReport(B.session, { from, to, compare: "none" }), B.session);
    expect(metric(rb, "waInbound")).toBe(1);
  });
});
