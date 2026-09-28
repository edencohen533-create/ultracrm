/** Browser QA (production, demo business): a LOST [QA] lead of agent2 transferred to agent1 appears for agent1 as a
 *  new lead, and the lead window shows the full history (transfer + "נפתח מחדש"). Nothing is dialed. Cleans up. */
import "dotenv/config";
import crypto from "node:crypto";
import pg from "pg";
import { chromium } from "playwright";
const BASE = process.argv[2] ?? "https://ultracrm-eta.vercel.app";
const results = [];
const b = await chromium.launch(); const ctx = await b.newContext({ locale: "he-IL", viewport: { width: 1500, height: 950 } }); const page = await ctx.newPage(); page.setDefaultTimeout(60000);
const step = async (n, fn) => { try { await fn(); results.push(`✅ ${n}`); } catch (e) { await page.screenshot({ path: `/tmp/qa-reopen-fail-${n.split(" ")[0]}.png` }).catch(() => {}); results.push(`❌ ${n}: ${e.message.slice(0, 300)}`); } };
const api = async (p, m = "GET", d) => { const r = await page.request.fetch(`${BASE}${p}`, { method: m, data: d, headers: { "Content-Type": "application/json" } }); return { status: r.status(), json: await r.json().catch(() => null) }; };
const login = async (email) => { await ctx.clearCookies(); await page.goto(`${BASE}/login`); await page.fill('input[type="email"]', email); await page.fill('input[type="password"]', "Demo1234!"); await page.click('button[type="submit"]'); await page.waitForURL((u) => !u.pathname.startsWith("/login")); };
const pgc = new pg.Pool({ connectionString: process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL, max: 2 }); pgc.on("error", () => {});
const id = () => `qa${crypto.randomUUID().replace(/-/g, "").slice(0, 22)}`;
const purge = async (ids) => { for (const t of ["tasks", "calls", "list_leads", "leads"]) await pgc.query(`DELETE FROM ${t} WHERE contact_id = ANY($1)`, [ids]); await pgc.query("DELETE FROM contacts WHERE id = ANY($1)", [ids]); };

await login("owner@demo.local");
const users = (await api("/api/users")).json.data.items; const agent1 = users.find((u) => u.email === "agent1@demo.local"); const agent2 = users.find((u) => u.email === "agent2@demo.local");
const bizId = (await pgc.query("SELECT business_id FROM users WHERE id = $1", [agent1.id])).rows[0].business_id;
const stale = (await pgc.query("SELECT id FROM contacts WHERE business_id = $1 AND full_name LIKE '[QA] אבוד %'", [bizId])).rows.map((r) => r.id); if (stale.length) await purge(stale);
const cId = id(), lId = id(), name = `[QA] אבוד ${Date.now().toString().slice(-5)}`, phone = `+97252${String(Date.now()).slice(-7)}`;
await pgc.query("INSERT INTO contacts (id, business_id, full_name, phone_e164, phone_raw, owner_user_id, updated_at) VALUES ($1,$2,$3,$4,$4,$5,now())", [cId, bizId, name, phone, agent2.id]);
await pgc.query("INSERT INTO leads (id, business_id, contact_id, status, owner_user_id, closed_at, close_reason, updated_at) VALUES ($1,$2,$3,'lost',$4, now() - interval '1 day', 'לא מעוניין כרגע', now())", [lId, bizId, cId, agent2.id]);
await pgc.query("INSERT INTO calls (id, business_id, user_id, contact_id, mode, provider, direction, idempotency_key, to_e164, from_e164, status, telephony_result, lead_dialed_at, ended_at, outcome, outcome_note, created_at) VALUES ($1,$2,$3,$4,'power','mock','outbound',$5,$6,'qa','ended','no_answer', now() - interval '2 days', now() - interval '2 days', 'no_answer', 'לא ענה (QA)', now() - interval '2 days')", [id(), bizId, agent2.id, cId, crypto.randomUUID(), phone]);

await step("R1 owner transfers the lost lead of agent2 to agent1 → 'reopened' reported", async () => {
  const r = await api("/api/leads/transfer", "POST", { leadIds: [lId], toUserId: agent1.id });
  if (r.status !== 200 || !r.json.data.reopened?.includes(lId)) throw new Error(JSON.stringify(r.json).slice(0, 200));
});
await step("R2 agent1: the lead is 'חדש' with 0 attempts; the lead window shows the history incl. agent2's call", async () => {
  await login("agent1@demo.local");
  const l = (await api(`/api/leads/${lId}`)).json.data; if (l.status !== "new" || l.attempts !== 0) throw new Error(`${l.status} / ${l.attempts}`);
  await page.goto(`${BASE}/leads?q=${encodeURIComponent(name)}`); await page.getByRole("button", { name }).first().click();
  await page.waitForSelector('[data-testid="lead-history"]');
  const h = await page.textContent('[data-testid="lead-history"]'); if (!h.includes("נפתח מחדש כליד חדש (היה: אבוד)") || !h.includes("לא מעוניין כרגע")) throw new Error(h.slice(0, 300));
  await page.screenshot({ path: "docs/qa/reopen-lost-history.png" });
  await page.getByRole("button", { name: "סיכומי שיחה" }).click(); await page.waitForSelector("text=לא ענה (QA)");
});
await step("R3 agent2 no longer sees it", async () => { await login("agent2@demo.local"); const r = await api(`/api/leads/${lId}`); if (r.status !== 404) throw new Error(String(r.status)); });
await step("R4 cleanup", async () => { await purge([cId]); });
await pgc.end(); await b.close(); console.log(results.join("\n"));
