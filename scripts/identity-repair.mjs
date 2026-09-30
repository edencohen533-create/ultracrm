/**
 * Existing-customer identity: scan + repair of existing data.
 *   node scripts/identity-repair.mjs            → report only (READ ONLY transaction)
 *   node scripts/identity-repair.mjs --apply    → also applies the CERTAIN fixes, in one transaction
 * Uses DATABASE_URL (optionally ?schema=…). Output: counts + internal ids only – no names / phone numbers.
 *
 * Certain fixes (applied with --apply):
 *   1. contacts.customer_since ← earliest purchase (won deal / paid store order) when missing.
 *   2. open leads opened after the person's first purchase → existing_customer = true (they are not "new leads").
 *   3. pending rows of existing customers in ACQUISITION campaigns → completed (reason existing_customer).
 *   4. unassigned open leads of customers with no active handler → review_reason (a manager assigns; never round robin).
 * Reported only (need a person – nothing is merged, moved or deleted automatically):
 *   the same number on two cards, possible duplicates (same last 9 digits), open leads of a customer owned by someone
 *   other than the handling agent, a person with open leads at two agents, customers whose handler is inactive.
 * Payment records are NOT read by this script (store orders and won deals are the purchase facts used here).
 */
import pg from "pg";
import fs from "node:fs";

const APPLY = process.argv.includes("--apply");
let url = process.env.DATABASE_URL;
if (!url && fs.existsSync(".env")) url = Object.fromEntries(fs.readFileSync(".env", "utf8").split("\n").filter((l) => l.includes("=")).map((l) => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1).replace(/^"|"$/g, "")]; })).DATABASE_URL;
const schema = new URL(url).searchParams.get("schema");
const c = new pg.Client({ connectionString: url.replace(/[?&]schema=[^&]*/, "") });
await c.connect();
await c.query(APPLY ? "BEGIN" : "BEGIN READ ONLY");
if (schema) await c.query(`SET LOCAL search_path TO "${schema.replaceAll('"', '""')}"`);
const q = async (sql, p = []) => (await c.query(sql, p)).rows;
const PURCHASES = `(SELECT business_id, contact_id, closed_at AS at, owner_user_id FROM deals WHERE status = 'won'
  UNION ALL SELECT business_id, contact_id, coalesce(converted_at, updated_at), NULL FROM carts WHERE contact_id IS NOT NULL AND status IN ('converted','recovered'))`;
const CUST = `(SELECT business_id, contact_id, min(at) AS first_at FROM ${PURCHASES} p GROUP BY 1, 2)`;
const OPEN = `('new','contacted','follow_up','qualified')`;
const report = {};

report.sameNumberTwoCards = await q(`SELECT cp.business_id, count(*)::int n, array_agg(cp.contact_id || '~' || k.id) pairs FROM contact_phones cp JOIN contacts k ON k.business_id = cp.business_id AND k.phone_e164 = cp.e164 AND k.id <> cp.contact_id GROUP BY 1`);
report.possibleDuplicatesLast9 = await q(`SELECT business_id, count(*)::int groups, (array_agg(ids))[1:20] sample FROM (SELECT business_id, array_agg(id) ids FROM contacts GROUP BY business_id, right(regexp_replace(phone_e164, '\\D', '', 'g'), 9) HAVING count(*) > 1) t GROUP BY 1`);
report.openLeadsAtTwoAgents = await q(`SELECT business_id, count(*)::int n, (array_agg(contact_id))[1:20] contacts FROM (SELECT business_id, contact_id FROM leads WHERE status::text IN ${OPEN} AND owner_user_id IS NOT NULL GROUP BY 1, 2 HAVING count(DISTINCT owner_user_id) > 1) t GROUP BY 1`);
report.customerLeadNotWithHandler = await q(`
  WITH h AS (SELECT k.id contact_id, k.business_id, COALESCE(
      (SELECT u.id FROM users u WHERE u.id = k.owner_user_id AND u.is_active AND u.role = 'agent'),
      (SELECT d.owner_user_id FROM deals d JOIN users su ON su.id = d.owner_user_id AND su.is_active WHERE d.contact_id = k.id AND d.status = 'won' ORDER BY d.closed_at DESC NULLS LAST LIMIT 1)) handler
    FROM contacts k JOIN ${CUST} cu ON cu.contact_id = k.id)
  SELECT l.business_id, count(*)::int n, (array_agg(l.id))[1:20] leads FROM leads l JOIN h ON h.contact_id = l.contact_id
  WHERE l.status::text IN ${OPEN} AND h.handler IS NOT NULL AND l.owner_user_id IS DISTINCT FROM h.handler GROUP BY 1`);
report.customersHandlerInactive = await q(`
  SELECT k.business_id, count(*)::int n, (array_agg(k.id))[1:20] contacts FROM contacts k JOIN ${CUST} cu ON cu.contact_id = k.id
  WHERE NOT EXISTS (SELECT 1 FROM users u WHERE u.id = k.owner_user_id AND u.is_active AND u.role = 'agent')
    AND NOT EXISTS (SELECT 1 FROM deals d JOIN users su ON su.id = d.owner_user_id AND su.is_active WHERE d.contact_id = k.id AND d.status = 'won')
  GROUP BY 1`);

// Certain fixes (counted in dry run, applied with --apply).
const fix = {};
const run = async (name, countSql, applySql) => { fix[name] = (await q(countSql))[0]?.n ?? 0; if (APPLY && fix[name]) await c.query(applySql); };
await run("customerSinceBackfill",
  `SELECT count(*)::int n FROM contacts k JOIN ${CUST} cu ON cu.contact_id = k.id WHERE k.customer_since IS NULL OR k.customer_since > cu.first_at`,
  `UPDATE contacts k SET customer_since = cu.first_at FROM ${CUST} cu WHERE cu.contact_id = k.id AND (k.customer_since IS NULL OR k.customer_since > cu.first_at)`);
await run("leadsMarkedExistingCustomer",
  `SELECT count(*)::int n FROM leads l JOIN ${CUST} cu ON cu.contact_id = l.contact_id WHERE l.created_at > cu.first_at AND NOT l.existing_customer`,
  `UPDATE leads l SET existing_customer = true FROM ${CUST} cu WHERE cu.contact_id = l.contact_id AND l.created_at > cu.first_at AND NOT l.existing_customer`);
await run("acquisitionRowsClosed",
  `SELECT count(*)::int n FROM list_leads ll JOIN dial_lists dl ON dl.id = ll.list_id WHERE dl.audience = 'new_prospects' AND ll.status::text IN ('pending','callback') AND EXISTS (SELECT 1 FROM ${CUST} cu WHERE cu.contact_id = ll.contact_id)`,
  `UPDATE list_leads ll SET status = 'completed', next_attempt_at = NULL, preferred_user_id = NULL, last_skip_reason = 'existing_customer', updated_at = now()
     FROM dial_lists dl WHERE dl.id = ll.list_id AND dl.audience = 'new_prospects' AND ll.status::text IN ('pending','callback') AND EXISTS (SELECT 1 FROM ${CUST} cu WHERE cu.contact_id = ll.contact_id)`);
await run("reviewFlagged",
  `SELECT count(*)::int n FROM leads l WHERE l.status::text IN ${OPEN} AND l.owner_user_id IS NULL AND l.review_reason IS NULL AND EXISTS (SELECT 1 FROM ${CUST} cu WHERE cu.contact_id = l.contact_id)
     AND NOT EXISTS (SELECT 1 FROM contacts k JOIN users u ON u.id = k.owner_user_id AND u.is_active AND u.role = 'agent' WHERE k.id = l.contact_id)
     AND NOT EXISTS (SELECT 1 FROM deals d JOIN users su ON su.id = d.owner_user_id AND su.is_active WHERE d.contact_id = l.contact_id AND d.status = 'won')`,
  `UPDATE leads l SET review_reason = 'handler_inactive' WHERE l.status::text IN ${OPEN} AND l.owner_user_id IS NULL AND l.review_reason IS NULL AND EXISTS (SELECT 1 FROM ${CUST} cu WHERE cu.contact_id = l.contact_id)
     AND NOT EXISTS (SELECT 1 FROM contacts k JOIN users u ON u.id = k.owner_user_id AND u.is_active AND u.role = 'agent' WHERE k.id = l.contact_id)
     AND NOT EXISTS (SELECT 1 FROM deals d JOIN users su ON su.id = d.owner_user_id AND su.is_active WHERE d.contact_id = l.contact_id AND d.status = 'won')`);
await c.query(APPLY ? "COMMIT" : "ROLLBACK");
await c.end();
console.log(JSON.stringify({ mode: APPLY ? "applied" : "dry-run", fixes: fix, needsAPerson: report }, null, 2));
