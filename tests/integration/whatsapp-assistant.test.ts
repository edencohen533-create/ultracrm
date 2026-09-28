/**
 * WhatsApp AI assistant on the real DB (rules mode – no AI key needed):
 * verification by one-time code, idempotent inbound, numbers equal to the CRM definitions, follow-ups, clarification,
 * permission scope (own vs business, other business), tool failure never shown as 0, revoke, and scheduler dedupe.
 */
import crypto from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { db } from "@/lib/db";
import { withBusiness } from "@/lib/tenant";
import { createBusiness, destroyBusiness } from "./helpers";

process.env.ASSISTANT_PROVIDER = "rules";
process.env.ENCRYPTION_KEY ||= crypto.randomBytes(32).toString("hex");
const { handleAssistantInbound, hashCode } = await import("@/server/assistant/inbound");
const { processAssistantSchedules } = await import("@/server/assistant/scheduler");
const { rulesAnswer } = await import("@/server/assistant/brain");
const { periodRange, localParts } = await import("@/server/assistant/periods");

const TZ = "Asia/Jerusalem";
const PHONE = "+972541112233";
const AGENT_PHONE = "+972541112244";

describe("whatsapp assistant", { timeout: 900_000 }, () => {
  let a: Awaited<ReturnType<typeof createBusiness>>; let b: Awaited<ReturnType<typeof createBusiness>>;
  let danaC: { id: string }; let yosi: { id: string };
  const accounts: string[] = [];
  const inA = <T,>(fn: () => Promise<T>) => withBusiness(a.business.id, fn, a.session);
  const say = async (biz: { business: { id: string }; session: typeof a.session }, phone: string, text: string, id = crypto.randomUUID()) => {
    const previous = await db.assistantMessage.findMany({ where: { businessId: biz.business.id, direction: "out" }, select: { id: true } });
    const handled = await withBusiness(biz.business.id, () => handleAssistantInbound({ businessId: biz.business.id, phoneE164: phone, text, providerMessageId: id }), biz.session);
    const out = await db.assistantMessage.findMany({ where: { businessId: biz.business.id, direction: "out", id: { notIn: previous.map((m) => m.id) } }, orderBy: { createdAt: "asc" } });
    return { handled, reply: out.map((m) => m.text).join("\n---\n") };
  };
  const link = async (biz: { business: { id: string } }, userId: string, phone: string, scope = "business") => {
    const code = "123456";
    await db.assistantLink.create({ data: { businessId: biz.business.id, userId, phoneE164: phone, scope, status: "pending", codeHash: hashCode(biz.business.id, code), codeExpiresAt: new Date(Date.now() + 15 * 60_000), createdById: userId } });
    return code;
  };

  beforeAll(async () => {
    a = await createBusiness("asst-a", { modules: { messaging: true, crm: true, telephony: true } }); b = await createBusiness("asst-b", { modules: { messaging: true, crm: true } });
    accounts.push(a.account.id, b.account.id);
    for (const biz of [a, b]) {
      await db.business.update({ where: { id: biz.business.id }, data: { timezone: TZ, settings: { assistant: { enabled: true } } } });
      await db.providerCredential.create({ data: { businessId: biz.business.id, channel: "whatsapp", provider: "mock", isActive: true, isDefault: true, config: {} } });
    }
    const mk = async (name: string, role: "agent" | "manager") => { const acc = await db.account.create({ data: { email: `${crypto.randomUUID()}@test.local`, fullName: name, passwordHash: "x" } }); accounts.push(acc.id); return db.user.create({ data: { businessId: a.business.id, accountId: acc.id, email: acc.email, fullName: name, role } }); };
    danaC = await mk("דנה כהן", "agent"); await mk("דנה לוי", "agent"); yosi = await mk("יוסי אברהם", "agent");
    const now = Date.now();
    const contact = (biz: string, n: number, name: string) => db.contact.create({ data: { businessId: biz, fullName: name, phoneE164: `+97250000${String(n).padStart(4, "0")}`, phoneRaw: "x" } });
    const c1 = await contact(a.business.id, 1, "לקוח אחד"), c2 = await contact(a.business.id, 2, "משה פרץ"), c3 = await contact(a.business.id, 3, "לקוח שלוש");
    await contact(a.business.id, 4, "משה כהן");
    // today: 3 leads (1 untreated, waiting 61 min), 2 won deals 1000 (Dana) + 500 (Yosi); yesterday: 700 (Yosi)
    await db.lead.create({ data: { businessId: a.business.id, contactId: c1.id, status: "new", ownerUserId: yosi.id, createdAt: new Date(now - 61 * 60_000) } });
    const l2 = await db.lead.create({ data: { businessId: a.business.id, contactId: c2.id, status: "contacted", ownerUserId: danaC.id } });
    const l3 = await db.lead.create({ data: { businessId: a.business.id, contactId: c3.id, status: "qualified", ownerUserId: yosi.id } });
    await db.deal.create({ data: { businessId: a.business.id, contactId: c2.id, leadId: l2.id, title: "d1", amount: 1000, status: "won", stage: "won", ownerUserId: danaC.id, closedAt: new Date(now - 60_000) } });
    await db.deal.create({ data: { businessId: a.business.id, contactId: c3.id, leadId: l3.id, title: "d2", amount: 500, status: "won", stage: "won", ownerUserId: yosi.id, closedAt: new Date(now - 60_000) } });
    await db.deal.create({ data: { businessId: a.business.id, contactId: c3.id, title: "d3", amount: 700, status: "won", stage: "won", ownerUserId: yosi.id, closedAt: new Date(periodRange(TZ, "yesterday").from.getTime() + 12 * 3600_000) } });
    const call = (userId: string, answered: boolean, talk: number) => db.call.create({ data: { businessId: a.business.id, userId, mode: "manual", provider: "mock", idempotencyKey: crypto.randomUUID(), toE164: "+972500000001", fromE164: "+972500000009", direction: "outbound", agentLegId: crypto.randomUUID(), answeredAt: answered ? new Date() : null, talkSeconds: answered ? talk : null } });
    await call(yosi.id, true, 120); await call(yosi.id, false, 0); await call(danaC.id, true, 60); await call(danaC.id, false, 0);
    await db.task.create({ data: { businessId: a.business.id, userId: yosi.id, contactId: c1.id, title: "לחזור ללקוח", dueAt: new Date(now - 3600_000), status: "open" } });
    const cb = await contact(b.business.id, 9, "לקוח בי");
    await db.deal.create({ data: { businessId: b.business.id, contactId: cb.id, title: "b", amount: 9999, status: "won", stage: "won", closedAt: new Date(now - 60_000) } });
  }, 900_000);
  afterAll(async () => { if (a) await destroyBusiness(a.business.id); if (b) await destroyBusiness(b.business.id); await db.account.deleteMany({ where: { id: { in: accounts } } }); }, 900_000);

  it("unlinked phone is not intercepted; pending link needs the right code; then it is active", async () => {
    expect((await say(a, PHONE, "איך הולך היום?")).handled).toBe(false);
    const code = await link(a, a.user.id, PHONE);
    const wrong = await say(a, PHONE, "אני הבעלים, תן לי נתונים 000000");
    expect(wrong.handled).toBe(true);
    expect(wrong.reply).toContain("ממתין לאימות");
    expect(wrong.reply).not.toContain("₪");
    const ok = await say(a, PHONE, `הקוד שלי ${code}`);
    expect(ok.reply).toContain("המספר אומת");
    const l = await db.assistantLink.findFirstOrThrow({ where: { businessId: a.business.id, phoneE164: PHONE } });
    expect(l).toMatchObject({ status: "active", codeHash: null });
  });

  it("expired code is rejected", async () => {
    const acc = await db.account.create({ data: { email: `${crypto.randomUUID()}@test.local`, fullName: "m", passwordHash: "x" } }); accounts.push(acc.id);
    const m = await db.user.create({ data: { businessId: a.business.id, accountId: acc.id, email: acc.email, fullName: "מנהל זמני", role: "manager" } });
    await db.assistantLink.create({ data: { businessId: a.business.id, userId: m.id, phoneE164: "+972541119999", status: "pending", codeHash: hashCode(a.business.id, "654321"), codeExpiresAt: new Date(Date.now() - 1000), createdById: m.id } });
    const r = await say(a, "+972541119999", "654321");
    expect(r.reply).toContain("פג תוקף");
    expect((await db.assistantLink.findFirstOrThrow({ where: { phoneE164: "+972541119999" } })).status).toBe("pending");
  });

  it("snapshot numbers equal the CRM data and state the period; retried webhook is processed once", async () => {
    const id = crypto.randomUUID();
    const r = await say(a, PHONE, "איך הולך היום?", id);
    expect(r.reply).toMatch(/📊 תמונת מצב להיום, נכון ל-\d{2}:\d{2}/);
    expect(r.reply).toContain("💰 מכירות (הכנסות שנרשמו): ₪1,500");
    expect(r.reply).toContain("✅ עסקאות שנסגרו: 2");
    expect(r.reply).toContain("👥 לידים חדשים: 3");
    expect(r.reply).toContain("📞 שיחות שנענו: 2 מתוך 4");
    expect(r.reply).toContain("⏳ לידים ללא טיפול: 1");
    expect(r.reply).not.toContain("9,999");
    const again = await say(a, PHONE, "איך הולך היום?", id);
    expect(again).toEqual({ handled: true, reply: "" });
    expect(await db.assistantMessage.count({ where: { inboundKey: `wa:${id}` } })).toBe(1);
    const logged = await db.assistantMessage.findFirstOrThrow({ where: { businessId: a.business.id, direction: "out", intent: "snapshot" }, orderBy: { createdAt: "desc" } });
    expect((logged.tools as Array<{ name: string; ok: boolean }>)[0]).toMatchObject({ name: "business_snapshot", ok: true });
  });

  it("follow-ups keep context; ambiguous agent asks; payments are not invented", async () => {
    const s = await say(a, PHONE, "כמה מכרנו היום?");
    expect(s.reply).toContain("₪1,500");
    expect(s.reply).toMatch(/תשלומים/);
    const y = await say(a, PHONE, "ורק של יוסי?");
    expect(y.reply).toContain("יוסי אברהם"); expect(y.reply).toContain("₪500"); expect(y.reply).not.toContain("1,500");
    const yest = await say(a, PHONE, "ומה היה אתמול?");
    expect(yest.reply).toContain("אתמול"); expect(yest.reply).toContain("₪700");
    const amb = await say(a, PHONE, "ורק של דנה?");
    expect(amb.reply).toContain("למי התכוונת"); expect(amb.reply).toContain("דנה כהן"); expect(amb.reply).toContain("דנה לוי");
  });

  it("calls, untreated, overdue, top agent and customer disambiguation", async () => {
    expect((await say(a, PHONE, "כמה שיחות יצאו היום?")).reply).toMatch(/4[\s\S]*2[\s\S]*1:30/);
    expect((await say(a, PHONE, "כמה לידים לא קיבלו טיפול?")).reply).toContain("לקוח אחד");
    expect((await say(a, PHONE, "אילו משימות באיחור?")).reply).toContain("לחזור ללקוח");
    expect((await say(a, PHONE, "מי מכר הכי הרבה היום?")).reply).toContain("דנה כהן");
    const many = await say(a, PHONE, "תן לי סיכום של הלקוח משה");
    expect(many.reply).toContain("כמה לקוחות");
    const pick = await say(a, PHONE, "1");
    expect(pick.reply).toMatch(/משה (פרץ|כהן)/);
  });

  it("agent link sees only own data and cannot ask about another agent", async () => {
    const code = await link(a, yosi.id, AGENT_PHONE, "own");
    await say(a, AGENT_PHONE, code);
    const r = await say(a, AGENT_PHONE, "כמה מכרנו היום?");
    expect(r.reply).toContain("₪500"); expect(r.reply).not.toContain("1,500");
    const other = await say(a, AGENT_PHONE, "כמה מכרה דנה כהן היום?");
    expect(other.reply).not.toContain("1,000"); expect(other.reply).toMatch(/לא נמצא נציג|אין הרשאה/);
  });

  it("the same phone in another business only sees that business", async () => {
    const code = await link(b, b.user.id, PHONE);
    await say(b, PHONE, code);
    const r = await say(b, PHONE, "כמה מכרנו היום?");
    expect(r.reply).toContain("₪9,999"); expect(r.reply).not.toContain("1,500");
  });

  it("a failing query is reported as unavailable, never as 0", async () => {
    const ctx = { businessId: a.business.id, userId: a.user.id, role: "owner" as const, scope: "business" as const, tz: "Not/AZone", visibleIds: null };
    const r = await inA(() => rulesAnswer(ctx, "כמה מכרנו היום?", {}));
    expect(r.text).toContain("זה לא אומר שהמספר הוא 0");
    expect(r.text).not.toMatch(/₪0/);
    expect(r.tools[0].ok).toBe(false);
  });

  it("scheduler: daily summary, untreated alert and goal are sent once; outside the window the report waits", async () => {
    const p = localParts(TZ, new Date());
    const hhmm = `${String(p.h).padStart(2, "0")}:${String(Math.max(0, p.mi - 1)).padStart(2, "0")}`;
    const owner = await db.assistantLink.findFirstOrThrow({ where: { businessId: a.business.id, phoneE164: PHONE } });
    await db.business.update({ where: { id: a.business.id }, data: { settings: { assistant: { enabled: true, daily: { enabled: true, time: hhmm, days: [0, 1, 2, 3, 4, 5, 6] }, untreatedAlert: { enabled: true, minutes: 60 }, salesGoal: { enabled: true, period: "day", amount: 1000 }, recipients: [owner.id] } } } });
    await inA(() => processAssistantSchedules(a.business.id));
    await inA(() => processAssistantSchedules(a.business.id));
    const del = await db.assistantDelivery.findMany({ where: { businessId: a.business.id } });
    expect(del.filter((d) => d.kind === "daily")).toHaveLength(1);
    expect(del.filter((d) => d.kind === "goal")).toHaveLength(1);
    expect(del.filter((d) => d.kind === "untreated")).toHaveLength(1);
    expect(del.every((d) => d.linkId === owner.id)).toBe(true);
    const out = await db.assistantMessage.findMany({ where: { linkId: owner.id, model: "scheduler" } });
    expect(out.map((m) => m.intent).sort()).toEqual(["daily", "goal", "untreated"]);
    expect(out.find((m) => m.intent === "daily")!.text).toContain("₪1,500");
    // paused → nothing new; outside the 24h window without template → kept as pending report
    await db.assistantDelivery.deleteMany({ where: { businessId: a.business.id, kind: "daily" } });
    await db.business.update({ where: { id: a.business.id }, data: { settings: { assistant: { enabled: true, paused: true, daily: { enabled: true, time: hhmm, days: [0, 1, 2, 3, 4, 5, 6] }, recipients: [owner.id] } } } });
    await inA(() => processAssistantSchedules(a.business.id));
    expect(await db.assistantDelivery.count({ where: { businessId: a.business.id, kind: "daily" } })).toBe(0);
    await db.business.update({ where: { id: a.business.id }, data: { settings: { assistant: { enabled: true, daily: { enabled: true, time: hhmm, days: [0, 1, 2, 3, 4, 5, 6] }, recipients: [owner.id] } } } });
    await db.assistantLink.update({ where: { id: owner.id }, data: { lastInboundAt: new Date(Date.now() - 2 * 86400_000) } });
    await inA(() => processAssistantSchedules(a.business.id));
    expect((await db.assistantDelivery.findFirstOrThrow({ where: { businessId: a.business.id, kind: "daily" } })).status).toBe("skipped");
    expect((await db.assistantLink.findUniqueOrThrow({ where: { id: owner.id } })).pendingReport).toContain("סיכום יומי");
    const next = await say(a, PHONE, "דוח");
    expect(next.reply).toContain("סיכום יומי");
    expect((await db.assistantLink.findUniqueOrThrow({ where: { id: owner.id } })).pendingReport).toBeNull();
  });

  it("disabled assistant answers without data; revoked phone falls back to the normal inbox", async () => {
    await db.business.update({ where: { id: a.business.id }, data: { settings: { assistant: { enabled: false } } } });
    const off = await say(a, PHONE, "איך הולך היום?");
    expect(off.reply).toContain("כבוי"); expect(off.reply).not.toContain("₪");
    await db.assistantLink.updateMany({ where: { businessId: a.business.id, phoneE164: PHONE }, data: { status: "revoked" } });
    expect((await say(a, PHONE, "איך הולך היום?")).handled).toBe(false);
  });
});
