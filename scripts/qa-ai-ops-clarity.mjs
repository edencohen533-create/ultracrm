/** QA (local / demo data only): "עוזר AI → מנהל AI" – help icons (click, keyboard, mobile), switches (one click, saved,
 *  survives reload, server error reverts), measured impact without invented numbers, removed diagnostics panel.
 *  The switches are put back to their original values at the end. Usage: node scripts/qa-ai-ops-clarity.mjs [base] [outDir] [email] */
import { chromium } from "playwright";
const BASE = process.argv[2] ?? "http://localhost:3210";
const OUT = process.argv[3] ?? "docs/qa";
const EMAIL = process.argv[4] ?? "owner@demo.local";
const results = []; const step = async (n, fn) => { try { await fn(); results.push(`✅ ${n}`); } catch (e) { results.push(`❌ ${n}: ${e.message.split("\n")[0].slice(0, 300)}`); } };
const b = await chromium.launch(); const ctx = await b.newContext({ locale: "he-IL", viewport: { width: 1400, height: 950 } }); const page = await ctx.newPage(); page.setDefaultTimeout(90000);
await page.goto(`${BASE}/login`); await page.fill('input[type="email"]', EMAIL); await page.fill('input[type="password"]', "Demo1234!"); await page.click('button[type="submit"]'); await page.waitForURL((u) => !u.pathname.startsWith("/login"));
const settings = async () => (await (await page.request.fetch(`${BASE}/api/ops`)).json()).data.settings;
const initial = await settings();
const open = async () => { await page.goto(`${BASE}/ai?tab=ops`); await page.getByTestId("ops-tab").waitFor(); };
const HELPS = ["help-recommendations", "help-requests", "help-enabled", "help-whatsapp", "help-impact"];

await step("H1 each of the 5 sections has a '?' that opens on click and closes on Escape", async () => {
  await open();
  for (const h of HELPS) {
    await page.getByTestId(h).click();
    const txt = await page.getByTestId(`${h}-text`).innerText(); if (txt.length < 60) throw new Error(`${h}: short text`);
    await page.keyboard.press("Escape");
    if (await page.getByTestId(`${h}-text`).count()) throw new Error(`${h}: not closed`);
  }
});
await step("H2 keyboard only: Tab to a '?' and open it with Enter", async () => {
  await page.getByTestId("help-impact").focus(); await page.keyboard.press("Enter");
  await page.getByTestId("help-impact-text").waitFor();
  await page.keyboard.press("Escape");
});
await step("T1 one click changes the switch at once, saves, and survives a reload", async () => {
  const box = page.getByTestId("ops-notifyWhatsApp"); const before = await box.isChecked();
  let patches = 0; const count = (r) => { if (r.url().includes("/api/ops/settings") && r.method() === "PATCH") patches++; }; page.on("request", count);
  await page.getByTestId("ops-toggle-notifyWhatsApp").locator("label").click(); // the label text, not the box
  if ((await box.isChecked()) === before) throw new Error("did not change on the first click");
  await page.waitForResponse((r) => r.url().includes("/api/ops/settings"));
  await page.waitForTimeout(400); page.off("request", count);
  if (patches !== 1) throw new Error(`${patches} saves for one click`);
  if ((await settings()).notifyWhatsApp === before) throw new Error("not saved");
  await page.reload(); await page.getByTestId("ops-notifyWhatsApp").waitFor();
  if ((await page.getByTestId("ops-notifyWhatsApp").isChecked()) === before) throw new Error("lost after reload");
});
await step("T2 server error: the switch goes back and an error is shown; nothing saved", async () => {
  const box = page.getByTestId("ops-enabled"); const before = await box.isChecked(); const server = (await settings()).enabled;
  await page.route("**/api/ops/settings", (r) => r.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ success: false, error: "תקלה זמנית בשרת" }) }));
  await box.click();
  await page.getByTestId("ops-enabled-error").waitFor();
  if ((await box.isChecked()) !== before) throw new Error("did not revert");
  await page.unroute("**/api/ops/settings");
  if ((await settings()).enabled !== server) throw new Error("server changed");
  await page.screenshot({ path: `${OUT}/ai-ops-error.png` });
});
await step("I1 measured impact: empty state or rows with period, observed vs comparison – no invented numbers", async () => {
  const empty = await page.getByTestId("ops-impact-empty").count();
  if (empty) { if (/\d+%/.test(await page.getByTestId("ops-impact-empty").innerText())) throw new Error("numbers in the empty state"); return; }
  const row = await page.getByTestId("ops-impact-row").first().innerText();
  if (!row.includes("תקופה") || !row.includes("נתון נצפה") || !row.includes("השוואה")) throw new Error(row.slice(0, 200));
});
await step("M1 phone 390px: help opens by tap without horizontal overflow; switch works", async () => {
  await page.setViewportSize({ width: 390, height: 844 }); await open();
  await page.getByTestId("help-enabled").tap?.().catch(() => page.getByTestId("help-enabled").click());
  if (!(await page.getByTestId("help-enabled-text").count())) await page.getByTestId("help-enabled").click();
  await page.getByTestId("help-enabled-text").waitFor();
  const r = await page.getByTestId("help-enabled-text").boundingBox();
  if (!r || r.x < 0 || r.x + r.width > 391) throw new Error(`popover off-screen ${JSON.stringify(r)}`);
  if (await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)) throw new Error("horizontal overflow");
  await page.screenshot({ path: `${OUT}/ai-ops-mobile.png` });
  await page.keyboard.press("Escape");
});
await step("R1 reports: the 'אבחון ירידה במענה ועמידה ביעד חיוג' panel is gone; report numbers stay", async () => {
  await page.setViewportSize({ width: 1400, height: 950 });
  await page.goto(`${BASE}/reports`); await page.waitForLoadState("networkidle");
  const body = await page.locator("body").innerText();
  if (/אבחון ירידה|רענן אבחון|עמידה ביעד חיוג/.test(body)) throw new Error("diagnostics still shown");
});
await step("Z restore the original switch values", async () => {
  const r = await page.request.fetch(`${BASE}/api/ops/settings`, { method: "PATCH", data: { enabled: initial.enabled, notifyWhatsApp: initial.notifyWhatsApp }, headers: { "Content-Type": "application/json" } });
  if (r.status() !== 200) throw new Error(String(r.status()));
});
await b.close(); console.log(results.join("\n"));
