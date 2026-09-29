/**
 * A dedicated login for Meta App Review (owner of the demo business, English interface) with a strong random
 * password that is printed ONCE to your terminal – paste it into the App Review "test credentials" field.
 *   node scripts/create-reviewer.mjs reviewer@yourdomain.com            → create / reset password
 *   node scripts/create-reviewer.mjs reviewer@yourdomain.com --revoke   → disable it after the review
 * Options: --business <slug>; --create-isolated creates a new empty business and refuses existing accounts/slugs.
 * Without --create-isolated, the historical default is the business of owner@demo.local; prefer an explicit isolated slug.
 */
import "dotenv/config";
import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import pg from "pg";
const args = process.argv.slice(2);
const email = args.find((a) => a.includes("@"))?.toLowerCase();
if (!email) { console.error("usage: node scripts/create-reviewer.mjs <email> [--revoke] [--business <slug>]"); process.exit(1); }
const revoke = args.includes("--revoke");
const slug = args.includes("--business") ? args[args.indexOf("--business") + 1] : null;
const c = new pg.Client({ connectionString: process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL }); await c.connect();
if (args.includes("--create-isolated")) {
  if (!slug) throw new Error("--create-isolated requires --business <new slug>");
  if ((await c.query("SELECT id FROM accounts WHERE lower(email)=$1",[email])).rowCount) throw new Error("Use a new reviewer email; existing accounts are never reset in isolated mode");
  if ((await c.query("SELECT id FROM businesses WHERE slug=$1",[slug])).rowCount) throw new Error("Use a new isolated business slug");
  await c.query("INSERT INTO businesses (id,name,slug,modules,updated_at) VALUES ($1,$2,$3,$4,now())", [`revbiz${crypto.randomBytes(10).toString("hex")}`, "Meta Review — isolated test business", slug, JSON.stringify({crm:true,messaging:true,whatsapp:true})]);
}
const biz = slug ? (await c.query("SELECT id, name FROM businesses WHERE slug = $1", [slug])).rows[0] : (await c.query("SELECT b.id, b.name FROM businesses b JOIN users u ON u.business_id = b.id WHERE lower(u.email) = 'owner@demo.local' AND u.role = 'owner' ORDER BY b.created_at LIMIT 1")).rows[0];
if (!biz) { console.error("business not found"); process.exit(1); }
const acc = (await c.query("SELECT id FROM accounts WHERE lower(email) = $1", [email])).rows[0];
if (revoke) {
  if (!acc) { console.error("no such account"); process.exit(1); }
  await c.query("UPDATE users SET is_active = false WHERE account_id = $1", [acc.id]);
  await c.query("UPDATE accounts SET password_hash = $2, session_version = session_version + 1 WHERE id = $1", [acc.id, crypto.randomBytes(32).toString("hex")]);
  console.log(`${email}: disabled`); await c.end(); process.exit(0);
}
const password = crypto.randomBytes(12).toString("base64url");
const hash = await bcrypt.hash(password, 10);
let accountId = acc?.id;
if (accountId) await c.query("UPDATE accounts SET password_hash = $2, session_version = session_version + 1 WHERE id = $1", [accountId, hash]);
else { accountId = `rev${crypto.randomBytes(10).toString("hex")}`; await c.query("INSERT INTO accounts (id, email, full_name, password_hash, updated_at) VALUES ($1,$2,'Meta Reviewer',$3,now())", [accountId, email, hash]); }
const u = (await c.query("SELECT id FROM users WHERE account_id = $1 AND business_id = $2", [accountId, biz.id])).rows[0];
if (u) await c.query("UPDATE users SET is_active = true, role = 'owner' WHERE id = $1", [u.id]);
else await c.query("INSERT INTO users (id, business_id, account_id, email, full_name, role, updated_at) VALUES ($1,$2,$3,$4,'Meta Reviewer','owner',now())", [`rev${crypto.randomBytes(10).toString("hex")}`, biz.id, accountId, email]);
console.log(`Reviewer login for "${biz.name}"\n  URL:      ${process.env.NEXT_PUBLIC_APP_URL ?? "https://ultracrm-eta.vercel.app"}/login\n  Email:    ${email}\n  Password: ${password}\n(The interface language button "English" is at the top of the login page and the side menu.)`);
await c.end();
