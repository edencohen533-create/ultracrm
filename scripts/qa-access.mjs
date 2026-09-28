/** Browser QA (production, demo business): packages & permissions. Restores everything it changes.
 *  P1 permissions table · P2 revoke WhatsApp from agent1 → menu, direct URL and API refuse it for the logged-in agent
 *  · P3 package tab is read-only + upgrade request · P4 platform admin screen (needs QA_PLATFORM=1: the demo owner is
 *  made platform admin for the run and revoked at the end). */
import { chromium } from "playwright";
import { execSync } from "node:child_process";
const BASE = process.argv[2] ?? "https://ultracrm-eta.vercel.app";
const ONLY = (process.env.QA_ONLY ?? "").split(",").filter(Boolean);
const results = [];
const b = await chromium.launch(); const ctx = await b.newContext({ locale: "he-IL", viewport: { width: 1500, height: 950 } }); const page = await ctx.newPage(); page.setDefaultTimeout(60000); page.on("dialog", (d) => d.accept("QA – בקשת בדיקה"));
const step = async (n, fn) => { if (ONLY.length && !ONLY.includes(n.split(" ")[0])) return; try { await fn(); results.push(`✅ ${n}`); } catch (e) { await page.screenshot({ path: `/tmp/qa-access-fail-${n.split(" ")[0]}.png` }).catch(() => {}); results.push(`❌ ${n}: ${e.message.slice(0, 300)}`); } };
const api = async (p, m = "GET", d) => { const r = await page.request.fetch(`${BASE}${p}`, { method: m, data: d, headers: { "Content-Type": "application/json" } }); return { status: r.status(), json: await r.json().catch(() => null) }; };
const login = async (email) => { await ctx.clearCookies(); await page.goto(`${BASE}/login`); await page.fill('input[type="email"]', email); await page.fill('input[type="password"]', "Demo1234!"); await page.click('button[type="submit"]'); await page.waitForURL((u) => !u.pathname.startsWith("/login")); };

await login("owner@demo.local");
const matrix = (await api("/api/access")).json.data;
const agent1 = matrix.users.find((u) => u.email === "agent1@demo.local");
const original = agent1 ? { template: agent1.template === "owner" ? "custom" : agent1.template, scope: agent1.scope, modules: agent1.permissions } : null;

await step("P1 settings → מודולים והרשאות: users × modules with seats and states", async () => {
  await page.goto(`${BASE}/settings?tab=access`); await page.waitForSelector('[data-testid="access-table"]');
  for (const m of ["crm", "telephony", "whatsapp", "sms", "email"]) await page.waitForSelector(`[data-testid="seats-${m}"]`);
  await page.screenshot({ path: "docs/qa/access-matrix.png" });
});
await step("P2 revoke WhatsApp from agent1: the logged-in agent loses it at once (menu, direct URL, API); restored after", async () => {
  if (!agent1) throw new Error("agent1 missing");
  // agent1 logs in first – the same session must be refused after the change (no re-login)
  const agentCtx = await b.newContext({ locale: "he-IL", viewport: { width: 1400, height: 900 } }); const ap = await agentCtx.newPage();
  await ap.goto(`${BASE}/login`); await ap.fill('input[type="email"]', "agent1@demo.local"); await ap.fill('input[type="password"]', "Demo1234!"); await ap.click('button[type="submit"]'); await ap.waitForURL((u) => !u.pathname.startsWith("/login"));
  const before = await ap.request.fetch(`${BASE}/api/conversations`); if (before.status() !== 200) throw new Error(`before: ${before.status()}`);
  await page.click(`[data-testid="access-edit-${agent1.id}"]`); await page.waitForSelector('[data-testid="access-editor"]');
  const wa = page.locator('[data-testid="access-enable-whatsapp"]'); if (await wa.isChecked()) await wa.uncheck();
  await page.screenshot({ path: "docs/qa/access-editor.png" });
  await page.click('[data-testid="access-save"]'); await page.waitForSelector('[data-testid="access-editor"]', { state: "detached" });
  const after = await ap.request.fetch(`${BASE}/api/conversations`); const j = await after.json().catch(() => ({}));
  if (after.status() !== 403 || j.code !== "module_not_assigned") throw new Error(`after: ${after.status()} ${j.code}`);
  await ap.goto(`${BASE}/inbox`); await ap.waitForSelector('[data-testid="no-access"]');
  await ap.goto(`${BASE}/leads`); if (await ap.locator('[data-testid="nav-inbox"]').count()) throw new Error("menu still shows WhatsApp");
  await ap.screenshot({ path: "docs/qa/access-agent-no-whatsapp.png" });
  await agentCtx.close();
  const r = await api(`/api/access/users/${agent1.id}`, "PUT", original); if (r.status !== 200) throw new Error(`restore ${r.status}`);
});
await step("P3 package tab is read-only (no self-upgrade) with sources, seats and an upgrade request", async () => {
  await page.goto(`${BASE}/settings?tab=plan`); await page.waitForSelector('[data-testid="plan-overview"]');
  if (await page.locator('select').filter({ hasText: "בחר חבילה" }).count()) throw new Error("plan selector still there");
  const patch = await api("/api/settings/plan", "PATCH", { modules: { telephony: true } }); if (patch.status !== 405 && patch.status !== 404) throw new Error(`PATCH answered ${patch.status}`);
  await page.click('[data-testid="upgrade-request"]'); await page.waitForTimeout(1500);
  await page.screenshot({ path: "docs/qa/access-plan.png" });
});
if (process.env.QA_PLATFORM === "1") {
  await step("P4 platform admin: businesses with entitlement sources, business detail with impact preview (nothing applied)", async () => {
    execSync("node scripts/set-platform-admin.mjs owner@demo.local", { stdio: "ignore" });
    try {
      await page.goto(`${BASE}/platform`); await page.waitForSelector('[data-testid="platform-businesses"]');
      await page.screenshot({ path: "docs/qa/platform-businesses.png" });
      await page.locator('[data-testid^="platform-open-"]').first().click(); await page.waitForSelector('[data-testid="platform-business-detail"]');
      await page.screenshot({ path: "docs/qa/platform-business.png" });
      await page.keyboard.press("Escape");
      await page.click('[data-testid="platform-tab-plans"]'); await page.waitForSelector('[data-testid="platform-plans"]');
      await page.screenshot({ path: "docs/qa/platform-plans.png" });
    } finally { execSync("node scripts/set-platform-admin.mjs owner@demo.local --revoke", { stdio: "ignore" }); }
    const denied = await api("/api/platform/plans"); if (denied.status !== 403) throw new Error(`after revoke: ${denied.status}`);
  });
}
await b.close(); console.log(results.join("\n"));
