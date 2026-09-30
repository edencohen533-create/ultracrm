/**
 * Initial import and reconcile for WooCommerce, resumable:
 *  • Preview: real counts per resource (X-WP-Total) for the chosen scope before anything is imported.
 *  • Pages of 50, ordered by id (stable); the cursor (page per resource) is saved after every page, so a stop – timeout,
 *    rate limit (429 → Retry-After), temporary outage – resumes exactly there. 5 transient errors in a row → paused
 *    with the error shown; permission / key errors stop with an explanation.
 *  • Items go through the same event path as webhooks (dedupe, stale guard) with source "import" (silent – no
 *    automations, no abandoned-cart flow) or "reconcile".
 *  • Reconcile (hourly from the job, or "סנכרן עכשיו"): orders / products modified since the last successful sync
 *    (minus 15 minutes of overlap) – catches anything a webhook missed. Customers come with their orders.
 */
import { Prisma, type StoreConnection } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { ApiError } from "@/lib/response";
import { wooRequest, WooError } from "./client";
import { enqueueStoreItem, handleStoreEvent, wooCredentials } from "./events";

export type OrdersScope = "none" | "30" | "90" | "365" | "all";
export interface SyncScope { orders: OrdersScope; customers: boolean; products: boolean }
type Resource = "customers" | "products" | "orders";
interface ResState { page: number; totalPages: number | null; total: number | null; done: number; failed: number; finished: boolean }
export interface SyncState { mode: "initial" | "reconcile"; status: "running" | "paused" | "done" | "error"; scope: SyncScope; since: string | null; resources: Partial<Record<Resource, ResState>>; startedAt: string; finishedAt?: string; nextAt?: string; error?: string; errors: string[]; consecutiveErrors: number }
const PER_PAGE = 50;

const sinceFor = (o: OrdersScope) => (o === "all" || o === "none" ? null : new Date(Date.now() - Number(o) * 86400_000).toISOString());
function query(r: Resource, st: Pick<SyncState, "mode" | "since">, page: number) {
  const base: Record<string, string | number> = { per_page: PER_PAGE, page, orderby: "id", order: "asc" };
  if (r === "orders") { base.status = "any"; base.dates_are_gmt = "true"; if (st.since) base[st.mode === "reconcile" ? "modified_after" : "after"] = st.since; }
  if (r === "products" && st.mode === "reconcile" && st.since) { base.modified_after = st.since; base.dates_are_gmt = "true"; }
  if (r === "customers") base.role = "all";
  return base;
}
const resourcesOf = (scope: SyncScope, mode: SyncState["mode"]): Resource[] => [...(scope.customers && mode === "initial" ? ["customers" as const] : []), ...(scope.products ? ["products" as const] : []), ...(scope.orders !== "none" ? ["orders" as const] : [])];

export async function previewSync(store: StoreConnection, scope: SyncScope) {
  const creds = wooCredentials(store);
  if (!creds) throw new ApiError("יש לחבר קודם את ה-API של החנות", 400, "woo_not_configured");
  const st = { mode: "initial" as const, since: sinceFor(scope.orders) };
  const out: Partial<Record<Resource, number | null>> = {};
  for (const r of resourcesOf(scope, "initial")) out[r] = (await wooRequest(creds, `/${r}`, { query: { ...query(r, st, 1), per_page: 1 } })).total;
  return out;
}

export async function startSync(store: StoreConnection, scope: SyncScope, mode: SyncState["mode"], since?: string | null) {
  if (!wooCredentials(store)) throw new ApiError("יש לחבר קודם את ה-API של החנות", 400, "woo_not_configured");
  const cur = store.syncState as SyncState | null;
  if (cur?.status === "running") return cur;
  const resources = Object.fromEntries(resourcesOf(scope, mode).map((r) => [r, { page: 0, totalPages: null, total: null, done: 0, failed: 0, finished: false }]));
  const state: SyncState = { mode, status: "running", scope, since: since !== undefined ? since : sinceFor(scope.orders), resources, startedAt: new Date().toISOString(), errors: [], consecutiveErrors: 0 };
  await prisma.storeConnection.update({ where: { id: store.id }, data: { syncState: state as unknown as Prisma.InputJsonValue } });
  return state;
}

/** Continue a paused / errored sync from its cursor. */
export async function resumeSync(store: StoreConnection) {
  const st = store.syncState as SyncState | null;
  if (!st || st.status === "done" || st.status === "running") return st;
  const next = { ...st, status: "running" as const, consecutiveErrors: 0, error: undefined, nextAt: undefined };
  await prisma.storeConnection.update({ where: { id: store.id }, data: { syncState: next as unknown as Prisma.InputJsonValue } });
  return next;
}

/** One bounded slice of work (called by the job every minute and by the screen while it is open). */
export async function runSyncStep(storeId: string, deadline = Date.now() + 20_000) {
  let store = await prisma.storeConnection.findUniqueOrThrow({ where: { id: storeId } });
  let st = store.syncState as SyncState | null;
  if (!st || st.status !== "running") return st;
  if (st.nextAt && new Date(st.nextAt).getTime() > Date.now()) return st;
  const creds = wooCredentials(store);
  if (!creds) { st = { ...st, status: "error", error: "פרטי ה-API הוסרו" }; await save(storeId, st); return st; }
  const source = st.mode === "initial" ? "import" : "reconcile";
  while (Date.now() < deadline) {
    const r = (Object.keys(st.resources) as Resource[]).find((k) => !st!.resources[k]!.finished);
    if (!r) break;
    const rs = st.resources[r]!;
    try {
      const res = await wooRequest<Array<Record<string, unknown>>>(creds, `/${r}`, { query: query(r, st, rs.page + 1) });
      const items = res.data ?? [];
      for (const item of items) {
        try {
          const { event, duplicate } = await enqueueStoreItem(store, source, `${r.slice(0, -1)}.updated`, item);
          if (event) { const out = await handleStoreEvent(store, event); await prisma.storeEvent.update({ where: { id: event.id }, data: { status: out, attempts: 1, processedAt: new Date() } }); store = await prisma.storeConnection.findUniqueOrThrow({ where: { id: storeId } }); }
          void duplicate; rs.done++;
        } catch (e) {
          rs.failed++; st.errors = [...st.errors, `${r} #${String(item.id ?? "?")}: ${(e as Error).message.slice(0, 160)}`].slice(-20);
        }
      }
      rs.page++; rs.total = res.total ?? rs.total; rs.totalPages = res.totalPages ?? rs.totalPages ?? (items.length < PER_PAGE ? rs.page : null);
      if (items.length < PER_PAGE || (rs.totalPages !== null && rs.page >= rs.totalPages)) rs.finished = true;
      st.consecutiveErrors = 0; st.nextAt = undefined;
    } catch (e) {
      const woo = e instanceof WooError ? e : null;
      st.errors = [...st.errors, `${r}: ${(e as Error).message.slice(0, 200)}`].slice(-20);
      if (woo && !woo.transient) { st.status = "error"; st.error = woo.message; break; }
      st.consecutiveErrors++;
      st.nextAt = new Date(Date.now() + (woo?.retryAfterMs ?? Math.min(15, 2 ** st.consecutiveErrors) * 60_000)).toISOString();
      if (st.consecutiveErrors >= 5) { st.status = "paused"; st.error = `הסנכרון הושהה אחרי כשלים חוזרים: ${(e as Error).message.slice(0, 160)}. אפשר להמשיך מאותה נקודה.`; }
      break;
    }
    await save(storeId, st);
  }
  if (st.status === "running" && (Object.keys(st.resources) as Resource[]).every((k) => st!.resources[k]!.finished)) {
    st.status = "done"; st.finishedAt = new Date().toISOString();
    await prisma.storeConnection.update({ where: { id: storeId }, data: { lastSyncAt: new Date(st.startedAt), lastSyncError: null } });
  }
  if (st.status === "error" || st.status === "paused") await prisma.storeConnection.update({ where: { id: storeId }, data: { lastSyncError: st.error ?? null } });
  await save(storeId, st);
  return st;
}
async function save(storeId: string, st: SyncState) { await prisma.storeConnection.update({ where: { id: storeId }, data: { syncState: st as unknown as Prisma.InputJsonValue } }); }

/** Reconcile what webhooks may have missed (the job calls this hourly per connected store; also "סנכרן עכשיו"). */
export async function startReconcile(store: StoreConnection) {
  const from = store.lastSyncAt ?? store.lastVerifiedEventAt ?? new Date(Date.now() - 30 * 86400_000);
  return startSync(store, { orders: "all", customers: false, products: true }, "reconcile", new Date(from.getTime() - 15 * 60_000).toISOString());
}
