/**
 * PostgreSQL row-level security for tenant tables (defence in depth under the application scoping in db.ts).
 *
 * Every statement that runs inside a business context is executed as the non-owner role `ultracrm_runtime`
 * with `app.business_id` (and `app.account_id`) set *transaction-locally*:
 *   • an autocommit statement is wrapped in its own BEGIN … COMMIT so the settings never outlive it, and
 *   • inside an explicit transaction the settings are applied once, right after BEGIN / SET TRANSACTION.
 * Transaction-local settings are the only safe option behind the Neon pooler (PgBouncer transaction mode),
 * where session-level SET/RESET could leak onto another client's server connection.
 *
 * Statements without a business context (login, webhook routing, cron enumeration, migrations) keep running
 * as the connection owner, exactly as before. The policies live in prisma/migrations/*_rls_session_version.
 * `DB_RLS=off` disables the wrapper (for a database where the migration has not been applied yet).
 */
import pg from "pg";
import { AsyncResource } from "node:async_hooks";
import { currentAccountId, currentBusinessId } from "@/lib/tenant";

export const RUNTIME_ROLE = "ultracrm_runtime";
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function rlsEnabled() {
  return process.env.DB_RLS !== "off";
}

function setupSql(businessId: string, accountId: string | null) {
  if (!ID_RE.test(businessId) || (accountId !== null && !ID_RE.test(accountId))) throw new Error("invalid tenant identifier");
  return `SET LOCAL ROLE ${RUNTIME_ROLE}; SELECT set_config('app.business_id', '${businessId}', true), set_config('app.account_id', '${accountId ?? ""}', true)`;
}

type Kind = "begin" | "commit" | "rollback" | "rollback_to" | "control" | "other";
function classify(sql: string): Kind {
  if (/^\s*(BEGIN|START\s+TRANSACTION)\b/i.test(sql)) return "begin";
  if (/^\s*(COMMIT|END)\b/i.test(sql)) return "commit";
  if (/^\s*ROLLBACK\s+TO\b/i.test(sql)) return "rollback_to";
  if (/^\s*ROLLBACK\b/i.test(sql)) return "rollback";
  if (/^\s*(SET|RESET|SAVEPOINT|RELEASE|DEALLOCATE|DISCARD)\b/i.test(sql)) return "control";
  return "other";
}

type QueryArgs = unknown[];
type Submittable = { submit: (connection: unknown) => void };

/** Wrap `client.query` so tenant statements run under the runtime role with transaction-local settings. */
export function patchClient(client: pg.Client) {
  const orig = client.query.bind(client) as (...args: QueryArgs) => Promise<pg.QueryResult>;
  let inTx = false;
  let applied = false;
  let applying: Promise<unknown> | null = null;
  const patched = function (this: pg.Client, ...args: QueryArgs) {
    const cb = typeof args[args.length - 1] === "function" ? (args.pop() as (err: Error | null, res?: pg.QueryResult) => void) : null;
    const first = args[0];
    if (first && typeof first === "object" && typeof (first as Submittable).submit === "function") {
      // Cursors / streams bypass the wrapper (not used by Prisma); keep native behaviour.
      return cb ? orig(first, cb) : orig(first);
    }
    const sql = typeof first === "string" ? first : String((first as { text?: string } | undefined)?.text ?? "");
    const run = async () => {
      const kind = classify(sql);
      if (kind === "begin") { const r = await orig(...args); inTx = true; applied = false; return r; }
      if (kind === "commit" || kind === "rollback") { try { return await orig(...args); } finally { inTx = false; applied = false; applying = null; } }
      // ROLLBACK TO SAVEPOINT also reverts SET LOCAL / transaction-local settings → re-apply before the next statement.
      if (kind === "rollback_to") { try { return await orig(...args); } finally { applied = false; applying = null; } }
      const businessId = currentBusinessId();
      if (!businessId || kind === "control") return orig(...args);
      if (inTx) {
        if (!applied) {
          applying ??= orig(setupSql(businessId, currentAccountId())).then(() => { applied = true; });
          await applying;
        }
        return orig(...args);
      }
      await orig(`BEGIN; ${setupSql(businessId, currentAccountId())}`);
      try {
        const r = await orig(...args);
        if (/^\s*SELECT\b/i.test(sql)) {
          // Read-only statement: the result is already in hand and COMMIT of a read cannot change data, so do not
          // wait for its round trip. pg serialises queries per client, so anything queued next on this connection
          // (including another tenant's BEGIN) runs strictly after this COMMIT.
          void orig("COMMIT").catch(() => undefined);
          return r;
        }
        await orig("COMMIT");
        return r;
      } catch (e) {
        await orig("ROLLBACK").catch(() => undefined);
        throw e;
      }
    };
    const p = run();
    if (cb) { p.then((r) => cb(null, r), (e) => cb(e)); return undefined; }
    return p;
  };
  (client as unknown as { query: unknown }).query = patched;
}

export function createTenantPool(config: pg.PoolConfig): pg.Pool {
  const pool = new pg.Pool(config);
  if (!rlsEnabled()) return pool;
  pool.on("connect", (client) => patchClient(client));
  // Under pool saturation pg-pool dispatches a queued request from the *releasing* client's socket handler, i.e. in a
  // foreign async context. Bind the callback to the requester's context so the wrapper reads the right tenant.
  const connect = pool.connect.bind(pool) as (cb?: (err: Error, client: pg.PoolClient, done: (release?: unknown) => void) => void) => Promise<pg.PoolClient> | void;
  (pool as unknown as { connect: unknown }).connect = ((cb?: (err: Error, client: pg.PoolClient, done: (release?: unknown) => void) => void) =>
    cb ? connect(AsyncResource.bind(cb)) : connect()) as typeof pool.connect;
  return pool;
}
