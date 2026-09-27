/** Reset the isolated load DB between scenarios (local :5544 only): queue, calls, sessions, leads back to "new". */
import pg from "pg";
if (!/:5544\//.test(process.env.DATABASE_URL ?? "")) { console.error("refusing: local load DB only"); process.exit(1); }
const c = new pg.Client({ connectionString: process.env.DATABASE_URL }); await c.connect();
const B = "(select id from businesses where slug like 'load-%')";
for (const sql of [
  `delete from coach_sessions where business_id in ${B}`,
  `delete from calls where business_id in ${B}`,
  `delete from dialer_sessions where business_id in ${B}`,
  `delete from tasks where business_id in ${B}`,
  `update list_leads set status = 'pending', attempts = 0, follow_up_attempts = null, next_attempt_at = null, last_attempt_at = null, last_outcome = null, locked_by_user_id = null, lock_token = null, lock_expires_at = null, preferred_user_id = null where business_id in ${B}`,
  `update leads set status = 'new', closed_at = null where business_id in ${B} and source = 'load'`,
  `update users set presence = 'offline' where business_id in ${B}`,
  `delete from usage_counters where business_id in ${B}`,
  `delete from domain_events where business_id in ${B} and status in ('pending','processing','failed')`,
]) await c.query(sql);
console.log("reset done");
await c.end();
