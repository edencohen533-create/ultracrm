/**
 * Failure & recovery scenarios on the isolated env (mock telephony, no paid sends):
 *  F1 network drop while dialing + retry with the same key · F2 page refresh (new tab id) during a live call ·
 *  F3 connection lost mid-call, then back · F4 stale session / expired lock is reclaimed · F5 dial rate limit ·
 *  F6 duplicate + out-of-order WhatsApp status webhooks · F7 duplicate + out-of-order store webhooks.
 *   SEED=… BASE=… DATABASE_URL=… META_APP_SECRET=… node scripts/load/faults.mjs
 */
import fs from "node:fs";
import crypto from "node:crypto";
import pg from "pg";
const SEED = JSON.parse(fs.readFileSync(process.env.SEED, "utf8"));
const BASE = process.env.BASE ?? "http://127.0.0.1:3300";
const db = new pg.Client({ connectionString: process.env.DATABASE_URL }); await db.connect();
const q = async (sql, p = []) => (await db.query(sql, p)).rows;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = []; let failed = 0;
const check = (name, ok, detail = "") => { if (!ok) failed++; out.push(`${ok ? "✅" : "❌"} ${name}${detail ? ` – ${detail}` : ""}`); };
const call = async (path, { method = "GET", body, cookie, headers = {}, signal } = {}) => { const r = await fetch(`${BASE}${path}`, { method, headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}), ...headers }, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body), signal }); let j = null; try { j = await r.json(); } catch { /* */ } return { status: r.status, json: j }; };
const biz = SEED[SEED.length - 1]; // last business – not used by the ladder scenarios' first businesses
async function startAgent(a) {
  const tab = `fault-${crypto.randomUUID()}`;
  const list = (await call("/api/dialer/personal-list", { method: "POST", cookie: a.cookie })).json.data.id;
  const s = await call("/api/dialer/session", { method: "POST", cookie: a.cookie, body: { mode: "preview", listId: list, browserSessionId: tab } });
  return { tab, list, sessionId: s.json.data.id ?? s.json.data.session?.id };
}
const state = (a, tab) => call(`/api/dialer/state?browserSessionId=${tab}`, { cookie: a.cookie });
async function waitEnd(a, tab, callId, max = 30) { for (let i = 0; i < max; i++) { const s = await state(a, tab); const ac = s.json?.data?.activeCall; if (ac?.status === "answered") await call(`/api/dialer/call/${callId}/hangup`, { method: "POST", cookie: a.cookie }); if (!ac) return s; await sleep(1000); } return state(a, tab); }

// F1 – network drop right after sending the dial, then retry with the same idempotency key
{ const a = biz.agents[40]; const s = await startAgent(a);
  const lead = (await call("/api/dialer/next-lead", { method: "POST", cookie: a.cookie, body: { sessionId: s.sessionId, browserSessionId: s.tab } })).json.data;
  const key = crypto.randomUUID(); const body = { idempotencyKey: key, mode: "preview", sessionId: s.sessionId, browserSessionId: s.tab, leadId: lead.id, lockToken: lead.lockToken };
  try { await call("/api/dialer/call", { method: "POST", cookie: a.cookie, body, signal: AbortSignal.timeout(15) }); } catch { /* dropped */ }
  await sleep(300);
  const retry = await call("/api/dialer/call", { method: "POST", cookie: a.cookie, body });
  const rows = await q("select id from calls where idempotency_key = $1", [key]);
  check("F1 dial retried after a dropped request creates exactly one call", rows.length === 1 && retry.json?.data?.id === rows[0].id, `calls=${rows.length} status=${retry.status}`);
  await waitEnd(a, s.tab, rows[0]?.id);
  if (rows[0]) await call(`/api/dialer/call/${rows[0].id}/outcome`, { method: "POST", cookie: a.cookie, body: { outcome: "no_answer" } });
}
// F2 – refresh during a live call: the new tab takes over the session and sees the same call; no second call
{ const a = biz.agents[41]; const s = await startAgent(a);
  const lead = (await call("/api/dialer/next-lead", { method: "POST", cookie: a.cookie, body: { sessionId: s.sessionId, browserSessionId: s.tab } })).json.data;
  const c = (await call("/api/dialer/call", { method: "POST", cookie: a.cookie, body: { idempotencyKey: crypto.randomUUID(), mode: "preview", sessionId: s.sessionId, browserSessionId: s.tab, leadId: lead.id, lockToken: lead.lockToken } })).json.data;
  const tab2 = `fault-refresh-${crypto.randomUUID()}`;
  const take = await call("/api/dialer/session", { method: "POST", cookie: a.cookie, body: { mode: "preview", listId: s.list, browserSessionId: tab2 } });
  const st2 = await state(a, tab2);
  const oldTabNext = await call("/api/dialer/next-lead", { method: "POST", cookie: a.cookie, body: { sessionId: s.sessionId, browserSessionId: s.tab } });
  check("F2 refresh: new tab sees the same live call", st2.json?.data?.activeCall?.id === c.id || st2.json?.data?.wrapUpCall?.id === c.id, `take=${take.status}`);
  check("F2 refresh: the old tab can no longer pull leads (single owner)", oldTabNext.status === 409, `status=${oldTabNext.status} ${oldTabNext.json?.code ?? ""}`);
  await waitEnd(a, tab2, c.id); await call(`/api/dialer/call/${c.id}/outcome`, { method: "POST", cookie: a.cookie, body: { outcome: "no_answer" } });
  check("F2 no second call was created", (await q("select count(*)::int n from calls where user_id = $1 and created_at > now() at time zone 'utc' - interval '2 minutes'", [a.id]))[0].n === 1);
}
// F3 – connection lost for 25s during an answered call, then back: the call is still there and can be finished
{ const a = biz.agents[42]; const s = await startAgent(a);
  let c = null;
  for (let i = 0; i < 6 && !c; i++) { // find a lead that answers (last digit 5/6/7)
    const lead = (await call("/api/dialer/next-lead", { method: "POST", cookie: a.cookie, body: { sessionId: s.sessionId, browserSessionId: s.tab } })).json.data;
    const x = (await call("/api/dialer/call", { method: "POST", cookie: a.cookie, body: { idempotencyKey: crypto.randomUUID(), mode: "preview", sessionId: s.sessionId, browserSessionId: s.tab, leadId: lead.id, lockToken: lead.lockToken } })).json.data;
    for (let k = 0; k < 12; k++) { const st = await state(a, s.tab); if (st.json?.data?.activeCall?.status === "answered") { c = x; break; } if (!st.json?.data?.activeCall) break; await sleep(1000); }
    if (!c) { await waitEnd(a, s.tab, x.id); await call(`/api/dialer/call/${x.id}/outcome`, { method: "POST", cookie: a.cookie, body: { outcome: "no_answer" } }); }
  }
  if (c) {
    await sleep(25_000); // offline – no polls, no heartbeat
    const back = await state(a, s.tab);
    check("F3 after reconnect the answered call is still shown to its agent", back.json?.data?.activeCall?.id === c.id);
    await call(`/api/dialer/call/${c.id}/hangup`, { method: "POST", cookie: a.cookie }); await waitEnd(a, s.tab, c.id);
    const o = await call(`/api/dialer/call/${c.id}/outcome`, { method: "POST", cookie: a.cookie, body: { outcome: "answered_interested" } });
    check("F3 the call is documented after reconnect", o.status === 200);
  } else check("F3 found an answered call to test", false);
}
// F4 – stale session: lock expired + no heartbeat → the lead goes back to the queue, the session ends
{ const a = biz.agents[43]; const s = await startAgent(a);
  const lead = (await call("/api/dialer/next-lead", { method: "POST", cookie: a.cookie, body: { sessionId: s.sessionId, browserSessionId: s.tab } })).json.data;
  await q("update dialer_sessions set last_heartbeat_at = now() at time zone 'utc' - interval '1 hour' where id = $1", [s.sessionId]);
  await q("update list_leads set lock_expires_at = now() at time zone 'utc' - interval '1 minute' where id = $1", [lead.id]);
  const other = biz.agents[44];
  for (let i = 0; i < 60; i++) { await state(other, "fault-other"); const [r] = await q("select status from dialer_sessions where id = $1", [s.sessionId]); if (r.status === "ended") break; }
  const [sess] = await q("select status from dialer_sessions where id = $1", [s.sessionId]);
  const [row] = await q("select status, locked_by_user_id from list_leads where id = $1", [lead.id]);
  check("F4 stale session is ended and its locked lead returns to the queue", sess.status === "ended" && row.status !== "locked" && !row.locked_by_user_id, `session=${sess.status} lead=${row.status}`);
}
// F5 – dial rate limit: 3rd dial within a minute is refused (429), nothing stuck
{ const a = biz.agents[45];
  await q(`update businesses set settings = jsonb_set(settings, '{maxDialsPerMinute}', '2') where id = $1`, [biz.businessId]);
  const contacts = await q("select c.id from contacts c where c.business_id = $1 and c.owner_user_id = $2 and right(c.phone_e164, 1) = '1' limit 3", [biz.businessId, a.id]);
  const codes = [];
  for (const c of contacts) { const r = await call("/api/dialer/call", { method: "POST", cookie: a.cookie, body: { idempotencyKey: crypto.randomUUID(), mode: "manual", contactId: c.id } }); codes.push(r.status); if (r.json?.data?.id) { await waitEnd(a, "x", r.json.data.id); await call(`/api/dialer/call/${r.json.data.id}/outcome`, { method: "POST", cookie: a.cookie, body: { outcome: "busy" } }); } }
  await q(`update businesses set settings = jsonb_set(settings, '{maxDialsPerMinute}', '0') where id = $1`, [biz.businessId]);
  check("F5 rate limit refuses the 3rd dial in a minute (429) without breaking the agent", codes[2] === 429 && codes[0] === 200, codes.join(","));
}
// F6 – WhatsApp status webhooks: duplicates + out of order (read before delivered) never regress the status
{ const secret = process.env.META_APP_SECRET;
  const [cred] = await q(`insert into provider_credentials (id, business_id, channel, provider, is_active, is_default, phone_number_id, config, created_at, updated_at) values ($1, $2, 'whatsapp', 'meta_whatsapp_cloud_api', false, false, $3, jsonb_build_object('phoneNumberId', $3::text), now(), now()) returning id`, [`fault${Date.now()}`, biz.businessId, `loadpn${Date.now()}`]);
  const pn = (await q("select phone_number_id from provider_credentials where id = $1", [cred.id]))[0].phone_number_id;
  const contact = (await q("select id from contacts where business_id = $1 limit 1", [biz.businessId]))[0];
  const conv = (await q(`insert into conversations (id, business_id, contact_id, provider_credential_id, created_at, updated_at) values ($1, $2, $3, $4, now(), now()) returning id`, [`fconv${Date.now()}`, biz.businessId, contact.id, cred.id]))[0];
  const wamid = `wamid.LOAD${Date.now()}`;
  await q(`insert into messages (id, business_id, conversation_id, direction, type, body, status, provider_message_id, provider_credential_id, created_at) values ($1, $2, $3, 'OUTBOUND', 'TEXT', 'x', 'SENT', $4, $5, now())`, [`fmsg${Date.now()}`, biz.businessId, conv.id, wamid, cred.id]);
  const hook = (status, ts) => { const body = JSON.stringify({ object: "whatsapp_business_account", entry: [{ id: "waba", changes: [{ field: "messages", value: { messaging_product: "whatsapp", metadata: { phone_number_id: pn, display_phone_number: "972700000000" }, statuses: [{ id: wamid, status, timestamp: String(ts), recipient_id: "972500000000" }] } }] }] }); return call("/api/webhooks/whatsapp", { method: "POST", body, headers: { "x-hub-signature-256": `sha256=${crypto.createHmac("sha256", secret).update(body).digest("hex")}` } }); };
  const now = Math.floor(Date.now() / 1000);
  const codes = [(await hook("read", now + 3)).status, (await hook("delivered", now + 2)).status, (await hook("sent", now + 1)).status, (await hook("read", now + 3)).status, (await hook("read", now + 3)).status];
  const [m] = await q("select status from messages where provider_message_id = $1", [wamid]);
  const [ev] = await q("select count(*)::int n from provider_webhook_events where event_id like $1", [`${wamid}%`]);
  check("F6 out-of-order / duplicate WhatsApp statuses end as READ (no regression)", m.status === "READ", `final=${m.status} http=${codes.join(",")}`);
  check("F6 each status is recorded once (dedupe)", ev.n === 3, `events=${ev.n}`);
  const bad = await call("/api/webhooks/whatsapp", { method: "POST", body: "{}", headers: { "x-hub-signature-256": "sha256=deadbeef" } });
  check("F6 unsigned webhook rejected", bad.status === 401 || bad.status === 400, String(bad.status));
}
// F7 – store webhooks: 5 concurrent duplicates → one cart; "paid" update arriving before "created" is not reverted
{ const order = 700000 + Math.floor(Math.random() * 1e5);
  const mk = (status) => JSON.stringify({ id: order, number: String(order), status, currency: "ILS", total: "150.00", payment_url: "https://x", billing: { first_name: "F", last_name: "7", phone: "0549990077", email: `f7-${order}@load.test` }, line_items: [{ name: "x", quantity: 1, price: 150 }] });
  const send = (status, topic) => { const body = mk(status); return call(`/api/webhooks/stores/woocommerce/${biz.store.id}`, { method: "POST", body, headers: { "x-wc-webhook-signature": crypto.createHmac("sha256", biz.store.secret).update(body).digest("base64"), "x-wc-webhook-topic": topic } }); };
  await send("processing", "order.updated"); // paid first (out of order)
  await Promise.all([1, 2, 3, 4, 5].map(() => send("pending", "order.created")));
  const carts = await q("select status from carts where store_id = $1 and (external_id = $2 or order_id = $3)", [biz.store.id, `order:${order}`, String(order)]);
  check("F7 duplicates create one cart", carts.length === 1, `carts=${carts.length}`);
  check("F7 late 'created' does not undo the paid order", carts[0]?.status === "converted", `status=${carts[0]?.status}`);
}
console.log(out.join("\n")); console.log(`\n${out.length - failed}/${out.length} fault checks passed`);
await db.end(); process.exitCode = failed ? 1 : 0;
