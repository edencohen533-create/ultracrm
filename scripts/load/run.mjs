/**
 * UltraCRM load driver – realistic concurrent agents per business against a running server (isolated env).
 *   SEED=/tmp/seed.json BASE=http://127.0.0.1:3300 DURATION=300 RAMP=60 AGENTS_PER_BIZ=10 OUT=/tmp/run.json node scripts/load/run.mjs
 * Each virtual agent: personal queue → preview session → next lead → dial (5% double-click with the same key) →
 * poll state 1s → hang up / auto-ended → outcome → sometimes: leads page, note, status change, post-call WhatsApp.
 * Per business: manager live screen (2s) + waiting card + agent report, WooCommerce webhooks (20% duplicated),
 * public-API lead ingest, simulated inbound WhatsApp. Crons (events/automations/campaigns) run like Vercel's.
 * Measures latency p50/p95/p99 per endpoint, technical error rate, manager-view delay, DB connections, queue depth,
 * server CPU/RSS. Mock telephony only – no real calls or paid sends.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import { execSync } from "node:child_process";
import pg from "pg";

const SEED = JSON.parse(fs.readFileSync(process.env.SEED, "utf8"));
const BASE = process.env.BASE ?? "http://127.0.0.1:3300";
const DURATION = Number(process.env.DURATION ?? 120) * 1000;
const RAMP = Number(process.env.RAMP ?? 30) * 1000;
const PER_BIZ = Number(process.env.AGENTS_PER_BIZ ?? 1e9);
const BIZ_LIMIT = Number(process.env.BIZ_LIMIT ?? 1e9);
const HEAVY_BIZ = process.env.HEAVY_BIZ === "1"; // business #1 gets 4x webhook/API traffic (noisy-neighbour test)
const CRON = process.env.CRON_SECRET;
const t0 = Date.now(); const deadline = t0 + RAMP + DURATION;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rnd = (a, b) => a + Math.random() * (b - a);

// ─── metrics ───────────────────────────────────────────────────────────────────────────────────────────────────
const lat = new Map(); const errs = new Map(); const expected = new Map(); const bizLat = new Map();
const counters = { calls: 0, doubleClicks: 0, doubleClickMismatch: 0, callsAnswered: 0, notes: 0, statusChanges: 0, whatsapp: 0, webhooks: 0, apiLeads: 0, inbound: 0, managerPolls: 0, noLead: 0 };
const realtimeDelays = []; const callStartedAt = new Map();
const rec = (m, k, v) => { if (!m.has(k)) m.set(k, []); m.get(k).push(v); };
async function req(name, path, { method = "GET", body, cookie, headers = {}, biz, raw = false, expect = [] } = {}) {
  const t = performance.now();
  let res, json = null;
  try {
    res = await fetch(`${BASE}${path}`, { method, headers: { ...(body !== undefined && !raw ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}), ...headers }, body: body === undefined ? undefined : raw ? body : JSON.stringify(body), signal: AbortSignal.timeout(30_000) });
    const txt = await res.text(); try { json = txt ? JSON.parse(txt) : null; } catch { json = null; }
  } catch (e) {
    rec(lat, name, performance.now() - t); rec(errs, name, `network:${e.name}`); return { status: 0, json: null };
  }
  const ms = performance.now() - t; rec(lat, name, ms); if (biz !== undefined) rec(bizLat, biz, ms);
  if (res.status >= 500 || res.status === 429 && !expect.includes(429)) rec(errs, name, `${res.status}:${json?.code ?? json?.error ?? ""}`.slice(0, 80));
  else if (res.status >= 400) rec(expected, name, `${res.status}:${json?.code ?? ""}`);
  return { status: res.status, json };
}
const pct = (arr, p) => { if (!arr.length) return null; const s = [...arr].sort((a, b) => a - b); return Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]); };

// ─── virtual agent ─────────────────────────────────────────────────────────────────────────────────────────────
async function agent(biz, a, bi) {
  const cookie = a.cookie; const browserSessionId = `load-${crypto.randomUUID()}`;
  await sleep(rnd(0, RAMP));
  const pl = await req("POST personal-list", "/api/dialer/personal-list", { method: "POST", cookie, biz: bi });
  const listId = pl.json?.data?.id; if (!listId) return;
  const s = await req("POST session", "/api/dialer/session", { method: "POST", cookie, biz: bi, body: { mode: "preview", listId, browserSessionId } });
  const sessionId = s.json?.data?.id ?? s.json?.data?.session?.id; if (!sessionId) return;
  let lastHeartbeat = 0; let leadsPage = null; let iter = 0;
  const poll = () => req("GET state", `/api/dialer/state?browserSessionId=${browserSessionId}`, { cookie, biz: bi });
  while (Date.now() < deadline) {
    iter++;
    if (Date.now() - lastHeartbeat > 15_000) { lastHeartbeat = Date.now(); await req("POST heartbeat", "/api/dialer/heartbeat", { method: "POST", cookie, biz: bi, body: { sessionId, browserSessionId } }); }
    const n = await req("POST next-lead", "/api/dialer/next-lead", { method: "POST", cookie, biz: bi, body: { sessionId, browserSessionId } });
    const lead = n.json?.data;
    if (!lead?.id) {
      // Like the UI: a call whose response was lost (network error) is still live on the server – the screen shows
      // it from /state, so the agent hangs it up and documents it instead of waiting forever.
      const st = await poll(); const ac = st.json?.data?.activeCall; const wu = st.json?.data?.wrapUpCall;
      if (ac?.id) { counters.recovered = (counters.recovered ?? 0) + 1; await req("POST hangup", `/api/dialer/call/${ac.id}/hangup`, { method: "POST", cookie, biz: bi }); await sleep(1500); await req("POST outcome", `/api/dialer/call/${ac.id}/outcome`, { method: "POST", cookie, biz: bi, body: { outcome: "no_answer", note: "recovered" } }); continue; }
      if (wu?.id) { counters.recovered = (counters.recovered ?? 0) + 1; await req("POST outcome", `/api/dialer/call/${wu.id}/outcome`, { method: "POST", cookie, biz: bi, body: { outcome: "no_answer", note: "recovered" } }); continue; }
      counters.noLead++; await sleep(5000); continue;
    }
    await sleep(rnd(300, 1200)); // agent glances at the lead card
    const key = crypto.randomUUID(); const callBody = { idempotencyKey: key, mode: "preview", sessionId, browserSessionId, leadId: lead.id, lockToken: lead.lockToken };
    let c;
    if (Math.random() < 0.05) { // double click / retry with the same key
      counters.doubleClicks++;
      const [x, y] = await Promise.all([req("POST call", "/api/dialer/call", { method: "POST", cookie, biz: bi, body: callBody }), req("POST call", "/api/dialer/call", { method: "POST", cookie, biz: bi, body: callBody })]);
      if (x.json?.data?.id && y.json?.data?.id && x.json.data.id !== y.json.data.id) counters.doubleClickMismatch++;
      c = x.json?.data?.id ? x : y;
    } else c = await req("POST call", "/api/dialer/call", { method: "POST", cookie, biz: bi, body: callBody });
    const callId = c.json?.data?.id;
    if (!callId) { await sleep(2000); continue; }
    counters.calls++; callStartedAt.set(callId, Date.now());
    // live call: poll like the UI; answered → talk a few seconds then hang up
    let answered = false; let ended = false; let talkUntil = 0; const callDeadline = Date.now() + 40_000;
    while (!ended && Date.now() < callDeadline) {
      await sleep(1000);
      const st = await poll(); const ac = st.json?.data?.activeCall; const wu = st.json?.data?.wrapUpCall;
      if (ac && ac.status === "answered" && !answered) { answered = true; counters.callsAnswered++; talkUntil = Date.now() + rnd(3000, 8000); }
      if (answered && Date.now() > talkUntil && ac) { await req("POST hangup", `/api/dialer/call/${callId}/hangup`, { method: "POST", cookie, biz: bi }); }
      if (!ac && (wu?.id === callId || !wu)) ended = true;
    }
    if (!ended) { await req("POST hangup", `/api/dialer/call/${callId}/hangup`, { method: "POST", cookie, biz: bi }); await sleep(2000); }
    const outcome = answered ? (Math.random() < 0.5 ? "answered_interested" : "answered_not_interested") : "no_answer";
    await req("POST outcome", `/api/dialer/call/${callId}/outcome`, { method: "POST", cookie, biz: bi, body: { outcome, note: `load ${iter}` } });
    // CRM work between calls
    if (iter % 5 === 1) leadsPage = (await req("GET leads", "/api/leads?limit=30&period=all&page=1", { cookie, biz: bi })).json?.data?.items ?? leadsPage;
    const pick = leadsPage?.[Math.floor(Math.random() * leadsPage.length)];
    if (pick && Math.random() < 0.4) { counters.notes++; await req("POST note", "/api/notes", { method: "POST", cookie, biz: bi, body: { contactId: pick.contact.id, body: `הערת עומס ${iter} ${crypto.randomUUID().slice(0, 6)}` } }); }
    if (pick && Math.random() < 0.25) { counters.statusChanges++; await req("PATCH lead status", `/api/leads/${pick.id}`, { method: "PATCH", cookie, biz: bi, body: { status: Math.random() < 0.5 ? "contacted" : "qualified" } }); }
    if (answered && Math.random() < 0.2) { counters.whatsapp++; await req("POST post-call WhatsApp", `/api/dialer/call/${callId}/whatsapp`, { method: "POST", cookie, biz: bi, body: { templateId: biz.templateId, variables: { "1": "לקוח" }, requestId: crypto.randomUUID() }, expect: [409] }); }
    await sleep(rnd(500, 2000));
  }
  { const st = await poll(); const ac = st.json?.data?.activeCall; const wu = st.json?.data?.wrapUpCall;
    if (ac?.id) { await req("POST hangup", `/api/dialer/call/${ac.id}/hangup`, { method: "POST", cookie, biz: bi }); await sleep(1500); }
    const open = ac?.id ?? wu?.id; if (open) await req("POST outcome", `/api/dialer/call/${open}/outcome`, { method: "POST", cookie, biz: bi, body: { outcome: "no_answer", note: "end of run" } }); }
  await req("DELETE session", "/api/dialer/session", { method: "DELETE", cookie, biz: bi, body: { sessionId, browserSessionId } });
}

// ─── manager, webhooks, API, inbound ───────────────────────────────────────────────────────────────────────────
async function manager(biz, bi) {
  const seen = new Set(); let n = 0;
  await sleep(rnd(0, 3000));
  while (Date.now() < deadline) {
    n++; counters.managerPolls++;
    const r = await req("GET manager live", "/api/manager/live", { cookie: biz.manager.cookie, biz: bi });
    for (const row of r.json?.data?.rows ?? []) { const id = row.call?.id; if (id && !seen.has(id)) { seen.add(id); const at = callStartedAt.get(id); if (at) realtimeDelays.push(Date.now() - at); } }
    if (n % 15 === 0) await req("GET waiting card", "/api/leads/waiting", { cookie: biz.manager.cookie, biz: bi });
    if (n % 15 === 7) await req("GET agent report", "/api/reports/agents", { cookie: biz.manager.cookie, biz: bi });
    await sleep(2000);
  }
}
async function webhooks(biz, bi) {
  const factor = HEAVY_BIZ && bi === 0 ? 4 : 1; let k = 0;
  while (Date.now() < deadline) {
    await sleep(rnd(3000, 7000) / factor); k++;
    const body = JSON.stringify({ id: 900000 + k, number: String(k), status: k % 3 === 0 ? "processing" : "pending", currency: "ILS", total: "99.00", payment_url: "https://shop.example/pay", billing: { first_name: "Load", last_name: `W${k}`, email: `w${bi}-${k}@load.test`, phone: `0549${String(bi).padStart(2, "0")}${String(k % 10000).padStart(4, "0")}` }, line_items: [{ name: "מוצר", quantity: 1, price: 99 }] });
    const sig = crypto.createHmac("sha256", biz.store.secret).update(body).digest("base64");
    const send = () => req("POST woo webhook", `/api/webhooks/stores/woocommerce/${biz.store.id}`, { method: "POST", raw: true, body, headers: { "content-type": "application/json", "x-wc-webhook-signature": sig, "x-wc-webhook-topic": "order.created" }, biz: bi });
    counters.webhooks++; await send(); if (Math.random() < 0.2) { counters.webhooks++; await send(); } // duplicate delivery
    if (k % 2 === 0) { counters.apiLeads++; await req("POST v1 lead", "/api/v1/leads", { method: "POST", headers: { authorization: `Bearer ${biz.apiKey}` }, body: { fullName: `API ${bi}-${k}`, phone: `0548${String(bi).padStart(2, "0")}${String(k % 10000).padStart(4, "0")}`, source: "load-api" }, biz: bi }); }
  }
}
async function inbound(biz, bi) {
  const contacts = biz.probe.contactIds;
  while (Date.now() < deadline) {
    await sleep(rnd(8000, 14000)); counters.inbound++;
    await req("POST simulate inbound WA", "/api/demo/simulate-inbound", { method: "POST", cookie: biz.manager.cookie, body: { contactId: contacts[Math.floor(Math.random() * contacts.length)], body: "שאלה מהלקוח" }, biz: bi });
  }
}
async function crons() {
  let i = 0;
  while (Date.now() < deadline) {
    await sleep(30_000); i++;
    await req("CRON events", "/api/jobs/events", { headers: { authorization: `Bearer ${CRON}` } });
    if (i % 2 === 0) await req("CRON automations", "/api/jobs/automations", { headers: { authorization: `Bearer ${CRON}` } });
    if (i % 2 === 1) await req("CRON campaigns", "/api/jobs/campaigns", { headers: { authorization: `Bearer ${CRON}` } });
  }
}

// ─── resource sampling ─────────────────────────────────────────────────────────────────────────────────────────
const samples = [];
async function sampler() {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL }); await client.connect();
  const ports = (process.env.SERVER_PORTS ?? "3300").split(",");
  while (Date.now() < deadline + 5000) {
    const conns = (await client.query("select state, count(*)::int n from pg_stat_activity where datname = current_database() group by state")).rows;
    const q = (await client.query(`select (select count(*) from domain_events where status in ('pending','processing'))::int events_open, (select count(*) from webhook_deliveries where status='pending')::int deliveries_pending, (select count(*) from calls where ended_at is null)::int live_calls, (select count(*) from list_leads where status in ('locked','in_call'))::int locked_leads`)).rows[0];
    let cpu = 0, rss = 0;
    for (const p of ports) { try { const pid = execSync(`lsof -ti tcp:${p} -sTCP:LISTEN`).toString().trim().split("\n")[0]; const [c, r] = execSync(`ps -o %cpu=,rss= -p ${pid}`).toString().trim().split(/\s+/).map(Number); cpu += c; rss += r; } catch { /* not a server port */ } }
    samples.push({ t: Math.round((Date.now() - t0) / 1000), db: Object.fromEntries(conns.map((r) => [r.state ?? "null", r.n])), ...q, cpu, rssMb: Math.round(rss / 1024) });
    await sleep(5000);
  }
  await client.end();
}

// ─── run ───────────────────────────────────────────────────────────────────────────────────────────────────────
const businesses = SEED.slice(0, BIZ_LIMIT);
const tasks = [sampler(), crons()];
businesses.forEach((biz, bi) => { biz.agents.slice(0, PER_BIZ).forEach((a) => tasks.push(agent(biz, a, bi))); tasks.push(manager(biz, bi), webhooks(biz, bi), inbound(biz, bi)); });
const agentsTotal = businesses.reduce((n, b) => n + Math.min(PER_BIZ, b.agents.length), 0);
console.error(`running: ${businesses.length} businesses, ${agentsTotal} agents, ramp ${RAMP / 1000}s, steady ${DURATION / 1000}s → ${BASE}`);
const peak = { liveCalls: 0 }; const peakTimer = setInterval(() => { const s = samples.at(-1); if (s && s.live_calls > peak.liveCalls) peak.liveCalls = s.live_calls; }, 1000);
await Promise.all(tasks); clearInterval(peakTimer);

const all = [...lat.values()].flat(); const totalErr = [...errs.values()].reduce((n, v) => n + v.length, 0);
const endpoints = [...lat.entries()].map(([k, v]) => ({ endpoint: k, n: v.length, p50: pct(v, 50), p95: pct(v, 95), p99: pct(v, 99), max: Math.round(Math.max(...v)), errors: errs.get(k)?.length ?? 0, errorKinds: [...new Set(errs.get(k) ?? [])].slice(0, 4), expected4xx: expected.get(k)?.length ?? 0 })).sort((a, b) => b.n - a.n);
const crmNames = ["GET leads", "POST note", "PATCH lead status", "GET state", "POST next-lead", "POST outcome", "GET manager live", "POST personal-list", "POST session", "POST heartbeat"];
const crm = crmNames.flatMap((k) => lat.get(k) ?? []);
const summary = {
  scenario: { businesses: businesses.length, agents: agentsTotal, rampSec: RAMP / 1000, steadySec: DURATION / 1000, heavyBusiness: HEAVY_BIZ, base: BASE },
  totals: { requests: all.length, technicalErrors: totalErr, technicalErrorRate: all.length ? +(100 * totalErr / all.length).toFixed(3) : 0, p50: pct(all, 50), p95: pct(all, 95), p99: pct(all, 99), crmP95: pct(crm, 95), crmP99: pct(crm, 99), rps: +(all.length / ((Date.now() - t0) / 1000)).toFixed(1) },
  counters, peakLiveCalls: Math.max(peak.liveCalls, ...samples.map((s) => s.live_calls)),
  managerViewDelayMs: { n: realtimeDelays.length, p50: pct(realtimeDelays, 50), p95: pct(realtimeDelays, 95), max: realtimeDelays.length ? Math.max(...realtimeDelays) : null },
  perBusinessP95: [...bizLat.entries()].map(([b, v]) => ({ biz: b + 1, n: v.length, p95: pct(v, 95) })),
  resources: { maxDbConnections: Math.max(...samples.map((s) => Object.values(s.db).reduce((a, b) => a + b, 0))), maxEventsOpen: Math.max(...samples.map((s) => s.events_open)), maxDeliveriesPending: Math.max(...samples.map((s) => s.deliveries_pending)), maxCpu: Math.max(...samples.map((s) => s.cpu)), maxRssMb: Math.max(...samples.map((s) => s.rssMb)), samples: samples.length },
  endpoints,
};
if (process.env.OUT) fs.writeFileSync(process.env.OUT, JSON.stringify({ ...summary, samples }, null, 1));
console.log(JSON.stringify(summary, null, 1));
