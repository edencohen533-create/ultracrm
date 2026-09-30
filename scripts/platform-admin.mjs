/**
 * Platform administrators – granted ONLY here, by an operator with direct database access (never from the app, a
 * business's settings or any API request; a business owner is never a platform admin by default).
 *   node scripts/platform-admin.mjs list
 *   node scripts/platform-admin.mjs grant  <email>   – the account must exist, be active and CLAIMED (password set)
 *   node scripts/platform-admin.mjs revoke <email>
 * Uses DATABASE_URL (or .env). Every change is written to access_audit_logs (actor: operator CLI) and revokes the
 * account's sessions (sessionVersion + 1) so a new sign-in picks the change up.
 */
import pg from "pg";
import fs from "node:fs";
import crypto from "node:crypto";

const [cmd, emailArg] = process.argv.slice(2);
let url = process.env.DATABASE_URL;
if (!url && fs.existsSync(".env")) url = Object.fromEntries(fs.readFileSync(".env", "utf8").split("\n").filter((l) => l.includes("=")).map((l) => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1).replace(/^"|"$/g, "")]; })).DATABASE_URL;
if (!url) { console.error("DATABASE_URL is required"); process.exit(1); }
const schema = new URL(url).searchParams.get("schema");
const c = new pg.Client({ connectionString: url.replace(/[?&]schema=[^&]*/, "") });
await c.connect();
if (schema) await c.query(`SET search_path TO "${schema.replaceAll('"', '""')}"`);
try {
  if (cmd === "list") {
    const r = await c.query(`SELECT email, full_name, is_active, claimed_at IS NOT NULL AS claimed FROM accounts WHERE is_platform_admin ORDER BY email`);
    console.table(r.rows);
  } else if (cmd === "grant" || cmd === "revoke") {
    const email = String(emailArg ?? "").trim().toLowerCase();
    if (!email.includes("@")) throw new Error("usage: grant|revoke <email>");
    await c.query("BEGIN");
    const a = (await c.query(`SELECT id, is_active, claimed_at, is_platform_admin FROM accounts WHERE email = $1 FOR UPDATE`, [email])).rows[0];
    if (!a) throw new Error("no account with this email – the person must first join a business and set a password");
    if (cmd === "grant" && (!a.is_active || !a.claimed_at)) throw new Error("the account is not active / not claimed (no password set yet) – not granted");
    const next = cmd === "grant";
    if (a.is_platform_admin === next) { console.log(`no change: ${email} is ${next ? "already" : "not"} a platform admin`); await c.query("ROLLBACK"); }
    else {
      await c.query(`UPDATE accounts SET is_platform_admin = $2, session_version = session_version + 1 WHERE id = $1`, [a.id, next]);
      await c.query(`INSERT INTO access_audit_logs (id, business_id, actor_account_id, target_user_id, action, before, after, created_at) VALUES ($1, NULL, NULL, NULL, $2, $3, $4, now())`,
        [`pa_${crypto.randomUUID()}`, next ? "platform_admin.granted" : "platform_admin.revoked", JSON.stringify({ isPlatformAdmin: a.is_platform_admin }), JSON.stringify({ accountId: a.id, isPlatformAdmin: next, via: "operator_cli" })]);
      await c.query("COMMIT");
      console.log(`${next ? "granted" : "revoked"}: ${email} (sessions revoked – sign in again)`);
    }
  } else { console.log("usage: node scripts/platform-admin.mjs list | grant <email> | revoke <email>"); }
} catch (e) { await c.query("ROLLBACK").catch(() => undefined); console.error(e.message); process.exitCode = 1; }
await c.end();
