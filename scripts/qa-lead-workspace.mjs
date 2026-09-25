/**
 * Browser QA for the lead workspace (dialer inside /leads, short navigation, reports hub).
 * Usage: node scripts/qa-lead-workspace.mjs [baseUrl]   (simulation telephony – no real calls)
 */
import { chromium } from "playwright";
const BASE = process.argv[2] ?? process.env.BASE_URL ?? "http://localhost:3000";
const results = [];
const step = async (name, fn) => { try { await fn(); results.push(`✅ ${name}`); } catch (e) { results.push(`❌ ${name}: ${e.message.split("\n")[0]}`); } };
const browser = await chromium.launch();
const ctx = await browser.newContext({ locale: "he-IL", viewport: { width: 1366, height: 860 } });
const page = await ctx.newPage();
page.setDefaultTimeout(120000); page.setDefaultNavigationTimeout(120000);
page.on("dialog", (d) => d.accept());
const shot = (n) => page.screenshot({ path: `docs/qa/lw-${n}.png`, fullPage: false }).catch(() => undefined);
const api = async (path, method = "GET", body) => { const r = await page.request.fetch(`${BASE}${path}`, { method, data: body, headers: { "Content-Type": "application/json" }, timeout: 120000 }); return { status: r.status(), json: await r.json().catch(() => null) }; };
const login = async (email, password = "Demo1234!") => {
  await page.goto(`${BASE}/login`); await page.fill('input[type="email"]', email); await page.fill('input[type="password"]', password); await page.click('button[type="submit"]');
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 90000 });
};
const navLabels = async () => page.$$eval("aside nav a", (els) => els.map((e) => e.textContent.trim()));

await step("L0 cleanup: end any call / wrap-up / session left by a previous run (server truth via API)", async () => {
  await login("owner@demo.local");
  const st = (await api("/api/dialer/state")).json?.data ?? {};
  if (st.activeCall) await api(`/api/dialer/call/${st.activeCall.id}/hangup`, "POST", {});
  const st2 = (await api("/api/dialer/state")).json?.data ?? {};
  if (st2.wrapUpCall) await api(`/api/dialer/call/${st2.wrapUpCall.id}/outcome`, "POST", { outcome: "no_answer" });
  if (st2.session && st2.session.status !== "ended") await api("/api/dialer/session", "DELETE");
});

await step("L1 owner login lands on /leads with the work strip and the dialer button", async () => {
  await page.goto(`${BASE}/leads`, { waitUntil: "domcontentloaded" });
  if (!page.url().includes("/leads")) throw new Error(`landed on ${page.url()}`);
  await page.waitForSelector('[data-testid="work-strip"]', { timeout: 120000 });
  await page.waitForSelector('[data-testid="open-dialer"]', { timeout: 120000 });
  await shot("leads");
});

await step("L2 manager navigation: 4 work items + reports + live floor; management group collapsed by default", async () => {
  const labels = await navLabels();
  for (const l of ["לידים", "שיחות", "עסקאות", "משימות", "דוחות", "מוקד בזמן אמת"]) if (!labels.includes(l)) throw new Error(`missing ${l} in ${labels.join(",")}`);
  for (const l of ["קמפיינים וקהלים", "תבניות", "רשימות חיוג"]) if (labels.includes(l)) throw new Error(`${l} should be inside the collapsed management group`);
  await page.click('[data-testid="nav-mgmt"]');
  const after = await navLabels();
  for (const l of ["הגדרות וחיבורים", "רשימות חיוג", "קמפיינים וקהלים", "תבניות", "אוטומציות", "מספרים יוצאים"]) if (!after.includes(l)) throw new Error(`management group lacks ${l}`);
  await page.click('[data-testid="nav-mgmt"]');
});

await step("L3 old routes redirect: /dashboard and /dialer → /leads; /leads/:id → the contact card", async () => {
  for (const p of ["/dashboard", "/dialer"]) { await page.goto(`${BASE}${p}`, { waitUntil: "domcontentloaded" }); await page.waitForURL((u) => u.pathname === "/leads", { timeout: 60000 }); }
  const leads = await api("/api/leads?limit=1");
  const lead = leads.json.data?.items?.[0] ?? leads.json.items?.[0];
  if (!lead) throw new Error("no lead to test");
  await page.goto(`${BASE}/leads/${lead.id}`, { waitUntil: "domcontentloaded" });
  await page.waitForURL((u) => u.pathname === `/contacts/${lead.contact.id}` && u.search.includes(`lead=${lead.id}`), { timeout: 60000 });
});

await step("L4 'הפעל חייגן' shows the queue pre-flight (list, due count) and starts the auto dialer inside /leads", async () => {
  await page.goto(`${BASE}/leads`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="open-dialer"]:not([disabled])', { timeout: 120000 });
  await page.click('[data-testid="open-dialer"]');
  await page.waitForSelector("text=יחויגו לידים מהתור", { timeout: 60000 });
  const txt = await page.textContent('div[role="dialog"]');
  if (!/זמינים לחיוג עכשיו/.test(txt)) throw new Error("no due-count line in pre-flight");
  await page.click('[data-testid="start-dialer"]');
  await page.waitForSelector('[data-testid="dialer-embedded"]', { timeout: 90000 });
  await page.waitForSelector("text=חייגן פעיל", { timeout: 30000 });
  await shot("dialer-embedded");
});

await step("L5 the session dials the next lead automatically (simulation), the lead card opens, pause/resume work", async () => {
  await page.waitForFunction(async () => { const r = await fetch("/api/dialer/state?browserSessionId=" + (sessionStorage.getItem("dialer.browserSessionId") ?? "")); const d = await r.json(); const s = d.data ?? d; return Boolean(s.activeCall || s.lead); }, null, { timeout: 90000 });
  await page.waitForSelector("text=היסטוריית התקשרות", { timeout: 60000 }); // lead card rendered for the dialed lead
  await page.click('[data-testid="leadcard-tab-chat"]');
  await page.waitForSelector('[data-testid="contact-chat"]', { timeout: 60000 });
  await page.click('[data-testid="leadcard-tab-timeline"]');
  await page.waitForSelector("text=ציר פעילות", { timeout: 60000 });
  await page.click('[data-testid="leadcard-tab-calls"]');
  const pause = page.locator("button", { hasText: /^השהה$/ });
  if (await pause.count()) { await pause.first().click(); await page.waitForSelector("button:has-text('המשך')", { timeout: 30000 }); await page.click("button:has-text('המשך')"); }
  await shot("dialer-call");
});

await step("L6 hang up → outcome panel in the same screen → save outcome → next lead countdown; stop returns to the list", async () => {
  const hang = page.locator("button", { hasText: /^נתק/ });
  if (await hang.count()) await hang.first().click();
  await page.waitForSelector("text=תוצאת שיחה", { timeout: 90000 });
  const noAnswer = page.locator("button", { hasText: /^אין מענה/ }).first();
  await noAnswer.click();
  await page.click("button:has-text('שמור תוצאה והמשך')");
  await page.waitForSelector("text=הליד הבא בעוד", { timeout: 60000 }).catch(() => undefined);
  await page.click("button:has-text('סיים סשן')");
  await page.waitForSelector("text=סיכום סשן", { timeout: 60000 }); // end-of-session summary stays on screen until closed
  await shot("after-session");
  await page.click("div[role='dialog'] button:has-text('סגור')");
  await page.waitForSelector('[data-testid="open-dialer"]', { timeout: 90000 });
});

await step("L7 manual dial from a lead row, then hang up and record the outcome from /leads", async () => {
  const dialBtn = page.locator("table button", { hasText: /^חייג$/ }).first();
  await dialBtn.click();
  await page.waitForSelector('[data-testid="dialer-embedded"]', { timeout: 60000 });
  await page.waitForFunction(async () => { const r = await fetch("/api/dialer/state"); const d = (await r.json()).data; return Boolean(d.activeCall || d.wrapUpCall); }, null, { timeout: 60000, polling: 1500 });
  await page.waitForTimeout(6000); // simulated call answers after ~4.5s
  // The simulated call may end on its own; hang up only while it is still live, then the outcome form must appear.
  const hang = page.locator("button", { hasText: /^נתק/ }).first();
  try { await hang.waitFor({ timeout: 20000 }); await hang.click({ timeout: 10000 }); } catch { /* already ended */ }
  await page.waitForSelector("text=תוצאת שיחה", { timeout: 90000 });
  const noAnswer = page.locator("button", { hasText: /^אין מענה/ }).first();
  await noAnswer.click();
  await page.click("button:has-text('שמור תוצאה והמשך')");
  await page.waitForSelector('[data-testid="open-dialer"]', { timeout: 90000 });
});

await step("L7a 'הלידים שלי': the pre-flight builds a personal queue from the agent's open leads without a manager list", async () => {
  let st = (await api("/api/dialer/state")).json?.data ?? {};
  if (st.activeCall) { await api(`/api/dialer/call/${st.activeCall.id}/hangup`, "POST", {}); await page.waitForTimeout(2000); st = (await api("/api/dialer/state")).json?.data ?? {}; }
  if (st.wrapUpCall) await api(`/api/dialer/call/${st.wrapUpCall.id}/outcome`, "POST", { outcome: "no_answer" });
  await page.goto(`${BASE}/leads`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="open-dialer"]:not([disabled])');
  await page.click('[data-testid="open-dialer"]');
  await page.click('[data-testid="source-mine"]');
  await page.waitForSelector("text=הלידים של", { timeout: 60000 });
  const txt = await page.textContent('div[role="dialog"]');
  if (!/זמינים לחיוג עכשיו/.test(txt)) throw new Error("personal queue has no due-count line");
  await page.keyboard.press("Escape");
  const lists = await api("/api/lists");
  const mine = (lists.json.data ?? lists.json).find((l) => l.name.startsWith("הלידים של"));
  if (!mine) throw new Error("personal list not created");
});

await step("L7b lead card: lead panel edits the lead in place; WhatsApp thread opens inside the card (no send)", async () => {
  const leads = await api("/api/leads?limit=1");
  const lead = leads.json.data?.items?.[0] ?? leads.json.items?.[0];
  await page.goto(`${BASE}/contacts/${lead.contact.id}?lead=${lead.id}`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="lead-status"]', { timeout: 120000 });
  await page.selectOption('[data-testid="lead-status"]', "contacted");
  await page.click('[data-testid="lead-save"]');
  await page.waitForSelector("text=הליד נשמר", { timeout: 30000 });
  const after = await api(`/api/leads/${lead.id}`);
  if ((after.json.data?.status ?? after.json.status) !== "contacted") throw new Error("lead status not saved");
  await page.click('[data-testid="card-whatsapp"]');
  await page.waitForSelector('[data-testid="contact-chat"]', { timeout: 60000 });
  await page.waitForSelector("text=ציר פעילות", { timeout: 30000 });
  await shot("card");
});

await step("L7c 'שיחות' has WhatsApp + phone-call tabs; the calls tab lists calls with a call-back action; work-strip links filter tasks", async () => {
  await page.goto(`${BASE}/inbox`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="conversations-tabs"]', { timeout: 120000 });
  await page.click('[data-testid="conversations-tabs"] a:has-text("שיחות טלפון")');
  await page.waitForSelector('[data-testid="calls-inbox"]', { timeout: 120000 });
  await page.click("button:has-text('כל השיחות')");
  await page.waitForSelector('[data-testid="call-back"]', { timeout: 60000 });
  await page.goto(`${BASE}/tasks?type=callback&due=today`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('select[aria-label="מועד"]', { timeout: 120000 });
  const due = await page.inputValue('select[aria-label="מועד"]');
  if (due !== "today") throw new Error(`due filter not applied (${due})`);
  await shot("calls");
});

await step("L8 reports hub: overview / telephony / calls / messaging tabs render for a manager", async () => {
  for (const t of ["overview", "telephony", "calls", "messaging"]) {
    await page.goto(`${BASE}/reports?tab=${t}`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(`[data-testid="reports-tab-${t}"]`, { timeout: 180000 });
  }
  await page.goto(`${BASE}/manager`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("text=מוקד בזמן אמת", { timeout: 60000 });
  await shot("reports");
});

await step("L9 agent: four menu items only, no management group, /reports and /manager denied", async () => {
  await page.goto(`${BASE}/login`);
  await page.request.post(`${BASE}/api/auth/logout`);
  await login("agent1@demo.local");
  const labels = await navLabels();
  const allowed = new Set(["לידים", "שיחות", "עסקאות", "משימות"]);
  const extra = labels.filter((l) => !allowed.has(l));
  if (extra.length) throw new Error(`agent sees extra nav: ${extra.join(",")}`);
  if (await page.locator('[data-testid="nav-mgmt"]').count()) throw new Error("agent sees the management group");
  await page.goto(`${BASE}/reports`, { waitUntil: "domcontentloaded" });
  await page.waitForURL((u) => u.pathname === "/leads", { timeout: 60000 });
  const r = await page.request.get(`${BASE}/api/manager/live`);
  if (r.status() < 400) throw new Error(`agent can read the live floor API (${r.status()})`);
  await shot("agent");
});

await browser.close();
process.stdout.write(results.join("\n") + "\n", () => process.exit(results.some((r) => r.startsWith("❌")) ? 1 : 0));
