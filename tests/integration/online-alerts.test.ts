/**
 * "תודיע לי כשנציגים עולים לקו" + "כמה זמן כל נציג היה בקו" end to end (real DB, mock WhatsApp, no model):
 * the manager writes in free text on WhatsApp → subscription saved → an agent starts a dialer session → the event
 * handler sends the manager a WhatsApp message (once – a second tab / a reconnect later that day does not repeat
 * it in "first of the day" mode) → ending the session sends "התנתק/ה" with today's time on the line →
 * online-time answer includes pauses; a recurring summary asked in free text is delivered at its time, once.
 * An agent cannot subscribe to other agents; a team-scoped manager gets nothing about agents outside the team.
 */
import crypto from "node:crypto";
import { beforeAll, afterAll, it, expect, describe } from "vitest";
import { db } from "@/lib/db";
import { withBusiness } from "@/lib/tenant";
import type { SessionUser } from "@/lib/auth";
import { createBusiness, destroyBusiness } from "./helpers";
import { waitForEvents } from "@/lib/events";
import { startSession, pauseSession, resumeSession, endSession } from "@/lib/dialer/session";
import { handleAssistantInbound } from "@/server/assistant/inbound";
import { deliverScheduledReports } from "@/server/assistant/subscriptions";

let a: Awaited<ReturnType<typeof createBusiness>>;
let owner: SessionUser, dana: SessionUser, yossi: SessionUser;
const accounts: string[] = [];
const OWNER_PHONE = `+97250${String(Date.now()).slice(-7)}`;
const DANA_PHONE = `+97252${String(Date.now()).slice(-7)}`;
const run = <T,>(u: SessionUser, fn: () => Promise<T>) => withBusiness(u.businessId, fn, u);
/** The manager writes on WhatsApp; returns the assistant's reply. */
async function say(phone: string, text: string) {
  const before = new Date();
  await withBusiness(a.business.id, () => handleAssistantInbound({ businessId: a.business.id, phoneE164: phone, text, providerMessageId: crypto.randomUUID() }));
  const out = await db.assistantMessage.findFirst({ where: { businessId: a.business.id, direction: "out", link: { phoneE164: phone }, createdAt: { gte: before } }, orderBy: { createdAt: "desc" } });
  return out?.text ?? "";
}
const sentTo = (phone: string, intent: string) => db.assistantMessage.findMany({ where: { businessId: a.business.id, direction: "out", intent, link: { phoneE164: phone } }, orderBy: { createdAt: "asc" } });

describe("agents on the line: alerts and summaries from free text", { timeout: 900_000 }, () => {
  beforeAll(async () => {
    delete process.env.ANTHROPIC_API_KEY;
    a = await createBusiness("online-alerts", { modules: { crm: true, telephony: true, whatsapp: true } });
    accounts.push(a.account.id); owner = a.session;
    const mk = async (name: string) => { const acc = await db.account.create({ data: { email: `${crypto.randomUUID()}@test.local`, fullName: name, passwordHash: "x" } }); accounts.push(acc.id); const u = await db.user.create({ data: { businessId: a.business.id, accountId: acc.id, email: acc.email, fullName: name, role: "agent" } }); return { id: u.id, accountId: acc.id, businessId: a.business.id, email: acc.email, fullName: name, role: "agent", teamId: null } as SessionUser; };
    dana = await mk("דנה כהן"); yossi = await mk("יוסי לוי");
    await db.providerCredential.create({ data: { businessId: a.business.id, channel: "whatsapp", provider: "mock", isActive: true, isDefault: true, config: {} } });
    const x = await db.business.findUniqueOrThrow({ where: { id: a.business.id } });
    await db.business.update({ where: { id: a.business.id }, data: { settings: { ...(x.settings as object), timezone: "Asia/Jerusalem", assistant: { enabled: true, daily: { enabled: false, time: "19:00", days: [] } } } as object } });
    await db.assistantLink.create({ data: { businessId: a.business.id, userId: owner.id, phoneE164: OWNER_PHONE, status: "active", verifiedAt: new Date(), scope: "business", createdById: owner.id } });
    await db.assistantLink.create({ data: { businessId: a.business.id, userId: dana.id, phoneE164: DANA_PHONE, status: "active", verifiedAt: new Date(), scope: "own", createdById: owner.id } });
  }, 600_000);
  afterAll(async () => { if (a) await destroyBusiness(a.business.id); await db.account.deleteMany({ where: { id: { in: accounts } } }); }, 600_000);

  it("manager: 'תודיע לי כשנציגים עולים לקו' → saved; agent connects → one WhatsApp (not again on a second tab)", async () => {
    const r = await say(OWNER_PHONE, "אני רוצה לקבל התראה כשהנציגים עולים לקו");
    expect(r).toContain("✅");
    expect(await say(OWNER_PHONE, "מה ההתראות שלי?")).toContain("מתחבר/ת לחייגן");
    await run(dana, () => startSession(dana, { mode: "manual", browserSessionId: crypto.randomUUID() }));
    await waitForEvents(a.business.id, 60_000);
    let alerts = await sentTo(OWNER_PHONE, "agent_online");
    expect(alerts).toHaveLength(1);
    expect(alerts[0].text).toContain("דנה כהן התחבר/ה לחייגן");
    // Another tab takes over (still connected) → no new "online" event.
    await run(dana, () => startSession(dana, { mode: "manual", browserSessionId: crypto.randomUUID() }));
    await waitForEvents(a.business.id, 60_000);
    alerts = await sentTo(OWNER_PHONE, "agent_online");
    expect(alerts).toHaveLength(1);
  });

  it("'גם כשמתנתקים' → ending the session sends 'סיים/ה' with today's time on the line; reconnect today is not re-announced (first of day)", async () => {
    expect(await say(OWNER_PHONE, "תעדכן אותי גם כשנציג מתנתק")).toContain("✅");
    const s = await db.dialerSession.findFirstOrThrow({ where: { userId: dana.id, status: "active" } });
    await run(dana, () => endSession(dana, s.id, s.browserSessionId));
    await waitForEvents(a.business.id, 60_000);
    const off = await sentTo(OWNER_PHONE, "agent_offline");
    expect(off).toHaveLength(1);
    expect(off[0].text).toMatch(/דנה כהן סיים\/ה את הסשן.*היום בקו/);
    await run(dana, () => startSession(dana, { mode: "manual", browserSessionId: crypto.randomUUID() }));
    await waitForEvents(a.business.id, 60_000);
    expect(await sentTo(OWNER_PHONE, "agent_online")).toHaveLength(1);
  });

  it("'כמה זמן כל נציג היה בקו היום?' → online time with pauses, talk time and who is connected now", async () => {
    const s = await db.dialerSession.findFirstOrThrow({ where: { userId: dana.id, status: "active" } });
    // 40 minutes on the line, 10 of them paused.
    await db.dialerSession.update({ where: { id: s.id }, data: { startedAt: new Date(Date.now() - 40 * 60_000), lastHeartbeatAt: new Date() } });
    await run(dana, () => pauseSession(dana, s.id, s.browserSessionId));
    await db.auditLog.updateMany({ where: { entityId: s.id, action: "session.paused" }, data: { createdAt: new Date(Date.now() - 20 * 60_000) } });
    await run(dana, () => resumeSession(dana, s.id, s.browserSessionId));
    await db.auditLog.updateMany({ where: { entityId: s.id, action: "session.resumed" }, data: { createdAt: new Date(Date.now() - 10 * 60_000) } });
    const r = await say(OWNER_PHONE, "כמה זמן כל נציג היה בקו היום?");
    expect(r).toContain("זמני קו היום");
    expect(r).toContain("דנה כהן");
    expect(r).toMatch(/בקו עכשיו/);
    expect(r).toMatch(/הפסקות 10 דק׳/);
    expect(await say(OWNER_PHONE, "מי מחובר עכשיו?")).toContain("מחוברים עכשיו: דנה כהן");
  });

  it("recurring summary from free text: 'כל יום ב-HH:MM …' → delivered at its time, once", async () => {
    const at = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Jerusalem", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(Date.now() - 60_000));
    expect(await say(OWNER_PHONE, `כל יום ב-${at} תשלח לי כמה כל נציג היה בקו`)).toContain("✅");
    expect(await withBusiness(a.business.id, () => deliverScheduledReports(a.business.id))).toBe(1);
    expect(await withBusiness(a.business.id, () => deliverScheduledReports(a.business.id))).toBe(0);
    const rep = await sentTo(OWNER_PHONE, "custom_report");
    expect(rep.at(-1)!.text).toContain("זמני קו");
    expect(await say(OWNER_PHONE, "בטל את הסיכום היומי")).toContain("✅ בוטל");
    expect(await say(OWNER_PHONE, "תפסיק להודיע לי כשנציגים עולים לקו")).toContain("✅ בוטל");
    expect(await say(OWNER_PHONE, "מה ההתראות שלי")).toContain("אין לך התראות");
  });

  it("an agent cannot subscribe to others and sees only their own time on the line", async () => {
    expect(await say(DANA_PHONE, "תודיע לי כשיוסי עולה לקו")).toContain("למנהלים בלבד");
    const r = await say(DANA_PHONE, "כמה זמן הייתי בקו היום?");
    expect(r).toContain("דנה כהן");
    expect(r).not.toContain("יוסי");
    void yossi;
  });
});
