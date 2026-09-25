/**
 * Browser QA for the "חבר WhatsApp" card (no Meta credentials → "missing config" state).
 * Usage: node scripts/qa-embedded-signup.mjs [baseUrl]
 */
import { chromium } from "playwright";
const BASE = process.argv[2] ?? "http://localhost:3000";
const results = [];
const step = async (name, fn) => { try { await fn(); results.push(`✅ ${name}`); } catch (e) { results.push(`❌ ${name}: ${e.message.split("\n")[0]}`); } };
const browser = await chromium.launch();
async function login(email) {
  const ctx = await browser.newContext({ locale: "he-IL" });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/login`);
  await page.fill('input[type="email"]', email);
  await page.fill('input[type="password"]', "Demo1234!");
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 60000 });
  return page;
}
const owner = await login("owner@demo.local");
await step("owner sees the connect card with the exact explanation text", async () => {
  await owner.goto(`${BASE}/settings/whatsapp`, { waitUntil: "networkidle" });
  await owner.waitForSelector('[data-testid="wa-connect-card"]', { timeout: 60000 });
  const text = await owner.textContent('[data-testid="wa-connect-card"]');
  if (!text.includes("חיבור חשבון הוואטסאפ העסקי לשליחה וקבלת הודעות בתוך UltraCRM")) throw new Error("explanation text missing");
});
await step("missing-config state lists the env vars and disables the button (no fake success)", async () => {
  const missing = await owner.textContent('[data-testid="wa-missing-config"]');
  for (const v of ["META_APP_ID", "META_APP_SECRET", "META_ES_CONFIG_ID"]) if (!missing.includes(v)) throw new Error(`missing var ${v} not listed`);
  if (!(await owner.isDisabled('[data-testid="wa-connect-btn"]'))) throw new Error("connect button should be disabled");
  const status = await owner.textContent('[data-testid="wa-connect-card"]');
  if (status.includes("מחובר ופעיל")) throw new Error("must not show connected");
});
await step("no secrets are embedded in the page HTML", async () => {
  const html = await owner.content();
  for (const needle of ["META_APP_SECRET=", "enc:v1:", "EAAB"]) if (html.includes(needle)) throw new Error(`found ${needle}`);
});
await step("API: start refuses with 503 + missing list while unconfigured", async () => {
  const r = await owner.request.post(`${BASE}/api/whatsapp/signup/start`, { data: {} });
  if (r.status() !== 503) throw new Error(`status ${r.status()}`);
  const j = await r.json();
  if (!Array.isArray(j.details?.missing) || !j.details.missing.includes("META_APP_ID")) throw new Error("missing list absent");
});
await owner.screenshot({ path: "docs/qa/embedded-signup-missing-config.png", fullPage: true }).catch(() => undefined);
const manager = await login("manager@demo.local");
await step("manager can open the page (card visible), manual form hidden", async () => {
  await manager.goto(`${BASE}/settings/whatsapp`, { waitUntil: "networkidle" });
  await manager.waitForSelector('[data-testid="wa-connect-card"]', { timeout: 60000 });
  if (await manager.$('text=חיבור ידני מתקדם')) throw new Error("manual form should be owner-only");
});
const agent = await login("agent1@demo.local");
await step("agent is denied (page + API)", async () => {
  await agent.goto(`${BASE}/settings/whatsapp`, { waitUntil: "networkidle" });
  if (await agent.$('[data-testid="wa-connect-card"]')) throw new Error("agent sees the card");
  const r = await agent.request.get(`${BASE}/api/whatsapp/connection`);
  if (r.status() !== 403) throw new Error(`api status ${r.status()}`);
});
await browser.close();
process.stdout.write(results.join("\n") + "\n", () => process.exit(results.some((r) => r.startsWith("❌")) ? 1 : 0));
