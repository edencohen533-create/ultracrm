/**
 * Browser QA for /numbers (requires NUMBER_PROVIDER=mock on the server – simulation, no charges).
 * Usage: node scripts/qa-numbers.mjs [baseUrl]
 */
import { chromium } from "playwright";
const BASE = process.argv[2] ?? "http://localhost:3000";
const results = [];
let n = 0;
const browser = await chromium.launch();
const ctx = await browser.newContext({ locale: "he-IL", viewport: { width: 1366, height: 900 } });
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const step = async (name, fn) => { n++; try { await fn(); results.push(`✅ ${name}`); } catch (e) { await page.screenshot({ path: `docs/qa/num-fail-${n}.png`, fullPage: true }).catch(() => undefined); results.push(`❌ ${name}: ${e.message.split("\n")[0]}`); } };
const shot = (s) => page.screenshot({ path: `docs/qa/num-${s}.png`, fullPage: true }).catch(() => undefined);

await step("login as owner", async () => {
  await page.goto(`${BASE}/login`);
  await page.fill('input[type="email"]', "owner@demo.local");
  await page.fill('input[type="password"]', "Demo1234!");
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 60000 });
});
await step("management page renders (RTL), reputation honestly unsupported, simulation flagged", async () => {
  await page.goto(`${BASE}/numbers`, { waitUntil: "networkidle" });
  await page.waitForSelector("text=חיבור ספק מספרים", { timeout: 60000 });
  const t = await page.textContent("body");
  if (!t.includes("החיבור אינו נתמך")) throw new Error("reputation must be shown as unsupported");
  if (!t.includes("הדמיה")) throw new Error("simulation badge missing");
  const width = await page.evaluate(() => document.documentElement.scrollWidth);
  if (width > 1366) throw new Error(`horizontal overflow ${width}`);
  await shot("management");
});
await step("check connection → verified only after the provider test, then sync", async () => {
  await page.click('button:has-text("בדיקת חיבור")');
  let j;
  for (let i = 0; i < 30; i++) { j = await (await page.request.get(`${BASE}/api/numbers`)).json(); if (j.data.provider.status === "verified") break; await page.waitForTimeout(1000); }
  if (j.data.provider.status !== "verified") throw new Error(`status ${j.data.provider.status}`);
  if (j.data.provider.simulated !== true) throw new Error("simulated flag missing");
});
await step("purchase flow: search → quote with price → explicit confirmation → ready (simulation, no charge)", async () => {
  await page.click('button:has-text("חפש מספרים זמינים")');
  await page.waitForSelector("text=+972733001001", { timeout: 30000 });
  const row = page.locator("div.border", { hasText: "+972733001001" }).last();
  await row.locator('button:has-text("רכישת מספר")').first().click();
  await page.waitForSelector("text=אישור רכישת מספר", { timeout: 30000 });
  const confirm = page.locator('button:has-text("אישור רכישה בתשלום")').last();
  if (!(await confirm.isDisabled())) throw new Error("confirm must be disabled before explicit approval");
  const modal = await page.textContent("body");
  if (!/1\.00|2\.00/.test(modal)) throw new Error("price not shown before confirmation");
  const box = page.locator('input[type="checkbox"]').last();
  await box.check();
  await confirm.click();
  await page.waitForSelector("text=פעיל ומאומת", { timeout: 60000 });
  const j = await (await page.request.get(`${BASE}/api/numbers`)).json();
  const owned = j.data.numbers.find((x) => x.e164 === "+972733001001");
  if (!owned || owned.verificationStatus !== "verified") throw new Error("purchased number not in pool as verified");
  await shot("purchase");
});
await step("manual reputation report → spam alert + pause action persisted", async () => {
  const j = await (await page.request.get(`${BASE}/api/numbers`)).json();
  const num = j.data.numbers.find((x) => x.e164 === "+972733001001");
  const r = await page.request.post(`${BASE}/api/numbers`, { data: { action: "reputation_manual", id: num.id, status: "spam", note: "QA: דיווח ידני מהפורטל" } });
  if (r.status() !== 200) throw new Error(`manual report ${r.status()}`);
  await page.reload({ waitUntil: "networkidle" });
  await page.waitForSelector("text=מסומנים כספאם", { timeout: 30000 });
  const p = await page.request.post(`${BASE}/api/numbers`, { data: { action: "number", id: num.id, outboundPaused: true } });
  if (p.status() !== 200) throw new Error(`pause ${p.status()}`);
  const after = (await (await page.request.get(`${BASE}/api/numbers`)).json()).data.numbers.find((x) => x.id === num.id);
  if (!after.outboundPaused) throw new Error("pause not persisted");
  await shot("spam-alert");
  await page.request.post(`${BASE}/api/numbers`, { data: { action: "review", id: num.id, note: "QA: נסגר", resolved: true } });
  await page.request.post(`${BASE}/api/numbers`, { data: { action: "number", id: num.id, outboundPaused: false } });
});
await step("campaign policy saves via API and reloads", async () => {
  const j = await (await page.request.get(`${BASE}/api/numbers`)).json();
  const list = j.data.lists[0];
  if (!list) { results.push("ℹ️ no dial list in demo data – policy step skipped"); return; }
  const ids = j.data.numbers.filter((x) => x.isActive).map((x) => x.id);
  const r = await page.request.post(`${BASE}/api/numbers`, { data: { action: "policy", listId: list.id, policy: { mode: "round_robin", numberIds: ids } } });
  if (r.status() !== 200) throw new Error(`policy ${r.status()} ${await r.text()}`);
  const after = (await (await page.request.get(`${BASE}/api/numbers`)).json()).data.lists.find((l) => l.id === list.id);
  if (after.numberPolicy.mode !== "round_robin") throw new Error("policy not persisted");
});
await step("agent is denied", async () => {
  const c2 = await browser.newContext({ locale: "he-IL" });
  const p = await c2.newPage();
  await p.goto(`${BASE}/login`); await p.fill('input[type="email"]', "agent1@demo.local"); await p.fill('input[type="password"]', "Demo1234!"); await p.click('button[type="submit"]');
  await p.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 60000 });
  const r = await p.request.get(`${BASE}/api/numbers`);
  if (r.status() !== 403) throw new Error(`status ${r.status()}`);
  await c2.close();
});
if (errors.length) results.push(`❌ browser page errors: ${errors.join(" | ").slice(0, 300)}`);
await browser.close();
process.stdout.write(results.join("\n") + "\n", () => process.exit(results.some((r) => r.startsWith("❌")) ? 1 : 0));
