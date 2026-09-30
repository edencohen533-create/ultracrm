/**
 * Restore drill – proves a backup can be restored, not just that one exists.
 *   node scripts/restore-drill.mjs            (DATABASE_URL = the SOURCE database; never run against production)
 * 1. Logical backup of every table (rows as JSON, ordered by id) into a temp folder – including uploaded media
 *    (stored in the database). Recordings (telephony provider) and WhatsApp media (Meta URLs) are NOT in the
 *    database and are reported as not covered.
 * 2. A NEW isolated database; schema from prisma/migrations (`prisma migrate deploy`); rows loaded with triggers /
 *    FKs deferred (session_replication_role = replica).
 * 3. Restore safety (src/server/ops/restore-safety.sql): in-flight queues parked so nothing can repeat an action.
 * 4. Verification: per-table row counts + content checksums equal the source; append-only trigger and RLS present;
 *    no locked queue rows / pending events / held budget left.
 * 5. The result is recorded in ops_drills of the SOURCE database (shown in platform ops) and the copy is dropped.
 * The restored copy must run with RESTORE_MODE=1 (no crons / dialing / sending / charging) if an app is ever pointed at it.
 */
import pg from "pg";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execSync } from "node:child_process";

// Keep timestamp / date values exactly as stored (node-postgres would otherwise shift "timestamp without time zone"
// through the machine's local time zone and the restore would silently move every time by the offset).
pg.types.setTypeParser(1114, (v) => v); pg.types.setTypeParser(1082, (v) => v);
const src = process.env.DATABASE_URL;
if (!src) { console.error("DATABASE_URL required"); process.exit(1); }
if (/neon\.tech|vercel|amazonaws/.test(src) && process.env.I_UNDERSTAND_THIS_IS_NOT_PRODUCTION !== "1") { console.error("Refusing: DATABASE_URL looks like a hosted (production) database. Run against a test copy."); process.exit(1); }
const started = new Date();
const u = new URL(src); const target = `ultracrm_restore_drill_${Date.now()}`;
const adminUrl = new URL(src); adminUrl.pathname = "/postgres";
const targetUrl = new URL(src); targetUrl.pathname = `/${target}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ucrm-backup-"));
const client = (url) => { const c = new pg.Client({ connectionString: url.toString() }); c.on("error", () => undefined); return c; };
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");
/** Canonical row form for checksums: sorted keys, dates as ISO, bytes as base64 – independent of column order. */
const canon = (rows) => JSON.stringify(rows.map((r) => Object.fromEntries(Object.keys(r).sort().map((k) => { const v = r[k]; return [k, v instanceof Date ? v.toISOString() : Buffer.isBuffer(v) ? v.toString("base64") : typeof v === "bigint" ? v.toString() : v]; }))));
const details = { source: `${u.hostname}:${u.port}${u.pathname}`, target, tables: {}, notCovered: ["הקלטות שיחה – אצל ספק הטלפוניה (Telnyx), לא בבסיס הנתונים", "מדיה של WhatsApp – קישורים אצל Meta"], covered: ["כל טבלאות בסיס הנתונים", "קבצים שהועלו (media_assets.data בתוך בסיס הנתונים)", "הגדרות העסקים (businesses.settings)"] };
let result = "ok"; const problems = [];

const s = client(src); await s.connect();
const tables = (await s.query(`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations' ORDER BY tablename`)).rows.map((r) => r.tablename);
// 1. backup
for (const t of tables) {
  const hasId = (await s.query(`SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 AND column_name='id'`, [t])).rowCount > 0;
  const rows = (await s.query(`SELECT * FROM "${t}"${hasId ? " ORDER BY id" : ""}`)).rows;
  fs.writeFileSync(path.join(dir, `${t}.json`), JSON.stringify(rows, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
  details.tables[t] = { rows: rows.length, checksum: sha(canon(rows)) };
}
// 2. restore into an isolated database
const a = client(adminUrl); await a.connect(); await a.query(`CREATE DATABASE "${target}"`); await a.end();
try {
  execSync("npx prisma migrate deploy", { env: { ...process.env, DATABASE_URL: targetUrl.toString(), DATABASE_URL_UNPOOLED: targetUrl.toString() }, stdio: "pipe" });
  var tg = client(targetUrl); await tg.connect();
  await tg.query("SET session_replication_role = replica");
  for (const t of tables) {
    const rows = JSON.parse(fs.readFileSync(path.join(dir, `${t}.json`), "utf8"));
    if (!rows.length) continue;
    const cols = Object.keys(rows[0]);
    const types = Object.fromEntries((await tg.query(`SELECT column_name, data_type FROM information_schema.columns WHERE table_schema='public' AND table_name=$1`, [t])).rows.map((r) => [r.column_name, r.data_type]));
    const conv = (c, v) => { if (v === null || v === undefined) return v; if (v?.type === "Buffer" && Array.isArray(v.data)) return Buffer.from(v.data); if (types[c] === "json" || types[c] === "jsonb") return JSON.stringify(v); return v; };
    for (let i = 0; i < rows.length; i += 200) {
      const chunk = rows.slice(i, i + 200); const vals = []; const params = [];
      chunk.forEach((r, ri) => { vals.push(`(${cols.map((_c, ci) => `$${ri * cols.length + ci + 1}`).join(",")})`); for (const c of cols) params.push(conv(c, r[c])); });
      await tg.query(`INSERT INTO "${t}" (${cols.map((c) => `"${c}"`).join(",")}) VALUES ${vals.join(",")}`, params);
    }
  }
  await tg.query("SET session_replication_role = DEFAULT");
  // 4a. verify data before the safety step changes queue rows
  for (const t of tables) {
    const hasId = (await tg.query(`SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 AND column_name='id'`, [t])).rowCount > 0;
    const rows = (await tg.query(`SELECT * FROM "${t}"${hasId ? " ORDER BY id" : ""}`)).rows;
    const cs = sha(canon(rows));
    if (process.env.DRILL_DEBUG === t) console.log("SRC", JSON.parse(fs.readFileSync(path.join(dir, `${t}.json`), "utf8"))[0], "\nDST", JSON.parse(canon(rows))[0]);
    details.tables[t].restoredRows = rows.length; details.tables[t].match = rows.length === details.tables[t].rows && cs === details.tables[t].checksum;
    if (!details.tables[t].match) problems.push(`${t}: ${details.tables[t].rows} → ${rows.length}${cs !== details.tables[t].checksum ? " (checksum differs)" : ""}`);
  }
  // 3. restore safety
  await tg.query(fs.readFileSync("src/server/ops/restore-safety.sql", "utf8"));
  // 4b. safety + structure checks
  const q = async (sql) => Number((await tg.query(sql)).rows[0].n);
  details.safety = { lockedQueueRows: await q(`SELECT count(*) n FROM list_leads WHERE status IN ('locked','in_call')`), pendingEvents: await q(`SELECT count(*) n FROM domain_events WHERE status IN ('pending','processing')`), pendingWebhooks: await q(`SELECT count(*) n FROM webhook_deliveries WHERE status = 'pending'`), pendingCrmWrites: await q(`SELECT count(*) n FROM crm_outbox WHERE status IN ('pending','failed')`), runningCampaigns: await q(`SELECT count(*) n FROM campaigns WHERE status IN ('SCHEDULED','RUNNING')`), heldBudget: await q(`SELECT count(*) n FROM budget_reservations WHERE status = 'held'`), openCalls: await q(`SELECT count(*) n FROM calls WHERE ended_at IS NULL`) };
  if (Object.values(details.safety).some((n) => n > 0)) problems.push(`restore safety left in-flight work: ${JSON.stringify(details.safety)}`);
  details.structure = { appendOnlyTrigger: await q(`SELECT count(*) n FROM pg_trigger WHERE tgname = 'usage_events_no_update'`), rlsTables: await q(`SELECT count(*) n FROM pg_tables WHERE schemaname='public' AND rowsecurity`) };
  if (!details.structure.appendOnlyTrigger) problems.push("append-only trigger missing after restore");
  await tg.end();
} catch (e) { result = "failed"; problems.push(`restore error: ${(e.stderr?.toString() || e.message).slice(0, 600)}`); await tg?.end().catch(() => undefined); }
finally {
  const a2 = client(adminUrl); await a2.connect(); await a2.query(`DROP DATABASE IF EXISTS "${target}" WITH (FORCE)`).catch(() => undefined); await a2.end();
  fs.rmSync(dir, { recursive: true, force: true });
}
if (result === "ok" && problems.length) result = "partial";
details.problems = problems;
await s.query(`INSERT INTO ops_drills (id, kind, environment, result, details, started_at, finished_at, performed_by) VALUES ($1, 'restore', $2, $3, $4, $5, now(), $6)`, [`drill_${crypto.randomUUID()}`, `isolated database on ${u.hostname}:${u.port}`, result, JSON.stringify(details), started, os.userInfo().username]);
await s.end();
const tot = Object.values(details.tables).reduce((n, x) => n + x.rows, 0);
console.log(JSON.stringify({ result, tables: tables.length, rows: tot, mismatched: problems.length, safety: details.safety, structure: details.structure, durationSec: Math.round((Date.now() - started.getTime()) / 1000) }, null, 2));
if (result !== "ok") { console.log(problems.join("\n")); process.exitCode = 1; }
