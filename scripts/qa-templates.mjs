/** Browser QA (production, demo business): WhatsApp-only templates screen – no SMS/email tabs, no filters, search,
 *  rename a template (display name) and restore it. Nothing is sent. */
import { chromium } from "playwright";
const BASE = process.argv[2] ?? "https://ultracrm-eta.vercel.app";
const results = [];
const b = await chromium.launch(); const ctx = await b.newContext({ locale: "he-IL", viewport: { width: 1500, height: 950 } }); const page = await ctx.newPage(); page.setDefaultTimeout(60000);
const step = async (n, fn) => { try { await fn(); results.push(`✅ ${n}`); } catch (e) { await page.screenshot({ path: `/tmp/qa-tpl-fail-${n.split(" ")[0]}.png` }).catch(() => {}); results.push(`❌ ${n}: ${e.message.slice(0, 300)}`); } };
const login = async (email) => { await ctx.clearCookies(); await page.goto(`${BASE}/login`); await page.fill('input[type="email"]', email); await page.fill('input[type="password"]', "Demo1234!"); await page.click('button[type="submit"]'); await page.waitForURL((u) => !u.pathname.startsWith("/login")); };
await login("owner@demo.local");
let id = null, original = null;
await step("T1 WhatsApp only: no SMS / email tabs, no category / language / status filters", async () => {
  await page.goto(`${BASE}/templates`); await page.waitForSelector('[data-testid="wa-templates"]');
  if (await page.locator('[data-testid^="templates-tab-"]').count()) throw new Error("channel tabs still shown");
  for (const l of ["קטגוריה", "שפה", "סטטוס"]) if (await page.locator(`select[aria-label="${l}"]`).count()) throw new Error(`filter ${l} still shown`);
  const row = page.locator('[data-testid^="tpl-name-"]').first(); if (!(await row.count())) throw new Error("no templates in demo");
  id = (await row.getAttribute("data-testid")).replace("tpl-name-", ""); original = (await row.textContent()).trim();
  await page.screenshot({ path: "docs/qa/templates-wa-only.png" });
});
await step("T2 rename → shown in the list; restore", async () => {
  await page.click(`[data-testid="tpl-${id}"]`); await page.click('[data-testid="tpl-rename"]');
  const name = `QA שם ${Date.now().toString().slice(-4)}`;
  await page.fill('[data-testid="tpl-rename-input"]', name); await page.screenshot({ path: "docs/qa/templates-rename.png" });
  await page.click('[data-testid="tpl-rename-save"]'); await page.waitForSelector(`[data-testid="tpl-name-${id}"]:has-text("${name}")`);
  await page.fill('input[aria-label="חיפוש תבניות"]', name.toUpperCase()); await page.waitForSelector(`[data-testid="tpl-name-${id}"]`);
  await page.fill('input[aria-label="חיפוש תבניות"]', "");
  const r = await page.request.fetch(`${BASE}/api/templates/${id}`, { method: "PATCH", data: { displayName: original }, headers: { "Content-Type": "application/json" } }); if (r.status() !== 200) throw new Error(`restore ${r.status()}`);
});
await b.close(); console.log(results.join("\n"));
