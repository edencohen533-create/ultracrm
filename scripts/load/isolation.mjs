/**
 * Cross-tenant / cross-agent access probes (server-side enforcement): swap ids in real requests and expect 403/404 or
 * empty results. Runs against the isolated env after seeding (needs at least 2 businesses with 2 agents).
 *   SEED=… BASE=http://127.0.0.1:3300 DATABASE_URL=… node scripts/load/isolation.mjs
 */
import fs from "node:fs";
import crypto from "node:crypto";
import pg from "pg";
const SEED = JSON.parse(fs.readFileSync(process.env.SEED, "utf8"));
const BASE = process.env.BASE ?? "http://127.0.0.1:3300";
const [A, B] = SEED;
const db = new pg.Client({ connectionString: process.env.DATABASE_URL }); await db.connect();
const one = async (sql, p) => (await db.query(sql, p)).rows[0];
// B's resources (created by the load run / seed)
const bCall = await one("select id from calls where business_id = $1 order by created_at desc limit 1", [B.businessId]);
const bList = await one("select id from dial_lists where business_id = $1 limit 1", [B.businessId]);
const bLead = { id: B.probe.leadIds[0], contactId: B.probe.contactIds[0] };
const bLeadName = (await one("select c.full_name from contacts c where c.id = $1", [bLead.contactId])).full_name;
// A's second agent's lead (same business, other agent)
const a2Lead = await one("select l.id, l.contact_id from leads l where l.business_id = $1 and l.owner_user_id = $2 limit 1", [A.businessId, A.agents[1].id]);
const results = []; let failed = 0;
async function probe(name, path, { method = "GET", body, cookie, headers = {}, ok }) {
  const res = await fetch(`${BASE}${path}`, { method, headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}), ...headers }, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) });
  const txt = await res.text(); let json = null; try { json = JSON.parse(txt); } catch { /* not json */ }
  const pass = ok(res.status, json, txt);
  if (!pass) failed++;
  results.push(`${pass ? "✅" : "❌"} ${name} → ${res.status}`);
}
const denied = (s) => s === 403 || s === 404;
const agentA = A.agents[0].cookie, mgrA = A.manager.cookie;
for (const [who, cookie] of [["agent A", agentA], ["manager A", mgrA]]) {
  await probe(`${who}: B lead by id`, `/api/leads/${bLead.id}`, { cookie, ok: denied });
  await probe(`${who}: PATCH B lead`, `/api/leads/${bLead.id}`, { method: "PATCH", cookie, body: { status: "lost" }, ok: denied });
  await probe(`${who}: B lead attempts`, `/api/leads/${bLead.id}/attempts`, { cookie, ok: denied });
  await probe(`${who}: B lead follow-up`, `/api/leads/${bLead.id}/follow-up`, { method: "PUT", cookie, body: { date: "2030-01-01", time: "10:00" }, ok: denied });
  await probe(`${who}: B lead move-to-list`, `/api/leads/${bLead.id}/move-to-list`, { method: "POST", cookie, body: { listId: bList?.id ?? "x" }, ok: denied });
  await probe(`${who}: B contact card`, `/api/contacts/${bLead.contactId}`, { cookie, ok: denied });
  await probe(`${who}: B contact timeline`, `/api/contacts/${bLead.contactId}/timeline`, { cookie, ok: denied });
  await probe(`${who}: note on B contact`, "/api/notes", { method: "POST", cookie, body: { contactId: bLead.contactId, body: "x" }, ok: denied });
  await probe(`${who}: close deal on B contact`, "/api/deals/close", { method: "POST", cookie, body: { contactId: bLead.contactId, items: [] }, ok: denied });
  await probe(`${who}: transfer B lead`, "/api/leads/transfer", { method: "POST", cookie, body: { leadIds: [bLead.id], toUserId: A.agents[0].id }, ok: (s, j) => denied(s) || (s === 200 && j?.data?.notFound?.includes(bLead.id)) });
  if (bCall) {
    await probe(`${who}: hang up B call`, `/api/dialer/call/${bCall.id}/hangup`, { method: "POST", cookie, ok: denied });
    await probe(`${who}: outcome on B call`, `/api/dialer/call/${bCall.id}/outcome`, { method: "POST", cookie, body: { outcome: "no_answer" }, ok: denied });
    await probe(`${who}: B call recording`, `/api/recordings/${bCall.id}`, { cookie, ok: denied });
    await probe(`${who}: WhatsApp on B call`, `/api/dialer/call/${bCall.id}/whatsapp`, { method: "POST", cookie, body: { templateId: A.templateId, variables: { "1": "x" } }, ok: denied });
  }
  if (bList) await probe(`${who}: B dial list`, `/api/lists/${bList.id}`, { cookie, ok: denied });
  await probe(`${who}: search B lead by name`, `/api/leads?q=${encodeURIComponent(bLeadName)}&period=all`, { cookie, ok: (s, j) => s === 200 && !j.data.items.some((x) => x.id === bLead.id || x.contact?.fullName === bLeadName) }); // search is word-based: A's own "ליד 1.x" may match, B's never
  await probe(`${who}: search B contact by name`, `/api/contacts?q=${encodeURIComponent(bLeadName)}`, { cookie, ok: (s, j) => s === 200 && !j.data.items.some((x) => x.id === bLead.contactId || x.fullName === bLeadName) });
}
await probe("manager A: report filtered to a B agent", `/api/reports/agents?userId=${B.agents[0].id}`, { cookie: mgrA, ok: (s, j) => s === 200 && j.data.rows.length === 0 });
await probe("manager A: live screen has only A users", "/api/manager/live", { cookie: mgrA, ok: (s, j) => s === 200 && j.data.rows.every((r) => A.agents.some((a) => a.id === r.id) || r.id === A.manager.id) });
await probe("manager A: B store", `/api/stores/${B.store.id}`, { cookie: mgrA, ok: denied });
await probe("A API key: lists only A leads", "/api/v1/leads?limit=100", { headers: { authorization: `Bearer ${A.apiKey}` }, ok: (s, j) => s === 200 && !j.data.items.some((l) => B.probe.leadIds.includes(l.id)) });
const wooBody = JSON.stringify({ id: 1, status: "pending", total: "1", billing: { phone: "0501111111" } });
await probe("B store webhook signed with A's secret", `/api/webhooks/stores/woocommerce/${B.store.id}`, { method: "POST", body: wooBody, headers: { "x-wc-webhook-signature": crypto.createHmac("sha256", A.store.secret).update(wooBody).digest("base64"), "x-wc-webhook-topic": "order.created" }, ok: (s) => s === 401 });
// forged session: A's token payload with B's businessId, original signature
const [h, p, sig] = agentA.replace("ultracrm_session=", "").split(".");
const payload = JSON.parse(Buffer.from(p, "base64url").toString()); payload.businessId = B.businessId;
await probe("forged JWT with another businessId", "/api/leads?limit=5", { cookie: `ultracrm_session=${h}.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.${sig}`, ok: (s) => s === 401 });
// same business, other agent (default permissions: agents see only their own data)
if (a2Lead) {
  await probe("agent A1: lead of agent A2", `/api/leads/${a2Lead.id}`, { cookie: agentA, ok: denied });
  await probe("agent A1: contact of agent A2", `/api/contacts/${a2Lead.contact_id}`, { cookie: agentA, ok: denied });
  await probe("agent A1: note on A2's contact", "/api/notes", { method: "POST", cookie: agentA, body: { contactId: a2Lead.contact_id, body: "x" }, ok: denied });
}
console.log(results.join("\n")); console.log(`\n${results.length - failed}/${results.length} probes denied correctly`);
await db.end(); process.exitCode = failed ? 1 : 0;
