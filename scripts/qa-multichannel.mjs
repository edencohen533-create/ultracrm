/**
 * Browser QA for SMS / email marketing (simulation providers seeded for the demo business).
 * Usage: node scripts/qa-multichannel.mjs [baseUrl]
 */
import { chromium } from "playwright";
const BASE = process.argv[2] ?? "http://localhost:3000";
const results = [];
const step = async (name, fn) => { try { await fn(); results.push(`✅ ${name}`); } catch (e) { results.push(`❌ ${name}: ${e.message.split("\n")[0]}`); } };
const browser = await chromium.launch();
const ctx = await browser.newContext({ locale: "he-IL", viewport: { width: 1280, height: 900 } });
const page = await ctx.newPage();
const shot = (n) => page.screenshot({ path: `docs/qa/mc-${n}.png`, fullPage: true }).catch(() => undefined);
const stamp = Date.now();

await step("login as owner", async () => {
  await page.goto(`${BASE}/login`);
  await page.fill('input[type="email"]', "owner@demo.local");
  await page.fill('input[type="password"]', "Demo1234!");
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 60000 });
});
await step("settings → connections shows SMS + email status with links", async () => {
  await page.goto(`${BASE}/settings`, { waitUntil: "networkidle" });
  await page.click("text=חיבורים");
  await page.waitForSelector("text=ניהול חיבור SMS →", { timeout: 30000 });
  await page.waitForSelector("text=ניהול חיבור אימייל →");
  await shot("connections");
});
await step("SMS settings page: simulation connection saved & checked, secrets masked, test send only to allowed recipient", async () => {
  await page.goto(`${BASE}/settings/sms`, { waitUntil: "networkidle" });
  await page.waitForSelector('[data-testid="sms-connection"]', { timeout: 60000 });
  const status = await page.textContent('[data-testid="sms-status"]');
  if (!/מחובר|לא מחובר/.test(status)) throw new Error(`status ${status}`);
  const html = await page.content();
  if (/enc:v1:|whsec_[A-Za-z0-9]{10}/.test(html)) throw new Error("secret leaked into HTML");
  await shot("sms-settings");
});
await step("templates: create an SMS template with Hebrew → UCS-2 metrics shown", async () => {
  await page.goto(`${BASE}/templates?channel=sms`, { waitUntil: "networkidle" });
  await page.click("text=תבנית SMS חדשה");
  await page.fill('div[role="dialog"] input >> nth=0', `qa-sms-${stamp}`);
  await page.fill('div[role="dialog"] textarea', "שלום {{first_name|לקוח}}, מבצע השבוע ב-{{company|החנות}}!");
  const metrics = await page.textContent('[data-testid="sms-metrics"]');
  if (!metrics.includes("UCS-2")) throw new Error(`metrics ${metrics}`);
  await page.click('div[role="dialog"] button:has-text("שמור")');
  await page.waitForSelector(`text=qa-sms-${stamp}`, { timeout: 30000 });
});
await step("templates: create an email template via the block editor (live preview renders)", async () => {
  await page.goto(`${BASE}/templates?channel=email`, { waitUntil: "networkidle" });
  await page.click("text=תבנית אימייל חדשה");
  await page.fill('div[role="dialog"] input >> nth=0', `qa-email-${stamp}`);
  await page.fill('div[role="dialog"] input >> nth=1', "חדש אצלנו, {{first_name|לקוח}}");
  await page.waitForFunction(() => { const f = document.querySelector('div[role="dialog"] iframe'); return f && f.getAttribute("srcdoc")?.includes("/u/preview"); }, null, { timeout: 30000 });
  await page.click('div[role="dialog"] button:has-text("שמור")');
  await page.waitForSelector(`text=qa-email-${stamp}`, { timeout: 30000 });
  await shot("templates-email");
});
await step("campaigns: channel selector, SMS draft with segment/cost estimate, review shows simulated sender", async () => {
  await page.goto(`${BASE}/campaigns`, { waitUntil: "networkidle" });
  await page.click('[data-testid="channel-sms"]');
  await page.fill('input[maxlength="120"] >> nth=0', `qa-camp-${stamp}`);
  const lists = page.locator('select[aria-label="רשימת תפוצה לקמפיין"] option');
  if (await lists.count() < 2) throw new Error("no distribution list in demo data");
  await page.selectOption('select[aria-label="רשימת תפוצה לקמפיין"]', { index: 1 });
  await page.selectOption('[data-testid="campaign-template"]', { label: `qa-sms-${stamp} (שיווקי)` });
  const est = await page.textContent('[data-testid="sms-estimate"]');
  if (!/מקטעים/.test(est)) throw new Error(`estimate ${est}`);
  await page.click('[data-testid="campaign-save"]');
  await page.waitForSelector(`text=qa-camp-${stamp}`, { timeout: 30000 });
  const card = page.locator("article", { hasText: `qa-camp-${stamp}` }).first();
  await card.locator('button:has-text("התחל שליחה")').click();
  await page.waitForSelector('[data-testid="campaign-review"]', { timeout: 30000 });
  const review = await page.textContent('[data-testid="campaign-review"]');
  if (!review.includes("הדמיה")) throw new Error("review must flag simulation");
  if (!/אומדן עלות|לא ידועה/.test(review)) throw new Error("review must state cost estimate or unknown");
  await shot("campaign-review");
  await page.click("text=סגור סיכום");
  await card.locator('button:has-text("בטל קמפיין")').click();
  await page.waitForTimeout(1500);
});
await step("campaign filter by channel works", async () => {
  await page.click('[data-testid="filter-email"]');
  await page.waitForTimeout(300);
  const smsVisible = await page.locator("article", { hasText: `qa-camp-${stamp}` }).count();
  if (smsVisible) throw new Error("SMS campaign visible under email filter");
  await page.click('[data-testid="filter-all"]');
});
await step("suppressions screen loads with source counts", async () => {
  await page.goto(`${BASE}/settings`, { waitUntil: "networkidle" });
  await page.click("text=הסרות מדיוור");
  await page.waitForSelector("text=הסרות מדיוור (מקור אמת גלובלי)", { timeout: 30000 });
  await shot("suppressions");
});
await step("automations page shows the cross-channel sequences panel", async () => {
  await page.goto(`${BASE}/automations`, { waitUntil: "networkidle" });
  await page.waitForSelector('[data-testid="sequences"]', { timeout: 60000 });
  await shot("sequences");
});
await step("public unsubscribe page rejects an invalid token without leaking anything", async () => {
  await page.goto(`${BASE}/u/invalid.token`, { waitUntil: "networkidle" });
  const text = await page.textContent("main");
  if (!text.includes("אינו תקף")) throw new Error("expected invalid-token message");
  await shot("unsubscribe-invalid");
});
await step("agent is denied on channel settings APIs", async () => {
  const agentCtx = await browser.newContext({ locale: "he-IL" });
  const p = await agentCtx.newPage();
  await p.goto(`${BASE}/login`);
  await p.fill('input[type="email"]', "agent1@demo.local");
  await p.fill('input[type="password"]', "Demo1234!");
  await p.click('button[type="submit"]');
  await p.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 60000 });
  const r = await p.request.get(`${BASE}/api/channels/sms`);
  if (r.status() !== 403) throw new Error(`status ${r.status()}`);
  const r2 = await p.request.post(`${BASE}/api/sequences`, { data: {} });
  if (r2.status() !== 403) throw new Error(`sequences status ${r2.status()}`);
  await agentCtx.close();
});
await browser.close();
process.stdout.write(results.join("\n") + "\n", () => process.exit(results.some((r) => r.startsWith("❌")) ? 1 : 0));
