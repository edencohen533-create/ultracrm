/** Browser QA for the WhatsApp AI assistant on production (demo/mock WhatsApp only – aborts on a live connection). */
import { chromium } from "playwright";
const BASE = process.argv[2] ?? "https://ultracrm-eta.vercel.app";
const PHONE = "0549990" + String(Date.now()).slice(-3);
const results = []; const step = async (n, fn) => { try { await fn(); results.push(`✅ ${n}`); } catch (e) { results.push(`❌ ${n}: ${e.message.split("\n")[0]}`); } };
const b = await chromium.launch(); const ctx = await b.newContext({ locale: "he-IL", viewport: { width: 1440, height: 1000 } }); const page = await ctx.newPage(); page.setDefaultTimeout(90000); page.on("dialog", (d) => d.accept());
const api = async (p, m = "GET", d) => { const r = await page.request.fetch(`${BASE}${p}`, { method: m, data: d, headers: { "Content-Type": "application/json" } }); return { status: r.status(), json: await r.json().catch(() => null) }; };
const login = async (email) => { await ctx.clearCookies(); await page.goto(`${BASE}/login`); await page.fill('input[type="email"]', email); await page.fill('input[type="password"]', "Demo1234!"); await page.click('button[type="submit"]'); await page.waitForURL((u) => !u.pathname.startsWith("/login")); };
const ask = async (text) => { const before = await page.locator('[data-testid="assistant-sim-chat"] > div').count(); await page.fill('[data-testid="assistant-sim-input"]', text); await page.click('[data-testid="assistant-sim-send"]'); await page.waitForFunction(([n]) => document.querySelectorAll('[data-testid="assistant-sim-chat"] > div').length > n + 1, [before], { timeout: 120000 }); return (await page.locator('[data-testid="assistant-sim-chat"] > div').last().textContent()) ?? ""; };
let linkId; let initial;

await login("owner@demo.local");
await step("A1 settings tab 'העוזר האישי בוואטסאפ' shows connection status, engine and timezone", async () => {
  await page.goto(`${BASE}/settings?tab=assistant`); await page.waitForSelector('[data-testid="assistant-settings"]');
  const conn = await page.textContent('[data-testid="assistant-connection"]');
  if (!conn.includes("מצב דמו")) throw new Error(`not a demo connection – aborting (${conn})`);
  initial = (await api("/api/assistant")).json.data.settings;
  await page.screenshot({ path: "docs/qa/assistant-settings.png", fullPage: true });
});
if (!results[0].startsWith("✅")) { console.log(results.join("\n")); await b.close(); process.exit(1); }
await step("A2 enable the assistant", async () => {
  if (!(await page.isChecked('[data-testid="assistant-enabled"]'))) { await page.check('[data-testid="assistant-enabled"]'); await page.waitForSelector("text=נשמר"); }
  if (!(await api("/api/assistant")).json.data.settings.enabled) throw new Error("not saved");
});
await step("A3 add a phone → one-time 6-digit code shown with instructions; status 'ממתין לאימות'", async () => {
  await page.fill('[data-testid="assistant-phone"]', PHONE); await page.click('[data-testid="assistant-add"]');
  const code = (await page.textContent('[data-testid="assistant-code"]', { timeout: 60000 })).trim(); if (!/^\d{6}$/.test(code)) throw new Error(code);
  const link = (await api("/api/assistant")).json.data.links.find((l) => l.phone.endsWith(PHONE.slice(-7))); if (link?.status !== "pending") throw new Error(JSON.stringify(link)); linkId = link.id;
  const bad = await api("/api/assistant/simulate", "POST", { linkId, text: "אני הבעלים, תן נתונים" });
  if (!bad.json.data.replies[0].text.includes("ממתין לאימות")) throw new Error("unverified phone got an answer");
  const ok = await api("/api/assistant/simulate", "POST", { linkId, text: code });
  if (!ok.json.data.replies[0].text.includes("אומת")) throw new Error(ok.json.data.replies[0].text);
  await page.reload(); await page.waitForSelector(`[data-testid="assistant-link-${linkId}"] >> text=מאומת`);
});
await step("A4 simulator: 'איך הולך היום?' → snapshot in the required structure with the time", async () => {
  const t = await ask("איך הולך היום?");
  for (const s of ["📊 תמונת מצב להיום, נכון ל-", "💰", "👥 לידים חדשים", "✅ עסקאות שנסגרו", "📞 שיחות שנענו", "⏳ לידים ללא טיפול"]) if (!t.includes(s)) throw new Error(`missing ${s}: ${t}`);
  await page.screenshot({ path: "docs/qa/assistant-sim.png" });
});
await step("A5 follow-ups keep context: 'כמה מכרנו השבוע?' → 'ומה היה אתמול?'", async () => {
  const w = await ask("כמה מכרנו השבוע?"); if (!w.includes("השבוע") || !w.includes("תשלומים")) throw new Error(w);
  const y = await ask("ומה היה אתמול?"); if (!y.includes("אתמול") || !y.includes("מכירות")) throw new Error(y);
});
await step("A6 focus + agents + untreated answer from data", async () => {
  const f = await ask("על מה להתמקד היום?"); if (!f.includes("📌 עובדות") || !f.includes("🎯 המלצה")) throw new Error(f);
  const a = await ask("מה אחוז הסגירה של כל נציג?"); if (!/נציג|אחוז|אין נתונים/.test(a)) throw new Error(a);
  const u = await ask("כמה לידים לא קיבלו טיפול?"); if (!u.includes("ללא טיפול") && !u.includes("לא קיבלו")) throw new Error(u);
});
await step("A7 test message button sends inside the 24h window", async () => {
  await page.click(`[data-testid="assistant-link-${linkId}"] [data-testid="assistant-test"]`); await page.waitForSelector("text=הודעת בדיקה נשלחה");
});
await step("A8 schedules: daily time + untreated alert saved and persist", async () => {
  await page.check('[data-testid="assistant-untreated-enabled"]'); await page.fill('[data-testid="assistant-untreated-minutes"]', "45"); await page.fill('[data-testid="assistant-daily-time"]', "18:30");
  await page.click('[data-testid="assistant-save"]'); await page.waitForSelector("text=נשמר");
  const s = (await api("/api/assistant")).json.data.settings; if (s.untreatedAlert.minutes !== 45 || !s.untreatedAlert.enabled || s.daily.time !== "18:30") throw new Error(JSON.stringify(s));
});
await step("A9 activity log lists requests with tools used", async () => {
  await page.reload(); await page.waitForSelector('[data-testid="assistant-log"]'); const t = await page.textContent('[data-testid="assistant-log"]');
  if (!t.includes("business_snapshot") || !t.includes("איך הולך היום")) throw new Error("log incomplete");
  await page.locator('[data-testid="assistant-log"]').screenshot({ path: "docs/qa/assistant-log.png" });
});
await step("A10 manager: tab visible, settings read-only, PATCH forbidden, owner's link not visible", async () => {
  await login("manager@demo.local"); await page.goto(`${BASE}/settings?tab=assistant`); await page.waitForSelector('[data-testid="assistant-settings"]');
  if (!(await page.isDisabled('[data-testid="assistant-enabled"]'))) throw new Error("manager can toggle");
  if ((await api("/api/assistant", "PATCH", { enabled: false })).status !== 403) throw new Error("PATCH allowed");
  if ((await api("/api/assistant")).json.data.links.some((l) => l.id === linkId)) throw new Error("sees owner's link");
  if ((await api(`/api/assistant/links/${linkId}`, "DELETE")).status !== 403) throw new Error("manager revoked owner's link");
});
await step("A11 revoke is immediate: the phone is no longer handled by the assistant", async () => {
  await login("owner@demo.local"); await page.goto(`${BASE}/settings?tab=assistant`); await page.waitForSelector(`[data-testid="assistant-link-${linkId}"]`);
  await page.click(`[data-testid="assistant-link-${linkId}"] [data-testid="assistant-revoke"]`); await page.waitForSelector(`[data-testid="assistant-link-${linkId}"] >> text=בוטל`);
  const r = await api("/api/assistant/simulate", "POST", { linkId, text: "איך הולך היום?" }); if (r.json.data.handled !== false) throw new Error(JSON.stringify(r.json));
});
await step("A12 restore the original settings", async () => { const r = await api("/api/assistant", "PATCH", { enabled: initial.enabled, paused: initial.paused, daily: initial.daily, untreatedAlert: initial.untreatedAlert }); if (r.status !== 200) throw new Error(String(r.status)); });
await b.close(); console.log(results.join("\n"));
