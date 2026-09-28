/** QA (production, demo/mock WhatsApp): free-text alerts + "who is on the line" through the real inbound path
 *  (/api/assistant/simulate). The owner links a demo phone, asks in free text, agent1 connects to the dialer
 *  (manual session, nothing dialed) → the owner's link receives "התחבר/ה לחייגן"; online-time question; recurring
 *  summary saved; everything removed / restored at the end. */
import "dotenv/config";
import crypto from "node:crypto";
import { chromium } from "playwright";
const BASE = process.argv[2] ?? "https://ultracrm-eta.vercel.app";
const PHONE = "0549991" + String(Date.now()).slice(-3);
const results = []; const step = async (n, fn) => { try { await fn(); results.push(`✅ ${n}`); } catch (e) { results.push(`❌ ${n}: ${e.message.split("\n")[0].slice(0, 300)}`); } };
const b = await chromium.launch(); const ctx = await b.newContext({ locale: "he-IL" }); const page = await ctx.newPage(); page.setDefaultTimeout(90000);
const api = async (p, m = "GET", d) => { const r = await page.request.fetch(`${BASE}${p}`, { method: m, data: d, headers: { "Content-Type": "application/json" } }); return { status: r.status(), json: await r.json().catch(() => null) }; };
const login = async (email) => { await ctx.clearCookies(); await page.goto(`${BASE}/login`); await page.fill('input[type="email"]', email); await page.fill('input[type="password"]', "Demo1234!"); await page.click('button[type="submit"]'); await page.waitForURL((u) => !u.pathname.startsWith("/login")); };
const say = async (text) => { const r = await api("/api/assistant/simulate", "POST", { linkId, text }); if (r.status !== 200) throw new Error(`simulate ${r.status} ${JSON.stringify(r.json).slice(0, 200)}`); return r.json.data.replies.map((x) => x.text).join("\n"); };
let linkId, initial, sessionId, browserSessionId;

await login("owner@demo.local");
await step("L0 demo connection only; enable the assistant; link + verify a demo phone for the owner", async () => {
  const s = (await api("/api/assistant")).json.data; initial = s.settings;
  if (s.connection && s.connection.provider && s.connection.provider !== "mock") throw new Error("live WhatsApp – aborting");
  await api("/api/assistant", "PATCH", { enabled: true, paused: false });
  const r = await api("/api/assistant/links", "POST", { phone: PHONE, scope: "business" }); if (r.status !== 201) throw new Error(`link ${r.status}`);
  linkId = r.json.data.link.id;
  if (!(await say(r.json.data.code)).includes("אומת")) throw new Error("verify failed");
});
await step("L1 free text: 'אני רוצה לקבל התראה כשהנציגים עולים לקו' → confirmed; listed", async () => {
  const r = await say("אני רוצה לקבל התראה כשהנציגים עולים לקו"); if (!r.includes("✅")) throw new Error(r);
  const l = await say("מה ההתראות שלי?"); if (!l.includes("מתחבר/ת לחייגן")) throw new Error(l);
});
await step("L2 agent1 connects to the dialer → the owner's WhatsApp gets 'התחבר/ה לחייגן'", async () => {
  await login("agent1@demo.local");
  const st = (await api("/api/dialer/state")).json?.data;
  if (st?.session?.id) throw new Error("agent1 already connected – run later");
  browserSessionId = crypto.randomUUID();
  const s = await api("/api/dialer/session", "POST", { mode: "manual", browserSessionId }); if (s.status !== 200 && s.status !== 201) throw new Error(`session ${s.status} ${JSON.stringify(s.json).slice(0, 200)}`);
  sessionId = s.json.data.id ?? s.json.data.session?.id;
  await login("owner@demo.local");
  for (let i = 0; i < 12; i++) { await page.request.fetch(`${BASE}/api/jobs/events`, { headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } }).catch(() => {}); const msgs = (await api("/api/assistant/log")).json?.data; const hit = JSON.stringify(msgs ?? "").includes("התחבר/ה לחייגן"); if (hit) return; await new Promise((r) => setTimeout(r, 5000)); }
  throw new Error("no online alert in the assistant log");
});
await step("L3 'כמה זמן כל נציג היה בקו היום?' / 'מי מחובר עכשיו?'", async () => {
  const r = await say("כמה זמן כל נציג היה בקו היום?"); if (!r.includes("זמני קו היום")) throw new Error(r.slice(0, 200));
  const n = await say("מי מחובר עכשיו?"); if (!n.includes("מחוברים עכשיו:")) throw new Error(n.slice(0, 200));
});
await step("L4 'כל יום ב-18:00 תשלח לי כמה כל נציג היה בקו' → saved; cancel both", async () => {
  if (!(await say("כל יום ב-18:00 תשלח לי כמה כל נציג היה בקו")).includes("✅")) throw new Error("schedule");
  if (!(await say("מה ההתראות שלי")).includes("18:00")) throw new Error("not listed");
  await say("בטל את הסיכום היומי"); await say("תפסיק להודיע לי כשנציגים עולים לקו");
  if (!(await say("מה ההתראות שלי")).includes("אין לך התראות")) throw new Error("not removed");
});
await step("L5 cleanup: end agent1 session, remove the demo link, restore settings", async () => {
  await login("agent1@demo.local"); if (sessionId) await api("/api/dialer/session", "DELETE", { sessionId, browserSessionId });
  await login("owner@demo.local"); await api(`/api/assistant/links/${linkId}`, "DELETE");
  const r = await api("/api/assistant", "PATCH", { enabled: initial.enabled, paused: initial.paused }); if (r.status !== 200) throw new Error(String(r.status));
});
await b.close(); console.log(results.join("\n"));
