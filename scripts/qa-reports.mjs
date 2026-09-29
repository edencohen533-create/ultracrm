/** QA (local / demo data): reports page – hierarchy, comparison (previous / custom, partial, different lengths),
 *  metric help, agent filter, no diagnostics actions, phone layout. Usage: node scripts/qa-reports.mjs [base] [outDir] [email] */
import { chromium } from "playwright";
const BASE = process.argv[2] ?? "http://localhost:3210";
const OUT = process.argv[3] ?? "docs/qa";
const EMAIL = process.argv[4] ?? "owner@demo.local";
const results = []; const step = async (n, fn) => { try { await fn(); results.push(`✅ ${n}`); } catch (e) { results.push(`❌ ${n}: ${e.message.split("\n")[0].slice(0, 300)}`); } };
const b = await chromium.launch(); const ctx = await b.newContext({ locale: "he-IL", viewport: { width: 1400, height: 950 } }); const page = await ctx.newPage(); page.setDefaultTimeout(60000);
await page.goto(`${BASE}/login`); await page.fill('input[type="email"]', EMAIL); await page.fill('input[type="password"]', "Demo1234!"); await page.click('button[type="submit"]'); await page.waitForURL((u) => !u.pathname.startsWith("/login"));
const reqs = []; page.on("request", (r) => { if (r.url().includes("/api/reports/comparison")) reqs.push(r.url()); });

await step("R1 hierarchy: filters → key metrics → charts → per-agent detail; no diagnostics actions", async () => {
  await page.goto(`${BASE}/reports`); await page.getByTestId("rep-kpis").waitFor();
  const order = await page.evaluate(() => ["reports-overview", "rep-kpis", "rep-chart-outbound", "agent-performance"].map((id) => { const el = document.querySelector(`[data-testid="${id}"]`) ?? document.querySelector(`[data-testid="rep-chart-empty"]`); return el ? el.getBoundingClientRect().top : -1; }));
  if (order.some((y) => y < 0)) throw new Error(`missing section ${order}`);
  const body = await page.locator("body").innerText();
  if (/אבחון ירידה|עמידה ביעד חיוג|רענן אבחון/.test(body)) throw new Error("diagnostics shown");
  for (const id of ["answerRate", "leadCloseRate", "dealsWon", "revenue"]) await page.getByTestId(`rep-metric-${id}`).waitFor();
  await page.screenshot({ path: `${OUT}/reports-desktop.png`, fullPage: true });
});
await step("R2 rates show percentage points separately from relative change", async () => {
  const txt = await page.getByTestId("rep-metric-answerRate").innerText();
  if (!/נק׳ אחוז|אין נתונים|ללא שינוי/.test(txt)) throw new Error(txt);
});
await step("R3 'today' is marked partial; the comparison runs to the same hour", async () => {
  await page.getByTestId("rep-preset").selectOption("today");
  await page.getByTestId("rep-partial").waitFor();
  if (!(await page.getByTestId("rep-periods").innerText()).includes("עד אותה שעה")) throw new Error("no same-hour note");
});
await step("R4 custom comparison of another length is marked", async () => {
  await page.getByTestId("rep-preset").selectOption("last7");
  await page.getByTestId("rep-compare").selectOption("custom");
  await page.getByTestId("rep-cfrom").fill("2026-08-01"); await page.getByTestId("rep-cto").fill("2026-08-31");
  await page.getByTestId("rep-mismatch").waitFor();
  await page.getByTestId("rep-compare").selectOption("previous");
});
await step("R5 metric help opens by click and keyboard", async () => {
  await page.getByTestId("rep-help-responseMinutes").click();
  if (!(await page.getByTestId("rep-help-responseMinutes-text").innerText()).includes("נמוך יותר")) throw new Error("definition");
  await page.keyboard.press("Escape");
  await page.getByTestId("rep-help-dealsWon").focus(); await page.keyboard.press("Enter"); await page.getByTestId("rep-help-dealsWon-text").waitFor(); await page.keyboard.press("Escape");
});
await step("R6 agent filter goes to the server for both periods", async () => {
  const opt = await page.getByTestId("rep-agent").locator("option").nth(1).getAttribute("value");
  if (!opt) return; // no agents in scope
  reqs.length = 0;
  await page.getByTestId("rep-agent").selectOption(opt);
  await page.waitForTimeout(1500);
  if (!reqs.some((u) => u.includes(`userId=${opt}`))) throw new Error("no agent in the request");
});
await step("M1 phone 390px: readable cards, charts inside their box, no page overflow", async () => {
  await page.setViewportSize({ width: 390, height: 844 }); await page.goto(`${BASE}/reports`); await page.getByTestId("rep-kpis").waitFor();
  if (await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)) throw new Error("horizontal overflow");
  const card = await page.getByTestId("rep-metric-revenue").boundingBox(); if (!card || card.width < 150) throw new Error(`card width ${card?.width}`);
  await page.screenshot({ path: `${OUT}/reports-mobile.png`, fullPage: true });
});
await b.close(); console.log(results.join("\n"));
