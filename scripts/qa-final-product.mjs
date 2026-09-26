/**
 * Browser QA for the "final product" list (2026-09-25): dialer popup X, editable statuses, 4 lead metrics, big dialer
 * button + settings button on /leads, WhatsApp-only inbox, deals/tasks/crm-settings pages folded into /leads,
 * dial list = lead workspace, automation delete, campaigns split into 4 pages, round robin settings – manager + agent.
 * Usage: node scripts/qa-final-product.mjs [baseUrl]   (simulation telephony – no real calls)
 */
import { chromium } from "playwright";
const BASE = process.argv[2] ?? process.env.BASE_URL ?? "http://localhost:3211";
const results = [];
const ONLY = (process.env.QA_ONLY ?? "").split(",").map((s) => s.trim()).filter(Boolean); // e.g. QA_ONLY=F0,F7,F9 reruns a subset
const step = async (name, fn) => { if (ONLY.length && !ONLY.includes(name.split(" ")[0])) return; try { await fn(); results.push(`✅ ${name}`); } catch (e) { results.push(`❌ ${name}: ${e.message.split("\n")[0]}`); } };
const browser = await chromium.launch();
const ctx = await browser.newContext({ locale: "he-IL", viewport: { width: 1366, height: 860 } });
const page = await ctx.newPage();
page.setDefaultTimeout(120000); page.setDefaultNavigationTimeout(120000);
page.on("dialog", (d) => d.accept());
const shot = (n) => page.screenshot({ path: `docs/qa/fp-${n}.png`, fullPage: false }).catch(() => undefined);
const api = async (path, method = "GET", body) => { const r = await page.request.fetch(`${BASE}${path}`, { method, data: body, headers: { "Content-Type": "application/json" }, timeout: 120000 }); return { status: r.status(), json: await r.json().catch(() => null) }; };
const login = async (email, password = "Demo1234!") => {
  await ctx.clearCookies();
  await page.goto(`${BASE}/login`); await page.fill('input[type="email"]', email); await page.fill('input[type="password"]', password); await page.click('button[type="submit"]');
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 90000 });
};
const navLabels = async () => page.$$eval("aside nav a", (els) => els.map((e) => e.textContent.trim()));
const goto = (p) => page.goto(`${BASE}${p}`, { waitUntil: "domcontentloaded" });
// A power session keeps dialing after a hangup, so repeat until nothing is live (server truth via API).
const cleanup = async () => {
  for (let i = 0; i < 5; i++) {
    const st = (await api("/api/dialer/state")).json?.data ?? {};
    if (!st.activeCall && !st.wrapUpCall && (!st.session || st.session.status === "ended")) return;
    if (st.session && st.session.status !== "ended") await api("/api/dialer/session", "DELETE");
    if (st.activeCall) await api(`/api/dialer/call/${st.activeCall.id}/hangup`, "POST", {});
    if (st.wrapUpCall) await api(`/api/dialer/call/${st.wrapUpCall.id}/outcome`, "POST", { outcome: "no_answer" });
    await page.waitForTimeout(2500);
  }
};

await step("F0 manager login + cleanup of stale dialer state", async () => { await login("manager@demo.local"); await cleanup(); });

await step("F1 /leads: exactly 4 metric cards (לידים, עסקאות, אחוז סגירה, הכנסות), no budget/CAC/profit tiles", async () => {
  await goto("/leads"); await page.waitForSelector('[data-testid="leads-redesign"]');
  await page.waitForSelector(".lead-stat strong:not(:has-text('…'))", { timeout: 120000 });
  const labels = await page.$$eval(".lead-stat > span:last-child", (els) => els.map((e) => e.textContent.trim()));
  if (labels.length !== 4) throw new Error(`cards: ${labels.join(" | ")}`);
  for (const bad of ["תקציב פרסום", "עלות לליד", "CAC", "רווח"]) if (labels.includes(bad)) throw new Error(`still shows ${bad}`);
  for (const good of ["סה״כ לידים", "עסקאות שנסגרו", "אחוז סגירה", "הכנסות"]) if (!labels.includes(good)) throw new Error(`missing ${good}`);
  await shot("leads-manager");
});

await step("F2 metrics follow the agent filter (per-agent numbers)", async () => {
  const all = await page.textContent(".lead-stats");
  await page.selectOption('select[aria-label="נציג"]', "unassigned");
  await page.waitForTimeout(400); await page.waitForSelector('.lead-table-card:not([aria-busy="true"])', { timeout: 120000 });
  const filtered = await page.textContent(".lead-stats");
  const total = await page.textContent(".leads-count");
  if (all === filtered && !/^0 /.test(total)) throw new Error("metrics did not change with the agent filter");
  await page.selectOption('select[aria-label="נציג"]', "");
});

await step("F3 big 'הפעל חייגן' button + 'הגדרות חייגן' button on /leads; modal has dialer/statuses/assignment tabs", async () => {
  const h = await page.$eval('[data-testid="open-dialer"]', (b) => ({ h: b.getBoundingClientRect().height, cls: b.className }));
  if (h.h < 44 || !/dialer-launch/.test(h.cls)) throw new Error(`dialer button ${JSON.stringify(h)}`);
  await page.click('[data-testid="open-leads-settings"]');
  for (const t of ["dialer", "statuses", "assignment"]) await page.waitForSelector(`[data-testid="leads-settings-tab-${t}"]`);
  await page.waitForSelector(".crm-settings-embedded"); // the former /crm-settings page, embedded
  await shot("settings-modal");
});

await step("F4 rename a lead status in the modal → the table's status select shows the new name (then restore)", async () => {
  await page.click('[data-testid="leads-settings-tab-statuses"]');
  await page.waitForSelector('[data-testid="status-label-qualified"]');
  const before = await page.inputValue('[data-testid="status-label-qualified"]');
  await page.fill('[data-testid="status-label-qualified"]', "מתאים ✔ QA");
  await page.click('[data-testid="statuses-save"]');
  await page.waitForSelector("text=הסטטוסים נשמרו", { timeout: 60000 });
  const hook = await api("/api/lead-statuses");
  if (hook.json.data.items.find((s) => s.key === "qualified").label !== "מתאים ✔ QA") throw new Error("API did not persist the label");
  await page.waitForFunction(() => [...document.querySelectorAll("select.lead-status option")].some((o) => o.textContent === "מתאים ✔ QA"), null, { timeout: 30000 });
  await page.fill('[data-testid="status-label-qualified"]', before);
  await page.click('[data-testid="statuses-save"]');
  await page.waitForSelector("text=הסטטוסים נשמרו", { timeout: 60000 });
});

await step("F5 round robin + cap per agent saved from the modal (manager only)", async () => {
  await page.click('[data-testid="leads-settings-tab-assignment"]');
  await page.waitForSelector('[data-testid="assignment-mode"]');
  await page.selectOption('[data-testid="assignment-mode"]', "round_robin");
  await page.fill('[data-testid="assignment-cap"]', "25");
  await page.click('[data-testid="assignment-save"]');
  await page.waitForSelector("text=חלוקת הלידים נשמרה", { timeout: 60000 });
  const s = (await api("/api/lead-statuses")).json.data.leadAssignment;
  if (s.mode !== "round_robin" || s.maxOpenLeadsPerAgent !== 25) throw new Error(JSON.stringify(s));
  await api("/api/lead-statuses", "PATCH", { leadAssignment: { mode: "least_loaded", maxOpenLeadsPerAgent: 0, agentIds: [] } });
  await page.keyboard.press("Escape");
});

await step("F6 tasks live in a drawer on /leads; /tasks and /crm-settings and /deals redirect into /leads", async () => {
  await goto("/leads"); await page.click('[data-testid="open-tasks"]');
  await page.waitForSelector('[data-testid="tasks-drawer"]');
  await page.waitForSelector('[data-testid="tasks-drawer"] ul li, [data-testid="tasks-drawer"] :text("אין משימות")', { timeout: 60000 });
  await shot("tasks-drawer");
  await goto("/tasks"); await page.waitForURL((u) => u.pathname === "/leads" && u.search.includes("tasks=1")); await page.waitForSelector('[data-testid="tasks-drawer"]');
  await goto("/crm-settings"); await page.waitForURL((u) => u.pathname === "/leads" && u.search.includes("settings=1")); await page.waitForSelector(".crm-settings-embedded");
  await goto("/deals"); await page.waitForURL((u) => u.pathname === "/leads");
});

await step("F7 dialer popup: X closes it before a session; during a live session X hides it and a pill reopens it", async () => {
  await goto("/leads");
  await page.waitForSelector('[data-testid="open-dialer"]:not([disabled])', { timeout: 120000 });
  await page.click('[data-testid="open-dialer"]');
  await page.waitForSelector('[data-testid="dialer-embedded"]');
  await page.click('[data-testid="dialer-close"]');
  if (await page.$('[data-testid="dialer-embedded"]')) throw new Error("dock still visible after X");
  await page.click('[data-testid="open-dialer"]');
  await page.waitForSelector('[data-testid="start-dialer"]', { timeout: 60000 });
  await page.click('[data-testid="start-dialer"]');
  await page.waitForSelector("text=חייגן פעיל", { timeout: 90000 });
  await page.click('[data-testid="dialer-close"]');
  await page.waitForSelector('[data-testid="dialer-reopen"]', { timeout: 30000 });
  const st = (await api("/api/dialer/state")).json?.data ?? {};
  if (!st.session || st.session.status === "ended") throw new Error("closing the popup ended the session");
  await page.click('[data-testid="dialer-reopen"]');
  await page.waitForSelector('[data-testid="dialer-embedded"]');
  await shot("dialer-x");
  await cleanup();
});

await step("F8 manager nav: no עסקאות/משימות/הגדרות CRM; inbox is 'וואטסאפ' and has no calls tab; /calls → /inbox", async () => {
  await goto("/leads");
  const labels = await navLabels();
  for (const bad of ["עסקאות", "משימות", "הגדרות CRM", "שיחות"]) if (labels.includes(bad)) throw new Error(`nav still has ${bad}`);
  if (!labels.includes("וואטסאפ")) throw new Error(`nav: ${labels.join(",")}`);
  await page.click('[data-testid="nav-mgmt"]');
  const after = await navLabels();
  for (const l of ["קהלים ואנשי קשר", "קמפיין WhatsApp", "קמפיין אימייל", "קמפיין SMS"]) if (!after.includes(l)) throw new Error(`management group lacks ${l}`);
  if (after.includes("קמפיינים וקהלים")) throw new Error("old combined campaigns entry still present");
  await goto("/calls"); await page.waitForURL((u) => u.pathname === "/inbox");
  const tabs = await page.$$eval("main a", (els) => els.map((e) => e.getAttribute("href")));
  if (tabs.includes("/calls")) throw new Error("inbox still links to /calls");
  await shot("inbox");
});

await step("F9 dial list page = the lead workspace filtered to the list, with the queue table one tab away", async () => {
  const list = ((await api("/api/lists")).json?.data ?? [])[0];
  if (!list) throw new Error("no dial list in demo data");
  await goto(`/lists/${list.id}`);
  await page.waitForSelector('[data-testid="list-view-leads"]');
  await page.waitForSelector('[data-testid="leads-redesign"]');
  const h1 = await page.textContent('[data-testid="leads-redesign"] h1');
  if (!h1.includes(list.name)) throw new Error(`workspace header: ${h1}`);
  await page.waitForSelector('[data-testid="open-dialer"]');
  await page.waitForSelector('[data-testid="open-leads-settings"]');
  await page.click('[data-testid="list-view-queue"]');
  await page.waitForSelector("text=ניסיונות");
  await shot("list-workspace");
});

await step("F10 automations: rule rows have a delete button; deleting removes the rule (API + UI)", async () => {
  const created = await api("/api/automations", "POST", { name: `qa-del-${Date.now()}`, trigger: "NEW_CONVERSATION", triggerConfig: {}, actionType: "ADD_TAG", actionConfig: { tagName: "qa" }, isActive: false });
  if (created.status >= 300) throw new Error(`create rule: ${created.status} ${JSON.stringify(created.json).slice(0, 120)}`);
  const id = created.json?.rule?.id;
  await goto("/automations");
  await page.waitForSelector(`[data-testid="rule-delete-${id}"]`);
  await page.click(`[data-testid="rule-delete-${id}"]`);
  await page.waitForSelector(`[data-testid="rule-delete-${id}"]`, { state: "detached", timeout: 60000 });
  const gone = await api(`/api/automations/rules/${id}`, "DELETE");
  if (gone.status !== 404) throw new Error(`rule still exists: ${gone.status}`);
});

await step("F11 campaigns split: /audiences (lists+contacts only), /campaigns/{whatsapp,email,sms} (one channel each), /campaigns redirects", async () => {
  await goto("/audiences"); await page.waitForSelector("h1:has-text('קהלים ואנשי קשר')");
  if (await page.$("h2:has-text('קמפיין חדש')")) throw new Error("/audiences shows the campaign form");
  await page.waitForSelector("h2:has-text('ייבוא רשימה מ־CSV')");
  for (const [ch, label] of [["whatsapp", "WhatsApp"], ["email", "אימייל"], ["sms", "SMS"]]) {
    await goto(`/campaigns/${ch}`); await page.waitForSelector(`h1:has-text('קמפיין ${label}')`);
    if (await page.$('[role="tablist"][aria-label="ערוץ"]')) throw new Error(`${ch}: channel picker still shown`);
    if (await page.$("h2:has-text('רשימת תפוצה חדשה')")) throw new Error(`${ch}: audience editor leaked into the campaign page`);
    await page.waitForSelector("h2:has-text('קמפיין חדש')");
  }
  await goto("/campaigns"); await page.waitForURL((u) => u.pathname === "/campaigns/whatsapp");
  await shot("campaign-sms");
});

await step("A1 agent: /leads with 4 cards, dialer + settings (dialer tab only) + tasks drawer; no manager nav", async () => {
  await login("agent1@demo.local"); await cleanup();
  await goto("/leads"); await page.waitForSelector('[data-testid="leads-redesign"]');
  const labels = await navLabels();
  for (const bad of ["עסקאות", "משימות", "הגדרות CRM", "ביצועי נציגים", "קהלים ואנשי קשר"]) if (labels.includes(bad)) throw new Error(`agent nav has ${bad}`);
  const cards = await page.$$eval(".lead-stat", (els) => els.length);
  if (cards !== 4) throw new Error(`agent sees ${cards} cards`);
  await page.click('[data-testid="open-leads-settings"]');
  await page.waitForSelector('[data-testid="leads-settings-tab-dialer"]');
  if (await page.$('[data-testid="leads-settings-tab-statuses"]')) throw new Error("agent sees the statuses editor");
  await page.waitForSelector(".crm-settings-embedded");
  await page.keyboard.press("Escape");
  await page.click('[data-testid="open-tasks"]'); await page.waitForSelector('[data-testid="tasks-drawer"]');
  await shot("leads-agent");
});

await step("A2 agent: statuses PATCH is rejected (403) but the labels are readable; dialer popup X works", async () => {
  const r = await api("/api/lead-statuses", "PATCH", { leadStatuses: [{ key: "new", label: "x", hidden: false }] });
  if (r.status < 400) throw new Error(`agent could edit statuses: ${r.status}`);
  const hook = await api("/api/lead-statuses"); if (hook.status !== 200) throw new Error(`lead-statuses ${hook.status}`);
  await goto("/leads"); await page.waitForSelector('[data-testid="open-dialer"]:not([disabled])', { timeout: 120000 });
  await page.click('[data-testid="open-dialer"]'); await page.waitForSelector('[data-testid="dialer-embedded"]');
  await page.click('[data-testid="dialer-close"]');
  if (await page.$('[data-testid="dialer-embedded"]')) throw new Error("dock still visible after X");
});

await step("A3 agent: dial list page opens as the lead workspace; /deals, /tasks, /crm-settings redirect", async () => {
  const list = ((await api("/api/lists")).json?.data ?? [])[0];
  if (list) { await goto(`/lists/${list.id}`); await page.waitForSelector('[data-testid="leads-redesign"]'); }
  await goto("/deals"); await page.waitForURL((u) => u.pathname === "/leads");
  await goto("/tasks"); await page.waitForURL((u) => u.pathname === "/leads"); await page.waitForSelector('[data-testid="tasks-drawer"]');
  await goto("/crm-settings"); await page.waitForURL((u) => u.pathname === "/leads"); await page.waitForSelector(".crm-settings-embedded");
});

await browser.close();
console.log(results.join("\n"));
process.exit(results.some((r) => r.startsWith("❌")) ? 1 : 0);
