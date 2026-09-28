/** Browser QA (production, demo business): WhatsApp "אני זמינה עכשיו" → head of agent1's queue.
 *  Fixture: one [QA] lead owned by agent1 in a QA campaign, with a simulated outbound call an hour ago (DB row only –
 *  nothing is dialed). The customer's reply goes through the demo inbound simulator (mock provider – nothing is sent).
 *  H1 reply → active signal, banner + tag for the agent, first in the campaign queue · H2 cancel from the banner
 *  · H3 "אני לא זמינה עכשיו" never prioritizes · H4 cleanup. Needs CRON_SECRET (from .env) to run the events job. */
import "dotenv/config";
import crypto from "node:crypto";
import pg from "pg";
import { chromium } from "playwright";
const BASE = process.argv[2] ?? "https://ultracrm-eta.vercel.app";
const TAG = `QA-HOT ${Date.now().toString().slice(-6)}`;
const results = [];
const b = await chromium.launch(); const ctx = await b.newContext({ locale: "he-IL", viewport: { width: 1500, height: 950 } }); const page = await ctx.newPage(); page.setDefaultTimeout(60000); page.on("dialog", (d) => d.accept());
const step = async (n, fn) => { try { await fn(); results.push(`✅ ${n}`); } catch (e) { await page.screenshot({ path: `/tmp/qa-hot-fail-${n.split(" ")[0]}.png` }).catch(() => {}); results.push(`❌ ${n}: ${e.message.slice(0, 300)}`); } };
const api = async (p, m = "GET", d) => { const r = await page.request.fetch(`${BASE}${p}`, { method: m, data: d, headers: { "Content-Type": "application/json" } }); return { status: r.status(), json: await r.json().catch(() => null) }; };
const login = async (email) => { await ctx.clearCookies(); await page.goto(`${BASE}/login`); await page.fill('input[type="email"]', email); await page.fill('input[type="password"]', "Demo1234!"); await page.click('button[type="submit"]'); await page.waitForURL((u) => !u.pathname.startsWith("/login")); };
const runEvents = async () => { for (let i = 0; i < 3; i++) await page.request.fetch(`${BASE}/api/jobs/events`, { headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } }); };
const pgc = new pg.Pool({ connectionString: process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL, max: 2, idleTimeoutMillis: 10000 }); pgc.on("error", () => {});
const id = () => `qa${crypto.randomUUID().replace(/-/g, "").slice(0, 22)}`;

const purge = async (all) => {
  for (const t of ["callback_signals", "conversations", "tasks", "calls", "list_leads", "leads"]) await pgc.query(`DELETE FROM ${t} WHERE contact_id = ANY($1)`, [all]);
  await pgc.query("DELETE FROM contacts WHERE id = ANY($1)", [all]);
};
await login("owner@demo.local");
const users = (await api("/api/users")).json.data.items; const agent1 = users.find((u) => u.email === "agent1@demo.local");
const bizId = (await pgc.query("SELECT business_id FROM users WHERE id = $1", [agent1.id])).rows[0].business_id;
// Leftovers of an interrupted earlier run (network drop) – QA rows only.
const stale = (await pgc.query("SELECT id FROM contacts WHERE business_id = $1 AND (full_name LIKE '[QA] זמינה %' OR full_name LIKE '[QA] חדש %')", [bizId])).rows.map((r) => r.id);
if (stale.length) await purge(stale);
for (const l of (await pgc.query("SELECT id FROM dial_lists WHERE business_id = $1 AND name LIKE 'QA-HOT %'", [bizId])).rows) await api(`/api/lists/${l.id}`, "DELETE");
const list = (await api("/api/lists", "POST", { name: `${TAG} קמפיין`, agentIds: [agent1.id], dialWindow: { start: "00:00", end: "23:59", days: [0, 1, 2, 3, 4, 5, 6] } })).json.data;
const phone = `+97250${String(Date.now()).slice(-7)}`;
const contactId = id(), leadId = id();
await pgc.query("INSERT INTO contacts (id, business_id, full_name, phone_e164, phone_raw, owner_user_id, updated_at) VALUES ($1,$2,$3,$4,$4,$5,now())", [contactId, bizId, `[QA] זמינה ${TAG.slice(-6)}`, phone, agent1.id]);
await pgc.query("INSERT INTO leads (id, business_id, contact_id, status, owner_user_id, updated_at) VALUES ($1,$2,$3,'contacted',$4,now())", [leadId, bizId, contactId, agent1.id]);
// Waiting for a retry in 3h – the reply must make it due and first.
await pgc.query("INSERT INTO list_leads (id, business_id, list_id, contact_id, attempts, next_attempt_at, updated_at) VALUES ($1,$2,$3,$4,1, now() + interval '3 hours', now())", [id(), bizId, list.id, contactId]);
// Plus two fresh leads of agent1 in the same campaign (they would otherwise come first).
const others = [];
for (let i = 0; i < 2; i++) { const c = id(); others.push(c); await pgc.query("INSERT INTO contacts (id, business_id, full_name, phone_e164, phone_raw, owner_user_id, updated_at) VALUES ($1,$2,$3,$4,$4,$5,now())", [c, bizId, `[QA] חדש ${i}`, `+97250${String(Date.now() + i + 1).slice(-7)}`, agent1.id]); await pgc.query("INSERT INTO leads (id, business_id, contact_id, status, owner_user_id, updated_at) VALUES ($1,$2,$3,'new',$4,now())", [id(), bizId, c, agent1.id]); await pgc.query("INSERT INTO list_leads (id, business_id, list_id, contact_id, updated_at) VALUES ($1,$2,$3,$4,now())", [id(), bizId, list.id, c]); }
await pgc.query("INSERT INTO calls (id, business_id, user_id, contact_id, mode, provider, direction, idempotency_key, to_e164, from_e164, status, telephony_result, ended_at, outcome_saved_at, created_at, updated_at) VALUES ($1,$2,$3,$4,'power','mock','outbound',$5,$6,'qa','ended','no_answer', now() - interval '1 hour', now() - interval '1 hour', now() - interval '1 hour', now())", [id(), bizId, agent1.id, contactId, crypto.randomUUID(), phone]);

let signalId = null;
await step("H1 'אני זמינה עכשיו' → active priority; agent sees banner + tag; first in the campaign queue", async () => {
  const r = await api("/api/demo/simulate-inbound", "POST", { contactId, body: "אני זמינה עכשיו" }); if (r.status !== 200) throw new Error(`simulate ${r.status} ${JSON.stringify(r.json).slice(0, 200)}`);
  await runEvents();
  const s = (await pgc.query("SELECT id, status, reason FROM callback_signals WHERE contact_id = $1 ORDER BY created_at DESC LIMIT 1", [contactId])).rows[0];
  if (s?.status !== "active") throw new Error(`signal ${JSON.stringify(s)}`); signalId = s.id;
  await login("agent1@demo.local");
  await page.goto(`${BASE}/lists/${list.id}`); await page.waitForSelector('[data-testid="hot-tag"]', { timeout: 20000 });
  if (!(await page.textContent('[data-testid="hot-leads"]')).includes("אני זמינה עכשיו")) throw new Error("message not shown in banner");
  if (!(await page.locator('[data-testid="hot-dial"]').count())) throw new Error("no 'חייג עכשיו' while the dialer is off");
  const q = (await api(`/api/lists/${list.id}/leads?sort=queue&page=1`)).json?.data; const first = (q?.items ?? q ?? [])[0];
  if (first?.contactId !== contactId || !first?.availableNow) throw new Error(`queue head ${first?.contactId} (expected ${contactId})`);
  await page.waitForSelector('[data-testid="available-now-tag"]');
  await page.screenshot({ path: "docs/qa/hot-banner-agent.png" });
  if ((await api("/api/dialer/state")).json?.data?.activeCall) throw new Error("the dialer started by itself");
});
await step("H2 'בטל עדיפות' from the banner → priority removed", async () => {
  await page.click('[data-testid="hot-cancel"]'); await page.waitForSelector('[data-testid="hot-tag"]', { state: "detached", timeout: 20000 });
  const s = (await pgc.query("SELECT status FROM callback_signals WHERE id = $1", [signalId])).rows[0]; if (s.status !== "cancelled") throw new Error(s.status);
});
await step("H3 'אני לא זמינה עכשיו' never prioritizes", async () => {
  await login("owner@demo.local");
  await api("/api/demo/simulate-inbound", "POST", { contactId, body: "אני לא זמינה עכשיו" }); await runEvents();
  const s = (await pgc.query("SELECT status FROM callback_signals WHERE contact_id = $1 ORDER BY created_at DESC LIMIT 1", [contactId])).rows[0];
  if (s?.status !== "cancelled") throw new Error(JSON.stringify(s));
  const n = (await pgc.query("SELECT count(*)::int n FROM callback_signals WHERE contact_id = $1 AND status = 'active'", [contactId])).rows[0].n; if (n) throw new Error("active signal");
});
await step("H4 cleanup: QA leads, contacts, campaign", async () => {
  await purge([contactId, ...others]);
  await api(`/api/lists/${list.id}`, "DELETE");
});
await pgc.end(); await b.close(); console.log(results.join("\n"));
