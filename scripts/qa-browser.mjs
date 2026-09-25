/**
 * Browser QA for the unified flow (simulation telephony + mock WhatsApp).
 * Usage: BASE_URL=http://localhost:3100 node scripts/qa-browser.mjs
 * Writes screenshots to docs/qa/shots and a JSON summary to docs/qa/browser-results.json.
 * Never talks to a real provider.
 */
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.BASE_URL ?? "http://localhost:3100";
const OUT = path.join(process.cwd(), "docs", "qa", "shots");
fs.mkdirSync(OUT, { recursive: true });
const results = [];
const step = async (name, fn) => {
  try {
    const detail = await fn();
    results.push({ name, status: "pass", detail: detail ?? null });
    console.log("PASS", name, detail ? JSON.stringify(detail).slice(0, 160) : "");
  } catch (err) {
    results.push({ name, status: "fail", detail: String(err?.message ?? err).slice(0, 300) });
    console.log("FAIL", name, err?.message ?? err);
  }
};
const shot = (page, name) => page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: false });

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "he-IL", permissions: ["microphone"] });
const page = await context.newPage();
const consoleErrors = [];
page.on("pageerror", (e) => consoleErrors.push(`${e.message}\n${String(e.stack ?? "").split("\n").slice(0, 4).join("\n")}`));
page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text().slice(0, 200)); });

let contactId = "";
const runTag = String(Date.now()).slice(-6);
const contactName = `[דמו] דפדפן QA ${runTag}`;
const phone = `05299${String(Date.now()).slice(-4)}3`; // last digit 3 → the simulation answers

await step("B1 login (single login for every module)", async () => {
  await page.goto(`${BASE}/login`);
  await page.fill('input[type="email"]', "owner@demo.local");
  await page.fill('input[type="password"]', "Demo1234!");
  await page.click('button[type="submit"]');
  await page.waitForURL("**/leads", { timeout: 60000 });
  await page.waitForSelector("text=דשבורד");
  await shot(page, "B1-dashboard");
  return { url: page.url() };
});

await step("B1a cleanup: finish any call left by a previous run (server truth via API)", async () => {
  const st = await (await page.request.get(`${BASE}/api/dialer/state`)).json();
  const call = st.data?.activeCall ?? st.data?.wrapUpCall;
  if (!call) return { cleaned: false };
  if (!call.endedAt) { await page.request.post(`${BASE}/api/dialer/call/${call.id}/hangup`); await page.waitForTimeout(3000); await page.request.get(`${BASE}/api/dialer/state`); }
  await page.request.post(`${BASE}/api/dialer/call/${call.id}/outcome`, { data: { outcome: "no_answer", note: "QA cleanup" } });
  return { cleaned: call.id };
});

await step("B1b warm up dev compilation of every screen", async () => {
  for (const p of ["/contacts", "/leads", "/deals", "/tasks", "/inbox", "/campaigns", "/templates", "/automations", "/calls", "/reports", "/lists", "/manager", "/settings", "/dashboard"]) {
    await page.goto(`${BASE}${p}`, { waitUntil: "networkidle", timeout: 120000 }).catch(() => undefined);
  }
});

await step("B2 sidebar shows CRM + messaging + telephony for the Pro business", async () => {
  for (const label of ["אנשי קשר", "לידים", "עסקאות", "משימות", "תיבת הודעות", "קמפיינים וקהלים", "חייגן", "רשימות חיוג", "הגדרות"]) {
    await page.waitForSelector(`aside >> text=${label}`, { timeout: 10000 });
  }
  await page.waitForSelector("aside >> text=הדמיה", { timeout: 20000 });
  return { telephony: "simulation badge visible" };
});

await step("B3 create contact from the CRM screen", async () => {
  await page.goto(`${BASE}/contacts`);
  await page.click("text=+ איש קשר");
  await page.fill('label:has-text("שם מלא") input', contactName);
  await page.fill('label:has-text("טלפון") input', phone);
  await page.selectOption('label:has-text("הסכמה לדיוור") select', "OPTED_IN");
  await page.fill('label:has-text("אסמכתה") input', "QA browser consent");
  await page.click('div[role="dialog"] >> text=צור');
  await page.waitForSelector("text=איש הקשר נוצר", { timeout: 15000 });
  await page.fill('input[placeholder^="חיפוש"]', phone.slice(-4));
  await page.waitForSelector(`text=${contactName}`, { timeout: 15000 });
  await shot(page, "B3-contacts");
  const href = await page.getAttribute(`a:has-text("${contactName}")`, "href");
  contactId = href.split("/").pop();
  return { contactId, phone };
});

await step("B4 contact card: dial + WhatsApp + lead + deal + task actions present", async () => {
  await page.goto(`${BASE}/contacts/${contactId}`);
  await page.waitForSelector("text=ציר פעילות");
  for (const label of ["חייג", "שלח WhatsApp", "+ ליד", "+ עסקה", "+ משימה", "הסר מדיוור שיווקי"]) await page.waitForSelector(`button:has-text("${label}")`);
  await shot(page, "B4-contact-card");
});

await step("B5 create lead from the card → owner + first-contact task appear (event pipeline)", async () => {
  await page.click('button:has-text("+ ליד")');
  await page.fill('div[role="dialog"] label:has-text("כותרת") input', "ליד מהדפדפן");
  await page.click('div[role="dialog"] >> text=צור ליד');
  await page.waitForSelector("text=הליד נוצר", { timeout: 15000 });
  await page.waitForTimeout(2500);
  await page.reload();
  await page.waitForSelector("text=פנייה ראשונית לליד", { timeout: 20000 });
  await shot(page, "B5-lead-and-task");
});

await step("B6 dial from the card (simulation) → call bar appears", async () => {
  await page.click('button:has-text("חייג")');
  await page.waitForSelector("text=הדמיה", { timeout: 15000 });
  await page.waitForFunction(() => document.body.innerText.includes("מחייג ללקוח") || document.body.innerText.includes("מצלצל") || document.body.innerText.includes("בשיחה"), null, { timeout: 20000 });
  await shot(page, "B6-call-from-card");
});

await step("B7 navigate CRM → inbox → contacts during the call: call bar persists (no drop, no 2nd connection)", async () => {
  await page.click('aside >> text=תיבת הודעות');
  await page.waitForURL("**/inbox**", { timeout: 60000 });
  await page.waitForSelector('text=/למסך החיוג|ממתינה לתיעוד/', { timeout: 30000 });
  await shot(page, "B7-inbox-during-call");
  await page.click('aside >> text=אנשי קשר');
  await page.waitForURL("**/contacts**", { timeout: 60000 });
  await page.waitForSelector('text=/למסך החיוג|ממתינה לתיעוד/', { timeout: 30000 });
  const audioCount = await page.evaluate(() => document.querySelectorAll("#remote-audio").length);
  if (audioCount !== 1) throw new Error(`expected 1 audio sink, found ${audioCount}`);
  return { audioSinks: audioCount };
});

await step("B8 dial button disabled while a call is live (no second call)", async () => {
  await page.goto(`${BASE}/contacts/${contactId}`);
  await page.waitForSelector('button:text-is("חייג")');
  await page.waitForTimeout(2500); // dialer state poll
  const disabled = await page.isDisabled('button:text-is("חייג")');
  if (!disabled) throw new Error("dial button enabled during live call / pending wrap-up");
});

await step("B9 hang up and save outcome + note in the dialer screen; follow-up task created", async () => {
  await page.goto(`${BASE}/leads`); // the dialer workspace lives inside /leads while a call / wrap-up exists
  await page.waitForTimeout(8000); // let the simulated call answer (last digit ≠ 0/1/2 → answered)
  const hang = page.locator("main button", { hasText: /^נתק/ }).first();
  await hang.waitFor({ timeout: 30000 });
  await hang.click();
  // Server truth: the provider (simulation) must report the call ended.
  await page.waitForFunction(async () => { const r = await fetch("/api/dialer/state"); const d = (await r.json()).data; return !d.activeCall && d.wrapUpCall; }, null, { timeout: 60000, polling: 1500 });
  await page.waitForSelector('button:has-text("ענה – מעוניין")', { timeout: 60000 });
  const note = page.locator("textarea").first();
  if (await note.count()) await note.fill("הערת QA מהדפדפן");
  await page.click('button:has-text("ענה – מעוניין")');
  const save = page.locator('button:has-text("שמור")').first();
  if (await save.count()) await save.click().catch(() => undefined);
  await page.waitForTimeout(3000);
  await shot(page, "B9-outcome-saved");
  // Server truth first: the outcome event must produce the follow-up task (event worker runs after the response + cron safety net).
  await page.waitForFunction(async (id) => { const r = await fetch(`/api/tasks?contactId=${id}&status=open&limit=50`); const d = (await r.json()).data; return (d?.items ?? []).some((t) => t.type === "follow_up" && (t.title ?? "").includes("מעקב אחרי שיחה")); }, contactId, { timeout: 120000, polling: 2000 });
  await page.goto(`${BASE}/contacts/${contactId}`);
  await page.waitForSelector("text=מעקב אחרי שיחה", { timeout: 60000 });
  await page.waitForSelector("text=ענה – מעוניין", { timeout: 60000 });
  await shot(page, "B9-card-after-call");
});

await step("B10 WhatsApp from the card → inbox conversation (mock provider) → message in card timeline", async () => {
  await page.goto(`${BASE}/contacts/${contactId}`);
  await page.click('button:has-text("שלח WhatsApp")');
  await page.waitForURL("**/inbox/**", { timeout: 60000 });
  await page.waitForSelector("text=כרטיס לקוח והסרה מדיוור", { timeout: 60000 });
  const conversationId = page.url().split("/").pop();
  await shot(page, "B10-inbox-conversation");
  // Simulate an inbound reply through the real inbound path (demo simulator).
  const res = await page.request.post(`${BASE}/api/demo/simulate-inbound`, { data: { contactId, body: "היי, תשובת בדיקה" } });
  if (!res.ok()) throw new Error(`simulate-inbound ${res.status()}`);
  await page.reload();
  await page.waitForSelector("text=היי, תשובת בדיקה", { timeout: 20000 });
  // Now the 24h service window is open – send a free-text reply.
  const composer = page.locator("textarea:visible").last();
  await composer.waitFor({ timeout: 60000 });
  const sends = [];
  const onResp = (r) => { if (r.url().includes(`/api/conversations/${conversationId}/messages`) && r.request().method() === "POST") sends.push(r.status()); };
  page.on("response", onResp);
  await composer.fill("תודה, נחזור אליך");
  await page.locator("button", { hasText: /^שלח$/ }).last().click();
  // Server truth: an OUTBOUND message must exist for this conversation.
  await page.waitForFunction(async (id) => { const r = await fetch(`/api/conversations/${id}/messages`); const d = await r.json(); return (d.messages ?? []).some((m) => m.direction === "OUTBOUND" && (m.body ?? "").includes("נחזור אליך")); }, conversationId, { timeout: 120000, polling: 2000 });
  page.off("response", onResp);
  await page.waitForSelector("text=תודה, נחזור אליך", { timeout: 60000 });
  console.log("   send responses:", sends.join(","));
  await shot(page, "B10-inbox-reply");
  await page.goto(`${BASE}/contacts/${contactId}`);
  await page.waitForSelector("text=הודעה נכנסת · WhatsApp", { timeout: 60000 });
  await page.waitForSelector("text=תודה, נחזור אליך", { timeout: 60000 });
  await shot(page, "B10-card-timeline");
  return { conversationId };
});

await step("B11 unsubscribe via inbound 'הסר' → card shows suppression, WhatsApp marketing blocked", async () => {
  const res = await page.request.post(`${BASE}/api/demo/simulate-inbound`, { data: { contactId, body: "הסר" } });
  if (!res.ok()) throw new Error(`simulate-inbound ${res.status()}`);
  await page.goto(`${BASE}/contacts/${contactId}`);
  await page.waitForSelector("text=הוסר מדיוור שיווקי", { timeout: 20000 });
  await shot(page, "B11-suppressed");
});

await step("B12 update lead status from the leads screen and see it on the card", async () => {
  await page.goto(`${BASE}/leads`);
  await page.fill('input[placeholder="חיפוש"]', "דפדפן");
  await page.waitForSelector(`text=${contactName}`, { timeout: 15000 });
  const select = page.locator("tr", { hasText: contactName }).locator("select").first();
  await select.selectOption("qualified");
  await page.waitForTimeout(1500);
  await page.goto(`${BASE}/contacts/${contactId}`);
  await page.waitForSelector("text=מתאים", { timeout: 15000 });
  await shot(page, "B12-lead-status");
});

await step("B13 logout + login again → data persisted server-side", async () => {
  await page.click("text=התנתקות");
  await page.waitForURL("**/login");
  await page.fill('input[type="email"]', "agent1@demo.local");
  await page.fill('input[type="password"]', "Demo1234!");
  await page.click('button[type="submit"]');
  await page.waitForURL("**/leads", { timeout: 60000 });
  const hasSettings = await page.locator('aside >> text=הגדרות').count();
  if (hasSettings) throw new Error("agent sees settings nav");
  await page.goto(`${BASE}/contacts/${contactId}`);
  await page.waitForSelector(`text=${contactName}`, { timeout: 15000 });
  await shot(page, "B13-agent-view");
});

await step("B14 business switcher (owner belongs to two businesses; second has no telephony)", async () => {
  await page.click("text=התנתקות");
  await page.waitForURL("**/login");
  await page.fill('input[type="email"]', "owner@demo.local");
  await page.fill('input[type="password"]', "Demo1234!");
  await page.click('button[type="submit"]');
  await page.waitForURL("**/leads", { timeout: 60000 });
  const switcher = page.locator('select[aria-label="בחירת עסק"]');
  await switcher.waitFor({ timeout: 10000 });
  const options = await switcher.locator("option").allTextContents();
  await switcher.selectOption({ index: 1 });
  await page.waitForTimeout(3000);
  await page.waitForFunction(() => { const s = document.querySelector('select[aria-label="בחירת עסק"]'); return s && s.options[s.selectedIndex]?.textContent?.includes("עסק שני"); }, null, { timeout: 60000 });
  await page.waitForSelector("aside >> text=Starter", { timeout: 30000 });
  const dialerNav = await page.locator('aside >> text=חייגן').count();
  if (dialerNav) throw new Error("telephony nav visible for Starter business");
  await page.goto(`${BASE}/contacts`);
  await page.waitForSelector("text=לקוח של עסק ב", { timeout: 15000 });
  const leaked = await page.locator(`text=${contactName}`).count();
  if (leaked) throw new Error("contact of business A visible in business B");
  await shot(page, "B14-business-b");
  return { options };
});

await step("B15 settings screens render (owner)", async () => {
  await page.locator('select[aria-label="בחירת עסק"]').selectOption({ index: 0 });
  await page.waitForTimeout(3000);
  await page.goto(`${BASE}/settings`);
  for (const t of ["חבילה ומכסות", "אוטומציות", "הסרות מדיוור", "חיבורים"]) {
    await page.click(`button:has-text("${t}")`);
    await page.waitForTimeout(1200);
    await shot(page, `B15-settings-${t}`);
  }
  await page.goto(`${BASE}/settings/whatsapp`);
  await page.waitForSelector("text=חיבור וואטסאפ", { timeout: 15000 });
  await shot(page, "B15-settings-whatsapp");
  await page.goto(`${BASE}/campaigns`);
  await page.waitForSelector("text=קמפיינים", { timeout: 15000 });
  await shot(page, "B15-campaigns");
  await page.goto(`${BASE}/manager`);
  await page.waitForSelector("text=מוקד בזמן אמת", { timeout: 15000 });
  await shot(page, "B15-manager");
});

results.push({ name: "console errors", status: consoleErrors.length ? "warn" : "pass", detail: consoleErrors.slice(0, 20) });
fs.writeFileSync(path.join(process.cwd(), "docs", "qa", "browser-results.json"), JSON.stringify({ base: BASE, ranAt: new Date().toISOString(), results }, null, 2));
console.log("\nSummary:", results.filter((r) => r.status === "pass").length, "pass /", results.filter((r) => r.status === "fail").length, "fail");
await browser.close();
