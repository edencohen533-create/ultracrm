/**
 * Drives the areas changed in the review-fix pass, as a user would:
 * settings → דיוור tab, contact custom fields, audience owner filter, inbound SMS → inbox reply.
 * Usage: node scripts/qa-review-fixes.mjs [baseUrl]
 */
import crypto from "node:crypto";
import { chromium } from "playwright";
const BASE = process.argv[2] ?? "http://localhost:3000";
const results = [];
let n = 0;
const step = async (name, fn) => { n++; try { await fn(); results.push(`✅ ${name}`); } catch (e) { await page.screenshot({ path: `docs/qa/fix-fail-${n}.png`, fullPage: true }).catch(() => undefined); results.push(`❌ ${name}: ${e.message.split("\n")[0]}`); } };
const browser = await chromium.launch();
const ctx = await browser.newContext({ locale: "he-IL", viewport: { width: 1280, height: 900 } });
const page = await ctx.newPage();
const shot = (n) => page.screenshot({ path: `docs/qa/fix-${n}.png`, fullPage: true }).catch(() => undefined);
const stamp = Date.now();
const fromPhone = `+97250${String(stamp).slice(-7)}`;

await step("login as owner", async () => {
  await page.goto(`${BASE}/login`);
  await page.fill('input[type="email"]', "owner@demo.local");
  await page.fill('input[type="password"]', "Demo1234!");
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 60000 });
});
await step("settings → דיוור tab: window / rate / frequency saved and persisted", async () => {
  await page.goto(`${BASE}/settings`, { waitUntil: "networkidle" });
  await page.click('button:has-text("דיוור")');
  await page.waitForSelector("text=חלון שליחה, קצב ותדירות", { timeout: 30000 });
  const rate = page.locator('label:has-text("מקסימום נמענים לדקה") input');
  await rate.fill("45");
  await page.click('button:has-text("שמור")');
  await page.waitForSelector("text=נשמר", { timeout: 15000 });
  const r = await page.request.get(`${BASE}/api/settings`);
  const j = await r.json();
  if (j.data.settings.marketing.maxPerMinute !== 45) throw new Error(`persisted ${j.data.settings.marketing.maxPerMinute}`);
  await rate.fill("60");
  await page.click('button:has-text("שמור")');
  await shot("marketing-settings");
});
await step("contact card: add a custom field, save, see it displayed and usable", async () => {
  await page.goto(`${BASE}/contacts`, { waitUntil: "networkidle" });
  await page.locator('a[href^="/contacts/"]:not([href*="duplicates"])').first().click();
  await page.waitForSelector("text=פרטים", { timeout: 30000 });
  await page.click('button:has-text("עריכה")');
  await page.click('button:has-text("+ הוסף שדה")');
  await page.fill('input[placeholder="שם שדה"] >> nth=-1', `qa_${stamp}`);
  await page.fill('input[placeholder="ערך"] >> nth=-1', "ערך לבדיקה");
  await page.click('button:has-text("שמור")');
  await page.waitForSelector(`text=qa_${stamp}`, { timeout: 30000 });
  const t = await page.textContent("body");
  if (!t.includes("ערך לבדיקה")) throw new Error("custom value not displayed");
  await shot("contact-custom-field");
});
await step("audience editor offers owner / lead-status filters and previews a count", async () => {
  await page.goto(`${BASE}/campaigns`, { waitUntil: "networkidle" });
  await page.click('button:has-text("רשימות תפוצה")');
  await page.check('input[type="checkbox"] >> nth=0');
  await page.selectOption('select[aria-label="סוג תנאי 1.1"]', "owner");
  await page.selectOption('select[aria-label="ערך תנאי 1.1"]', { index: 1 });
  await page.click('button:has-text("בדוק קהל וזכאות")');
  await page.waitForSelector("text=מתאימים לתנאים", { timeout: 30000 });
  await page.selectOption('select[aria-label="סוג תנאי 1.1"]', "leadStatus");
  await page.click('button:has-text("בדוק קהל וזכאות")');
  await page.waitForSelector("text=מתאימים לתנאים", { timeout: 30000 });
  await shot("audience-owner");
});
await step("inbound SMS (signed mock webhook) → SMS conversation in inbox → free-text reply accepted", async () => {
  const creds = await (await page.request.get(`${BASE}/api/channels/sms`)).json();
  const cred = creds.data.items.find((c) => c.isActive && c.provider === "mock_sms");
  if (!cred) throw new Error("no simulation SMS credential in demo data");
  const body = JSON.stringify({ eventId: `qa-in-${stamp}`, providerMessageId: `qa-in-${stamp}`, inbound: { from: fromPhone, to: "+972501110000", body: "שלום, יש לכם מלאי?" } });
  const sig = crypto.createHmac("sha256", "mock-sms-demo").update(body).digest("hex");
  const r = await page.request.post(`${BASE}/api/webhooks/sms/mock/${cred.id}`, { data: body, headers: { "Content-Type": "application/json", "x-mock-signature": sig } });
  if (r.status() !== 200) throw new Error(`webhook ${r.status()} ${await r.text()}`);
  const bad = await page.request.post(`${BASE}/api/webhooks/sms/mock/${cred.id}`, { data: body, headers: { "Content-Type": "application/json", "x-mock-signature": "0".repeat(64) } });
  if (bad.status() !== 401) throw new Error(`bad signature accepted: ${bad.status()}`);
  await page.goto(`${BASE}/inbox`, { waitUntil: "networkidle" });
  const item = page.locator('a[href^="/inbox/"]', { hasText: "יש לכם מלאי?" }).first();
  await item.waitFor({ timeout: 30000 });
  await item.click();
  await page.waitForURL(/\/inbox\/.+/, { timeout: 30000 });
  await page.waitForSelector("text=SMS", { timeout: 30000 });
  await page.fill('textarea[placeholder="הקלד הודעה..."]', "כן, מוזמנים להגיע היום");
  await page.click('button:has-text("שלח")');
  await page.waitForSelector("text=כן, מוזמנים להגיע היום", { timeout: 30000 });
  const conv = page.url().split("/inbox/")[1];
  const msgs = await (await page.request.get(`${BASE}/api/conversations/${conv}/messages`)).json();
  const reply = (msgs.messages ?? msgs.data?.messages ?? msgs).find?.((m) => m.body === "כן, מוזמנים להגיע היום");
  if (reply && reply.status && !["ACCEPTED", "SENT"].includes(reply.status)) throw new Error(`reply status ${reply.status}`);
  await shot("inbox-sms-reply");
});
await browser.close();
process.stdout.write(results.join("\n") + "\n", () => process.exit(results.some((r) => r.startsWith("❌")) ? 1 : 0));
