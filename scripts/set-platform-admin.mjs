/**
 * Grant / revoke platform-admin rights to an EXISTING account (never possible from inside a business).
 *   node scripts/set-platform-admin.mjs you@example.com          → grant
 *   node scripts/set-platform-admin.mjs you@example.com --revoke → revoke
 * Uses DATABASE_URL_UNPOOLED / DATABASE_URL from .env. The change is written to access_audit_logs.
 */
import "dotenv/config";
import pg from "pg";
const [email, flag] = process.argv.slice(2);
if (!email) { console.error("usage: node scripts/set-platform-admin.mjs <email> [--revoke]"); process.exit(1); }
const on = flag !== "--revoke";
const c = new pg.Client({ connectionString: process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL }); await c.connect();
const r = await c.query("UPDATE accounts SET is_platform_admin = $2 WHERE lower(email) = lower($1) RETURNING id, email, is_platform_admin", [email, on]);
if (!r.rowCount) { console.error(`no account with email ${email}`); process.exit(1); }
await c.query("INSERT INTO access_audit_logs (id, business_id, actor_account_id, action, after, created_at) VALUES ($1, NULL, NULL, $2, $3, now())", [`aal_${Date.now().toString(36)}`, on ? "platform_admin.granted" : "platform_admin.revoked", JSON.stringify({ account: r.rows[0].id, via: "script" })]);
console.log(`${r.rows[0].email}: platform admin = ${r.rows[0].is_platform_admin}`);
await c.end();
