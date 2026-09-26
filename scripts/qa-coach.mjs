/**
 * Browser QA for the real-time sales coach (telephony simulation + COACH_PROVIDER=mock on the server).
 * Usage: COACH_PROVIDER=mock npx next dev -p 3210   →   node scripts/qa-coach.mjs http://localhost:3210
 * Flow: enable the coach + knowledge (settings) → start a manual call from /leads → the coach card appears →
 * simulated customer line "זה יקר לי" → recommendation → feedback → hang up + outcome → learning example visible to the manager.
 */
import { chromium } from "playwright";
const BASE = process.argv[2] ?? process.env.BASE_URL ?? "http://localhost:3000";
const results = [];
const step = async (name, fn) => { try { await fn(); results.push(`✅ ${name}`); } catch (e) { results.push(`❌ ${name}: ${e.message.split("\n")[0]}`); } };
const browser = await chromium.launch();
const ctx = await browser.newContext({ locale: "he-IL", viewport: { width: 1366, height: 900 } });
const page = await ctx.newPage(); page.setDefaultTimeout(120000);
page.on("dialog", (d) => d.accept());
const shot = (n) => page.screenshot({ path: `docs/qa/coach-${n}.png` }).catch(() => undefined);
const api = async (path, method = "GET", body) => { const r = await page.request.fetch(`${BASE}${path}`, { method, data: body, headers: { "Content-Type": "application/json" }, timeout: 120000 }); return { status: r.status(), json: await r.json().catch(() => null) }; };
const stateOf = async () => (await api("/api/dialer/state")).json?.data ?? {};

await step("C0 login + cleanup + enable the coach and business knowledge", async () => {
  await page.goto(`${BASE}/login`); await page.fill('input[type="email"]', "owner@demo.local"); await page.fill('input[type="password"]', "Demo1234!"); await page.click('button[type="submit"]');
  await page.waitForURL((u) => !u.pathname.startsWith("/login"));
  for (let i = 0; i < 5; i++) { // a power session keeps dialing after a hangup – repeat until nothing is live
    const s = await stateOf();
    if (!s.activeCall && !s.wrapUpCall && (!s.session || s.session.status === "ended")) break;
    if (s.session && s.session.status !== "ended") await api("/api/dialer/session", "DELETE");
    if (s.activeCall) await api(`/api/dialer/call/${s.activeCall.id}/hangup`, "POST", {});
    if (s.wrapUpCall) await api(`/api/dialer/call/${s.wrapUpCall.id}/outcome`, "POST", { outcome: "no_answer" });
    await page.waitForTimeout(2500);
  }
  const st = await api("/api/settings", "PATCH", { settings: { coach: { enabled: true } } }); if (st.status >= 300) throw new Error(`settings ${st.status}`);
  const k = await api("/api/coach/knowledge", "PUT", { description: "סטודיו כושר בוטיק", products: [{ name: "מנוי שנתי", price: "199 ₪ לחודש" }], objections: [{ objection: "זה יקר לי", response: "מבין אותך. כדי שאדע אם זה מתאים – מה הכי חשוב לך לקבל מהמנוי?" }], forbiddenClaims: ["הבטחת תוצאות"] });
  if (k.status >= 300) throw new Error(`knowledge ${k.status} ${JSON.stringify(k.json).slice(0, 120)}`);
  const status = await api("/api/coach/status"); if (!status.json?.data?.live) throw new Error(`coach not live: ${JSON.stringify(status.json?.data)} – run the dev server with COACH_PROVIDER=mock`);
});

let callId;
await step("C1 manual call from /leads → the coach card shows inside the call screen (listening, simulation labelled)", async () => {
  await page.goto(`${BASE}/leads`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="open-dialer"]:not([disabled])');
  await page.waitForSelector(".lead-call:not([disabled])", { timeout: 120000 });
  // Some demo contacts are DNC/unsubscribed (403 on dial) – try the first rows until a call is actually placed.
  let placed = false;
  for (let i = 0; i < 6 && !placed; i++) {
    const btn = page.locator(".lead-call:not([disabled])").nth(i); if (!(await btn.count())) break;
    const res = page.waitForResponse((r) => r.url().includes("/api/dialer/call") && r.request().method() === "POST", { timeout: 60000 });
    await btn.click();
    placed = (await res).status() < 300;
  }
  if (!placed) throw new Error("no dialable lead in the first rows");
  await page.waitForURL((u) => u.pathname === "/dialer", { timeout: 60000 });
  await page.waitForSelector('[data-testid="dialer-embedded"]');
  await page.waitForSelector('[data-testid="coach-card"]', { timeout: 120000 });
  await page.waitForFunction(async () => { const r = await fetch("/api/dialer/state"); const d = (await r.json()).data; return d.activeCall?.status === "answered"; }, null, { polling: 1500 });
  callId = (await stateOf()).activeCall.id;
  await page.waitForSelector('[data-testid="coach-sim"]');
  const txt = await page.textContent('[data-testid="coach-card"]');
  if (!/מאזין/.test(txt)) throw new Error("card not in listening state");
  await shot("listening");
});

await step("C2 customer objection → one short recommendation from the approved knowledge, with latency shown", async () => {
  await page.fill('[aria-label="טקסט הדמיה"]', "תקשיב, זה יקר לי");
  await page.click('[data-testid="coach-sim-send"]');
  await page.waitForSelector('[data-testid="coach-recommendation"]', { timeout: 60000 });
  const say = await page.textContent('[data-testid="coach-say-now"]');
  if (!/הכי חשוב/.test(say)) throw new Error(`unexpected recommendation: ${say}`);
  if (say.split(" ").length > 30) throw new Error("recommendation too long");
  await page.click("text=למה זה מתאים?");
  await page.waitForSelector("text=מבוסס על הידע העסקי");
  await shot("recommendation");
});

await step("C3 feedback dismisses the card; a new objection brings a new recommendation", async () => {
  await page.click("button:has-text('מועיל')");
  await page.waitForFunction(() => !document.querySelector('[data-testid="coach-recommendation"]'), null, { timeout: 30000 });
  await page.fill('[aria-label="טקסט הדמיה"]', "אני צריך לחשוב על זה");
  await page.click('[data-testid="coach-sim-send"]');
  await page.waitForSelector('[data-testid="coach-recommendation"]', { timeout: 60000 });
  const recs = await api(`/api/coach/calls/${callId}/state`);
  if (!recs.json.data.session?.recommendation) throw new Error("no current recommendation");
});

await step("C3b 'נתקעתי? שאל את ה-AI': free-text question → one line to say + follow-up, copy button, X closes without touching the call", async () => {
  await page.click('[data-testid="coach-chat-open"]');
  await page.waitForSelector('[data-testid="coach-chat"]');
  await page.fill('[data-testid="coach-chat-input"]', "היא אומרת שזה יקר ורוצה לחשוב על זה");
  await page.click('[data-testid="coach-chat-send"]');
  await page.waitForSelector('[data-testid="coach-chat-answer"]', { timeout: 60000 });
  const say = await page.textContent('[data-testid="coach-chat-say-now"]');
  if (!say || say.split(" ").length > 30) throw new Error(`bad answer: ${say}`);
  const meta = await page.textContent('[data-testid="coach-chat-answer"] .coach-meta');
  if (!/תמלול|לפי מה שכתבת/.test(meta)) throw new Error(`sources line missing: ${meta}`);
  if (!(await page.$('[data-testid="coach-chat-answer"] button[aria-label="העתק"]'))) throw new Error("no copy button");
  const inputStillThere = await page.$('[data-testid="coach-chat-input"]:not([disabled])'); if (!inputStillThere) throw new Error("input not available after the answer");
  await page.fill('[data-testid="coach-chat-input"]', "אמרתי את זה, עכשיו היא שואלת על משלוח");
  await page.click('[data-testid="coach-chat-send"]');
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="coach-chat-answer"]').length >= 2, null, { timeout: 60000 });
  await shot("chat");
  await page.click('[data-testid="coach-chat-close"]');
  if (await page.$('[data-testid="coach-chat"]')) throw new Error("chat still open after X");
  const st = await stateOf(); if (st.activeCall?.id !== callId || st.activeCall.status !== "answered") throw new Error("closing the chat changed the call");
  await page.click('[data-testid="coach-chat-open"]');
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="coach-chat-answer"]').length >= 2, null, { timeout: 30000 }); // history kept for this call
  await page.click('[data-testid="coach-chat-close"]');
});

await step("C4 hang up + outcome → the call finishes normally; learning extracts a reviewable example for the manager", async () => {
  await page.click("button:has-text('נתק')");
  await page.waitForSelector("text=תוצאת שיחה");
  await page.locator("button", { hasText: /^ענה – מעוניין/ }).first().click();
  await page.click("button:has-text('שמור תוצאה והמשך')");
  await page.waitForSelector('[data-testid="dialer-launcher"], [data-testid="open-dialer"]');
  // events are processed by the outbox worker; kick it and wait for the example
  for (let i = 0; i < 20; i++) { if (process.env.CRON_SECRET) await page.request.get(`${BASE}/api/jobs/events`, { headers: { authorization: `Bearer ${process.env.CRON_SECRET}` }, timeout: 120000 }).catch(() => undefined); const ex = await api("/api/coach/examples?status=pending"); if ((ex.json?.data?.items ?? []).some((e) => e.callId === callId)) return; await page.waitForTimeout(3000); }
  const ex = await api("/api/coach/examples?status=pending"); throw new Error(`no example for call ${callId}: ${(ex.json?.data?.items ?? []).length} pending`);
});

await step("C5 manager: settings → מאמן AI shows knowledge, pending example with quote, approve it; metrics render", async () => {
  await page.goto(`${BASE}/settings`, { waitUntil: "domcontentloaded" });
  await page.click("button:has-text('מאמן AI')");
  await page.waitForSelector('[data-testid="coach-enabled"]');
  await page.waitForSelector('[data-testid="coach-example"]');
  await page.click('[data-testid="coach-example-approve"]');
  await page.waitForSelector("text=אושר לשימוש");
  await page.waitForSelector('[data-testid="coach-report"]');
  await shot("admin");
});

await step("C6 agent without coach: toggling the agent off hides the card next call (API)", async () => {
  const me = await api("/api/auth/me"); const id = me.json.data?.user?.id ?? me.json.data?.id;
  await api(`/api/users/${id}`, "PATCH", { coachEnabled: false });
  const st = await api("/api/coach/status"); if (st.json.data.enabled) throw new Error("still enabled");
  await api(`/api/users/${id}`, "PATCH", { coachEnabled: true });
});

await browser.close();
process.stdout.write(results.join("\n") + "\n", () => process.exit(results.some((r) => r.startsWith("❌")) ? 1 : 0));
