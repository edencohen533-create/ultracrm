/**
 * Post-run invariants on the isolated DB (direct SQL, no RLS): run after a load scenario.
 *   DATABASE_URL=postgresql://…:5544/ultracrm_load node scripts/load/verify.mjs
 * Every check must be 0 (listed with the offending rows when not).
 */
import pg from "pg";
const c = new pg.Client({ connectionString: process.env.DATABASE_URL }); await c.connect();
const L = "b.slug like 'load-%'";
const checks = {
  "same number in two live calls at the same time (double dial)": `
    select c1.id, c2.id as other, c1.to_e164 from calls c1 join calls c2 on c2.business_id = c1.business_id and c2.to_e164 = c1.to_e164 and c2.id > c1.id
      and c1.created_at < coalesce(c2.ended_at, now() at time zone 'utc') and c2.created_at < coalesce(c1.ended_at, now() at time zone 'utc')
    join businesses b on b.id = c1.business_id where ${L} and c1.direction = 'outbound' and c2.direction = 'outbound' and c1.lead_dialed_at is not null and c2.lead_dialed_at is not null`,
  "one queue row dialed by two agents concurrently": `
    select c1.lead_id, c1.user_id, c2.user_id from calls c1 join calls c2 on c2.lead_id = c1.lead_id and c2.id > c1.id and c2.user_id <> c1.user_id
      and c1.created_at < coalesce(c2.ended_at, now() at time zone 'utc') and c2.created_at < coalesce(c1.ended_at, now() at time zone 'utc')
    join businesses b on b.id = c1.business_id where ${L}`,
  "call ↔ contact / agent / list in different businesses": `
    select cl.id from calls cl join businesses b on b.id = cl.business_id
      left join contacts ct on ct.id = cl.contact_id left join users u on u.id = cl.user_id left join dial_lists dl on dl.id = cl.list_id
    where ${L} and (ct.business_id <> cl.business_id or u.business_id <> cl.business_id or dl.business_id <> cl.business_id)`,
  "agent dialed a lead of another agent (personal queues)": `
    select cl.id, cl.user_id, dl.filter_json->>'leadOwnerUserId' as owner from calls cl join dial_lists dl on dl.id = cl.list_id join businesses b on b.id = cl.business_id
    where ${L} and dl.filter_json ? 'leadOwnerUserId' and dl.filter_json->>'leadOwnerUserId' <> cl.user_id`,
  "calls still live after the run (stuck)": `select cl.id, cl.status from calls cl join businesses b on b.id = cl.business_id where ${L} and cl.ended_at is null and cl.created_at < now() at time zone 'utc' - interval '2 minutes'`,
  "ended calls never documented (lost outcome)": `select cl.id from calls cl join businesses b on b.id = cl.business_id where ${L} and cl.ended_at is not null and cl.outcome_saved_at is null and cl.created_at < now() at time zone 'utc' - interval '2 minutes'`,
  "queue rows still locked after the run": `select l.id, l.status from list_leads l join businesses b on b.id = l.business_id where ${L} and l.status in ('locked','in_call') and l.updated_at < now() at time zone 'utc' - interval '3 minutes'`,
  "message / conversation / sender in different businesses": `
    select m.id from messages m join conversations cv on cv.id = m.conversation_id join businesses b on b.id = cv.business_id
      left join provider_credentials pc on pc.id = cv.provider_credential_id left join contacts ct on ct.id = cv.contact_id
    where ${L} and (m.business_id <> cv.business_id or pc.business_id <> cv.business_id or ct.business_id <> cv.business_id)`,
  "usage counter calls_started ≠ calls of the business (this month)": `
    select b.id, coalesce(u.value, 0) as counted, (select count(*) from calls cl where cl.business_id = b.id and cl.direction = 'outbound' and cl.created_at >= date_trunc('month', now() at time zone 'utc'))::int as calls
    from businesses b left join usage_counters u on u.business_id = b.id and u.metric = 'calls_started' and u.period = to_char(now() at time zone 'utc', 'YYYY-MM')
    where ${L} and coalesce(u.value, 0) <> (select count(*) from calls cl where cl.business_id = b.id and cl.direction = 'outbound' and cl.created_at >= date_trunc('month', now() at time zone 'utc'))`,
  "duplicate webhook created two carts for one order": `select ca.store_id, ca.external_id, count(*) from carts ca join businesses b on b.id = ca.business_id where ${L} group by 1, 2 having count(*) > 1`,
  "duplicate open leads for one contact (API ingest)": `select l.contact_id, count(*) from leads l join businesses b on b.id = l.business_id where ${L} and l.status in ('new','contacted','follow_up','qualified') group by 1 having count(*) > 1`,
  "domain events failed": `select e.type, count(*) from domain_events e join businesses b on b.id = e.business_id where ${L} and e.status = 'failed' group by 1`,
  "domain events still pending": `select e.type, count(*) from domain_events e join businesses b on b.id = e.business_id where ${L} and e.status in ('pending','processing') group by 1`,
  "notes whose author is from another business": `select n.id from notes n join users u on u.id = n.author_id join businesses b on b.id = n.business_id where ${L} and u.business_id <> n.business_id`,
};
let bad = 0; const report = {};
for (const [name, sql] of Object.entries(checks)) {
  try { const r = await c.query(sql); report[name] = r.rowCount; if (r.rowCount) { bad++; console.log(`❌ ${name}: ${r.rowCount}`, JSON.stringify(r.rows.slice(0, 3))); } else console.log(`✅ ${name}`); }
  catch (e) { bad++; report[name] = `error: ${e.message}`; console.log(`⚠️ ${name}: ${e.message}`); }
}
const totals = (await c.query(`select (select count(*) from calls cl join businesses b on b.id = cl.business_id where ${L})::int calls, (select count(*) from notes n join businesses b on b.id = n.business_id where ${L})::int notes, (select count(*) from messages m join businesses b on b.id = m.business_id where ${L})::int messages, (select count(*) from carts ca join businesses b on b.id = ca.business_id where ${L})::int carts`)).rows[0];
console.log("totals", JSON.stringify(totals));
await c.end();
process.exitCode = bad ? 1 : 0;
