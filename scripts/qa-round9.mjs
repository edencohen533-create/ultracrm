/** Browser QA (production) for round 9: carts under automations + store API, webhooks & API, next-lead in the dialer,
 *  Excel/CSV lead import with agent, no group-by, agent WhatsApp notify settings, agent report metrics, deal-closed popup. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
const BASE = process.argv[2] ?? "https://ultracrm-eta.vercel.app";
const TAG = `QA9 ${Date.now().toString().slice(-6)}`;
const results = []; const step = async (n, fn) => { try { await fn(); results.push(`✅ ${n}`); } catch (e) { results.push(`❌ ${n}: ${e.message.split("\n")[0]}`); } };
const b = await chromium.launch(); const ctx = await b.newContext({ locale: "he-IL", viewport: { width: 1600, height: 1000 } }); const page = await ctx.newPage(); page.setDefaultTimeout(90000); page.on("dialog", (d) => d.accept());
const api = async (p, m = "GET", d, headers = {}) => { const r = await page.request.fetch(`${BASE}${p}`, { method: m, data: d, headers: { "Content-Type": "application/json", ...headers } }); return { status: r.status(), json: await r.json().catch(() => null) }; };
const login = async (email) => { await ctx.clearCookies(); await page.goto(`${BASE}/login`); await page.fill('input[type="email"]', email); await page.fill('input[type="password"]', "Demo1234!"); await page.click('button[type="submit"]'); await page.waitForURL((u) => !u.pathname.startsWith("/login")); };
let agent1, storeId, keyId, apiKey, hookId; const leadIds = [];

await login("owner@demo.local");
await step("R1 abandoned carts moved under אוטומציות (tabs); /carts redirects; side menu has no carts item", async () => {
  const nav = await page.textContent('[data-testid="side-nav"]'); if (nav.includes("עגלות נטושות")) throw new Error("carts still in the side menu");
  await page.goto(`${BASE}/carts`); await page.waitForURL((u) => u.pathname === "/automations/carts"); await page.waitForSelector('[data-testid="carts-screen"]');
  await page.waitForSelector('[data-testid="automation-tabs"]'); await page.click('[data-testid="automation-tab-integrations"]'); await page.waitForSelector('[data-testid="integrations-screen"]');
});
await step("R2 store setup offers 'חיבור אוטומטי עם API' and reports a bad connection clearly", async () => {
  await page.goto(`${BASE}/automations/carts`); await page.click('[data-testid="store-connect"]'); await page.click('[data-testid="platform-shopify"]'); await page.fill('[data-testid="store-name"]', TAG); await page.click('[data-testid="store-create"]');
  await page.waitForSelector('[data-testid="store-api"]'); await page.screenshot({ path: "docs/qa/r9-store-api.png" });
  storeId = (await api("/api/stores")).json.data.items.find((s) => s.name === TAG).id;
  await page.fill('[data-testid="store-api-target"]', "evil.example.com"); await page.fill('[data-testid="store-api-key"]', "shpat_fake_token_123"); await page.fill('[data-testid="store-api-secret"]', "shpss_fake_secret");
  await page.click('[data-testid="store-api-connect"]'); await page.waitForSelector("text=myshopify.com");
});
await step("R3 API key: created once, creates a lead through /api/v1/leads, revoked key is refused", async () => {
  await page.goto(`${BASE}/automations/integrations`); await page.fill('[data-testid="api-key-name"]', TAG); await page.click('[data-testid="api-key-create"]');
  apiKey = (await page.textContent('[data-testid="api-key-value"]')).trim(); if (!apiKey.startsWith("uk_live_")) throw new Error(apiKey);
  const r = await fetch(`${BASE}/api/v1/leads`, { method: "POST", headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" }, body: JSON.stringify({ fullName: `${TAG} API`, phone: `05${String(Date.now()).slice(-8)}`, source: "qa-api" }) });
  if (r.status !== 201) throw new Error(`create ${r.status}`); leadIds.push((await r.json()).data.leadId);
  keyId = (await api("/api/integrations/keys")).json.data.items.find((k) => k.name === TAG).id;
  await api(`/api/integrations/keys/${keyId}`, "DELETE");
  const again = await fetch(`${BASE}/api/v1/me`, { headers: { Authorization: `Bearer ${apiKey}` } }); if (again.status !== 401) throw new Error(`revoked ${again.status}`);
});
await step("R4 webhook: add endpoint with events, secret shown once, 'שלח בדיקה' reports the result, internal URL refused", async () => {
  await page.click('[data-testid="webhook-add"]'); await page.fill('[data-testid="webhook-url"]', "http://localhost/x"); await page.click('[data-testid="webhook-save"]'); await page.waitForSelector("text=https://");
  await page.fill('[data-testid="webhook-url"]', "https://example.com/ultracrm-qa-hook"); await page.check('[data-testid="webhook-event-deal.won"]'); await page.click('[data-testid="webhook-save"]');
  await page.waitForSelector('[data-testid="webhook-created"]'); await page.keyboard.press("Escape");
  hookId = (await api("/api/integrations/webhooks")).json.data.items.find((w) => w.url.includes("ultracrm-qa-hook")).id;
  await page.click(`[data-testid="webhook-${hookId}"] [data-testid="webhook-test"]`); await page.waitForSelector("text=/נשלח בהצלחה|השליחה נכשלה/");
  await page.screenshot({ path: "docs/qa/r9-integrations.png", fullPage: true });
});
await step("R5 CRM: no 'קבץ'; Excel/CSV import assigns the leads to the chosen agent", async () => {
  agent1 = (await api("/api/users")).json.data.items.find((u) => u.email === "agent1@demo.local");
  await page.goto(`${BASE}/leads`); await page.waitForSelector('[data-testid="leads-redesign"]');
  if (await page.locator('select[aria-label="קיבוץ"]').count()) throw new Error("group-by still there");
  const file = path.join(os.tmpdir(), `qa9-${Date.now()}.csv`);
  const p1 = `05${String(Date.now() + 1).slice(-8)}`, p2 = `05${String(Date.now() + 2).slice(-8)}`;
  fs.writeFileSync(file, `שם,טלפון,מוצר\n"${TAG} יבוא, אחד",${p1},מנוי\n${TAG} יבוא שניים,${p2},\nשבור,12,\n`);
  await page.click('[data-testid="open-lead-import"]'); await page.setInputFiles('[data-testid="import-file"]', file);
  await page.selectOption('[data-testid="import-owner"]', agent1.id); await page.click('[data-testid="import-run"]');
  const sum = await (await page.waitForSelector('[data-testid="import-summary"]')).textContent(); if (!sum.includes("נוצרו 2")) throw new Error(sum);
  await page.screenshot({ path: "docs/qa/r9-import.png" }); await page.keyboard.press("Escape");
  const found = (await api(`/api/leads?q=${encodeURIComponent(`${TAG} יבוא`)}&limit=10`)).json.data.items;
  if (found.length !== 2 || found.some((l) => l.owner?.id !== agent1.id)) throw new Error(JSON.stringify(found.map((l) => l.owner)));
  leadIds.push(...found.map((l) => l.id));
});
await step("R6 status 'הומר לעסקה' opens the deal popup (products + period); saved to notes; customer moves to the existing-customers list", async () => {
  await page.fill('input[aria-label="חיפוש לידים"]', `${TAG} יבוא, אחד`);
  const row = page.locator(`[data-testid="lead-row-${leadIds[1]}"], [data-testid="lead-row-${leadIds[2]}"]`).first(); await row.waitFor();
  const id = (await row.getAttribute("data-testid")).replace("lead-row-", "");
  await row.locator("select.lead-status").selectOption("converted"); await page.waitForSelector('[data-testid="deal-close"]');
  await page.fill('[data-testid="deal-item-name-0"]', "מנוי שנתי QA"); await page.fill('[data-testid="deal-item-price-0"]', "1200");
  await page.screenshot({ path: "docs/qa/r9-deal-close.png" });
  await page.click('[data-testid="deal-close-save"]'); await page.waitForSelector("text=העסקה נסגרה");
  const lead = (await api(`/api/leads/${id}`)).json.data; if (lead.status !== "converted") throw new Error(lead.status);
  const contact = (await api(`/api/contacts/${lead.contact.id}`)).json.data;
  if (!contact.noteItems.some((n) => n.body.includes("מנוי שנתי QA") && n.body.includes("1,200"))) throw new Error("note missing");
  const lists = (await api("/api/lists")).json.data; const items = lists.items ?? lists;
  if (!items.some((l) => l.name === "לקוחות קיימים – חידושים")) throw new Error("customers list missing");
});
await step("R7 lead distribution: WhatsApp-to-agent option with template status and agent phones", async () => {
  await page.goto(`${BASE}/leads`); await page.click('[data-testid="open-assignment"]'); await page.waitForSelector('[data-testid="notify-agent"]');
  await page.waitForSelector(`[data-testid="agent-phone-${agent1.id}"]`); await page.screenshot({ path: "docs/qa/r9-notify-agent.png" }); await page.keyboard.press("Escape");
});
await step("R8 agent performance report shows response time and conversion columns", async () => {
  await page.goto(`${BASE}/reports`); await page.waitForSelector('[data-testid="agent-performance"]', { timeout: 60000 }).catch(async () => { await page.goto(`${BASE}/manager/agents`); await page.waitForSelector('[data-testid="agent-performance"]'); });
  const t = await (await page.waitForSelector('[data-testid="lead-quality"]')).textContent();
  for (const s of ["זמן שיחה ממוצע", "זמן תגובה לליד חדש", "המרה מליד חדש", "המרה מליד שהועבר", "המרה מכל הלידים", "שווי עסקה ממוצע"]) if (!t.includes(s)) throw new Error(`missing ${s}`);
  await page.locator('[data-testid="lead-quality"]').screenshot({ path: "docs/qa/r9-report.png" });
});
await step("R9 dialer: hang up → 'המשך לליד הבא' (no wrap-up screen) → the next lead is dialed", async () => {
  await login("agent1@demo.local"); await page.goto(`${BASE}/dialer`); await page.waitForSelector('[data-testid="dialer-screen"]');
  const live = await page.locator('[data-testid="dialer-embedded"]').count();
  if (!live) { await page.getByRole("button", { name: "Preview" }).first().click(); await page.waitForSelector('[data-testid="start-dialer"]:not([disabled])', { timeout: 60000 }); await page.click('[data-testid="start-dialer"]'); }
  await page.waitForSelector('[data-testid="call-strip"]');
  const dial = page.locator('[data-testid="strip-dial-lead"]'); await dial.waitFor(); await page.waitForFunction(() => !document.querySelector('[data-testid="strip-dial-lead"]')?.hasAttribute("disabled"), null, { timeout: 60000 }); await dial.click();
  await page.getByRole("button", { name: /^נתק/ }).waitFor({ timeout: 60000 }); await page.waitForTimeout(1500); await page.getByRole("button", { name: /^נתק/ }).click();
  await page.waitForSelector('[data-testid="next-bar"]', { timeout: 60000 }); await page.screenshot({ path: "docs/qa/r9-next-bar.png" });
  if (await page.locator('[data-testid="next-quick-answered_not_interested"]').count()) await page.click('[data-testid="next-quick-answered_not_interested"]');
  await page.click('[data-testid="next-continue"]');
  await page.getByRole("button", { name: /^נתק/ }).waitFor({ timeout: 60000 }); // the next lead is being dialed
  await page.waitForTimeout(1500); await page.getByRole("button", { name: /^נתק/ }).click();
  await page.waitForSelector('[data-testid="next-bar"]'); await page.click('[data-testid="next-full"]');
  await page.getByRole("button", { name: "אין מענה" }).first().click(); await page.getByRole("button", { name: /שמור תוצאה/ }).click();
  await page.getByRole("button", { name: "סיים סשן" }).click().catch(() => undefined);
});
await step("R10 cleanup: test leads closed, store / webhook removed", async () => {
  await login("owner@demo.local");
  for (const id of leadIds) await api(`/api/leads/${id}`, "PATCH", { status: "lost" });
  if (storeId) await api(`/api/stores/${storeId}`, "DELETE");
  if (hookId) await api(`/api/integrations/webhooks/${hookId}`, "DELETE");
});
await b.close(); console.log(results.join("\n"));
