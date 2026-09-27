/** Browser QA on production for CRM rename, dial attempts, follow-ups, transfer and "waiting for a call today". */
import { chromium } from "playwright";
const BASE = process.argv[2] ?? "https://ultracrm-eta.vercel.app";
const TAG = `QA-FU ${Date.now().toString().slice(-6)}`;
const PHONE = `05${String(Date.now()).slice(-8)}`;
const results = []; const step = async (n, fn) => { try { await fn(); results.push(`✅ ${n}`); } catch (e) { results.push(`❌ ${n}: ${e.message.split("\n")[0]}`); } };
const b = await chromium.launch(); const ctx = await b.newContext({ locale: "he-IL", viewport: { width: 1600, height: 1000 } }); const page = await ctx.newPage(); page.setDefaultTimeout(90000); page.on("dialog", (d) => d.accept());
const api = async (p, m = "GET", d) => { const r = await page.request.fetch(`${BASE}${p}`, { method: m, data: d, headers: { "Content-Type": "application/json" } }); return { status: r.status(), json: await r.json().catch(() => null) }; };
const login = async (email) => { await ctx.clearCookies(); await page.goto(`${BASE}/login`); await page.fill('input[type="email"]', email); await page.fill('input[type="password"]', "Demo1234!"); await page.click('button[type="submit"]'); await page.waitForURL((u) => !u.pathname.startsWith("/login")); };
const tomorrow = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jerusalem", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(Date.now() + 86400_000));
let leadId, contactId, agent1, agent2;

await login("owner@demo.local");
await step("Q1 side menu item is called CRM and opens the leads workspace", async () => {
  const t = (await page.textContent('[data-testid="nav-leads"]')).trim(); if (t !== "CRM") throw new Error(t);
  await page.click('[data-testid="nav-leads"]'); await page.waitForSelector('[data-testid="leads-redesign"]');
});
await step("Q2 test lead created and assigned to agent1", async () => {
  const users = (await api("/api/users")).json.data.items; agent1 = users.find((u) => u.email === "agent1@demo.local"); agent2 = users.find((u) => u.email === "agent2@demo.local");
  if (!agent1 || !agent2) throw new Error("demo agents missing");
  const c = await api("/api/contacts", "POST", { fullName: TAG, phone: PHONE }); if (c.status !== 201) throw new Error(`contact ${c.status} ${JSON.stringify(c.json)}`); contactId = c.json.data.id;
  const l = await api("/api/leads", "POST", { contactId, ownerUserId: agent1.id }); if (l.status !== 201) throw new Error(`lead ${l.status}`); leadId = l.json.data.id;
});
const row = () => page.locator(`[data-testid="lead-row-${leadId}"]`);
await step("Q3 list shows 'ניסיונות חיוג' + 'פולואפ' columns; choosing 'פולואפ' opens the mandatory date/time picker", async () => {
  await page.goto(`${BASE}/leads`); await page.fill('input[aria-label="חיפוש לידים"]', TAG); await row().waitFor();
  const head = await page.textContent(".leads-table thead"); if (!head.includes("ניסיונות חיוג") || !head.includes("פולואפ")) throw new Error("columns missing");
  if ((await row().locator('[data-testid="attempts-count"] b').textContent()) !== "0") throw new Error("attempts not 0");
  await row().locator("select.lead-status").selectOption("follow_up"); await page.waitForSelector('[data-testid="followup-modal"]');
  await page.fill('[data-testid="followup-date"]', tomorrow); await page.fill('[data-testid="followup-time"]', "11:00"); await page.fill('[data-testid="followup-note"]', "לחזור לגבי הצעת מחיר");
  await page.click('[data-testid="followup-save"]'); await row().locator('[data-testid="followup-badge"]').waitFor();
  const lead = (await api(`/api/leads/${leadId}`)).json.data; if (lead.status !== "follow_up" || !lead.followUp) throw new Error(JSON.stringify(lead.followUp));
  await page.screenshot({ path: "docs/qa/crm-followup-list.png" });
});
await step("Q4 outside dial hours shows a clear message and a valid suggestion", async () => {
  // The demo business dials 24/7 – narrow the window for this step and restore it right after.
  const sd = (await api("/api/settings")).json.data; const before = (sd.settings ?? sd).dialWindow; if (!before?.days) throw new Error("dial window not readable");
  const set = await api("/api/settings", "PATCH", { settings: { dialWindow: { ...before, start: "09:00", end: "20:00" } } }); if (set.status !== 200) throw new Error(`window ${set.status}`);
  try { await q4(); } finally { await api("/api/settings", "PATCH", { settings: { dialWindow: before } }); }
});
async function q4() {
  await row().locator('[data-testid="followup-badge"]').click(); await page.waitForSelector('[data-testid="followup-modal"]');
  await page.fill('[data-testid="followup-time"]', "23:30"); await page.click('[data-testid="followup-save"]');
  const p = await page.waitForSelector('[data-testid="followup-problem"]'); if (!(await p.textContent()).includes("מחוץ לשעות")) throw new Error(await p.textContent());
  await page.screenshot({ path: "docs/qa/crm-followup-window.png" });
  await page.fill('[data-testid="followup-time"]', "12:00"); await page.click('[data-testid="followup-save"]'); await page.waitForSelector('[data-testid="followup-modal"]', { state: "detached" });
  const lead = (await api(`/api/leads/${leadId}`)).json.data; const hhmm = new Intl.DateTimeFormat("en-GB", { timeZone: lead.timezone, hour: "2-digit", minute: "2-digit" }).format(new Date(lead.followUp.dueAt));
  if (hhmm !== "12:00") throw new Error(hhmm);
}
await step("Q5 attempts counter opens the history", async () => {
  await row().locator('[data-testid="attempts-count"]').click(); await page.waitForSelector("text=ניסיונות חיוג – "); await page.keyboard.press("Escape");
});
await step("Q6 'ממתינים לשיחה היום' card: category click filters the list to exactly that number", async () => {
  await page.fill('input[aria-label="חיפוש לידים"]', ""); await page.waitForSelector('[data-testid="waiting-card"]');
  await page.waitForFunction(() => /\d/.test(document.querySelector('[data-testid="waiting-total"] strong')?.textContent ?? ""));
  await page.screenshot({ path: "docs/qa/crm-waiting-card.png" });
  for (const k of ["total", "new", "overdue"]) {
    const n = Number(await page.textContent(k === "total" ? '[data-testid="waiting-total"] strong' : `[data-testid="waiting-${k}"] b`));
    await page.click(`[data-testid="waiting-${k}"]`); await page.waitForSelector('[data-testid="waiting-filter-chip"]');
    await page.waitForFunction((want) => (document.querySelector(".lead-pagination span")?.textContent ?? "").startsWith(`${want.toLocaleString("he-IL")} לידים`), n, { timeout: 60000 });
    await page.click(`[data-testid="waiting-${k}"]`); await page.waitForSelector('[data-testid="waiting-filter-chip"]', { state: "detached" });
  }
});
await step("Q7 manager transfers the lead from the list (row action) to agent2", async () => {
  await page.fill('input[aria-label="חיפוש לידים"]', TAG); await row().waitFor();
  await page.click(`[data-testid="lead-transfer-${leadId}"]`); await page.waitForSelector('[data-testid="transfer-modal"]');
  await page.selectOption('[data-testid="transfer-to"]', agent2.id); await page.click('[data-testid="transfer-submit"]');
  await page.waitForFunction(([id, to]) => document.querySelector(`[data-testid="lead-owner-${id}"]`)?.value === to, [leadId, agent2.id]);
});
await step("Q8 previous agent (agent1) has no access: list, lead API, contact card", async () => {
  await login("agent1@demo.local");
  if ((await api(`/api/leads/${leadId}`)).status !== 404) throw new Error("lead visible");
  if ((await api(`/api/contacts/${contactId}`)).status !== 404) throw new Error("contact visible");
  if ((await api(`/api/leads/${leadId}/attempts`)).status !== 404) throw new Error("attempts visible");
  await page.goto(`${BASE}/leads`); await page.fill('input[aria-label="חיפוש לידים"]', TAG); await page.waitForTimeout(2500);
  if (await row().count()) throw new Error("row still in agent1 list");
});
await step("Q9 new agent (agent2) sees the lead with the same follow-up time and note", async () => {
  await login("agent2@demo.local");
  const lead = (await api(`/api/leads/${leadId}`)).json?.data; if (!lead?.followUp) throw new Error("no follow-up");
  const hhmm = new Intl.DateTimeFormat("en-GB", { timeZone: lead.timezone, hour: "2-digit", minute: "2-digit" }).format(new Date(lead.followUp.dueAt));
  if (hhmm !== "12:00" || lead.followUp.note !== "לחזור לגבי הצעת מחיר") throw new Error(`${hhmm} ${lead.followUp.note}`);
  await page.goto(`${BASE}/leads`); await page.fill('input[aria-label="חיפוש לידים"]', TAG); await row().waitFor();
  await row().locator(".lead-name").click(); await page.waitForSelector('[data-testid="lead-dial-summary"]');
  await page.screenshot({ path: "docs/qa/crm-lead-card.png" });
});
await step("Q10 cleanup: follow-up cancelled and test lead closed", async () => {
  await login("owner@demo.local");
  if ((await api(`/api/leads/${leadId}/follow-up`, "DELETE")).status !== 200) throw new Error("cancel");
  if ((await api(`/api/leads/${leadId}`, "PATCH", { status: "lost" })).status !== 200) throw new Error("close");
});
await b.close(); console.log(results.join("\n"));
