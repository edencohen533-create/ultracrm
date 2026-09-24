/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * API + DB QA matrix. Runs against a local dev server in SIMULATION mode.
 * Usage: npx tsx scripts/qa-api.ts  (server on http://localhost:3000, qa-seed applied)
 * Writes results to qa-results-api.json.
 */
import "dotenv/config";
import crypto from "node:crypto";
import fs from "node:fs";
import { PrismaClient } from "../src/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

if (process.env.QA_LOCAL !== "1" || new URL(process.env.DATABASE_URL!).hostname !== "127.0.0.1" || process.env.TELEPHONY_PROVIDER !== "mock") throw new Error("Run via scripts/qa-local.cjs: local mock database required");

const BASE = process.env.QA_BASE ?? "http://localhost:3000";
const url = new URL(process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL!);
const schema = url.searchParams.get("schema") ?? "public";
url.searchParams.delete("schema");
const db = new PrismaClient({ adapter: new PrismaPg({ connectionString: url.toString() }, { schema }) });

// ── tiny framework ─────────────────────────────────────────────────────
type Status = "עבר" | "נכשל" | "חסר במימוש" | "חסום לבדיקה";
interface Row { id: string; area: string; scenario: string; expected: string; actual: string; status: Status; evidence: string; mode: "mock" | "n/a" }
const rows: Row[] = [];
const ONLY = (process.env.QA_ONLY ?? "").split(",").map((x) => x.trim()).filter(Boolean);
// QA_ONLY entries are exact ids (e.g. "W10") or whole letter-groups (e.g. "W").
const skip = (id: string) => ONLY.length > 0 && !ONLY.some((p) => p === id || (/^[A-Z]+$/.test(p) && id.replace(/\d+$/, "") === p));
async function t(id: string, area: string, scenario: string, expected: string, fn: () => Promise<{ pass: boolean; actual: string; evidence?: string }>, mode: Row["mode"] = "mock") {
  if (skip(id)) return;
  try {
    const r = await fn();
    rows.push({ id, area, scenario, expected, actual: r.actual, status: r.pass ? "עבר" : "נכשל", evidence: r.evidence ?? "", mode });
    console.log(`${r.pass ? "PASS" : "FAIL"} ${id} ${scenario} :: ${r.actual}`);
  } catch (e) {
    rows.push({ id, area, scenario, expected, actual: `חריגה: ${(e as Error).message}`, status: "נכשל", evidence: "", mode });
    console.log(`FAIL ${id} ${scenario} :: exception ${(e as Error).message}`);
  }
}
function blocked(id: string, area: string, scenario: string, expected: string, why: string) {
  if (skip(id)) return;
  rows.push({ id, area, scenario, expected, actual: why, status: "חסום לבדיקה", evidence: "", mode: "n/a" });
  console.log(`BLOCKED ${id} ${scenario} :: ${why}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── http client with cookie jar ────────────────────────────────────────
class Client {
  cookie = "";
  constructor(public name: string) {}
  async req(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const res = await fetch(BASE + path, { method, headers: { "Content-Type": "application/json", cookie: this.cookie, ...headers }, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) });
    const sc = res.headers.get("set-cookie");
    if (sc) this.cookie = sc.split(";")[0];
    let json: any = null;
    const text = await res.text();
    try { json = JSON.parse(text); } catch { json = { raw: text }; }
    return { status: res.status, json, data: json?.data, error: json?.error, code: json?.code };
  }
  get = (p: string) => this.req("GET", p);
  post = (p: string, b?: unknown) => this.req("POST", p, b ?? {});
  patch = (p: string, b?: unknown) => this.req("PATCH", p, b ?? {});
  put = (p: string, b?: unknown) => this.req("PUT", p, b ?? {});
  del = (p: string, b?: unknown) => this.req("DELETE", p, b ?? {});
  async login(email: string, password: string) {
    const r = await this.post("/api/auth/login", { email, password });
    if (r.status !== 200) throw new Error(`login failed ${email}: ${r.status} ${r.error}`);
    await this.post("/api/telephony/token");
    return r.data;
  }
}

/** Poll a call until it ends (simulation advances on poll). */
async function waitEnd(c: Client, callId: string, maxMs = 45000) {
  const t0 = Date.now();
  let last: any = null;
  while (Date.now() - t0 < maxMs) {
    const r = await c.get(`/api/dialer/call/${callId}`);
    last = r.data;
    if (last?.endedAt) return last;
    await sleep(700);
  }
  return last;
}
async function waitStatus(c: Client, callId: string, statuses: string[], maxMs = 40000) {
  const t0 = Date.now();
  let last: any = null;
  while (Date.now() - t0 < maxMs) {
    const r = await c.get(`/api/dialer/call/${callId}`);
    last = r.data;
    if (statuses.includes(last?.status) || last?.endedAt) return last;
    await sleep(500);
  }
  return last;
}
const key = () => crypto.randomUUID();
/** Bring an agent to a clean state: hang up, save outcome, end session, release lead. */
async function cleanupAgent(c: Client) {
  for (let i = 0; i < 30; i++) {
    const st = (await c.get("/api/dialer/state")).data;
    if (!st) return;
    if (st.activeCall) { await c.post(`/api/dialer/call/${st.activeCall.id}/hangup`); await sleep(1000); continue; }
    if (st.wrapUpCall) { await c.post(`/api/dialer/call/${st.wrapUpCall.id}/outcome`, { outcome: st.wrapUpCall.answeredAt ? "answered_not_interested" : "no_answer" }); continue; }
    if (st.session) { await c.del("/api/dialer/session", { sessionId: st.session.id, browserSessionId: st.session.browserSessionId }); continue; }
    return;
  }
}
/** Bring a manual test call to a clean end: hang up if answered, wait for the provider end, save an outcome. */
async function endCall(c: Client, callId: string | undefined, outcome = "answered_not_interested") {
  if (!callId) return null;
  const st = await waitStatus(c, callId, ["answered", "ended", "failed"], 40000);
  if (st && !st.endedAt) await c.post(`/api/dialer/call/${callId}/hangup`);
  const e = await waitEnd(c, callId);
  await c.post(`/api/dialer/call/${callId}/outcome`, { outcome: e?.answeredAt ? outcome : "no_answer" });
  return e;
}

async function main() {
  const ids = JSON.parse(fs.readFileSync(process.env.QA_IDS ?? ".qa-local/ids.json", "utf8"));
  const A1 = new Client("agent1"); const A2 = new Client("agent2"); const MA = new Client("managerA"); const ADA = new Client("adminA");
  const B3 = new Client("agent3"); const B4 = new Client("agent4"); const MB = new Client("managerB"); const ADB = new Client("adminB"); const LB = new Client("lonelyB");
  const a1 = await A1.login("agent1@demo.local", "agent123"); await A2.login("agent2@demo.local", "agent123"); await MA.login("manager@demo.local", "manager123"); await ADA.login("admin@demo.local", "admin123");
  const a3 = await B3.login("agent3@qa-b.local", "agent123"); const a4 = await B4.login("agent4@qa-b.local", "agent123"); await MB.login("manager@qa-b.local", "manager123"); await ADB.login("admin@qa-b.local", "admin123"); await LB.login("lonely@qa-b.local", "manager123");
  const bizA = a1.businessId as string; const bizB = a3.businessId as string;
  // Test suite throughput must not accidentally exercise rate limiting outside N5.
  for (const id of [bizA, bizB]) { const b = await db.business.findUniqueOrThrow({ where: { id } }); await db.business.update({ where: { id }, data: { settings: { ...(b.settings as any), maxDialsPerMinute: 0, dialWindow: { start: "00:00", end: "23:59", days: [0,1,2,3,4,5,6], timezone: "Asia/Jerusalem" } } } }); }
  const T = { sess3: "tab-3-" + key(), sess4: "tab-4-" + key(), sess1: "tab-1-" + key() };

  await Promise.all([cleanupAgent(B3), cleanupAgent(B4), cleanupAgent(A1)]);
  // ═══ §3 Manual dial ═══════════════════════════════════════════════════
  await t("M1", "חיוג ידני", "הקלדה בפורמט מקומי עם רווח ומקף", "נרמול ל-+972501234567, המקור נשמר להצגה", async () => {
    const r = await B3.post("/api/dialer/call", { idempotencyKey: key(), mode: "manual", phone: "050-123 4567" });
    const c = r.data?.contactId ? await db.contact.findUnique({ where: { id: r.data.contactId } }) : null;
    await endCall(B3, r.data?.id);
    return { pass: r.status === 200 && r.data.toE164 === "+972501234567" && c?.phoneRaw === "050-123 4567", actual: `status ${r.status}, toE164=${r.data?.toE164}, phoneRaw=${c?.phoneRaw}`, evidence: `call ${r.data?.id}` };
  });
  await t("M2", "חיוג ידני", "פורמט בינלאומי של מספר קיים", "אותו איש קשר (ללא כפילות)", async () => {
    const before = await db.contact.count({ where: { businessId: bizB, phoneE164: "+972521000003" } });
    const r = await B3.post("/api/dialer/call", { idempotencyKey: key(), mode: "manual", phone: "+972 52-100-0003" });
    await endCall(B3, r.data?.id);
    const after = await db.contact.count({ where: { businessId: bizB, phoneE164: "+972521000003" } });
    return { pass: r.status === 200 && before === 1 && after === 1 && r.data.contact?.fullName === "לקוח ב׳ 1", actual: `contacts before=${before} after=${after}, name=${r.data?.contact?.fullName}` };
  });
  await t("M3", "חיוג ידני", "מספר עם סוגריים", "נרמול תקין", async () => {
    const r = await B3.post("/api/dialer/call", { idempotencyKey: key(), mode: "manual", phone: "(052) 100-0004" });
    await endCall(B3, r.data?.id);
    return { pass: r.status === 200 && r.data.toE164 === "+972521000004", actual: `${r.status} ${r.data?.toE164 ?? r.error}` };
  });
  await t("M4", "חיוג ידני", "מספר ריק / קצר / לא תקין", "400 עם הודעה ברורה, לא נוצרת שיחה", async () => {
    const before = await db.call.count({ where: { userId: a3.id } });
    const rs = await Promise.all(["", "123", "abc", "05012"].map((p) => B3.post("/api/dialer/call", { idempotencyKey: key(), mode: "manual", phone: p })));
    const after = await db.call.count({ where: { userId: a3.id } });
    return { pass: rs.every((r) => r.status === 400) && before === after, actual: rs.map((r) => `${r.status}:${r.code}`).join(" "), evidence: `calls ${before}→${after}` };
  });
  await t("M5", "חיוג ידני", "מספר בינלאומי (ארה״ב) עם מדיניות ברירת מחדל IL בלבד", "מנורמל ל-E.164 אך נדחה 403 country_not_allowed (ראה N4 להתרה)", async () => {
    const r = await B3.post("/api/dialer/call", { idempotencyKey: key(), mode: "manual", phone: "+1 202 555 0199" });
    return { pass: r.status === 403 && r.code === "country_not_allowed" && r.json?.details?.country === "US", actual: `${r.status} ${r.code} (${r.json?.details?.country})` };
  });
  await t("M6", "חיוג ידני", "לחיצה כפולה מהירה (שתי בקשות במקביל, מפתחות שונים)", "נוצרת שיחה אחת בלבד", async () => {
    const before = await db.call.count({ where: { userId: a3.id } });
    const [r1, r2] = await Promise.all([B3.post("/api/dialer/call", { idempotencyKey: key(), mode: "manual", phone: "0521000005" }), B3.post("/api/dialer/call", { idempotencyKey: key(), mode: "manual", phone: "0521000005" })]);
    const after = await db.call.count({ where: { userId: a3.id } });
    const ok = [r1, r2].filter((r) => r.status === 200).length;
    const id = (r1.data ?? r2.data)?.id;
    await endCall(B3, id);
    return { pass: ok === 1 && after - before === 1, actual: `הצלחות=${ok} (${r1.status}/${r2.status}), שיחות חדשות=${after - before}` };
  });
  await t("M7", "חיוג ידני", "אותו מפתח idempotency פעמיים", "אותו מזהה שיחה", async () => {
    const k = key();
    const r1 = await B3.post("/api/dialer/call", { idempotencyKey: k, mode: "manual", phone: "0521000005" });
    const r2 = await B3.post("/api/dialer/call", { idempotencyKey: k, mode: "manual", phone: "0521000005" });
    await endCall(B3, r1.data?.id);
    return { pass: r1.data?.id && r1.data.id === r2.data?.id, actual: `${r1.data?.id} / ${r2.data?.id}` };
  });
  await t("M8", "חיוג ידני", "חיוג בזמן שיחה פעילה", "409 call_active", async () => {
    const r1 = await B3.post("/api/dialer/call", { idempotencyKey: key(), mode: "manual", phone: "0521000003" });
    const r2 = await B3.post("/api/dialer/call", { idempotencyKey: key(), mode: "manual", phone: "0521000004" });
    await endCall(B3, r1.data.id);
    return { pass: r2.status === 409 && r2.code === "call_active", actual: `${r2.status} ${r2.code}` };
  });
  await t("M9", "חיוג ידני", "חיוג מכרטיס לקוח (contactId)", "שיחה עם contactId נכון ומספר יוצא של העסק", async () => {
    const c = await db.contact.findFirst({ where: { businessId: bizB, phoneE164: "+972521000005" } });
    const r = await B3.post("/api/dialer/call", { idempotencyKey: key(), mode: "manual", contactId: c!.id });
    await endCall(B3, r.data?.id);
    return { pass: r.status === 200 && r.data.contactId === c!.id && r.data.fromE164 === "+97239876543", actual: `contact ok=${r.data?.contactId === c!.id}, from=${r.data?.fromE164}` };
  });
  await t("M10", "חיוג ידני", "מספר יוצא של עסק אחר", "400 – לא מורשה", async () => {
    const other = await db.phoneNumber.findFirst({ where: { businessId: bizA } });
    const r = await B3.post("/api/dialer/call", { idempotencyKey: key(), mode: "manual", phone: "0521000005", phoneNumberId: other!.id });
    return { pass: r.status === 400 && r.code === "invalid_from_number", actual: `${r.status} ${r.code}` };
  });
  await t("M11", "חיוג ידני", "שיחות אחרונות / חיוג חוזר", "המספר מופיע ב-recent", async () => {
    const r = await B3.get("/api/dialer/recent");
    return { pass: r.status === 200 && r.data.some((x: any) => x.toE164 === "+972521000005"), actual: `${r.data?.length} רשומות, כולל 0521000005=${r.data?.some((x: any) => x.toE164 === "+972521000005")}` };
  });
  await t("M12", "חיוג ידני", "מספר חסום (DNC) – ידני, מכרטיס ומליד", "403 dnc_blocked בכל המסלולים", async () => {
    await MB.post("/api/contacts", { fullName: "US contact", phone: "+14155552671" }).catch(() => undefined);
    await B3.post("/api/dnc", { phone: "+14155552671", reason: "qa" });
    const c = await db.contact.findFirst({ where: { businessId: bizB, phoneE164: "+14155552671" } });
    const r1 = await B3.post("/api/dialer/call", { idempotencyKey: key(), mode: "manual", phone: "+14155552671" });
    const r2 = await B3.post("/api/dialer/call", { idempotencyKey: key(), mode: "manual", contactId: c!.id });
    return { pass: r1.code === "dnc_blocked" && r2.code === "dnc_blocked", actual: `${r1.status}/${r1.code}, ${r2.status}/${r2.code}` };
  });
  await t("M13", "חיוג ידני", "כפילות מספר בין כרטיסים", "יצירת איש קשר עם מספר קיים → 409", async () => {
    const r = await B3.post("/api/contacts", { fullName: "כפול", phone: "052-100-0003" });
    return { pass: r.status === 409 && r.code === "duplicate_phone", actual: `${r.status} ${r.code}` };
  });
  await t("M14", "חיוג ידני", "עסק ללא מספר יוצא", "400 no_from_number", async () => {
    const n = await db.phoneNumber.findFirst({ where: { businessId: bizB } });
    await db.phoneNumber.update({ where: { id: n!.id }, data: { isActive: false } });
    const r = await B3.post("/api/dialer/call", { idempotencyKey: key(), mode: "manual", phone: "0521000005" });
    await db.phoneNumber.update({ where: { id: n!.id }, data: { isActive: true } });
    return { pass: r.status === 400 && r.code === "no_from_number", actual: `${r.status} ${r.code}` };
  });
  blocked("M15", "חיוג ידני", "חיוג כשהספק מנותק / מיקרופון חסום", "כפתור חיוג מנוטרל והודעה ברורה", "נבדק ב-UI (ראה U-סדרה); ניתוק ספק אמיתי דורש חשבון Telnyx");

  await Promise.all([cleanupAgent(B3), cleanupAgent(B4)]);
  // ═══ §4 Preview ═══════════════════════════════════════════════════════
  let s3: any;
  await t("P1", "Preview", "התחלת סשן Preview ומשיכת ליד", "ליד עם פרטי קשר, lockToken ותפוגת נעילה", async () => {
    const s = await B3.post("/api/dialer/session", { mode: "preview", listId: ids.listId, browserSessionId: T.sess3 });
    s3 = s.data;
    const r = await B3.post("/api/dialer/next-lead", { sessionId: s3.id, browserSessionId: T.sess3 });
    const calls = await db.call.count({ where: { leadId: r.data?.id } });
    return { pass: s.status === 200 && r.data?.lockToken && r.data.contact?.phoneE164 && r.data.status === "locked" && calls === 0, actual: `lead=${r.data?.contact?.fullName}, status=${r.data?.status}, calls=${calls} (אין חיוג אוטומטי)` };
  });
  await t("P2", "Preview", "דילוג עם סיבה", "הסיבה נשמרת, הליד חוזר לתור עם nextAttemptAt עתידי, attempts לא עולה", async () => {
    const st = await B3.get(`/api/dialer/state?browserSessionId=${T.sess3}`);
    const lead = st.data.lead;
    const r = await B3.post("/api/dialer/skip", { leadId: lead.id, lockToken: lead.lockToken, reason: "לא זמן מתאים" });
    const l = await db.listLead.findUnique({ where: { id: lead.id } });
    return { pass: r.status === 200 && l?.lastSkipReason === "לא זמן מתאים" && l.status === "pending" && (l.nextAttemptAt?.getTime() ?? 0) > Date.now() && l.attempts === 0 && !l.lockedByUserId, actual: `reason=${l?.lastSkipReason}, status=${l?.status}, attempts=${l?.attempts}, next=${l?.nextAttemptAt?.toISOString()}` };
  });
  await t("P3", "Preview", "עדכון פרטי ליד לפני חיוג", "PATCH נשמר ומופיע בכרטיס", async () => {
    const r0 = await B3.post("/api/dialer/next-lead", { sessionId: s3.id, browserSessionId: T.sess3 });
    const lead = r0.data;
    const r = await B3.patch(`/api/contacts/${lead.contactId}`, { company: "חברת QA", email: "qa@example.com" });
    const c = await B3.get(`/api/contacts/${lead.contactId}`);
    return { pass: r.status === 200 && c.data.company === "חברת QA" && c.data.email === "qa@example.com", actual: `${r.status} company=${c.data?.company}` };
  });
  await t("P4", "Preview", "ליד נחסם (DNC) בזמן ההמתנה", "חיוג נדחה 403 dnc_blocked והליד מסומן dnc", async () => {
    const st = await B3.get(`/api/dialer/state?browserSessionId=${T.sess3}`);
    const lead = st.data.lead;
    await MB.post("/api/dnc", { phone: lead.contact.phoneE164, reason: "qa P4" });
    const r = await B3.post("/api/dialer/call", { idempotencyKey: key(), mode: "preview", sessionId: s3.id, browserSessionId: T.sess3, leadId: lead.id, lockToken: lead.lockToken });
    const l = await db.listLead.findUnique({ where: { id: lead.id } });
    await MB.del("/api/dnc", { phone: lead.contact.phoneE164 });
    return { pass: r.code === "dnc_blocked" && l?.status === "dnc", actual: `${r.status} ${r.code}, lead.status=${l?.status}` };
  });
  await t("P5", "Preview", "ליד הוסר ע״י מנהל בזמן ההמתנה", "חיוג נדחה (lock_lost)", async () => {
    const r0 = await B3.post("/api/dialer/next-lead", { sessionId: s3.id, browserSessionId: T.sess3 });
    const lead = r0.data;
    await MB.patch(`/api/lists/${ids.listId}/leads`, { leadIds: [lead.id], action: "remove" });
    const r = await B3.post("/api/dialer/call", { idempotencyKey: key(), mode: "preview", sessionId: s3.id, browserSessionId: T.sess3, leadId: lead.id, lockToken: lead.lockToken });
    await MB.patch(`/api/lists/${ids.listId}/leads`, { leadIds: [lead.id], action: "requeue" });
    return { pass: r.status === 409 && r.code === "lock_lost", actual: `${r.status} ${r.code}` };
  });
  await t("P6", "Preview", "נעילה פגה וליד נלקח ע״י נציג אחר", "נציג ב׳ מקבל את הליד; לנציג א׳ lock_lost", async () => {
    const r0 = await B3.post("/api/dialer/next-lead", { sessionId: s3.id, browserSessionId: T.sess3 });
    const lead = r0.data;
    await db.listLead.update({ where: { id: lead.id }, data: { lockExpiresAt: new Date(Date.now() - 1000) } });
    const s4 = await B4.post("/api/dialer/session", { mode: "preview", listId: ids.listId, browserSessionId: T.sess4 });
    // agent4 pulls until it gets this lead or the queue empties
    let got: any = null;
    for (let i = 0; i < 6; i++) {
      const r = await B4.post("/api/dialer/next-lead", { sessionId: s4.data.id, browserSessionId: T.sess4 });
      if (!r.data) break;
      if (r.data.id === lead.id) { got = r.data; break; }
      await B4.post("/api/dialer/skip", { leadId: r.data.id, lockToken: r.data.lockToken, reason: "qa" });
    }
    const r = await B3.post("/api/dialer/call", { idempotencyKey: key(), mode: "preview", sessionId: s3.id, browserSessionId: T.sess3, leadId: lead.id, lockToken: lead.lockToken });
    if (got) await B4.post("/api/dialer/skip", { leadId: got.id, lockToken: got.lockToken, reason: "qa" });
    await B4.del("/api/dialer/session", { sessionId: s4.data.id, browserSessionId: T.sess4 });
    return { pass: Boolean(got) && r.code === "lock_lost", actual: `agent4 got lead=${Boolean(got)}, agent3 dial → ${r.status} ${r.code}` };
  });
  await t("P7", "Preview", "רשימה ריקה", "next-lead מחזיר null", async () => {
    const s = await B4.post("/api/dialer/session", { mode: "preview", listId: ids.emptyListId, browserSessionId: T.sess4 });
    const r = await B4.post("/api/dialer/next-lead", { sessionId: s.data.id, browserSessionId: T.sess4 });
    await B4.del("/api/dialer/session", { sessionId: s.data.id, browserSessionId: T.sess4 });
    return { pass: r.status === 200 && r.data === null, actual: `${r.status} data=${JSON.stringify(r.data)}` };
  });
  if (s3) await B3.del("/api/dialer/session", { sessionId: s3.id, browserSessionId: T.sess3 });
  await db.listLead.updateMany({ where: { listId: ids.listId }, data: { status: "pending", nextAttemptAt: null, lockedByUserId: null, lockToken: null, lockExpiresAt: null, attempts: 0, lastSkipReason: null } });

  await Promise.all([cleanupAgent(B3), cleanupAgent(B4)]);
  // ═══ §5 Power ═════════════════════════════════════════════════════════
  let ps: any;
  await t("W1", "תותח שיחות", "התחלת סשן, משיכה וחיוג – רק שיחה אחת לנציג", "שני חיוגים במקביל → אחד מצליח", async () => {
    const s = await B3.post("/api/dialer/session", { mode: "power", listId: ids.listId, browserSessionId: T.sess3, countdownSeconds: 0 });
    ps = s.data;
    const l = await B3.post("/api/dialer/next-lead", { sessionId: ps.id, browserSessionId: T.sess3 });
    const [r1, r2] = await Promise.all([1, 2].map(() => B3.post("/api/dialer/call", { idempotencyKey: key(), mode: "power", sessionId: ps.id, browserSessionId: T.sess3, leadId: l.data.id, lockToken: l.data.lockToken })));
    const ok = [r1, r2].filter((r) => r.status === 200);
    const live = await db.call.count({ where: { userId: a3.id, endedAt: null } });
    const cid = ok[0]?.data.id;
    const st = await waitStatus(B3, cid, ["answered"]);
    if (st && !st.endedAt) await B3.post(`/api/dialer/call/${cid}/hangup`);
    const ended = await waitEnd(B3, cid);
    return { pass: ok.length === 1 && live === 1 && Boolean(ended?.endedAt), actual: `הצלחות=${ok.length}, שיחות חיות=${live}, סיום=${ended?.telephonyResult}`, evidence: `call ${cid}` };
  });
  await t("W2", "תותח שיחות", "מעבר לליד הבא לפני תיעוד", "409 outcome_required", async () => {
    const r = await B3.post("/api/dialer/next-lead", { sessionId: ps.id, browserSessionId: T.sess3 });
    return { pass: r.status === 409 && r.code === "outcome_required", actual: `${r.status} ${r.code}` };
  });
  await t("W3", "תותח שיחות", "שמירת תוצאה בזמן שיחה פעילה", "409 call_still_active", async () => {
    // save outcome of previous call first
    const st = await B3.get(`/api/dialer/state?browserSessionId=${T.sess3}`);
    await B3.post(`/api/dialer/call/${st.data.wrapUpCall.id}/outcome`, { outcome: "answered_not_interested", note: "qa W3" });
    // force an "answered" lead (…05) so the call stays alive until we hang up
    const c05 = await db.contact.findFirst({ where: { businessId: bizB, phoneE164: "+972521000005" } });
    await db.listLead.updateMany({ where: { listId: ids.listId, contactId: c05!.id }, data: { priority: 100, status: "pending", nextAttemptAt: null } });
    const l = await B3.post("/api/dialer/next-lead", { sessionId: ps.id, browserSessionId: T.sess3 });
    await db.listLead.updateMany({ where: { listId: ids.listId, contactId: c05!.id }, data: { priority: 0 } });
    const c = await B3.post("/api/dialer/call", { idempotencyKey: key(), mode: "power", sessionId: ps.id, browserSessionId: T.sess3, leadId: l.data.id, lockToken: l.data.lockToken });
    await waitStatus(B3, c.data.id, ["ringing", "answered"]);
    const r = await B3.post(`/api/dialer/call/${c.data.id}/outcome`, { outcome: "sale" });
    await B3.post(`/api/dialer/call/${c.data.id}/hangup`);
    const ended = await waitEnd(B3, c.data.id);
    const saved = await B3.post(`/api/dialer/call/${c.data.id}/outcome`, { outcome: "answered_interested", note: "qa W3b" });
    return { pass: r.status === 409 && r.code === "call_still_active" && saved.status === 200 && Boolean(ended.endedAt), actual: `בזמן שיחה: ${r.status} ${r.code}; אחרי ניתוק: ${saved.status}` };
  });
  await t("W4", "תותח שיחות", "תוצאות ספק: נענה / אין מענה / תפוס / נדחה", "telephonyResult תואם, talkSeconds רק לשיחה שנענתה ונמדד מהמענה", async () => {
    const results: string[] = [];
    let pass = true;
    for (const [phone, expect] of [["0521000010", "no_answer"], ["0521000011", "busy"], ["0521000012", "rejected"], ["0521000005", "answered"]] as const) {
      const c = await B3.post("/api/dialer/call", { idempotencyKey: key(), mode: "manual", phone });
      if (c.status !== 200) { results.push(`${phone}: ${c.status} ${c.error}`); pass = false; continue; }
      if (expect === "answered") { await waitStatus(B3, c.data.id, ["answered"]); await sleep(2500); await B3.post(`/api/dialer/call/${c.data.id}/hangup`); }
      const e = await waitEnd(B3, c.data.id);
      const talk = e.talkSeconds ?? 0;
      const ok = e.telephonyResult === expect && (expect === "answered" ? talk >= 2 && e.answeredAt && new Date(e.answeredAt) > new Date(e.ringingAt) : talk === 0 && !e.answeredAt);
      if (!ok) pass = false;
      results.push(`${phone}→${e.telephonyResult} talk=${talk}s${e.answeredAt ? ` ring→answer ${Math.round((new Date(e.answeredAt).getTime() - new Date(e.ringingAt).getTime()) / 1000)}s` : ""}`);
      await B3.post(`/api/dialer/call/${c.data.id}/outcome`, { outcome: expect === "answered" ? "answered_interested" : expect === "rejected" ? "wrong_number" : expect });
    }
    return { pass, actual: results.join(" | ") };
  });
  await t("W5", "תותח שיחות", "השהיה – משיכת ליד בסשן מושהה", "409 session_paused", async () => {
    await B3.patch("/api/dialer/session", { sessionId: ps.id, browserSessionId: T.sess3, action: "pause" });
    const r = await B3.post("/api/dialer/next-lead", { sessionId: ps.id, browserSessionId: T.sess3 });
    const u = await db.user.findUnique({ where: { id: a3.id } });
    await B3.patch("/api/dialer/session", { sessionId: ps.id, browserSessionId: T.sess3, action: "resume" });
    return { pass: r.code === "session_paused" && u?.presence === "paused", actual: `${r.status} ${r.code}, presence=${u?.presence}` };
  });
  await t("W6", "תותח שיחות", "סיום סשן בזמן שיחה", "409 call_active; אחרי ניתוק – הסשן נסגר והליד משוחרר", async () => {
    const l = await B3.post("/api/dialer/next-lead", { sessionId: ps.id, browserSessionId: T.sess3 });
    const c = await B3.post("/api/dialer/call", { idempotencyKey: key(), mode: "power", sessionId: ps.id, browserSessionId: T.sess3, leadId: l.data.id, lockToken: l.data.lockToken });
    await waitStatus(B3, c.data.id, ["ringing", "answered"]);
    const r1 = await B3.del("/api/dialer/session", { sessionId: ps.id, browserSessionId: T.sess3 });
    await B3.post(`/api/dialer/call/${c.data.id}/hangup`);
    await waitEnd(B3, c.data.id);
    await B3.post(`/api/dialer/call/${c.data.id}/outcome`, { outcome: "no_answer" });
    const r2 = await B3.del("/api/dialer/session", { sessionId: ps.id, browserSessionId: T.sess3 });
    const lead = await db.listLead.findUnique({ where: { id: l.data.id } });
    const u = await db.user.findUnique({ where: { id: a3.id } });
    return { pass: r1.code === "call_active" && r2.status === 200 && !lead?.lockedByUserId && u?.presence === "offline", actual: `בזמן שיחה ${r1.status}/${r1.code}; אחרי: ${r2.status}, lead.locked=${Boolean(lead?.lockedByUserId)}, presence=${u?.presence}` };
  });
  await t("W7", "תותח שיחות", "החלפת רשימה בזמן סשן", "סשן חדש מחליף את הקודם והליד הקודם משוחרר", async () => {
    const s1 = await B3.post("/api/dialer/session", { mode: "power", listId: ids.listId, browserSessionId: T.sess3, countdownSeconds: 0 });
    const l = await B3.post("/api/dialer/next-lead", { sessionId: s1.data.id, browserSessionId: T.sess3 });
    const s2 = await B3.post("/api/dialer/session", { mode: "preview", listId: ids.emptyListId, browserSessionId: T.sess3 });
    const old = await db.dialerSession.findUnique({ where: { id: s1.data.id } });
    const lead = await db.listLead.findUnique({ where: { id: l.data.id } });
    await B3.del("/api/dialer/session", { sessionId: s2.data.id, browserSessionId: T.sess3 });
    return { pass: old?.status === "ended" && lead?.status === "pending" && !lead.lockedByUserId, actual: `old.status=${old?.status}, lead.status=${lead?.status}, locked=${Boolean(lead?.lockedByUserId)}` };
  });
  await t("W8", "תותח שיחות", "מדיניות ניסיונות: אין מענה → ניסיון חוזר; מקסימום → מוצה", "attempts=1 & nextAttemptAt≈+30ד׳; ניסיון שני → exhausted (maxAttempts=2)", async () => {
    const s = await B3.post("/api/dialer/session", { mode: "power", listId: ids.listId, browserSessionId: T.sess3, countdownSeconds: 0 });
    const c10 = await db.contact.findFirst({ where: { businessId: bizB, phoneE164: "+972521000010" } });
    const lead0 = await db.listLead.findFirst({ where: { listId: ids.listId, contactId: c10!.id } });
    await db.listLead.updateMany({ where: { listId: ids.listId }, data: { priority: 0 } });
    await db.listLead.update({ where: { id: lead0!.id }, data: { priority: 100, status: "pending", nextAttemptAt: null, attempts: 0 } });
    const notes: string[] = [];
    let pass = true;
    for (let i = 1; i <= 2; i++) {
      const l = await B3.post("/api/dialer/next-lead", { sessionId: s.data.id, browserSessionId: T.sess3 });
      if (l.data?.id !== lead0!.id) { notes.push(`iteration ${i}: got other lead ${l.data?.id}`); pass = false; break; }
      const c = await B3.post("/api/dialer/call", { idempotencyKey: key(), mode: "power", sessionId: s.data.id, browserSessionId: T.sess3, leadId: l.data.id, lockToken: l.data.lockToken });
      await waitEnd(B3, c.data.id);
      await B3.post(`/api/dialer/call/${c.data.id}/outcome`, { outcome: "no_answer" });
      const L = await db.listLead.findUnique({ where: { id: lead0!.id } });
      const mins = L?.nextAttemptAt ? Math.round((L.nextAttemptAt.getTime() - Date.now()) / 60000) : null;
      notes.push(`#${i}: attempts=${L?.attempts} status=${L?.status} next=+${mins}m`);
      if (i === 1 && !(L?.attempts === 1 && L.status === "pending" && mins !== null && mins >= 29 && mins <= 31)) pass = false;
      if (i === 2 && !(L?.attempts === 2 && L.status === "exhausted")) pass = false;
      if (i === 1) await db.listLead.update({ where: { id: lead0!.id }, data: { nextAttemptAt: null } }); // make it due again
    }
    await B3.del("/api/dialer/session", { sessionId: s.data.id, browserSessionId: T.sess3 });
    await db.listLead.update({ where: { id: lead0!.id }, data: { priority: 0 } });
    return { pass, actual: notes.join(" | ") };
  });
  await t("W9", "תותח שיחות", "תפוס → ניסיון חוזר לפי busyRetryMinutes (5)", "nextAttemptAt ≈ +5 דק׳", async () => {
    const c11 = await db.contact.findFirst({ where: { businessId: bizB, phoneE164: "+972521000011" } });
    const lead = await db.listLead.findFirst({ where: { listId: ids.listId, contactId: c11!.id } });
    await db.listLead.update({ where: { id: lead!.id }, data: { priority: 100, status: "pending", nextAttemptAt: null, attempts: 0 } });
    const s = await B3.post("/api/dialer/session", { mode: "power", listId: ids.listId, browserSessionId: T.sess3, countdownSeconds: 0 });
    const l = await B3.post("/api/dialer/next-lead", { sessionId: s.data.id, browserSessionId: T.sess3 });
    const c = await B3.post("/api/dialer/call", { idempotencyKey: key(), mode: "power", sessionId: s.data.id, browserSessionId: T.sess3, leadId: l.data.id, lockToken: l.data.lockToken });
    const e = await waitEnd(B3, c.data.id);
    await B3.post(`/api/dialer/call/${c.data.id}/outcome`, { outcome: "busy" });
    const L = await db.listLead.findUnique({ where: { id: lead!.id } });
    const mins = L?.nextAttemptAt ? Math.round((L.nextAttemptAt.getTime() - Date.now()) / 60000) : null;
    await B3.del("/api/dialer/session", { sessionId: s.data.id, browserSessionId: T.sess3 });
    await db.listLead.update({ where: { id: lead!.id }, data: { priority: 0 } });
    return { pass: l.data.id === lead!.id && e.telephonyResult === "busy" && mins === 5, actual: `provider=${e.telephonyResult}, next=+${mins}m` };
  });
  await t("W10", "תותח שיחות", "callback מנותב לנציג שקבע אותו", "נציג אחר לא מקבל את הליד לפני חלון החסד; הבעלים כן", async () => {
    const c5 = await db.contact.findFirst({ where: { businessId: bizB, phoneE164: "+972521000005" } });
    const lead = await db.listLead.findFirst({ where: { listId: ids.listId, contactId: c5!.id } });
    await db.listLead.updateMany({ where: { listId: ids.listId }, data: { status: "removed" } });
    await db.listLead.update({ where: { id: lead!.id }, data: { status: "callback", nextAttemptAt: new Date(Date.now() - 60_000), preferredUserId: a3.id, lockedByUserId: null, lockToken: null } });
    const s4 = await B4.post("/api/dialer/session", { mode: "preview", listId: ids.listId, browserSessionId: T.sess4 });
    const r4 = await B4.post("/api/dialer/next-lead", { sessionId: s4.data.id, browserSessionId: T.sess4 });
    const s3b = await B3.post("/api/dialer/session", { mode: "preview", listId: ids.listId, browserSessionId: T.sess3 });
    const r3 = await B3.post("/api/dialer/next-lead", { sessionId: s3b.data.id, browserSessionId: T.sess3 });
    if (r3.data) await B3.post("/api/dialer/skip", { leadId: r3.data.id, lockToken: r3.data.lockToken, reason: "qa" });
    await B4.del("/api/dialer/session", { sessionId: s4.data.id, browserSessionId: T.sess4 });
    await B3.del("/api/dialer/session", { sessionId: s3b.data.id, browserSessionId: T.sess3 });
    await db.listLead.updateMany({ where: { listId: ids.listId }, data: { status: "pending", nextAttemptAt: null, preferredUserId: null, attempts: 0, lockedByUserId: null, lockToken: null, lockExpiresAt: null, priority: 0 } });
    return { pass: r4.data === null && r3.data?.id === lead!.id, actual: `agent4 got=${r4.data?.id ?? "null"}, owner got=${r3.data?.id === lead!.id}` };
  });

  await Promise.all([cleanupAgent(B3), cleanupAgent(B4)]);
  // ═══ §7 Outcomes ══════════════════════════════════════════════════════
  const longNote = "הערה ארוכה בעברית עם תווים מיוחדים: \"מרכאות\", 'גרש', <tag>, & אמפרסנד, אימוג׳י 🎯📞, שורה\nחדשה. " + "טקסט ".repeat(300);
  const outcomeCases: Array<[string, Record<string, unknown>, (c: any, l: any) => boolean]> = [
    ["answered_interested", {}, (c, l) => l.status === "completed"],
    ["answered_not_interested", {}, (c, l) => l.status === "completed"],
    ["callback", { callbackAt: new Date(Date.now() + 3600_000).toISOString() }, (c, l) => l.status === "callback" && l.preferredUserId === a3.id],
    ["no_answer", {}, (c, l) => l.status === "pending" && l.attempts === 1],
    ["busy", {}, (c, l) => l.status === "pending"],
    ["wrong_number", {}, (c, l) => l.status === "completed"],
    ["sale", {}, (c, l) => l.status === "completed"],
    ["dnc", {}, (c, l) => l.status === "dnc"],
  ];
  await db.listLead.updateMany({ where: { listId: ids.listId }, data: { priority: 0, status: "pending", nextAttemptAt: null, attempts: 0, lockedByUserId: null, lockToken: null, lockExpiresAt: null, preferredUserId: null } });
  const leadsB = await db.listLead.findMany({ where: { listId: ids.listId }, include: { contact: true }, take: 8, orderBy: { createdAt: "asc" } });
  for (let i = 0; i < outcomeCases.length; i++) {
    const [outcome, extra, check] = outcomeCases[i];
    await t(`O${i + 1}`, "תוצאות", `תוצאה "${outcome}" משיחה על ליד`, "נשמרת ב-DB עם שיוך נכון, מופיעה בהיסטוריה, הליד מתעדכן, הערה נשמרת במלואה", async () => {
      const lead = leadsB[i % leadsB.length];
      await db.listLead.update({ where: { id: lead.id }, data: { status: "pending", attempts: 0, nextAttemptAt: null, lockedByUserId: null, lockToken: null, priority: 100 } });
      const s = await B3.post("/api/dialer/session", { mode: "power", listId: ids.listId, browserSessionId: T.sess3, countdownSeconds: 0 });
      const l = await B3.post("/api/dialer/next-lead", { sessionId: s.data.id, browserSessionId: T.sess3 });
      if (l.data?.id !== lead.id) { if (l.data) await B3.post("/api/dialer/skip", { leadId: l.data.id, lockToken: l.data.lockToken, reason: "qa" }); await db.listLead.update({ where: { id: lead.id }, data: { priority: 0 } }); await B3.del("/api/dialer/session", { sessionId: s.data.id, browserSessionId: T.sess3 }); return { pass: false, actual: `pulled other lead ${l.data?.id} (expected ${lead.id})` }; }
      const c = await B3.post("/api/dialer/call", { idempotencyKey: key(), mode: "power", sessionId: s.data.id, browserSessionId: T.sess3, leadId: lead.id, lockToken: l.data.lockToken });
      if (c.status !== 200) { await db.listLead.update({ where: { id: lead.id }, data: { priority: 0 } }); await B3.del("/api/dialer/session", { sessionId: s.data.id, browserSessionId: T.sess3 }); return { pass: false, actual: `dial ${c.status} ${c.error}` }; }
      const st = await waitStatus(B3, c.data.id, ["answered"], 40000);
      if (st && !st.endedAt) await B3.post(`/api/dialer/call/${c.data.id}/hangup`);
      await waitEnd(B3, c.data.id);
      const r = await B3.post(`/api/dialer/call/${c.data.id}/outcome`, { outcome, note: longNote, ...extra });
      const dbCall = await db.call.findUnique({ where: { id: c.data.id } });
      const L = await db.listLead.findUnique({ where: { id: lead.id } });
      const hist = await B3.get(`/api/contacts/${lead.contactId}`);
      const inHist = hist.data.calls.some((x: any) => x.id === c.data.id && x.outcome === outcome && x.outcomeNote === longNote.trim());
      const tasks = outcome === "callback" ? await db.task.count({ where: { callId: c.data.id } }) : -1;
      const dnc = outcome === "dnc" ? await db.dncEntry.count({ where: { businessId: bizB, phoneE164: lead.contact.phoneE164 } }) : -1;
      await db.listLead.update({ where: { id: lead.id }, data: { priority: 0 } });
      await B3.del("/api/dialer/session", { sessionId: s.data.id, browserSessionId: T.sess3 });
      const pass = r.status === 200 && dbCall?.outcome === outcome && dbCall.outcomeNote === longNote.trim() && dbCall.businessId === bizB && dbCall.userId === a3.id && dbCall.leadId === lead.id && Boolean(dbCall.outcomeSavedAt) && check(dbCall, L) && inHist && (tasks === -1 || tasks === 1) && (dnc === -1 || dnc === 1) && dbCall.telephonyResult !== null;
      return { pass, actual: `${r.status}; provider=${dbCall?.telephonyResult}, outcome=${dbCall?.outcome}, note ok=${dbCall?.outcomeNote === longNote.trim()} (${longNote.length} תווים), lead.status=${L?.status}${tasks >= 0 ? `, tasks=${tasks}` : ""}${dnc >= 0 ? `, dnc=${dnc}` : ""}, בהיסטוריה=${inHist}`, evidence: `call ${c.data.id}` };
    });
  }
  await t("O9", "תוצאות", "שמירה כפולה של תוצאה", "השמירה השנייה לא דורסת ולא יוצרת משימה נוספת", async () => {
    const call = await db.call.findFirst({ where: { userId: a3.id, outcome: "callback" }, orderBy: { createdAt: "desc" } });
    const before = await db.task.count({ where: { callId: call!.id } });
    const r = await B3.post(`/api/dialer/call/${call!.id}/outcome`, { outcome: "sale", note: "override?" });
    const after = await db.call.findUnique({ where: { id: call!.id } });
    const tasks = await db.task.count({ where: { callId: call!.id } });
    return { pass: r.status === 200 && after?.outcome === "callback" && after.outcomeNote === longNote.trim() && tasks === before && tasks === 1, actual: `outcome=${after?.outcome}, tasks=${tasks}` };
  });
  // O8 has already asserted DNC persistence. Remove its fixture before unrelated calls.
  await db.dncEntry.deleteMany({ where: { businessId: bizB } });
  await t("O10", "תוצאות", "טיוטת הערה נשמרת בשרת ונמחקת אחרי תיעוד", "PUT/GET draft עובדים; אחרי outcome הטיוטה נמחקת", async () => {
    const c = leadsB[0].contactId;
    const p = await B3.put("/api/dialer/draft", { contactId: c, body: "טיוטה 123" });
    const g = await B3.get(`/api/dialer/draft?contactId=${c}`);
    const call = await B3.post("/api/dialer/call", { idempotencyKey: key(), mode: "manual", contactId: c });
    await endCall(B3, call.data.id, "no_answer");
    const g2 = await B3.get(`/api/dialer/draft?contactId=${c}`);
    return { pass: p.status === 200 && g.data.body === "טיוטה 123" && g2.data.body === "", actual: `draft=${g.data?.body} → after outcome="${g2.data?.body}"` };
  });
  await t("O11", "תוצאות", "מכירה אינה יוצרת הזמנה/הכנסה", "אין ישות הזמנות במערכת; המדד סופר תוצאות בלבד", async () => {
    const tables = await db.$queryRawUnsafe<{ table_name: string }[]>(`SELECT table_name FROM information_schema.tables WHERE table_schema = '${schema}'`);
    const names = tables.map((x) => x.table_name);
    return { pass: !names.some((n) => /order|invoice|revenue|payment/i.test(n)), actual: `טבלאות: ${names.join(", ")}` };
  }, "n/a");

  await cleanupAgent(B3);
  // ═══ §8 Tasks & DNC ═══════════════════════════════════════════════════
  await t("T1", "משימות חזרה", "מועד חזרה בעבר", "400 callback_in_past", async () => {
    const c = await B3.post("/api/dialer/call", { idempotencyKey: key(), mode: "manual", phone: "0521000010" });
    await waitEnd(B3, c.data.id);
    const r = await B3.post(`/api/dialer/call/${c.data.id}/outcome`, { outcome: "callback", callbackAt: new Date(Date.now() - 3600_000).toISOString() });
    const r2 = await B3.post(`/api/dialer/call/${c.data.id}/outcome`, { outcome: "callback" });
    await B3.post(`/api/dialer/call/${c.data.id}/outcome`, { outcome: "no_answer" });
    return { pass: r.code === "callback_in_past" && r2.code === "callback_time_required", actual: `עבר: ${r.status}/${r.code}; בלי מועד: ${r2.status}/${r2.code}` };
  });
  await t("T2", "משימות חזרה", "אזור זמן: מועד עם offset של ישראל נשמר כרגע UTC נכון", "dueAt זהה לרגע שנשלח", async () => {
    const c = await B3.post("/api/dialer/call", { idempotencyKey: key(), mode: "manual", phone: "0521000010" });
    await waitEnd(B3, c.data.id);
    const d = new Date(Date.now() + 26 * 3600_000); d.setSeconds(0, 0);
    const il = new Date(d.getTime() + 3 * 3600_000).toISOString().replace("Z", "+03:00");
    const r = await B3.post(`/api/dialer/call/${c.data.id}/outcome`, { outcome: "callback", callbackAt: il });
    const task = await db.task.findFirst({ where: { callId: c.data.id } });
    return { pass: r.status === 200 && task?.dueAt.getTime() === d.getTime(), actual: `sent=${il} stored=${task?.dueAt.toISOString()}` };
  });
  await t("T3", "משימות חזרה", "שינוי מועד ומשימה מסומנת כבוצעה", "dueAt מתעדכן וגם nextAttemptAt של הליד; done → ליד completed", async () => {
    const task = await db.task.findFirst({ where: { userId: a3.id, status: "open", leadId: { not: null } }, orderBy: { createdAt: "desc" } });
    const nd = new Date(Date.now() + 48 * 3600_000).toISOString();
    const r1 = await B3.patch(`/api/tasks/${task!.id}`, { dueAt: nd });
    const lead1 = await db.listLead.findUnique({ where: { id: task!.leadId! } });
    const r2 = await B3.patch(`/api/tasks/${task!.id}`, { status: "done" });
    const lead2 = await db.listLead.findUnique({ where: { id: task!.leadId! } });
    const t2 = await db.task.findUnique({ where: { id: task!.id } });
    return { pass: r1.status === 200 && lead1?.nextAttemptAt?.toISOString() === nd && r2.status === 200 && t2?.status === "done" && Boolean(t2.doneAt) && lead2?.status === "completed", actual: `next=${lead1?.nextAttemptAt?.toISOString()}, task=${t2?.status}, lead=${lead2?.status}` };
  });
  await t("T4", "משימות חזרה", "נציג רואה רק את המשימות שלו; מנהל רואה את הצוות", "agent4 לא רואה משימות של agent3; managerB רואה", async () => {
    const r4 = await B4.get("/api/tasks?status=open");
    const rm = await MB.get("/api/tasks?status=open");
    const r4x = await B4.get(`/api/tasks?status=open&userId=${a3.id}`);
    return { pass: r4.data.items.every((x: any) => x.user.id === a4.id) && rm.data.items.some((x: any) => x.user.id === a3.id) && r4x.data.items.length === 0, actual: `agent4=${r4.data.items.length} (כולן שלו), manager=${rm.data.items.length}, agent4 מבקש של agent3=${r4x.data.items.length}` };
  });
  await t("D1", "DNC", "חסימה חלה על כל הרשימות של העסק ולא על עסק אחר עם אותו מספר", "לידים של +972501234503 בעסק ב׳ → dnc; בעסק א׳ נשארים", async () => {
    const cB = await db.contact.findFirst({ where: { businessId: bizB, phoneE164: "+972501234533" } });
    await db.listLead.createMany({ data: [{ businessId: bizB, listId: ids.restrictedListId, contactId: cB!.id }], skipDuplicates: true });
    const r = await B3.post("/api/dnc", { phone: "0501234533", reason: "qa D1" });
    const leadsBx = await db.listLead.findMany({ where: { contactId: cB!.id } });
    const cA = await db.contact.findFirst({ where: { businessId: bizA, phoneE164: "+972501234533" } });
    const leadsA = await db.listLead.findMany({ where: { contactId: cA!.id } });
    const dncA = await db.dncEntry.count({ where: { businessId: bizA, phoneE164: "+972501234533" } });
    const audit = await db.auditLog.count({ where: { businessId: bizB, entityType: "dnc", entityId: "+972501234533", action: "dnc.added" } });
    return { pass: r.status === 201 && leadsBx.length >= 2 && leadsBx.every((l) => l.status === "dnc") && leadsA.every((l) => l.status !== "dnc") && dncA === 0 && audit >= 1, actual: `B leads=${leadsBx.map((l) => l.status).join(",")}; A leads=${leadsA.map((l) => l.status).join(",")}; dnc in A=${dncA}; audit=${audit}` };
  });
  await t("D2", "DNC", "הרשאות: נציג לא מסיר חסימה, מנהל כן; שינוי מתועד", "DELETE by agent → 403; by manager → 200 + audit", async () => {
    const r1 = await B3.del("/api/dnc", { phone: "0501234533" });
    const r2 = await MB.del("/api/dnc", { phone: "0501234533" });
    const audit = await db.auditLog.count({ where: { businessId: bizB, entityType: "dnc", entityId: "+972501234533", action: "dnc.removed" } });
    return { pass: r1.status === 403 && r2.status === 200 && audit >= 1, actual: `agent ${r1.status}, manager ${r2.status}, audit=${audit}` };
  });
  await t("D3", "DNC", "רשימת DNC למנהל בלבד", "GET by agent → 403", async () => {
    const r = await B3.get("/api/dnc");
    return { pass: r.status === 403, actual: `${r.status}` };
  });

  await Promise.all([cleanupAgent(B3), cleanupAgent(B4)]);
  // ═══ §9 Lists ═════════════════════════════════════════════════════════
  await t("L1", "רשימות", "יצירת רשימה מסינון CRM + מניעת כפילויות + סינון DNC", "added = אנשי קשר במקור qa שאינם חסומים; הוספה חוזרת = 0", async () => {
    await MB.post("/api/dnc", { phone: "0521000012", reason: "qa L1" });
    const expected = (await db.contact.count({ where: { businessId: bizB, source: "qa" } })) - (await db.dncEntry.count({ where: { businessId: bizB, phoneE164: { in: (await db.contact.findMany({ where: { businessId: bizB, source: "qa" }, select: { phoneE164: true } })).map((c) => c.phoneE164) } } }));
    const r = await MB.post("/api/lists", { name: "QA-L1", filter: { source: "qa" } });
    const again = await MB.post(`/api/lists/${r.data.id}/leads`, { filter: { source: "qa" } });
    await MB.del("/api/dnc", { phone: "0521000012" });
    return { pass: r.status === 201 && r.data.added === expected && again.data.added === 0, actual: `added=${r.data?.added} (צפוי ${expected}), שוב=${again.data?.added}` };
  });
  await t("L2", "רשימות", "רשימה משויכת לנציג אחר", "agent3 → 403 בהתחלת סשן; agent4 מצליח", async () => {
    const r3 = await B3.post("/api/dialer/session", { mode: "preview", listId: ids.restrictedListId, browserSessionId: T.sess3 });
    const r4 = await B4.post("/api/dialer/session", { mode: "preview", listId: ids.restrictedListId, browserSessionId: T.sess4 });
    if (r4.data?.id) await B4.del("/api/dialer/session", { sessionId: r4.data.id, browserSessionId: T.sess4 });
    return { pass: r3.status === 403 && r4.status === 200, actual: `agent3 ${r3.status}, agent4 ${r4.status}` };
  });
  await t("L3", "רשימות", "חלון חיוג סגור (רשימת לילה)", "next-lead → 409 outside_dial_window עם מועד הפתיחה הבא", async () => {
    const s = await B3.post("/api/dialer/session", { mode: "power", listId: ids.nightListId, browserSessionId: T.sess3, countdownSeconds: 0 });
    const r = await B3.post("/api/dialer/next-lead", { sessionId: s.data.id, browserSessionId: T.sess3 });
    await B3.del("/api/dialer/session", { sessionId: s.data.id, browserSessionId: T.sess3 });
    return { pass: r.status === 409 && r.code === "outside_dial_window" && Boolean(r.json.details?.nextOpening), actual: `${r.status} ${r.code} next=${r.json.details?.nextOpening}` };
  });
  await t("L4", "רשימות", "נציג רואה רק רשימות משויכות אליו או פתוחות", "agent3 לא רואה 'QA-B רק נציג ד׳'", async () => {
    const r = await B3.get("/api/lists");
    return { pass: r.status === 200 && !r.data.some((l: any) => l.id === ids.restrictedListId) && r.data.some((l: any) => l.id === ids.listId), actual: r.data.map((l: any) => l.name).join(", ") };
  });
  await t("L5", "רשימות", "מחיקת רשימה עם שיחה פעילה", "409 list_busy; ללא שיחה → מושבתת (לא נמחקת)", async () => {
    await db.listLead.updateMany({ where: { listId: ids.listId }, data: { status: "pending", nextAttemptAt: null, attempts: 0, lockedByUserId: null, lockToken: null, lockExpiresAt: null, preferredUserId: null, priority: 0 } });
    const s = await B3.post("/api/dialer/session", { mode: "power", listId: ids.listId, browserSessionId: T.sess3, countdownSeconds: 0 });
    const l = await B3.post("/api/dialer/next-lead", { sessionId: s.data.id, browserSessionId: T.sess3 });
    const c = await B3.post("/api/dialer/call", { idempotencyKey: key(), mode: "power", sessionId: s.data.id, browserSessionId: T.sess3, leadId: l.data.id, lockToken: l.data.lockToken });
    await waitStatus(B3, c.data.id, ["ringing", "answered"]);
    const r1 = await MB.del(`/api/lists/${ids.listId}`);
    await B3.post(`/api/dialer/call/${c.data.id}/hangup`);
    await waitEnd(B3, c.data.id);
    await B3.post(`/api/dialer/call/${c.data.id}/outcome`, { outcome: "no_answer" });
    await B3.del("/api/dialer/session", { sessionId: s.data.id, browserSessionId: T.sess3 });
    const tmp = await MB.post("/api/lists", { name: "QA-L5" });
    const r2 = await MB.del(`/api/lists/${tmp.data.id}`);
    const after = await db.dialList.findUnique({ where: { id: tmp.data.id } });
    return { pass: r1.code === "list_busy" && r2.status === 200 && after?.isActive === false, actual: `busy: ${r1.status}/${r1.code}; idle: ${r2.status}, exists=${Boolean(after)} active=${after?.isActive}` };
  });

  // ═══ Tenancy & permissions ═══════════════════════════════════════════
  const contactA = await db.contact.findFirst({ where: { businessId: bizA } });
  const callA = await db.call.findFirst({ where: { businessId: bizA } });
  await t("X1", "הפרדת עסקים", "נציג בעסק ב׳ ניגש לאיש קשר / שיחה / הקלטה של עסק א׳", "404 בכולם", async () => {
    const r1 = await B3.get(`/api/contacts/${contactA!.id}`);
    const r2 = callA ? await B3.get(`/api/dialer/call/${callA.id}`) : { status: 404 };
    const r3 = callA ? await B3.get(`/api/recordings/${callA.id}`) : { status: 404 };
    const r4 = await B3.patch(`/api/contacts/${contactA!.id}`, { fullName: "hack" });
    return { pass: [r1, r2, r3, r4].every((r) => r.status === 404), actual: `${r1.status} ${r2.status} ${r3.status} ${r4.status}` };
  });
  await t("X2", "הפרדת עסקים", "רשימות/חיפוש אנשי קשר לא דולפים בין עסקים", "contacts של ב׳ רק businessId ב׳; ליד מעסק א׳ לא ניתן לחיוג", async () => {
    const r = await B3.get("/api/contacts?limit=100");
    const all = r.data.items.every((c: any) => c.businessId === bizB);
    const leadA = await db.listLead.findFirst({ where: { businessId: bizA } });
    const d = await B3.post("/api/dialer/call", { idempotencyKey: key(), mode: "manual", leadId: leadA!.id });
    return { pass: all && d.status !== 200, actual: `contacts all B=${all}; dial lead of A → ${d.status} ${d.code}` };
  });
  await t("X3", "הרשאות", "דשבורד מנהל: מנהל ב׳ רואה רק את עסק ב׳; מנהל בלי צוות רואה את עצמו בלבד; נציג 403", "", async () => {
    const rm = await MB.get("/api/manager/dashboard");
    const rl = await LB.get("/api/manager/dashboard");
    const ra = await B3.get("/api/manager/dashboard");
    const usersB = await db.user.findMany({ where: { businessId: bizB }, select: { id: true } });
    const onlyB = rm.data.agents.every((a: any) => usersB.some((u) => u.id === a.id));
    return { pass: onlyB && rm.data.agents.length >= 3 && rl.data.agents.length === 1 && ra.status === 403, actual: `managerB agents=${rm.data.agents.length} (רק ב׳=${onlyB}), lonely=${rl.data.agents.length}, agent=${ra.status}` };
  });
  await t("X4", "הרשאות", "היסטוריית שיחות לפי נראות", "נציג רואה רק שלו; מנהל צוות רואה את הצוות; מנהל בלי צוות רק את עצמו", async () => {
    const r3 = await B3.get("/api/calls?limit=100");
    const rm = await MB.get("/api/calls?limit=100");
    const rl = await LB.get("/api/calls?limit=100");
    const rx = await B3.get(`/api/calls?limit=100&userId=${a4.id}`);
    return { pass: r3.data.items.every((c: any) => c.user.id === a3.id) && rm.data.items.some((c: any) => c.user.id === a3.id) && rl.data.items.length === 0 && rx.data.items.length === 0, actual: `agent3=${r3.data.items.length}, manager=${rm.data.items.length}, lonely=${rl.data.items.length}, agent3→agent4=${rx.data.items.length}` };
  });
  await t("X5", "הרשאות", "פעולות ניהול", "agent: settings PATCH 403, users POST 403, lists POST 403, import 403; manager: users POST 403, settings PATCH 403; admin: 200", async () => {
    const a = await Promise.all([B3.patch("/api/settings", { name: "x" }), B3.post("/api/users", { fullName: "x", email: "x@x.com", password: "123456" }), B3.post("/api/lists", { name: "x" }), B3.post("/api/contacts/import", { rows: [{ fullName: "x", phone: "0521000099" }] })]);
    const m = await Promise.all([MB.post("/api/users", { fullName: "x", email: "x@x.com", password: "123456" }), MB.patch("/api/settings", { name: "x" }), MB.post("/api/phone-numbers", { phone: "0500000000" })]);
    const ad = await ADB.patch("/api/settings", { settings: { autoDialCountdownSeconds: 2 } });
    return { pass: a.every((r) => r.status === 403) && m.every((r) => r.status === 403) && ad.status === 200, actual: `agent=${a.map((r) => r.status).join("/")}, manager=${m.map((r) => r.status).join("/")}, admin=${ad.status}` };
  });
  await t("X6", "הרשאות", "נציג עורך איש קשר שאינו שלו ולא טיפל בו", "403", async () => {
    const c = await db.contact.findFirst({ where: { businessId: bizB, ownerUserId: a3.id, calls: { none: {} }, leads: { none: { lockedByUserId: a4.id } } } });
    const r = await B4.patch(`/api/contacts/${c!.id}`, { city: "x" });
    return { pass: r.status === 403, actual: `${r.status} ${r.code}` };
  });
  await t("X7", "אבטחה", "ללא cookie / cookie מזויף", "401", async () => {
    const anon = new Client("anon");
    const r1 = await anon.get("/api/dialer/state");
    anon.cookie = "dialer_session=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.bad";
    const r2 = await anon.get("/api/dialer/state");
    return { pass: r1.status === 401 && r2.status === 401, actual: `${r1.status} ${r2.status}` };
  });
  await t("X8", "אבטחה", "משתמש מושבת מאבד גישה מיד", "401 אחרי isActive=false", async () => {
    const tmp = new Client("tmp");
    const email = `tmp-${Date.now()}@qa-b.local`;
    const u = await ADB.post("/api/users", { fullName: "זמני", email, password: "tmp12345", role: "agent" });
    await tmp.login(email, "tmp12345");
    const ok = await tmp.get("/api/auth/me");
    await ADB.patch(`/api/users/${u.data.id}`, { isActive: false });
    const r = await tmp.get("/api/auth/me");
    return { pass: ok.status === 200 && r.status === 401, actual: `לפני ${ok.status}, אחרי ${r.status}` };
  });

  await cleanupAgent(B3);
  // ═══ Sessions / tabs / heartbeat ═════════════════════════════════════
  await t("S1", "סשנים", "heartbeat מלשונית זרה", "sessionOk=false session_taken", async () => {
    const s = await B3.post("/api/dialer/session", { mode: "manual", browserSessionId: T.sess3 });
    const r = await B3.post("/api/dialer/heartbeat", { sessionId: s.data.id, browserSessionId: "other-tab" });
    const ok = await B3.post("/api/dialer/heartbeat", { sessionId: s.data.id, browserSessionId: T.sess3 });
    await B3.del("/api/dialer/session", { sessionId: s.data.id, browserSessionId: T.sess3 });
    return { pass: r.data.sessionOk === false && r.data.reason === "session_taken" && ok.data.sessionOk === true, actual: JSON.stringify(r.data) };
  });
  await t("S2", "סשנים", "לשונית שנייה מתחילה סשן", "הסשן הראשון מסתיים; פעולות מהלשונית הראשונה → session_ended", async () => {
    const s1 = await B3.post("/api/dialer/session", { mode: "power", listId: ids.listId, browserSessionId: "tabA-" + key(), countdownSeconds: 0 });
    const s2 = await B3.post("/api/dialer/session", { mode: "power", listId: ids.listId, browserSessionId: T.sess3, countdownSeconds: 0 });
    const r = await B3.post("/api/dialer/next-lead", { sessionId: s1.data.id, browserSessionId: s1.data.browserSessionId });
    const st = await B3.get(`/api/dialer/state?browserSessionId=${s1.data.browserSessionId}`);
    await B3.del("/api/dialer/session", { sessionId: s2.data.id, browserSessionId: T.sess3 });
    return { pass: r.code === "session_ended" && st.data.session?.id === s2.data.id && st.data.session.ownedByThisTab === false, actual: `old tab next-lead → ${r.code}; state.ownedByThisTab=${st.data.session?.ownedByThisTab}` };
  });
  await t("S3", "סשנים", "סגירת דפדפן: סשן ללא heartbeat נסגר, נציג offline, ליד משוחרר", "אחרי reaper: session ended, presence offline, lead pending", async () => {
    const s = await B3.post("/api/dialer/session", { mode: "preview", listId: ids.listId, browserSessionId: T.sess3 });
    const l = await B3.post("/api/dialer/next-lead", { sessionId: s.data.id, browserSessionId: T.sess3 });
    await db.dialerSession.update({ where: { id: s.data.id }, data: { lastHeartbeatAt: new Date(Date.now() - 120_000) } });
    await db.listLead.update({ where: { id: l.data.id }, data: { lockExpiresAt: new Date(Date.now() - 1000) } });
    await MB.get("/api/manager/dashboard"); // triggers reaper
    const ss = await db.dialerSession.findUnique({ where: { id: s.data.id } });
    const u = await db.user.findUnique({ where: { id: a3.id } });
    const L = await db.listLead.findUnique({ where: { id: l.data.id } });
    return { pass: ss?.status === "ended" && u?.presence === "offline" && L?.status === "pending" && !L.lockedByUserId, actual: `session=${ss?.status}, presence=${u?.presence}, lead=${L?.status}/locked=${Boolean(L?.lockedByUserId)}` };
  });
  await t("S4", "סשנים", "סשן עם שיחה חיה לא נקצר ע״י ה-reaper", "הסשן נשאר פעיל כל עוד השיחה חיה", async () => {
    const s = await B3.post("/api/dialer/session", { mode: "manual", browserSessionId: T.sess3 });
    const c = await B3.post("/api/dialer/call", { idempotencyKey: key(), mode: "manual", phone: "0521000005", sessionId: s.data.id, browserSessionId: T.sess3 });
    await waitStatus(B3, c.data.id, ["answered"]);
    await db.dialerSession.update({ where: { id: s.data.id }, data: { lastHeartbeatAt: new Date(Date.now() - 120_000) } });
    await MB.get("/api/manager/dashboard");
    const ss = await db.dialerSession.findUnique({ where: { id: s.data.id } });
    await B3.post(`/api/dialer/call/${c.data.id}/hangup`);
    await waitEnd(B3, c.data.id);
    await B3.post(`/api/dialer/call/${c.data.id}/outcome`, { outcome: "answered_not_interested" });
    await B3.del("/api/dialer/session", { sessionId: s.data.id, browserSessionId: T.sess3 });
    return { pass: ss?.status === "active", actual: `session=${ss?.status}` };
  });

  // ═══ Manager metrics ══════════════════════════════════════════════════
  await t("G1", "מנהל", "מדדים תואמים ל-DB לפי ההגדרות המוצהרות", "dials=count(calls), connected=count(answeredAt), avgTalk=sum(talk)/connected", async () => {
    const from = new Date(); from.setHours(0, 0, 0, 0);
    const r = await MB.get(`/api/manager/dashboard?from=${from.toISOString()}`);
    const calls = await db.call.findMany({ where: { businessId: bizB, createdAt: { gte: from } }, select: { answeredAt: true, talkSeconds: true, outcome: true } });
    const dials = calls.length, connected = calls.filter((c) => c.answeredAt).length, talk = calls.filter((c) => c.answeredAt).reduce((s, c) => s + (c.talkSeconds ?? 0), 0), sales = calls.filter((c) => c.outcome === "sale").length;
    const tt = r.data.totals;
    return { pass: tt.dials === dials && tt.connected === connected && tt.avgTalkSeconds === (connected ? Math.round(talk / connected) : 0) && tt.sales === sales && tt.connectRate === (dials ? Math.round((connected / dials) * 100) : 0), actual: `api dials=${tt.dials}/${dials} connected=${tt.connected}/${connected} avgTalk=${tt.avgTalkSeconds} sales=${tt.sales}/${sales} rate=${tt.connectRate}%` };
  });
  await t("G2", "מנהל", "מצב נציג בזמן אמת בזמן שיחה", "presence=in_call + liveCall בדשבורד; אחרי סיום wrap_up", async () => {
    const c = await B3.post("/api/dialer/call", { idempotencyKey: key(), mode: "manual", phone: "0521000005" });
    await waitStatus(B3, c.data.id, ["answered"]);
    const r = await MB.get("/api/manager/dashboard");
    const ag = r.data.agents.find((a: any) => a.id === a3.id);
    await B3.post(`/api/dialer/call/${c.data.id}/hangup`);
    await waitEnd(B3, c.data.id);
    const r2 = await MB.get("/api/manager/dashboard");
    const ag2 = r2.data.agents.find((a: any) => a.id === a3.id);
    await B3.post(`/api/dialer/call/${c.data.id}/outcome`, { outcome: "answered_not_interested" });
    const r3 = await MB.get("/api/manager/dashboard");
    const ag3 = r3.data.agents.find((a: any) => a.id === a3.id);
    return { pass: ag.presence === "in_call" && ag.liveCall?.id === c.data.id && ag2.presence === "wrap_up" && ag3.presence === "available", actual: `בשיחה: ${ag.presence}/${ag.liveCall?.status}; אחרי ניתוק: ${ag2.presence}; אחרי תיעוד: ${ag3.presence}` };
  });

  // ═══ Telnyx webhooks (signed with local test key) ═════════════════════
  const keys = JSON.parse(fs.readFileSync(process.env.QA_KEYS ?? ".qa-keys.json", "utf8"));
  const priv = crypto.createPrivateKey(keys.privatePem);
  const sign = (body: string, ts = Math.floor(Date.now() / 1000)) => ({ "telnyx-timestamp": String(ts), "telnyx-signature-ed25519": crypto.sign(null, Buffer.from(`${ts}|${body}`), priv).toString("base64") });
  const hook = (id: string, type: string, callId: string, leg: "agent" | "lead", ccid: string, extra: Record<string, unknown> = {}) =>
    JSON.stringify({ data: { id, event_type: type, occurred_at: new Date().toISOString(), payload: { call_control_id: ccid, call_leg_id: ccid + "-leg", call_session_id: "sess", client_state: Buffer.from(JSON.stringify({ callId, leg })).toString("base64"), ...extra } } });
  const anon = new Client("hook");
  await t("H1", "Webhooks", "חתימה תקינה / גוף שונה / חותמת זמן ישנה", "200 / 401 / 401", async () => {
    const body = hook("evt-h1-" + key(), "call.answered", "nonexistent", "lead", "cc-x");
    const ok = await anon.req("POST", "/api/webhooks/telnyx", body, sign(body));
    const tampered = await anon.req("POST", "/api/webhooks/telnyx", body.replace("answered", "hangup"), sign(body));
    const old = await anon.req("POST", "/api/webhooks/telnyx", body, sign(body, Math.floor(Date.now() / 1000) - 3600));
    return { pass: ok.status === 200 && tampered.status === 401 && old.status === 401, actual: `${ok.status} ${tampered.status} ${old.status}` };
  });
  await t("H2", "Webhooks", "אירוע כפול ואירועים בסדר הפוך (hangup לפני answered)", "כפול מסומן duplicate ללא שינוי; hangup מסיים; answered מאוחר לא מחייה את השיחה", async () => {
    // create a call and immediately drive it via webhooks before the mock advances the lead leg
    const c = await B3.post("/api/dialer/call", { idempotencyKey: key(), mode: "manual", phone: "0521000010" });
    const callId = c.data.id as string;
    const evId = "evt-h2-" + key();
    const hang = hook(evId, "call.hangup", callId, "lead", "cc-lead-" + callId, { hangup_cause: "user_busy", hangup_source: "callee" });
    const r1 = await anon.req("POST", "/api/webhooks/telnyx", hang, sign(hang));
    const after1 = await db.call.findUnique({ where: { id: callId } });
    const r2 = await anon.req("POST", "/api/webhooks/telnyx", hang, sign(hang));
    const late = hook("evt-h2b-" + key(), "call.answered", callId, "lead", "cc-lead-" + callId);
    await anon.req("POST", "/api/webhooks/telnyx", late, sign(late));
    const after2 = await db.call.findUnique({ where: { id: callId } });
    const events = await db.telephonyEvent.count({ where: { providerEventId: evId } });
    await B3.post(`/api/dialer/call/${callId}/outcome`, { outcome: "busy" });
    return { pass: r1.json.ok && after1?.endedAt !== null && after1?.telephonyResult === "busy" && r2.json.duplicate === true && events === 1 && after2?.status === "ended" && after2.answeredAt === null && after2.activeForUser === null, actual: `hangup→ended=${Boolean(after1?.endedAt)} result=${after1?.telephonyResult}; duplicate=${r2.json.duplicate}; events stored=${events}; late answered → status=${after2?.status}, answeredAt=${after2?.answeredAt}` };
  });
  await t("H3", "Webhooks", "recording.saved מסמן הקלטה; הורדה דרך proxy מאומת בלבד", "recordingStatus=saved; GET recording ע״י נציג אחר של אותו צוות → מותר למנהל, 403 לנציג אחר", async () => {
    const c = await B3.post("/api/dialer/call", { idempotencyKey: key(), mode: "manual", phone: "0521000005" });
    await waitStatus(B3, c.data.id, ["answered"]);
    await B3.post(`/api/dialer/call/${c.data.id}/hangup`);
    await waitEnd(B3, c.data.id);
    const body = hook("evt-h3-" + key(), "call.recording.saved", c.data.id, "lead", "cc-lead-" + c.data.id, { recording_started_at: new Date(Date.now() - 5000).toISOString(), recording_ended_at: new Date().toISOString(), channels: "dual", recording_urls: { mp3: "https://example.invalid/x.mp3" } });
    await anon.req("POST", "/api/webhooks/telnyx", body, sign(body));
    const dbc = await db.call.findUnique({ where: { id: c.data.id } });
    const own = await B3.get(`/api/recordings/${c.data.id}`);
    const other = await B4.get(`/api/recordings/${c.data.id}`);
    const mgr = await MB.get(`/api/recordings/${c.data.id}`);
    await B3.post(`/api/dialer/call/${c.data.id}/outcome`, { outcome: "answered_interested" });
    return { pass: dbc?.recordingStatus === "saved" && Boolean(dbc.recordingId?.startsWith("mock-rec-")) && dbc.recordingDurationMs === 5000 && other.status === 403 && [404].includes(own.status) && [404].includes(mgr.status), actual: `status=${dbc?.recordingStatus} id=${dbc?.recordingId} dur=${dbc?.recordingDurationMs}ms; owner=${own.status}(${own.code}) other-agent=${other.status} manager=${mgr.status}(${mgr.code}) – הורדה אמיתית חסומה ללא Telnyx` };
  });
  await t("H4", "Webhooks", "אירוע ל-leg לא מוכר", "200 ללא שינוי", async () => {
    const body = hook("evt-h4-" + key(), "call.hangup", "", "lead", "cc-unknown-" + key(), { hangup_cause: "normal_clearing" });
    const r = await anon.req("POST", "/api/webhooks/telnyx", body, sign(body));
    return { pass: r.status === 200 && r.json.callId === null, actual: `${r.status} ${JSON.stringify(r.json)}` };
  });
  blocked("H5", "Webhooks", "timeout בבקשת חיוג לספק → בדיקה אם נוצרה שיחה לפני ניסיון חוזר", "dialPendingSince → המתנה ל-webhook → retry עם אותו command_id", "דורש ספק אמיתי/פרוקסי רשת; הלוגיקה קיימת ב-reconcileCall אך לא הופעלה בבדיקה");
  blocked("A1", "אודיו", "אודיו דו-כיווני, השתקה בפועל, DTMF ליעד IVR, החלפת אוזניות באמצע שיחה", "אודיו נשמע בשני הצדדים", "אין חשבון Telnyx ומספר בדיקה מאושר");


  // ═══ New capabilities (gap-completion pass) ═══════════════════════════
  await Promise.all([cleanupAgent(B3), cleanupAgent(B4)]);
  const resetB = () => db.listLead.updateMany({ where: { listId: ids.listId }, data: { status: "pending", nextAttemptAt: null, attempts: 0, lockedByUserId: null, lockToken: null, lockExpiresAt: null, preferredUserId: null, priority: 0, claimReason: null } });
  const setB = (settings: Record<string, unknown>) => ADB.patch("/api/settings", { settings });

  await t("N1", "תעדוף", "סדר הגשה לפי ציון שקוף + הסבר לנציג", "חזרה שהגיע מועדה לפני ליד של הנציג לפני ליד רגיל; claimReason מוסבר", async () => {
    await resetB();
    const leads = await db.listLead.findMany({ where: { listId: ids.listId }, include: { contact: true }, orderBy: { createdAt: "asc" } });
    const cb = leads[0], own = leads[1], plain = leads[2];
    await db.listLead.updateMany({ where: { listId: ids.listId, NOT: { id: { in: [cb.id, own.id, plain.id] } } }, data: { status: "removed" } });
    await db.listLead.update({ where: { id: cb.id }, data: { status: "callback", lastOutcome: "callback", nextAttemptAt: new Date(Date.now() - 5 * 60_000), preferredUserId: a3.id } });
    await db.contact.update({ where: { id: own.contactId }, data: { ownerUserId: a3.id } });
    await db.contact.update({ where: { id: plain.contactId }, data: { ownerUserId: a4.id } });
    await db.contact.update({ where: { id: cb.contactId }, data: { ownerUserId: null } });
    const s = await B3.post("/api/dialer/session", { mode: "preview", listId: ids.listId, browserSessionId: T.sess3 });
    const got: string[] = []; const reasons: string[] = [];
    for (let i = 0; i < 3; i++) {
      const l = await B3.post("/api/dialer/next-lead", { sessionId: s.data.id, browserSessionId: T.sess3 });
      if (!l.data) break;
      got.push(l.data.id); reasons.push(l.data.claimReason);
      await db.listLead.update({ where: { id: l.data.id }, data: { status: "removed", lockedByUserId: null, lockToken: null } }); // take it out so the next pull differs
    }
    await B3.del("/api/dialer/session", { sessionId: s.data.id, browserSessionId: T.sess3 });
    await db.listLead.updateMany({ where: { listId: ids.listId }, data: { status: "pending", preferredUserId: null, nextAttemptAt: null } });
    await db.contact.updateMany({ where: { businessId: bizB }, data: { ownerUserId: a3.id } });
    const order = got.map((id) => (id === cb.id ? "callback" : id === own.id ? "owner" : "plain")).join(">");
    return { pass: order === "callback>owner>plain" && reasons[0]?.includes("חזרה") && reasons[1]?.includes("שלך"), actual: `סדר=${order}; הסברים: ${reasons.join(" | ")}` };
  });

  await t("N2", "בטיחות", "עצירת חיוגים ברמת העסק (kill switch)", "משיכת ליד וחיוג ידני נדחים ב-409 dialing_paused; אחרי חידוש עובד", async () => {
    await MB.post("/api/manager/pause", { scope: "business", paused: true });
    const s = await B3.post("/api/dialer/session", { mode: "power", listId: ids.listId, browserSessionId: T.sess3, countdownSeconds: 0 });
    const r1 = await B3.post("/api/dialer/next-lead", { sessionId: s.data.id, browserSessionId: T.sess3 });
    const r2 = await B3.post("/api/dialer/call", { idempotencyKey: key(), mode: "manual", phone: "0521000010" });
    const dash = await MB.get("/api/manager/dashboard");
    await MB.post("/api/manager/pause", { scope: "business", paused: false });
    const r3 = await B3.post("/api/dialer/call", { idempotencyKey: key(), mode: "manual", phone: "0521000010" });
    await endCall(B3, r3.data?.id);
    await B3.del("/api/dialer/session", { sessionId: s.data.id, browserSessionId: T.sess3 });
    const hist = await db.auditLog.count({ where: { businessId: bizB, action: "dialing.paused" } });
    return { pass: r1.code === "dialing_paused" && r2.code === "dialing_paused" && dash.data.dialingPaused === true && r3.status === 200 && hist >= 1, actual: `next-lead ${r1.code}, dial ${r2.code}, dashboard paused=${dash.data.dialingPaused}, after resume ${r3.status}, audit=${hist}` };
  });

  await t("N3", "בטיחות", "השהיית רשימה בודדת", "409 list_paused בהתחלת סשן; דשבורד מציג מושהית", async () => {
    await MB.post("/api/manager/pause", { scope: "list", listId: ids.listId, paused: true });
    const r = await B3.post("/api/dialer/session", { mode: "power", listId: ids.listId, browserSessionId: T.sess3, countdownSeconds: 0 });
    const dash = await MB.get("/api/manager/dashboard");
    const q = dash.data.queues.find((x: any) => x.id === ids.listId);
    await MB.post("/api/manager/pause", { scope: "list", listId: ids.listId, paused: false });
    return { pass: r.code === "list_paused" && q?.isPaused === true && q?.stats.dueNow === 0, actual: `${r.status} ${r.code}; queue paused=${q?.isPaused} dueNow=${q?.stats.dueNow}` };
  });

  await t("N4", "בטיחות", "הגבלת מדינות יעד", "IL בלבד → +1 נדחה 403; אחרי הוספת US → מותר", async () => {
    await setB({ allowedCountries: ["IL"] });
    const r1 = await B3.post("/api/dialer/call", { idempotencyKey: key(), mode: "manual", phone: "+1 202 555 0143" });
    await setB({ allowedCountries: ["IL", "US"] });
    const r2 = await B3.post("/api/dialer/call", { idempotencyKey: key(), mode: "manual", phone: "+1 202 555 0143" });
    await endCall(B3, r2.data?.id);
    await setB({ allowedCountries: ["IL"] });
    return { pass: r1.code === "country_not_allowed" && r2.status === 200, actual: `IL בלבד: ${r1.status}/${r1.code} (${r1.json?.details?.country}); עם US: ${r2.status}` };
  });

  await t("N5", "בטיחות", "הגבלת קצב חיוג לנציג", "maxDialsPerMinute=2 → החיוג השלישי 429", async () => {
    await setB({ maxDialsPerMinute: 2 });
    await cleanupAgent(B4);
    const codes: string[] = [];
    for (const ph of ["0521000010", "0521000011", "0521000012"]) {
      const r = await B4.post("/api/dialer/call", { idempotencyKey: key(), mode: "manual", phone: ph });
      codes.push(`${r.status}${r.code ? "/" + r.code : ""}`);
      if (r.status === 200) await endCall(B4, r.data.id);
    }
    await setB({ maxDialsPerMinute: 0 });
    return { pass: codes[0].startsWith("200") && codes[1].startsWith("200") && codes[2] === "429/rate_limited", actual: codes.join(", ") };
  });

  await t("N6", "חלוקת עבודה", "אותו מספר בשיחה חיה אצל נציג אחר (כרטיסים כפולים)", "409 number_in_call", async () => {
    const c3 = await B3.post("/api/dialer/call", { idempotencyKey: key(), mode: "manual", phone: "0521000005" });
    await waitStatus(B3, c3.data.id, ["answered"]);
    const c4 = await B4.post("/api/dialer/call", { idempotencyKey: key(), mode: "manual", phone: "052-100-0005" });
    await endCall(B3, c3.data.id);
    return { pass: c4.status === 409 && c4.code === "number_in_call", actual: `${c4.status} ${c4.code}` };
  });

  await t("N7", "תותח שיחות", "כשל טכני (leg הנציג נכשל לפני צלצול)", "הליד חוזר לתור אחרי X דק׳, הניסיון לא נספר, אין דרישת תיעוד, נרשמה אוטומציה", async () => {
    await resetB();
    const s = await B3.post("/api/dialer/session", { mode: "power", listId: ids.listId, browserSessionId: T.sess3, countdownSeconds: 0 });
    const l = await B3.post("/api/dialer/next-lead", { sessionId: s.data.id, browserSessionId: T.sess3 });
    const c = await B3.post("/api/dialer/call", { idempotencyKey: key(), mode: "power", sessionId: s.data.id, browserSessionId: T.sess3, leadId: l.data.id, lockToken: l.data.lockToken });
    // provider says the agent leg failed before anything rang (no poll happened yet, so the mock did not advance)
    const body = hook("evt-n7-" + key(), "call.hangup", c.data.id, "agent", c.data.agentLegId ?? "mock-agent-" + c.data.id, { hangup_cause: "call_rejected", hangup_source: "callee" });
    await anon.req("POST", "/api/webhooks/telnyx", body, sign(body));
    const call = await db.call.findUnique({ where: { id: c.data.id } });
    const lead = await db.listLead.findUnique({ where: { id: l.data.id } });
    const st = await B3.get(`/api/dialer/state?browserSessionId=${T.sess3}`);
    const auto = await db.auditLog.count({ where: { businessId: bizB, action: "automation.technical_failure_requeued", entityId: c.data.id } });
    await B3.del("/api/dialer/session", { sessionId: s.data.id, browserSessionId: T.sess3 });
    const mins = lead?.nextAttemptAt ? Math.round((lead.nextAttemptAt.getTime() - Date.now()) / 60000) : null;
    return { pass: call?.status === "failed" && Boolean(call.outcomeSavedAt) && call.outcome === null && lead?.status === "pending" && lead.attempts === 0 && mins === 10 && !st.data.wrapUpCall && auto === 1, actual: `call=${call?.status} autoSaved=${Boolean(call?.outcomeSavedAt)} lead=${lead?.status} attempts=${lead?.attempts} next=+${mins}m wrapUpRequired=${Boolean(st.data.wrapUpCall)} audit=${auto}` };
  });

  await t("N8", "חלוקת עבודה", "העברת ליד לנציג אחר ע״י מנהל", "הנעילה משוחררת, preferredUserId=יעד, audit; הנציג היעד מקבל אותו ראשון", async () => {
    await resetB();
    const s3 = await B3.post("/api/dialer/session", { mode: "preview", listId: ids.listId, browserSessionId: T.sess3 });
    const l = await B3.post("/api/dialer/next-lead", { sessionId: s3.data.id, browserSessionId: T.sess3 });
    const r = await MB.post(`/api/leads/${l.data.id}/transfer`, { toUserId: a4.id, note: "qa" });
    const lead = await db.listLead.findUnique({ where: { id: l.data.id } });
    const s4 = await B4.post("/api/dialer/session", { mode: "preview", listId: ids.listId, browserSessionId: T.sess4 });
    const l4 = await B4.post("/api/dialer/next-lead", { sessionId: s4.data.id, browserSessionId: T.sess4 });
    const audit = await db.auditLog.count({ where: { businessId: bizB, action: "lead.transferred", entityId: l.data.id } });
    await B4.del("/api/dialer/session", { sessionId: s4.data.id, browserSessionId: T.sess4 });
    await B3.del("/api/dialer/session", { sessionId: s3.data.id, browserSessionId: T.sess3 });
    return { pass: r.status === 200 && lead?.lockedByUserId === null && lead.preferredUserId === a4.id && l4.data?.id === l.data.id && audit === 1, actual: `${r.status}; locked=${lead?.lockedByUserId} preferred=${lead?.preferredUserId === a4.id}; agent4 got it=${l4.data?.id === l.data.id}; audit=${audit}` };
  });

  await t("N9", "רשימות", "שכפול, ארכוב ורענון רשימה דינמית", "העותק מכיל את הלידים; ארכיון → list_inactive; רענון מוסיף איש קשר חדש שעונה לסינון", async () => {
    await resetB();
    const dup = await MB.post(`/api/lists/${ids.listId}/duplicate`, { withLeads: true });
    const dupCount = await db.listLead.count({ where: { listId: dup.data.id } });
    const arch = await MB.patch(`/api/lists/${dup.data.id}`, { archived: true });
    const sess = await B4.post("/api/dialer/session", { mode: "power", listId: dup.data.id, browserSessionId: T.sess4 });
    const tag = "qa-dyn-" + key().slice(0, 6);
    const dyn = await MB.post("/api/lists", { name: "QA-" + tag, isDynamic: true, filter: { source: tag } });
    await MB.post("/api/contacts", { fullName: "דינמי חדש", phone: "052-10" + String(Math.floor(Math.random() * 90000) + 10000), source: tag });
    const ref = await MB.post(`/api/lists/${dyn.data.id}/refresh`);
    const frozen = await MB.post(`/api/lists/${ids.listId}/refresh`);
    const auto = await db.auditLog.count({ where: { businessId: bizB, action: "automation.list_refreshed", entityId: dyn.data.id } });
    return { pass: dup.status === 201 && dupCount === dup.data.copied && dupCount >= 7 && arch.status === 200 && sess.code === "list_inactive" && dyn.data.added === 0 && ref.data.added === 1 && frozen.code === "list_frozen" && auto === 1, actual: `copied=${dup.data?.copied}/${dupCount}; archived→session ${sess.code}; dynamic refresh added=${ref.data?.added}; frozen refresh=${frozen.status}/${frozen.data?.added ?? frozen.code}` };
  });

  await t("N10", "אוטומציות", "מכירה סוגרת את הליד בכל הרשימות האחרות ומבטלת משימות פתוחות", "ליד ברשימה השנייה → completed; יומן אוטומציה", async () => {
    await resetB();
    const c5 = await db.contact.findFirst({ where: { businessId: bizB, phoneE164: "+972521000005" } });
    const other = await MB.post("/api/lists", { name: "QA-other-" + key().slice(0, 6), contactIds: [c5!.id] });
    const otherLead = await db.listLead.findFirst({ where: { listId: other.data.id, contactId: c5!.id } });
    const c = await B3.post("/api/dialer/call", { idempotencyKey: key(), mode: "manual", contactId: c5!.id });
    await waitStatus(B3, c.data.id, ["answered"]);
    await B3.post(`/api/dialer/call/${c.data.id}/hangup`);
    await waitEnd(B3, c.data.id);
    await B3.post(`/api/dialer/call/${c.data.id}/outcome`, { outcome: "sale" });
    const after = await db.listLead.findUnique({ where: { id: otherLead!.id } });
    const auto = await db.auditLog.findFirst({ where: { businessId: bizB, action: "automation.sale_removed_from_lists", entityId: c5!.id }, orderBy: { createdAt: "desc" } });
    return { pass: after?.status === "completed" && Boolean(auto), actual: `other list lead=${after?.status}; automation log=${Boolean(auto)} (${JSON.stringify(auto?.payload)})` };
  });

  await t("N11", "שיחות נכנסות", "לקוח מתקשר: זיהוי, ניתוב לבעלים, קבלה, ניתוק, היסטוריה", "נותב ל-agent3 (בעלים), ringing; קבל → answered; נתק → ended; direction=inbound בכרטיס", async () => {
    await resetB();
    await cleanupAgent(B3); await cleanupAgent(B4);
    const c5 = await db.contact.findFirst({ where: { businessId: bizB, phoneE164: "+972521000005" } });
    await db.contact.update({ where: { id: c5!.id }, data: { ownerUserId: a3.id } });
    await B3.post("/api/dialer/session", { mode: "manual", browserSessionId: T.sess3 }); // agent3 available
    const sim = await MB.post("/api/dev/simulate-inbound", { from: "0521000005" });
    const routedTo3 = sim.data?.userId === a3.id && sim.data.routingNote === "routed_to_owner";
    const st = await B3.get(`/api/dialer/state?browserSessionId=${T.sess3}`);
    const ringing = st.data.activeCall?.direction === "inbound" && !st.data.activeCall.answeredAt;
    const acc = await B3.post(`/api/dialer/call/${sim.data.id}/accept`);
    const answered = await waitStatus(B3, sim.data.id, ["answered"]);
    await sleep(1500);
    await B3.post(`/api/dialer/call/${sim.data.id}/hangup`);
    const ended = await waitEnd(B3, sim.data.id);
    const st2 = await B3.get(`/api/dialer/state?browserSessionId=${T.sess3}`);
    await B3.post(`/api/dialer/call/${sim.data.id}/outcome`, { outcome: "answered_interested", note: "inbound qa" });
    const hist = await B3.get(`/api/contacts/${c5!.id}`);
    const inHist = hist.data.calls.find((x: any) => x.id === sim.data.id);
    await cleanupAgent(B3);
    return { pass: routedTo3 && ringing && acc.status === 200 && answered?.status === "answered" && Boolean(ended?.endedAt) && ended.telephonyResult === "answered" && Boolean(st2.data.wrapUpCall) && Boolean(inHist), actual: `routed=${sim.data?.routingNote}/${routedTo3}; ringing=${ringing}; accept ${acc.status}; ${answered?.status}; ended=${ended?.telephonyResult} talk=${ended?.talkSeconds}s; wrap-up=${Boolean(st2.data.wrapUpCall)}; בהיסטוריה=${Boolean(inHist)}` };
  });

  await t("N12", "שיחות נכנסות", "בעלים עסוק → נציג זמין אחר; אף אחד זמין → לא נענה + משימת חזרה; דחייה ע״י נציג", "ניתוב ל-agent4; missed עם task; reject → ended + routingNote", async () => {
    await cleanupAgent(B3); await cleanupAgent(B4);
    const c4c = await db.contact.findFirst({ where: { businessId: bizB, phoneE164: "+972521000004" } });
    await db.contact.update({ where: { id: c4c!.id }, data: { ownerUserId: a3.id } });
    await B3.post("/api/dialer/session", { mode: "manual", browserSessionId: T.sess3 });
    await B4.post("/api/dialer/session", { mode: "manual", browserSessionId: T.sess4 });
    const busy = await B3.post("/api/dialer/call", { idempotencyKey: key(), mode: "manual", phone: "0521000005" }); // agent3 busy
    await waitStatus(B3, busy.data.id, ["answered"]);
    const sim1 = await MB.post("/api/dev/simulate-inbound", { from: "0521000004" });
    const toAgent4 = sim1.data?.userId === a4.id && sim1.data.routingNote === "routed_to_available_agent";
    const rej = await B4.post(`/api/dialer/call/${sim1.data.id}/reject`);
    const rejCall = await waitEnd(B4, sim1.data.id);
    const rejDb = await db.call.findUnique({ where: { id: sim1.data.id } });
    await B4.post(`/api/dialer/call/${sim1.data.id}/outcome`, { outcome: "no_answer" }).catch(() => undefined);
    await endCall(B3, busy.data.id);
    await cleanupAgent(B3); await cleanupAgent(B4); // nobody available now
    const tasksBefore = await db.task.count({ where: { businessId: bizB, contactId: c4c!.id, status: "open" } });
    const sim2 = await MB.post("/api/dev/simulate-inbound", { from: "0521000004" });
    const tasksAfter = await db.task.count({ where: { businessId: bizB, contactId: c4c!.id, status: "open" } });
    const missedAudit = await db.auditLog.count({ where: { businessId: bizB, action: "inbound.missed", entityId: sim2.data?.id ?? "x" } });
    return { pass: toAgent4 && rej.status === 200 && Boolean(rejCall?.endedAt) && rejDb?.routingNote === "rejected_by_agent" && sim2.data?.routingNote === "no_agent_available" && sim2.data.telephonyResult === "no_answer" && tasksAfter === tasksBefore + 1 && missedAudit === 1, actual: `busy owner → ${sim1.data?.routingNote} (agent4=${toAgent4}); reject ${rej.status} ended=${Boolean(rejCall?.endedAt)} note=${rejDb?.routingNote}; nobody → ${sim2.data?.routingNote}/${sim2.data?.telephonyResult}, task +${tasksAfter - tasksBefore}, audit=${missedAudit}` };
  });

  await t("N13", "תותח שיחות", "סיכום סשן אמיתי", "dials/connected/outcomes תואמים ל-DB", async () => {
    await resetB();
    const s = await B3.post("/api/dialer/session", { mode: "power", listId: ids.listId, browserSessionId: T.sess3, countdownSeconds: 0 });
    for (let i = 0; i < 2; i++) {
      const l = await B3.post("/api/dialer/next-lead", { sessionId: s.data.id, browserSessionId: T.sess3 });
      const c = await B3.post("/api/dialer/call", { idempotencyKey: key(), mode: "power", sessionId: s.data.id, browserSessionId: T.sess3, leadId: l.data.id, lockToken: l.data.lockToken });
      await endCall(B3, c.data.id);
    }
    const sum = await B3.get(`/api/dialer/session/summary?sessionId=${s.data.id}`);
    const calls = await db.call.findMany({ where: { sessionId: s.data.id } });
    await B3.del("/api/dialer/session", { sessionId: s.data.id, browserSessionId: T.sess3 });
    const outcomesTotal = sum.data.outcomes.reduce((a: number, o: any) => a + o.count, 0);
    return { pass: sum.data.dials === 2 && sum.data.dials === calls.length && sum.data.connected === calls.filter((c) => c.answeredAt).length && outcomesTotal === 2 && sum.data.queue && typeof sum.data.queue.dueNow === "number", actual: `dials=${sum.data.dials} connected=${sum.data.connected} outcomes=${outcomesTotal} queue.total=${sum.data.queue?.total}` };
  });

  await t("N14", "מנהל", "היסטוריית שינויי הגדרות", "PATCH settings יוצר רשומת audit עם diff; מוצג ב-/api/settings/history", async () => {
    const before = await db.auditLog.count({ where: { businessId: bizB, action: "settings.updated" } });
    await setB({ wrapUpSeconds: 45 });
    await setB({ wrapUpSeconds: 30 });
    const after = await db.auditLog.count({ where: { businessId: bizB, action: "settings.updated" } });
    const h = await MB.get("/api/settings/history");
    const last = h.data.find((x: any) => x.action === "settings.updated");
    return { pass: after === before + 2 && Boolean(last?.payload?.changed?.wrapUpSeconds), actual: `audit +${after - before}; last diff=${JSON.stringify(last?.payload?.changed?.wrapUpSeconds)}` };
  });

  await t("N15", "רשימות", "ייבוא עם דוח שגיאות לפי שורה", "שורות לא תקינות מדווחות עם מספר שורה וסיבה", async () => {
    const r = await MB.post("/api/contacts/import", { rows: [{ fullName: "תקין", phone: "0521000088" }, { fullName: "לא תקין", phone: "12" }, { fullName: "לא תקין 2", phone: "abc" }], source: "qa-import" });
    return { pass: r.data.created + r.data.updated === 1 && r.data.invalid === 2 && r.data.errors.length === 2 && r.data.errors[0].row === 2, actual: JSON.stringify({ created: r.data.created, updated: r.data.updated, invalid: r.data.invalid, errors: r.data.errors }) };
  });

  await t("N16", "מדדים", "מדדים מורחבים ודיוק טווח (חציית חצות, ללא ספירה כפולה)", "uniqueContacts/avgRing/avgWrap/callbackAdherence מוגדרים; שיחה מאתמול 23:59 לא נספרת ב'היום'", async () => {
    const yesterday = new Date(); yesterday.setDate(yesterday.getDate() - 1); yesterday.setHours(23, 59, 0, 0);
    const old = await db.call.create({ data: { businessId: bizB, userId: a3.id, mode: "manual", provider: "mock", idempotencyKey: "qa-midnight-" + key(), toE164: "+972521000099", fromE164: "+97239876543", status: "ended", telephonyResult: "answered", createdAt: yesterday, ringingAt: yesterday, answeredAt: new Date(yesterday.getTime() + 5000), endedAt: new Date(yesterday.getTime() + 65000), talkSeconds: 60, outcome: "sale", outcomeSavedAt: new Date(yesterday.getTime() + 90000) } });
    const startOfToday = new Date(); startOfToday.setHours(0, 0, 0, 0);
    const today = await MB.get(`/api/manager/dashboard?from=${startOfToday.toISOString()}`);
    const both = await MB.get(`/api/manager/dashboard?from=${new Date(yesterday.getTime() - 3600_000).toISOString()}`);
    const expectToday = await db.call.count({ where: { businessId: bizB, createdAt: { gte: startOfToday } } });
    const connectedToday = await db.call.findMany({ where: { businessId: bizB, createdAt: { gte: startOfToday }, answeredAt: { not: null } }, select: { contactId: true } });
    const uniq = new Set(connectedToday.map((c) => c.contactId).filter(Boolean)).size;
    await db.call.delete({ where: { id: old.id } });
    const tt = today.data.totals;
    return { pass: tt.dials === expectToday && both.data.totals.dials === expectToday + 1 && both.data.totals.sales === tt.sales + 1 && tt.uniqueContacts === uniq && tt.avgRingSeconds > 0 && typeof tt.callbackAdherence?.due === "number", actual: `today dials=${tt.dials}/${expectToday}, with yesterday=${both.data.totals.dials}; unique=${tt.uniqueContacts}/${uniq}; avgRing=${tt.avgRingSeconds}s avgWrap=${tt.avgWrapUpSeconds}s gap=${tt.avgGapSeconds}s adherence=${JSON.stringify(tt.callbackAdherence)}` };
  });

  await t("N17", "הקלטות", "מדיניות שמירה – עבודת רקע מוחקת הקלטות ישנות", "call ישן עם הקלטה → recordingStatus=none אחרי הריצה; חדש נשאר", async () => {
    await setB({ recordingRetentionDays: 1 });
    const oldC = await db.call.create({ data: { businessId: bizB, userId: a3.id, mode: "manual", provider: "mock", idempotencyKey: "qa-ret-" + key(), toE164: "+972521000098", fromE164: "+97239876543", status: "ended", telephonyResult: "answered", createdAt: new Date(Date.now() - 3 * 86400_000), endedAt: new Date(Date.now() - 3 * 86400_000), recordingStatus: "saved", recordingId: "mock-rec-old", outcomeSavedAt: new Date() } });
    const newC = await db.call.create({ data: { businessId: bizB, userId: a3.id, mode: "manual", provider: "mock", idempotencyKey: "qa-ret2-" + key(), toE164: "+972521000098", fromE164: "+97239876543", status: "ended", telephonyResult: "answered", endedAt: new Date(), recordingStatus: "saved", recordingId: "mock-rec-new", outcomeSavedAt: new Date() } });
    const noAuth = await anon.req("GET", "/api/jobs/retention");
    const job = await anon.req("GET", "/api/jobs/retention", undefined, { authorization: `Bearer ${process.env.CRON_SECRET ?? ""}` });
    const o = await db.call.findUnique({ where: { id: oldC.id } });
    const n = await db.call.findUnique({ where: { id: newC.id } });
    await setB({ recordingRetentionDays: 0 });
    await db.call.deleteMany({ where: { id: { in: [oldC.id, newC.id] } } });
    return { pass: noAuth.status === 401 && job.status === 200 && o?.recordingStatus === "none" && n?.recordingStatus === "saved", actual: `unauth ${noAuth.status}; job ${job.status}; old=${o?.recordingStatus} new=${n?.recordingStatus}` };
  });

  await t("N18", "עומס", "4 נציגים בשני עסקים מריצים תותח שיחות במקביל", "אין ליד שנמסר פעמיים, אין שגיאות, מדידת latency", async () => {
    await resetB();
    await db.listLead.updateMany({ where: { businessId: bizA }, data: { status: "pending", nextAttemptAt: null, attempts: 0, lockedByUserId: null, lockToken: null, lockExpiresAt: null, preferredUserId: null } });
    const listA = (await db.dialList.findFirst({ where: { businessId: bizA, name: { startsWith: "לידים חמים" } } }))!.id;
    const agents: Array<[Client, string, string]> = [[A1, listA, "tabA1-" + key()], [A2, listA, "tabA2-" + key()], [B3, ids.listId, T.sess3], [B4, ids.listId, T.sess4]];
    await Promise.all(agents.map(([c]) => cleanupAgent(c)));
    const claimed: string[] = []; const lat: number[] = []; const errors: string[] = [];
    await Promise.all(agents.map(async ([c, listId, tab]) => {
      const s = await c.post("/api/dialer/session", { mode: "power", listId, browserSessionId: tab, countdownSeconds: 0 });
      for (let i = 0; i < 3; i++) {
        const t0 = Date.now();
        const l = await c.post("/api/dialer/next-lead", { sessionId: s.data.id, browserSessionId: tab });
        lat.push(Date.now() - t0);
        if (l.status !== 200) { errors.push(`${c.name}: next-lead ${l.status} ${l.code}`); break; }
        if (!l.data) break;
        claimed.push(l.data.id);
        const d = await c.post("/api/dialer/call", { idempotencyKey: key(), mode: "power", sessionId: s.data.id, browserSessionId: tab, leadId: l.data.id, lockToken: l.data.lockToken });
        if (d.status !== 200) { errors.push(`${c.name}: dial ${d.status} ${d.code}`); break; }
        await endCall(c, d.data.id, "answered_not_interested");
      }
      await c.del("/api/dialer/session", { sessionId: s.data.id, browserSessionId: tab });
    }));
    const dupes = claimed.length - new Set(claimed).size;
    lat.sort((a, b) => a - b);
    const p = (q: number) => lat[Math.min(lat.length - 1, Math.floor(lat.length * q))];
    return { pass: dupes === 0 && errors.length === 0 && claimed.length >= 8, actual: `לידים שנמשכו=${claimed.length} כפולים=${dupes} שגיאות=${errors.length ? errors.join("; ") : 0}; next-lead latency p50=${p(0.5)}ms p95=${p(0.95)}ms (PostgreSQL מקומי; סימולציה)` };
  });

  await t("N19", "ביצועים", "רשימה של 10,000 לידים – הקצאה ועימוד", "next-lead < 3s p95, עמוד לידים < 3s, ללא כפילויות", async () => {
    const perf = await db.dialList.create({ data: { businessId: bizB, name: "QA-perf-10k" } });
    const batch = 1000; let contactIds: string[] = [];
    for (let b = 0; b < 10; b++) {
      const rows = Array.from({ length: batch }, (_, i) => { const n = b * batch + i; return { businessId: bizB, fullName: `perf ${n}`, phoneE164: `+97255${String(n).padStart(7, "0")}`, phoneRaw: `055${String(n).padStart(7, "0")}`, source: "perf" }; });
      await db.contact.createMany({ data: rows, skipDuplicates: true });
    }
    const cs = await db.contact.findMany({ where: { businessId: bizB, source: "perf" }, select: { id: true } });
    contactIds = cs.map((c) => c.id);
    for (let i = 0; i < contactIds.length; i += 2000) await db.listLead.createMany({ data: contactIds.slice(i, i + 2000).map((cid) => ({ businessId: bizB, listId: perf.id, contactId: cid })), skipDuplicates: true });
    const total = await db.listLead.count({ where: { listId: perf.id } });
    const s = await B3.post("/api/dialer/session", { mode: "preview", listId: perf.id, browserSessionId: T.sess3 });
    const lat: number[] = []; const got = new Set<string>();
    for (let i = 0; i < 10; i++) {
      const t0 = Date.now();
      const l = await B3.post("/api/dialer/next-lead", { sessionId: s.data.id, browserSessionId: T.sess3 });
      lat.push(Date.now() - t0);
      if (l.data) { got.add(l.data.id); await B3.post("/api/dialer/skip", { leadId: l.data.id, lockToken: l.data.lockToken, reason: "perf" }); }
    }
    const t1 = Date.now(); const page = await MB.get(`/api/lists/${perf.id}/leads?limit=50&page=100`); const pageMs = Date.now() - t1;
    const t2 = Date.now(); const stats = await MB.get(`/api/lists/${perf.id}`); const statsMs = Date.now() - t2;
    await B3.del("/api/dialer/session", { sessionId: s.data.id, browserSessionId: T.sess3 });
    await db.listLead.deleteMany({ where: { listId: perf.id } }); await db.dialList.delete({ where: { id: perf.id } }); await db.contact.deleteMany({ where: { businessId: bizB, source: "perf" } });
    lat.sort((a, b) => a - b);
    const p95 = lat[Math.floor(lat.length * 0.95)];
    const r0 = Date.now(); await db.$queryRaw`SELECT 1`; const rtt = Date.now() - r0;
    // next-lead = ~12 sequential DB round trips; from this laptop each is ~rtt. Threshold is relative to RTT.
    return { pass: total === 10000 && got.size === 10 && p95 < Math.max(3000, rtt * 25) && pageMs < Math.max(3000, rtt * 12) && page.data.total === 10000, actual: `leads=${total}; DB RTT=${rtt}ms; next-lead p50=${lat[5]}ms p95=${p95}ms; עמוד 100 (50 שורות)=${pageMs}ms; סטטיסטיקה=${statsMs}ms (dueNow=${stats.data?.stats?.dueNow})` };
  });
  blocked("N20", "טלפוניה מתקדמת", "החזקה, העברה, ועידה, האזנה/לחישה", "פעולות זמינות רק אם ממומשות", "לא ממומש: Telnyx תומך דרך Conferences API; דורש החלטת מוצר ומימוש נפרד – לא מוצגים כפתורים");
  blocked("N21", "AI ותמלול", "תמלול, סיכום, זיהוי התנגדויות", "הצעות בלבד עם מקור", "אין ספק תמלול מחובר – לא מיוצרים סיכומים מדומים");
  blocked("N22", "WhatsApp", "הודעת המשך לפי כללי החיבור", "", "אין חיבור WhatsApp במערכת זו");


  // ═══ Live floor + listen/whisper (R) ══════════════════════════════════
  await Promise.all([cleanupAgent(B3), cleanupAgent(B4)]);
  await MB.post("/api/telephony/token"); await LB.post("/api/telephony/token"); // managers need a browser registration (mock)
  const stopAny = async (c: Client) => { const m = await c.get("/api/manager/monitor"); if (m.data?.id) await c.del(`/api/manager/monitor/${m.data.id}`); };
  await stopAny(MB); await stopAny(LB);

  await t("R1", "האזנה", "הרשאות: נציג, מנהל מעסק אחר, מנהל בלי צוות, האזנה לעצמך", "403 / 404 / 403 / 400 – גם בקריאת API ישירה", async () => {
    const c = await B3.post("/api/dialer/call", { idempotencyKey: key(), mode: "manual", phone: "0521000005" });
    await waitStatus(B3, c.data.id, ["answered"]);
    const r1 = await B3.post("/api/manager/monitor", { callId: c.data.id });
    const r2 = await MA.post("/api/manager/monitor", { callId: c.data.id });
    const r3 = await LB.post("/api/manager/monitor", { callId: c.data.id });
    const own = await MB.post("/api/dialer/call", { idempotencyKey: key(), mode: "manual", phone: "0521000004" });
    const r4 = await MB.post("/api/manager/monitor", { callId: own.data.id });
    await endCall(MB, own.data.id);
    await endCall(B3, c.data.id);
    return { pass: r1.status === 403 && r2.status === 404 && r3.status === 403 && r4.code === "self_monitor", actual: `agent ${r1.status}, other business ${r2.status}, no-team manager ${r3.status}, self ${r4.status}/${r4.code}` };
  });

  await t("R2", "האזנה", "הצטרפות רק אחרי מענה; 'מאזין' רק אחרי אישור חיבור", "לפני מענה 409; אחרי: connecting → listening (הדמיה ~1s); audit started+joined", async () => {
    const c = await B3.post("/api/dialer/call", { idempotencyKey: key(), mode: "manual", phone: "0521000005" });
    const early = await MB.post("/api/manager/monitor", { callId: c.data.id });
    await waitStatus(B3, c.data.id, ["answered"]);
    const m = await MB.post("/api/manager/monitor", { callId: c.data.id });
    const s0 = m.data?.status;
    let st = m.data; const t0 = Date.now();
    while (st && st.status === "connecting" && Date.now() - t0 < 8000) { await sleep(400); st = (await MB.get(`/api/manager/monitor/${m.data.id}`)).data; }
    const live = await MB.get("/api/manager/live");
    const row = live.data.rows.find((r: any) => r.id === a3.id);
    const audits = await db.auditLog.findMany({ where: { entityType: "monitor", entityId: m.data.id }, select: { action: true } });
    await MB.del(`/api/manager/monitor/${m.data.id}`);
    await endCall(B3, c.data.id);
    return { pass: early.code === "call_not_answered" && s0 === "connecting" && st?.status === "listening" && Boolean(st.joinedAt) && row?.call?.monitors?.[0]?.status === "listening" && audits.some((a) => a.action === "monitor.started") && audits.some((a) => a.action === "monitor.joined"), actual: `early=${early.code}; start=${s0} → ${st?.status} after ${Date.now() - t0}ms; live row shows monitor=${row?.call?.monitors?.[0]?.status}; audit=${audits.map((a) => a.action).join(",")}` };
  });

  await t("R3", "האזנה", "לחיצה כפולה ושיחה אחת בכל פעם", "אותו monitor id; שיחה אחרת → 409 monitor_active עם המזהה הקיים", async () => {
    const c1 = await B3.post("/api/dialer/call", { idempotencyKey: key(), mode: "manual", phone: "0521000005" });
    const c2 = await B4.post("/api/dialer/call", { idempotencyKey: key(), mode: "manual", phone: "0521000003" });
    await waitStatus(B3, c1.data.id, ["answered"]); await waitStatus(B4, c2.data.id, ["answered"]);
    const [m1, m2] = await Promise.all([MB.post("/api/manager/monitor", { callId: c1.data.id }), MB.post("/api/manager/monitor", { callId: c1.data.id })]);
    const other = await MB.post("/api/manager/monitor", { callId: c2.data.id });
    const active = await db.callMonitor.count({ where: { managerId: (await db.user.findFirst({ where: { email: "manager@qa-b.local" } }))!.id, endedAt: null } });
    await MB.del(`/api/manager/monitor/${m1.data?.id ?? m2.data?.id}`);
    await endCall(B3, c1.data.id); await endCall(B4, c2.data.id);
    const ok = [m1, m2].filter((m) => m.status === 200);
    return { pass: ok.length === 2 && m1.data.id === m2.data.id && other.code === "monitor_active" && other.json.details?.monitorId === m1.data.id && active === 1, actual: `double: ${m1.status}/${m2.status} same=${m1.data?.id === m2.data?.id}; other call → ${other.status}/${other.code}; active monitors=${active}` };
  });

  await t("R4", "לחישה", "מעבר מפורש ללחישה וחזרה; יציאה לא פוגעת בשיחה", "whispering + audit whisper_on; listen + whisper_off; DELETE → ended והשיחה של הנציג עדיין חיה", async () => {
    const c = await B3.post("/api/dialer/call", { idempotencyKey: key(), mode: "manual", phone: "0521000005" });
    await waitStatus(B3, c.data.id, ["answered"]);
    const m = await MB.post("/api/manager/monitor", { callId: c.data.id });
    await sleep(1500); await MB.get(`/api/manager/monitor/${m.data.id}`);
    const w = await MB.patch(`/api/manager/monitor/${m.data.id}`, { mode: "whisper" });
    const l = await MB.patch(`/api/manager/monitor/${m.data.id}`, { mode: "listen" });
    const agentTry = await B3.patch(`/api/manager/monitor/${m.data.id}`, { mode: "whisper" });
    const stop = await MB.del(`/api/manager/monitor/${m.data.id}`);
    const callAfter = await db.call.findUnique({ where: { id: c.data.id } });
    const audits = (await db.auditLog.findMany({ where: { entityType: "monitor", entityId: m.data.id }, orderBy: { createdAt: "asc" }, select: { action: true } })).map((a) => a.action);
    await endCall(B3, c.data.id);
    return { pass: w.data?.status === "whispering" && w.data.mode === "whisper" && l.data?.status === "listening" && agentTry.status === 403 && stop.data?.status === "ended" && callAfter?.endedAt === null && audits.includes("monitor.whisper_on") && audits.includes("monitor.whisper_off") && audits.includes("monitor.ended"), actual: `whisper→${w.data?.status}, listen→${l.data?.status}, agent switch ${agentTry.status}, stop→${stop.data?.status}, call alive=${callAfter?.endedAt === null}; audit=${audits.join(",")}` };
  });

  await t("R5", "האזנה", "השיחה מסתיימת בזמן האזנה / בזמן התחברות", "monitor → ended (call_ended) בשני המקרים; ללא שגיאה", async () => {
    const c = await B3.post("/api/dialer/call", { idempotencyKey: key(), mode: "manual", phone: "0521000005" });
    await waitStatus(B3, c.data.id, ["answered"]);
    const m = await MB.post("/api/manager/monitor", { callId: c.data.id });
    await sleep(1500); await MB.get(`/api/manager/monitor/${m.data.id}`);
    await B3.post(`/api/dialer/call/${c.data.id}/hangup`); await waitEnd(B3, c.data.id);
    const after = await MB.get(`/api/manager/monitor/${m.data.id}`);
    await B3.post(`/api/dialer/call/${c.data.id}/outcome`, { outcome: "answered_not_interested" });
    // connecting case
    const c2 = await B3.post("/api/dialer/call", { idempotencyKey: key(), mode: "manual", phone: "0521000005" });
    await waitStatus(B3, c2.data.id, ["answered"]);
    const m2 = await MB.post("/api/manager/monitor", { callId: c2.data.id });
    await B3.post(`/api/dialer/call/${c2.data.id}/hangup`); await waitEnd(B3, c2.data.id);
    const after2 = await MB.get(`/api/manager/monitor/${m2.data.id}`);
    await B3.post(`/api/dialer/call/${c2.data.id}/outcome`, { outcome: "answered_not_interested" });
    const mine = await MB.get("/api/manager/monitor");
    return { pass: after.data.status === "ended" && after.data.error === "call_ended" && after2.data.status === "ended" && mine.data === null, actual: `while listening → ${after.data.status}/${after.data.error}; while connecting (${m2.data.status}) → ${after2.data.status}; active monitor after=${mine.data}` };
  });

  await t("R6", "זמן אמת", "עדכון תוך ~2ש׳: חיוג, מענה, ניתוק משתקפים ב-/live; מונה השיחות עולה פעם אחת", "השורה עוברת מחייג→בשיחה→תיעוד; outboundAttempts +1 בלבד", async () => {
    const before = (await MB.get("/api/manager/live")).data.today.outboundAttempts;
    const c = await B3.post("/api/dialer/call", { idempotencyKey: key(), mode: "manual", phone: "0521000005" });
    const seen: Record<string, number> = {};
    const t0 = Date.now();
    let answeredAtServer: number | null = null; // provider timestamp of the answer
    let answeredProcessedAt: number | null = null; // when the server finished applying it (DB visible)
    while (Date.now() - t0 < 40000) {
      const st = (await B3.get(`/api/dialer/call/${c.data.id}`)).data; // advances the simulation
      if (st.answeredAt && !answeredAtServer) { answeredAtServer = new Date(st.answeredAt).getTime(); answeredProcessedAt = Date.now(); }
      const reqStart = Date.now();
      const live = (await MB.get("/api/manager/live")).data;
      const row = live.rows.find((r: any) => r.id === a3.id);
      if (row && !(row.status in seen)) seen[row.status] = reqStart; // freshness is measured at request start
      if (row?.status === "in_call") break;
      await sleep(300);
    }
    const lagAnswered = answeredProcessedAt && seen.in_call ? Math.max(0, seen.in_call - answeredProcessedAt) : null;
    const lagFromProvider = answeredAtServer && seen.in_call ? seen.in_call - answeredAtServer : null;
    await B3.post(`/api/dialer/call/${c.data.id}/hangup`); await waitEnd(B3, c.data.id);
    await B3.get("/api/dialer/state"); // the agent's browser would be polling – refreshes lastSeenAt
    const t1 = Date.now(); let wrap = false;
    while (Date.now() - t1 < 6000) { const row = (await MB.get("/api/manager/live")).data.rows.find((r: any) => r.id === a3.id); if (row?.status === "wrap_up") { wrap = true; break; } await sleep(300); }
    await B3.post(`/api/dialer/call/${c.data.id}/outcome`, { outcome: "answered_not_interested" });
    const after = (await MB.get("/api/manager/live")).data.today.outboundAttempts;
    return { pass: Boolean(seen.in_call) && (seen.dialing !== undefined || seen.ringing !== undefined) && wrap && after === before + 1 && (lagAnswered === null || lagAnswered < 2500), actual: `statuses seen: ${Object.keys(seen).join("→")}; lag DB-visible→live=${lagAnswered}ms; provider-timestamp→live=${lagFromProvider}ms (כולל עיבוד הסימולציה מקומית מול Neon); wrap_up=${wrap}; attempts ${before}→${after}` };
  });

  await t("R7", "זמן אמת", "אירוע ישן לא מחזיר שיחה שהסתיימה; אירוע כפול לא מכפיל מונים", "answered מאוחר → נשאר ended; attempts ללא שינוי", async () => {
    const c = await B3.post("/api/dialer/call", { idempotencyKey: key(), mode: "manual", phone: "0521000010" });
    const e = await waitEnd(B3, c.data.id);
    await B3.post(`/api/dialer/call/${c.data.id}/outcome`, { outcome: "no_answer" });
    const before = (await MB.get("/api/manager/live")).data.today;
    const late = hook("evt-r7-" + key(), "call.answered", c.data.id, "lead", `mock-lead-${c.data.id}`);
    await anon.req("POST", "/api/webhooks/telnyx", late, sign(late));
    await anon.req("POST", "/api/webhooks/telnyx", late, sign(late));
    const dbc = await db.call.findUnique({ where: { id: c.data.id } });
    const after = (await MB.get("/api/manager/live")).data.today;
    const row = (await MB.get("/api/manager/live")).data.rows.find((r: any) => r.id === a3.id);
    return { pass: e.endedAt && dbc?.status === "ended" && dbc.answeredAt === null && after.outboundAttempts === before.outboundAttempts && after.outboundAnswered === before.outboundAnswered && row.status !== "in_call", actual: `call stays ${dbc?.status}, answeredAt=${dbc?.answeredAt}; attempts ${before.outboundAttempts}→${after.outboundAttempts}; answered ${before.outboundAnswered}→${after.outboundAnswered}; row=${row.status}` };
  });

  await t("R8", "מדדים", "מדדי היום מול נתוני בדיקה ידועים (יוצאות = ניסיונות שהספק יצר; נכשלו לפני יצירה בנפרד)", "", async () => {
    const startOfToday = new Date(); startOfToday.setHours(0, 0, 0, 0);
    const live = (await MB.get("/api/manager/live")).data.today;
    const out = await db.call.findMany({ where: { businessId: bizB, direction: "outbound", createdAt: { gte: startOfToday } }, select: { agentLegId: true, answeredAt: true, status: true, outcome: true, talkSeconds: true } });
    const attempts = out.filter((c) => c.agentLegId).length;
    const answered = out.filter((c) => c.agentLegId && c.answeredAt).length;
    const failedPre = out.filter((c) => !c.agentLegId && c.status === "failed").length;
    const allCalls = await db.call.findMany({ where: { businessId: bizB, createdAt: { gte: startOfToday } }, select: { outcome: true, answeredAt: true, talkSeconds: true } });
    const sales = allCalls.filter((c) => c.outcome === "sale").length;
    const talk = allCalls.filter((c) => c.answeredAt).reduce((a, c) => a + (c.talkSeconds ?? 0), 0);
    return { pass: live.outboundAttempts === attempts && live.outboundAnswered === answered && live.failedBeforeProvider === failedPre && live.outboundAnswerRate === (attempts ? Math.round((answered / attempts) * 100) : 0) && live.sales === sales && live.talkSeconds === talk, actual: `attempts ${live.outboundAttempts}/${attempts}, answered ${live.outboundAnswered}/${answered}, failedPre ${live.failedBeforeProvider}/${failedPre}, rate ${live.outboundAnswerRate}%, sales ${live.sales}/${sales}, talk ${live.talkSeconds}/${talk}` };
  });

  await t("R9", "סטטוסים", "דפדפן מנותק אך השיחה חיה → מוצגים שני הנתונים; אין סיום שיחה בגלל אובדן heartbeat", "status=in_call, connected=false; call.endedAt null", async () => {
    const c = await B3.post("/api/dialer/call", { idempotencyKey: key(), mode: "manual", phone: "0521000005" });
    await waitStatus(B3, c.data.id, ["answered"]);
    await db.user.update({ where: { id: a3.id }, data: { lastSeenAt: new Date(Date.now() - 5 * 60_000) } });
    await db.dialerSession.updateMany({ where: { userId: a3.id, status: { in: ["active", "paused"] } }, data: { lastHeartbeatAt: new Date(Date.now() - 5 * 60_000) } });
    await MB.get("/api/manager/dashboard"); // reaper runs – must not touch the live call
    const row = (await MB.get("/api/manager/live")).data.rows.find((r: any) => r.id === a3.id);
    const dbc = await db.call.findUnique({ where: { id: c.data.id } });
    await endCall(B3, c.data.id);
    return { pass: row.status === "in_call" && row.connected === false && dbc?.endedAt === null, actual: `status=${row.status} connected=${row.connected} call alive=${dbc?.endedAt === null}` };
  });
  blocked("R10", "האזנה", "בידוד אודיו: המנהל שומע את שני הצדדים, אף צד לא שומע אותו; בלחישה רק הנציג שומע", "נבדק בשלוש נקודות קצה אמיתיות", "אין חשבון Telnyx ומספר בדיקה. הבידוד נאכף אצל הספק (supervisor_role monitor/whisper + whisper_call_control_ids) – מאומת מול ה-OpenAPI בלבד");

  // ── output ──────────────────────────────────────────────────────────
  const summary = { total: rows.length, passed: rows.filter((r) => r.status === "עבר").length, failed: rows.filter((r) => r.status === "נכשל").length, blocked: rows.filter((r) => r.status === "חסום לבדיקה").length, missing: rows.filter((r) => r.status === "חסר במימוש").length };
  fs.writeFileSync("qa-results-api.json", JSON.stringify({ summary, rows }, null, 2));
  process.exitCode = summary.failed ? 1 : 0;
  console.log("\nSUMMARY", JSON.stringify(summary));
  for (const r of rows.filter((r) => r.status === "נכשל")) console.log(`  FAILED ${r.id}: ${r.actual}`);
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => db.$disconnect());
