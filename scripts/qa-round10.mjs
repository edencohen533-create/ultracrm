/** Browser QA (production) round 10: names/menu, template builder + preview, CRM-status automation trigger, permissions,
 *  agent transfer, move to campaign, post-call WhatsApp control. QA_ONLY=T1,T4 runs a subset. */
import { chromium } from "playwright";
const BASE = process.argv[2] ?? "https://ultracrm-eta.vercel.app";
const TAG = `QA10 ${Date.now().toString().slice(-6)}`;
const ONLY = (process.env.QA_ONLY ?? "").split(",").filter(Boolean);
const results = []; const step = async (n, fn) => { if (ONLY.length && !ONLY.includes(n.split(" ")[0])) return; try { await fn(); results.push(`✅ ${n}`); } catch (e) { await page.screenshot({ path: `/tmp/qa10-fail-${n.split(" ")[0]}.png` }).catch(() => undefined); results.push(`❌ ${n}: ${e.message.split("\n")[0]}`); } };
const b = await chromium.launch(); const ctx = await b.newContext({ locale: "he-IL", viewport: { width: 1600, height: 1000 } }); const page = await ctx.newPage(); page.setDefaultTimeout(60000); page.on("dialog", (d) => d.accept());
const api = async (p, m = "GET", d) => { const r = await page.request.fetch(`${BASE}${p}`, { method: m, data: d, headers: { "Content-Type": "application/json" } }); return { status: r.status(), json: await r.json().catch(() => null) }; };
const login = async (email) => { await ctx.clearCookies(); await page.goto(`${BASE}/login`); await page.fill('input[type="email"]', email); await page.fill('input[type="password"]', "Demo1234!"); await page.click('button[type="submit"]'); await page.waitForURL((u) => !u.pathname.startsWith("/login")); };
const setPerms = (p) => api("/api/settings", "PATCH", { settings: { permissions: p } });
let agent1, agent2, poolLeadId, myLeadId, listId; const cleanup = [];
const newLead = async (name, ownerUserId) => { const c = await api("/api/contacts", "POST", { fullName: name, phone: `05${String(Date.now() + Math.floor(Math.random() * 1000)).slice(-8)}` }); const l = await api("/api/leads", "POST", { contactId: c.json.data.id, ...(ownerUserId ? { ownerUserId } : {}) }); cleanup.push(l.json.data.id); return l.json.data.id; };

await login("owner@demo.local");
const users = (await api("/api/users")).json.data.items; agent1 = users.find((u) => u.email === "agent1@demo.local"); agent2 = users.find((u) => u.email === "agent2@demo.local");
await step("T1 side menu: 'הודעות תפוצה' (messages) + 'קמפיינים' (dialer campaigns)", async () => {
  const nav = await page.textContent('[data-testid="side-nav"]'); if (!nav.includes("הודעות תפוצה")) throw new Error("no הודעות תפוצה");
  await page.click('[data-testid="nav-dial-campaigns"]'); await page.waitForURL((u) => u.pathname === "/lists"); await page.waitForSelector("text=קמפיינים – חייגן");
});
await step("T2 WhatsApp templates page: list + live WhatsApp preview; builder has every Meta option with live preview", async () => {
  await page.goto(`${BASE}/templates`); await page.waitForSelector('[data-testid="wa-templates"]'); await page.waitForSelector('[data-testid="tpl-preview"]');
  const first = page.locator('[data-testid^="tpl-"]').filter({ has: page.locator("td") }).first(); if (await first.count()) { await first.click(); await page.waitForSelector('[data-testid="wa-preview"]'); }
  await page.screenshot({ path: "docs/qa/r10-templates.png" });
  await page.click('[data-testid="tb-open"]'); await page.waitForSelector('[data-testid="template-builder"]');
  await page.click('[data-testid="tb-cat-MARKETING"]'); await page.fill('[data-testid="tb-name"]', "qa_builder_test");
  await page.click('[data-testid="tb-header-TEXT"]'); await page.fill('[data-testid="tb-header-text"]', "מבצע סוף עונה");
  await page.fill('[data-testid="tb-body"]', "שלום "); await page.click('[data-testid="tb-add-var"]'); await page.fill('[data-testid="tb-body"]', "שלום {{1}}, *20% הנחה* על כל החנות עד סוף החודש.");
  await page.fill('[data-testid="tb-example-1"]', "דנה"); await page.fill('[data-testid="tb-footer"]', "להסרה השיבו הסר");
  for (const t of ["QUICK_REPLY", "URL", "PHONE_NUMBER", "COPY_CODE"]) await page.click(`[data-testid="tb-add-${t}"]`);
  for (const t of ["IMAGE", "VIDEO", "DOCUMENT", "LOCATION"]) { await page.click(`[data-testid="tb-header-${t}"]`); } await page.click('[data-testid="tb-header-TEXT"]');
  const pv = await page.textContent('[data-testid="template-builder"] [data-testid="wa-preview"]'); if (!pv.includes("שלום דנה") || !pv.includes("מבצע סוף עונה") || !pv.includes("להסרה השיבו הסר")) throw new Error(`preview: ${pv.slice(0, 120)}`);
  await page.screenshot({ path: "docs/qa/r10-builder.png" });
  await page.click('[data-testid="tb-cat-AUTHENTICATION"]'); await page.waitForSelector('[data-testid="tb-auth"]');
  await page.keyboard.press("Escape");
});
await step("T3 automations: status card removed; rule builder offers trigger 'סטטוס CRM השתנה' with status + WhatsApp template", async () => {
  await page.goto(`${BASE}/automations`); await page.waitForSelector("text=חוק אוטומציה חדש");
  if (await page.locator('[data-testid="status-whatsapp-card"]').count()) throw new Error("card still there");
  await page.getByRole("button", { name: /חוק אוטומציה חדש/ }).click(); await page.getByRole("combobox").first().click(); await page.getByRole("option", { name: "סטטוס CRM השתנה" }).click();
  await page.waitForSelector('[data-testid="crm-status-trigger"]'); await page.selectOption('[data-testid="rule-lead-status"]', "qualified");
  await page.screenshot({ path: "docs/qa/r10-rule-crm-status.png" }); await page.keyboard.press("Escape");
});
await step("T4 permissions tab; agent sees only own leads (no unassigned) unless the owner allows the shared pool", async () => {
  await page.goto(`${BASE}/settings?tab=permissions`); await page.waitForSelector('[data-testid="permissions-tab"]'); await page.screenshot({ path: "docs/qa/r10-permissions.png" });
  poolLeadId = await newLead(`${TAG} ללא שיוך`, null); await api(`/api/leads/${poolLeadId}`, "PATCH", { ownerUserId: null });
  await setPerms({ agentSeesUnassigned: false });
  await login("agent1@demo.local");
  let ids = (await api(`/api/leads?q=${encodeURIComponent(TAG)}&period=all&limit=50`)).json.data.items.map((l) => l.id); if (ids.includes(poolLeadId)) throw new Error("agent sees an unassigned lead");
  if ((await api(`/api/leads/${poolLeadId}`)).status !== 404) throw new Error("direct link open");
  await login("owner@demo.local"); await setPerms({ agentSeesUnassigned: true });
  await login("agent1@demo.local"); ids = (await api(`/api/leads?q=${encodeURIComponent(TAG)}&limit=50`)).json.data.items.map((l) => l.id); if (!ids.includes(poolLeadId)) throw new Error("pool not visible when allowed");
  await login("owner@demo.local"); await setPerms({ agentSeesUnassigned: false });
});
await step("T5 a selected agent can transfer own leads from the CRM list", async () => {
  myLeadId = await newLead(`${TAG} של אורי`, agent1.id);
  await setPerms({ agentTransfer: "selected", agentTransferUserIds: [agent1.id] });
  await login("agent1@demo.local"); await page.goto(`${BASE}/leads`); await page.fill('input[aria-label="חיפוש לידים"]', `${TAG} של אורי`);
  await page.click(`[data-testid="lead-transfer-${myLeadId}"]`); await page.waitForSelector('[data-testid="transfer-modal"]');
  await page.selectOption('[data-testid="transfer-to"]', agent2.id); await page.click('[data-testid="transfer-submit"]'); await page.waitForSelector("text=/הועבר/");
  await login("owner@demo.local"); if ((await api(`/api/leads/${myLeadId}`)).json.data.ownerUserId !== agent2.id) throw new Error("not transferred");
  await setPerms({ agentTransfer: "none", agentTransferUserIds: [] });
});
await step("T6 marking 'לא מתאים' offers moving the lead to a dialer campaign", async () => {
  const lr = await api("/api/lists", "POST", { name: `${TAG} בריכת לידים` }); listId = lr.json?.data?.id; if (!listId) throw new Error(`list ${lr.status}`);
  const id = await newLead(`${TAG} לא מתאים`, agent1.id);
  await login("agent1@demo.local"); await page.goto(`${BASE}/leads`); await page.fill('input[aria-label="חיפוש לידים"]', `${TAG} לא מתאים`);
  const row = page.locator(`[data-testid="lead-row-${id}"]`); await row.waitFor(); await row.locator("select.lead-status").selectOption("unqualified");
  await page.waitForSelector('[data-testid="move-to-campaign"]'); await page.selectOption('[data-testid="move-list"]', listId); await page.screenshot({ path: "docs/qa/r10-move.png" });
  await page.click('[data-testid="move-submit"]'); await page.waitForSelector("text=/הועבר לקמפיין/");
});
await step("T7 dialer: after hang-up the 'שלח הודעת WhatsApp ללקוח' control is offered", async () => {
  await login("agent1@demo.local"); await page.goto(`${BASE}/dialer`); await page.waitForSelector('[data-testid="dialer-screen"]'); await page.waitForTimeout(2500);
  const strip = page.locator('[data-testid="call-strip"]'); const hang = () => strip.getByRole("button", { name: /^נתק/ });
  if (await page.getByRole("button", { name: "העבר לכאן" }).count()) { await page.getByRole("button", { name: "העבר לכאן" }).click(); await page.waitForTimeout(4500); }
  if (!(await page.locator('[data-testid="next-bar"]').count())) {
    if (!(await hang().count())) {
      if (!(await page.locator('[data-testid="strip-dial-lead"]').count())) { await page.getByRole("button", { name: "Preview" }).first().click(); await page.waitForSelector('[data-testid="start-dialer"]:not([disabled])'); await page.click('[data-testid="start-dialer"]'); await page.waitForSelector('[data-testid="call-strip"]'); }
      await page.waitForFunction(() => { const x = document.querySelector('[data-testid="strip-dial-lead"]'); return x && !x.hasAttribute("disabled"); }); await page.click('[data-testid="strip-dial-lead"]');
      await hang().waitFor(); await page.waitForTimeout(1500);
    }
    await hang().click();
  }
  await page.waitForSelector('[data-testid="next-bar"]'); await page.click('[data-testid="post-wa-open"]'); await page.waitForSelector('[data-testid="post-wa"]');
  await page.screenshot({ path: "docs/qa/r10-post-wa.png" });
  await page.click('[data-testid="next-full"]'); await page.getByRole("button", { name: "אין מענה" }).first().click(); await page.getByRole("button", { name: /שמור תוצאה/ }).click();
  await page.getByRole("button", { name: "סיים סשן" }).click().catch(() => undefined);
});
await step("T8 cleanup", async () => {
  await login("owner@demo.local"); await setPerms({ agentSeesUnassigned: false, agentTransfer: "none", agentTransferUserIds: [] });
  for (const id of cleanup) await api(`/api/leads/${id}`, "PATCH", { status: "lost" });
  if (listId) await api(`/api/lists/${listId}`, "DELETE");
});
await b.close(); console.log(results.join("\n"));
