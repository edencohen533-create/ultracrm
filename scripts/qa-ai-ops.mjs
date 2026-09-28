/** Browser QA (production, demo business): "מנהל AI". Nothing is sent to customers and nothing is dialed.
 *  O1 tab + team table + built-in rules · O2 free-text rule → summary → save → pause → delete
 *  · O3 shift for agent1 · O4 manager approves a recommendation (seeded pending_manager for agent1 – detection itself
 *  is covered by tests/integration/ai-ops.test.ts) → "ממתין לאישור נציג", nothing allocated
 *  · O5 agent1 answers "רק 2" in the app → allocation active (2) → O6 manager stops it · O7 cleanup (shift, rows). */
import "dotenv/config";
import pg from "pg";
import { chromium } from "playwright";
const BASE = process.argv[2] ?? "https://ultracrm-eta.vercel.app";
const results = [];
const b = await chromium.launch(); const ctx = await b.newContext({ locale: "he-IL", viewport: { width: 1500, height: 1000 } }); const page = await ctx.newPage(); page.setDefaultTimeout(60000); page.on("dialog", (d) => d.accept());
const step = async (n, fn) => { try { await fn(); results.push(`✅ ${n}`); } catch (e) { await page.screenshot({ path: `/tmp/qa-ops-fail-${n.split(" ")[0]}.png`, fullPage: true }).catch(() => {}); results.push(`❌ ${n}: ${e.message.slice(0, 300)}`); } };
const api = async (p, m = "GET", d) => { const r = await page.request.fetch(`${BASE}${p}`, { method: m, data: d, headers: { "Content-Type": "application/json" } }); return { status: r.status(), json: await r.json().catch(() => null) }; };
const login = async (email) => { await ctx.clearCookies(); await page.goto(`${BASE}/login`); await page.fill('input[type="email"]', email); await page.fill('input[type="password"]', "Demo1234!"); await page.click('button[type="submit"]'); await page.waitForURL((u) => !u.pathname.startsWith("/login")); };
const pgc = new pg.Pool({ connectionString: process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL, max: 2 }); pgc.on("error", () => {});

await login("owner@demo.local");
const users = (await api("/api/users")).json.data.items; const agent1 = users.find((u) => u.email === "agent1@demo.local");
const bizId = (await pgc.query("SELECT business_id FROM users WHERE id = $1", [agent1.id])).rows[0].business_id;
const TAG = `QA-OPS-${Date.now().toString().slice(-6)}`;
let recId = null, ruleId = null;

await step("O1 מנהל AI tab: team numbers, built-in rules", async () => {
  await page.goto(`${BASE}/ai?tab=ops`); await page.waitForSelector('[data-testid="ops-tab"]');
  await page.waitForSelector('[data-testid="ops-team"]'); await page.waitForSelector('[data-testid="ops-rule-approval_policy"]'); await page.waitForSelector('[data-testid="ops-rule-momentum"]');
  await page.screenshot({ path: "docs/qa/ops-tab.png", fullPage: true });
});
await step("O2 free text → summary + questions → save; pause; delete", async () => {
  await page.fill('[data-testid="ops-rule-text"]', "אם לנציג יש יותר מ-15 לידים שטרם טופלו, עצור הקצאת לידים חדשים אליו עד שהעומס יורד.");
  await page.click('[data-testid="ops-rule-interpret"]'); await page.waitForSelector('[data-testid="ops-rule-preview"]');
  const t = await page.textContent('[data-testid="ops-rule-preview"]'); if (!t.includes("15")) throw new Error(t.slice(0, 200));
  await page.screenshot({ path: "docs/qa/ops-rule-preview.png" });
  await page.click('[data-testid="ops-rule-save"]'); await page.waitForSelector('[data-testid="ops-rule-load_cap"]');
  ruleId = (await api("/api/ops")).json.data.rules.find((r) => r.kind === "load_cap" && r.sourceText?.includes("15"))?.id;
  await page.click('[data-testid="ops-rule-toggle-load_cap"]'); await page.waitForSelector('[data-testid="ops-rule-load_cap"] >> text=מושהה');
});
// Temporary [QA] handling history for agent1 (12 dials over the previous 3 days) so the handling pace is known –
// without it the allocation is (correctly) refused. Removed in O7.
const qaContacts = [];
for (let i = 0; i < 12; i++) {
  const cid = `qaops${Date.now().toString(36)}${i}`; qaContacts.push(cid);
  await pgc.query("INSERT INTO contacts (id, business_id, full_name, phone_e164, phone_raw, owner_user_id, updated_at) VALUES ($1,$2,$3,$4,$4,$5,now())", [cid, bizId, `[QA] ops ${i}`, `+97259${String(Date.now()).slice(-6)}${i % 10}`, agent1.id]);
  await pgc.query("INSERT INTO calls (id, business_id, user_id, contact_id, mode, provider, direction, idempotency_key, to_e164, from_e164, status, telephony_result, lead_dialed_at, ended_at, created_at) VALUES ($1,$2,$3,$4,'power','mock','outbound',$5,'x','qa','ended','no_answer', now() - ($6 || ' days')::interval, now() - ($6 || ' days')::interval, now() - ($6 || ' days')::interval)", [`${cid}c`, bizId, agent1.id, cid, `${cid}-k`, String(1 + (i % 3))]);
}
await step("O3 shift for agent1 (unknown shift = not available)", async () => {
  const r = await api("/api/ops/settings", "PATCH", { shift: { userId: agent1.id, value: { start: "00:00", end: "23:59", days: [0, 1, 2, 3, 4, 5, 6] } } }); if (r.status !== 200) throw new Error(String(r.status));
});
await step("O4 manager approves (extra leads) → waiting for the agent; nothing allocated", async () => {
  recId = `qa${Date.now().toString(36)}`;
  const until = new Date(Date.now() + 6 * 3600_000).toISOString();
  await pgc.query(`INSERT INTO ops_recommendations (id, business_id, kind, agent_id, status, code, title, explanation, evidence, proposal, requested_count, dedupe_key, expires_at, updated_at) VALUES ($1,$2,'momentum',$3,'pending_manager','7391',$4,'בדיקת QA – המלצה לדוגמה','{}',$5,3,$6, now() + interval '1 hour', now())`, [recId, bizId, agent1.id, `[${TAG}] נציג במומנטום (בדיקה)`, JSON.stringify({ mode: "extra", count: 3, sharePct: 60, source: null, listId: null, fromUnassigned: false, until }), TAG]);
  await page.reload(); await page.waitForSelector(`[data-testid="ops-rec-${recId}"]`);
  await page.screenshot({ path: "docs/qa/ops-recommendation.png" });
  await page.click(`[data-testid="ops-rec-${recId}"] [data-testid="ops-approve"]`);
  await page.waitForSelector(`[data-testid="ops-rec-${recId}"][data-status="pending_agent"]`);
  const n = (await pgc.query("SELECT count(*)::int n FROM assignment_overrides WHERE recommendation_id = $1", [recId])).rows[0].n; if (n) throw new Error("allocated before the agent answered");
});
await step("O5 agent1 sees the request in the app and answers 'רק 2' → allocation active (2)", async () => {
  await login("agent1@demo.local"); await page.goto(`${BASE}/leads`);
  await page.waitForSelector('[data-testid="ops-agent-requests"]');
  await page.screenshot({ path: "docs/qa/ops-agent-request.png" });
  await page.fill(`[data-testid="ops-agent-request-${recId}"] input[type="number"]`, "2");
  await page.click(`[data-testid="ops-agent-request-${recId}"] [data-testid="ops-agent-partial"]`);
  await page.waitForSelector('[data-testid="ops-agent-requests"]', { state: "detached", timeout: 30000 });
  const r = (await pgc.query("SELECT status, agent_approved_count, result->>'reason' AS reason FROM ops_recommendations WHERE id = $1", [recId])).rows[0];
  if (r.status !== "active" || r.agent_approved_count !== 2) throw new Error(JSON.stringify(r));
  const ov = (await pgc.query("SELECT lead_limit, mode, status FROM assignment_overrides WHERE recommendation_id = $1", [recId])).rows[0];
  if (ov?.lead_limit !== 2 || ov.mode !== "extra") throw new Error(JSON.stringify(ov));
});
await step("O6 manager stops the allocation → back to regular distribution", async () => {
  await login("owner@demo.local"); await page.goto(`${BASE}/ai?tab=ops`);
  await page.waitForSelector(`[data-testid="ops-rec-${recId}"][data-status="active"]`);
  await page.screenshot({ path: "docs/qa/ops-active.png" });
  await page.click(`[data-testid="ops-rec-${recId}"] [data-testid="ops-cancel"]`);
  await page.waitForSelector(`[data-testid="ops-rec-${recId}"]`, { state: "detached" });
  const ov = (await pgc.query("SELECT status FROM assignment_overrides WHERE recommendation_id = $1", [recId])).rows[0]; if (ov.status !== "cancelled") throw new Error(ov.status);
});
await step("O7 cleanup: QA rule, shift, recommendation rows", async () => {
  if (ruleId) await api(`/api/ops/rules/${ruleId}`, "DELETE");
  await api("/api/ops/settings", "PATCH", { shift: { userId: agent1.id, value: null } });
  await pgc.query("DELETE FROM assignment_overrides WHERE recommendation_id = $1", [recId]);
  await pgc.query("DELETE FROM ops_recommendations WHERE id = $1", [recId]);
  await pgc.query("DELETE FROM calls WHERE contact_id = ANY($1)", [qaContacts]);
  await pgc.query("DELETE FROM contacts WHERE id = ANY($1)", [qaContacts]);
});
await pgc.end(); await b.close(); console.log(results.join("\n"));
