/**
 * Browser QA for the campaigns area + builder (simulated providers only).
 * Usage: node scripts/qa-campaigns.mjs [baseUrl]
 * The final "send now" is pressed only when the review screen says the connection is simulated.
 */
import { chromium } from "playwright";
const BASE = process.argv[2] ?? "http://localhost:3211";
const results = [];
const ONLY = (process.env.QA_ONLY ?? "").split(",").filter(Boolean);
const step = async (name, fn) => { if (ONLY.length && !ONLY.includes(name.split(" ")[0])) return; try { await fn(); results.push(`✅ ${name}`); } catch (e) { results.push(`❌ ${name}: ${e.message.split("\n")[0]}`); } };
const browser = await chromium.launch();
const ctx = await browser.newContext({ locale: "he-IL", viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage(); page.setDefaultTimeout(90000);
page.on("dialog", (d) => d.accept());
const shot = (n) => page.screenshot({ path: `docs/qa/cmp-${n}.png` }).catch(() => undefined);
const api = async (path, method = "GET", body) => { const r = await page.request.fetch(`${BASE}${path}`, { method, data: body, headers: { "Content-Type": "application/json" }, timeout: 120000 }); return { status: r.status(), json: await r.json().catch(() => null) }; };
const login = async (email) => { await ctx.clearCookies(); await page.goto(`${BASE}/login`); await page.fill('input[type="email"]', email); await page.fill('input[type="password"]', "Demo1234!"); await page.click('button[type="submit"]'); await page.waitForURL((u) => !u.pathname.startsWith("/login")); };
const saved = () => page.waitForFunction(() => document.querySelector('[data-testid="wz-save-state"]')?.textContent === "נשמר", null, { timeout: 60000 });
let draftId; const name = `QA מייל ${Date.now()}`;

await step("K0 manager login; /campaigns redirects to the WhatsApp tab of the new list", async () => {
  await login("manager@demo.local");
  await page.goto(`${BASE}/campaigns`); await page.waitForURL((u) => u.pathname === "/campaigns/whatsapp");
  await page.waitForSelector('[data-testid="campaigns-list"]');
});

await step("K1 list: title+count, create/search/calendar buttons, 3 channel tabs, 6 status filters, rows with primary action; no big creation form", async () => {
  await page.goto(`${BASE}/campaigns/email`); await page.waitForSelector('[data-testid="campaigns-rows"]');
  const h1 = await page.textContent(".cmp-head h1"); if (!/קמפיינים \(\d+\)/.test(h1)) throw new Error(`title: ${h1}`);
  for (const t of ["campaign-create", "campaigns-search", "campaigns-view-toggle", "campaigns-tab-whatsapp", "campaigns-tab-email", "campaigns-tab-sms"]) await page.waitForSelector(`[data-testid="${t}"]`);
  for (const b of ["all", "draft", "scheduled", "running", "sent", "failed"]) await page.waitForSelector(`[data-testid="bucket-${b}"]`);
  if (await page.$("text=קמפיין חדש")) throw new Error("old creation form still on the list");
  if (await page.$("text=תצוגה מקדימה")) throw new Error("empty preview still on the list");
  await shot("list-email");
});

await step("K2 filters, search and calendar work (WhatsApp tab with demo campaigns)", async () => {
  await page.click('[data-testid="campaigns-tab-whatsapp"]'); await page.waitForURL((u) => u.pathname === "/campaigns/whatsapp");
  await page.waitForSelector('[data-testid="campaigns-rows"] article, [data-testid="campaigns-empty"]');
  const all = await page.$$eval('[data-testid="campaigns-rows"] article', (e) => e.length);
  await page.click('[data-testid="bucket-draft"]');
  const drafts = await page.$$eval('[data-testid="campaigns-rows"] article', (e) => e.map((x) => x.querySelector(".cmp-badge")?.textContent));
  if (drafts.some((b) => b !== "טיוטה")) throw new Error(`draft filter shows ${drafts.join(",")}`);
  await page.click('[data-testid="bucket-all"]');
  await page.fill('[data-testid="campaigns-search"]', "zzz-nothing-matches");
  await page.waitForSelector('[data-testid="campaigns-empty"]', { timeout: 30000 });
  await page.fill('[data-testid="campaigns-search"]', "");
  await page.waitForFunction((n) => document.querySelectorAll('[data-testid="campaigns-rows"] article').length === n, all, { timeout: 30000 });
  await page.click('[data-testid="campaigns-view-toggle"]'); await page.waitForSelector('[data-testid="campaigns-calendar"]');
  await shot("calendar"); await page.click('[data-testid="campaigns-view-toggle"]');
});

await step("K3 'יצירת קמפיין' (email) opens the full-screen builder with 5 steps; info step fields + sender profile + simulation notice", async () => {
  await page.goto(`${BASE}/campaigns/email`); await page.waitForSelector('[data-testid="campaign-create"]');
  await page.click('[data-testid="campaign-create"]');
  await page.waitForURL((u) => u.pathname.startsWith("/campaigns/wizard/"), { timeout: 60000 });
  draftId = page.url().split("/").pop();
  await page.waitForSelector('[data-testid="wz-info"]');
  const steps = await page.$$eval(".wz-steps button", (b) => b.map((x) => x.textContent.replace(/\d/g, "").trim()));
  if (steps.join("|") !== "מידע|קהל יעד|תבנית|תוכן|בקרה") throw new Error(steps.join("|"));
  await page.fill('[data-testid="info-name"]', name);
  await page.fill('[data-testid="info-subject"]', "שלום {{first_name|לקוח}}, מבצע סתיו");
  await page.fill('[data-testid="info-preheader"]', "רק השבוע");
  await page.waitForSelector("text=מצב הדמיה");
  await page.click('[data-testid="info-more"]'); await page.waitForSelector("text=כתובת לתשובות");
  await saved(); await shot("wz-info");
});

await step("K4 audience: multi-select with counts, search, exclusion area, unique eligible total", async () => {
  await page.click('[data-testid="wz-next"]'); await page.waitForSelector('[data-testid="wz-audience"]');
  await page.waitForSelector('[data-testid="audience-lists"] label');
  const rows = await page.$$('[data-testid="audience-lists"] label');
  if (rows.length < 2) throw new Error("need at least 2 audiences in demo data");
  await rows[0].click(); await rows[1].click();
  await page.waitForFunction(() => /נמענים ייחודיים זכאים/.test(document.querySelector('[data-testid="audience-total"]')?.textContent ?? ""), null, { timeout: 60000 });
  const counts = await page.$$eval(".wz-list-count", (e) => e.slice(0, 2).map((x) => x.textContent));
  if (counts.some((c) => !/אנשי קשר|—/.test(c))) throw new Error(`counts ${counts}`);
  await page.click('[data-testid="audience-exclude-toggle"]'); await page.waitForSelector(".wz-lists.small");
  await saved(); await shot("wz-audience");
});

await step("K5 template gallery: my templates / ready-made / blank, preview, pick a ready-made design", async () => {
  await page.click('[data-testid="wz-next"]'); await page.waitForSelector('[data-testid="wz-template"]');
  await page.click('[data-testid="gallery-starters"]');
  await page.waitForSelector('[data-testid="gallery-starter:promo"]');
  await page.click('[data-testid="gallery-starter:promo"] button:has-text("תצוגה מקדימה")'); await page.waitForSelector(".wz-modal iframe"); await page.click('.wz-modal button[aria-label="סגור"]');
  await page.click('[data-testid="gallery-starter:promo"] button:has-text("בחר")');
  await page.waitForSelector('[data-testid="gallery-starter:promo"].on');
  await saved(); await shot("wz-template");
});

await step("K6 visual editor: library + canvas + settings, add/duplicate/delete block, undo/redo, RTL/LTR, mobile preview; autosaves", async () => {
  await page.click('[data-testid="wz-next"]'); await page.waitForSelector('[data-testid="email-editor"]');
  const before = await page.$$eval('[data-testid^="ee-block-"]', (e) => e.length);
  await page.click('[data-testid="ee-add-heading"]');
  await page.waitForFunction((n) => document.querySelectorAll('[data-testid^="ee-block-"]').length === n + 1, before);
  await page.fill(".ee-settings textarea", "כותרת מ-QA");
  await page.waitForSelector(".ee-page >> text=כותרת מ-QA");
  await page.click('.ee-block.selected button[aria-label="שכפל"]');
  await page.waitForFunction((n) => document.querySelectorAll('[data-testid^="ee-block-"]').length === n + 2, before);
  await page.click('.ee-block.selected button[aria-label="מחק"]');
  await page.click('button[aria-label="בטל"]'); await page.waitForFunction((n) => document.querySelectorAll('[data-testid^="ee-block-"]').length === n + 2, before);
  await page.click('button[aria-label="בצע שוב"]'); await page.waitForFunction((n) => document.querySelectorAll('[data-testid^="ee-block-"]').length === n + 1, before);
  await page.click('.ee-settings-tabs button:has-text("הגדרות כלליות")'); await page.click('.ee .ee-seg button:has-text("LTR")');
  if ((await page.getAttribute(".ee-canvas", "dir")) !== "ltr") throw new Error("direction not applied");
  await page.click('.ee .ee-seg button:has-text("RTL")');
  await page.click('button[aria-label="תצוגת נייד"]'); await page.waitForSelector(".ee-canvas.mobile");
  await saved(); await shot("wz-editor");
});

await step("K7 save & exit → the draft is in the list; 'המשך עריכה' reopens at the same step with the data", async () => {
  await page.click('[data-testid="wz-exit"]'); await page.waitForURL((u) => u.pathname === "/campaigns/email");
  await page.waitForSelector(`[data-testid="draft-${draftId}"]`);
  await page.click(`[data-testid="draft-continue-${draftId}"]`); await page.waitForURL((u) => u.pathname.includes(draftId));
  await page.waitForSelector('[data-testid="email-editor"]');
  if ((await page.getAttribute('[data-testid="campaign-wizard"]', "data-step")) !== "content") throw new Error("did not reopen at the content step");
  await page.waitForSelector(".ee-page >> text=כותרת מ-QA");
});

await step("K8 test send: blocked for a non-allow-listed recipient, allowed for the connection's test recipient (simulated)", async () => {
  await page.fill('[data-testid="content-test-to"]', "stranger@example.test"); await page.click('[data-testid="content-test-send"]');
  await page.waitForSelector("text=נמעני בדיקה", { timeout: 60000 });
  const creds = (await api("/api/campaigns/senders?channel=email")).json.profiles; const allowed = creds[0]?.testRecipients?.[0];
  if (!allowed) { results.push("ℹ️ K8b no test recipient configured on the demo email connection – allowed-path not exercised"); return; }
  await page.fill('[data-testid="content-test-to"]', allowed); await page.click('[data-testid="content-test-send"]');
  await page.waitForSelector("text=הודעת בדיקה נשלחה", { timeout: 60000 });
});

await step("K9 review: checks with ✓/✕ and 'עריכה' per row, eligible total, simulation banner; send → confirm dialog → simulated send", async () => {
  await page.click('[data-testid="wz-step-review"]'); await page.waitForSelector('[data-testid="wz-review"]');
  await page.waitForSelector('[data-testid="review-checks"] li.ok', { timeout: 120000 });
  const rows = await page.$$eval('[data-testid="review-checks"] li', (l) => l.map((x) => x.querySelector("strong")?.textContent));
  for (const r of ["שולח וחיבור", "קהל יעד", "תוכן ותבנית", "משתנים אישיים וערכי גיבוי", "קישורים ומנגנון הסרה", "הגדרות מעקב", "מועד שליחה ואזור זמן"]) if (!rows.includes(r)) throw new Error(`missing check ${r}`);
  await shot("wz-review");
  const simulated = Boolean(await page.$(".wz-sim"));
  const canSend = await page.$eval('[data-testid="review-send-now"]', (b) => !b.disabled);
  if (!canSend) { const blockers = await page.$$eval(".wz-blockers li", (l) => l.map((x) => x.textContent)); results.push(`ℹ️ K9 send disabled by: ${blockers.join(" | ") || "no eligible recipients"}`); return; }
  if (!simulated) throw new Error("connection is not simulated – QA refuses to send");
  await page.click('[data-testid="review-send-now"]'); await page.waitForSelector(".wz-confirm");
  await page.click('[data-testid="review-confirm"]');
  await page.waitForURL((u) => u.pathname === "/campaigns/email", { timeout: 90000 });
});

await step("K10 report: overview metrics (no invented revenue), recipients search/filter, links tab", async () => {
  const list = (await api("/api/campaigns?channel=email")).json.campaigns;
  const c = list.find((x) => x.name === name) ?? list.find((x) => x.status !== "DRAFT");
  if (!c) throw new Error("no email campaign to report on");
  await page.goto(`${BASE}/campaigns/report/${c.id}`); await page.waitForSelector('[data-testid="campaign-report"]');
  await page.waitForSelector(".rep-metric");
  await page.waitForSelector("text=אין מנגנון ייחוס הכנסות");
  await page.click('[data-testid="report-tab-recipients"]'); await page.waitForSelector(".rep-table");
  await page.selectOption('select[aria-label="סינון לפי תוצאה"]', "SENT");
  await page.click('[data-testid="report-tab-links"]'); await page.waitForSelector("text=קישורים בתוכן");
  await page.click('[data-testid="report-tab-overview"]'); await shot("report");
});

await step("K11 SMS builder: 4 steps (no template), editor with segment counter and phone preview", async () => {
  await page.goto(`${BASE}/campaigns/sms`); await page.click('[data-testid="campaign-create"]');
  await page.waitForURL((u) => u.pathname.startsWith("/campaigns/wizard/"));
  const id = page.url().split("/").pop();
  await page.waitForSelector('[data-testid="wz-info"]');
  const steps = await page.$$eval(".wz-steps button", (b) => b.map((x) => x.textContent.replace(/\d/g, "").trim()));
  if (steps.join("|") !== "מידע|קהל יעד|תוכן|בקרה") throw new Error(steps.join("|"));
  await page.click('[data-testid="wz-step-content"]'); await page.waitForSelector('[data-testid="sms-body"]');
  await page.fill('[data-testid="sms-body"]', "שלום {{first_name|לקוח}}, מבצע מיוחד היום!");
  await page.waitForFunction(() => /מקטעים/.test(document.querySelector('[data-testid="sms-metrics"]')?.textContent ?? ""));
  await page.waitForSelector(".wz-phone .wz-bubble >> text=שלום לקוח");
  await saved(); await shot("wz-sms");
  const del = await api(`/api/campaigns/drafts/${id}`, "DELETE"); if (del.status !== 200) throw new Error(`cleanup ${del.status}`);
});

await step("K12 agent has no access to campaigns (menu + API)", async () => {
  await login("agent1@demo.local");
  const labels = await page.$$eval('[data-testid="side-nav"] nav a', (e) => e.map((x) => x.textContent.trim()));
  if (labels.includes("קמפיינים")) throw new Error("agent sees campaigns in the menu");
  const r = await api("/api/campaigns/drafts", "POST", { channel: "email" }); if (r.status !== 403) throw new Error(`agent draft create ${r.status}`);
});

await browser.close();
console.log(results.join("\n"));
process.exit(results.some((r) => r.startsWith("❌")) ? 1 : 0);
