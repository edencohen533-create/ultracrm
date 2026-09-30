/**
 * Pull-side sync for connectors that can read (initial import → periodic poll → reconcile), plus the write-back
 * worker. Resumable: the phase / cursor are stored after every page, so a failure continues where it stopped.
 * Rate limits and outages wait (nextSyncAt); an auth failure marks the connection – its records then stop automatic
 * dialing until the data is fresh again. Webhook-capable connectors still get the periodic reconcile for missed events.
 */
import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { openConfig } from "@/server/channels/registry";
import { connectorFor } from "./registry";
import { parseSettings } from "./settings";
import { ConnectorError, type ConnectorCtx } from "./types";
import { applyChange } from "./ingest";
import { connForIngest } from "./connections";
import { processCrmOutbox } from "./outbox";

const RECONCILE_MS = 6 * 3600_000;
interface State { phase?: "initial" | "idle" | "poll" | "reconcile" | "gap"; recordType?: "contact" | "lead"; cursor?: string | null; since?: string | null; processed?: number; startedAt?: string; finishedAt?: string; lastPollAt?: string; lastReconcileAt?: string; gapSince?: string | null; runStartedAt?: string }

export async function syncConnectionStep(connectionId: string, deadline: number) {
  const c = await prisma.crmConnection.findUniqueOrThrow({ where: { id: connectionId } });
  if (c.status !== "active") return { skipped: c.status };
  if (c.nextSyncAt && c.nextSyncAt > new Date()) return { skipped: "waiting" };
  const def = connectorFor(c.connectorKey);
  if (!def?.pull) return { skipped: "push_only" };
  const settings = parseSettings(c.settings);
  const ctx: ConnectorCtx = { connectionId: c.id, businessId: c.businessId, auth: openConfig(c.authConfig) as Record<string, string>, settings };
  let st = (c.syncState ?? {}) as State;
  const now = Date.now();
  // Decide the phase: finish initial / gap; else poll every pollMinutes; reconcile (full pass) every 6 hours.
  if (!st.phase || st.phase === "idle") {
    if (!st.lastReconcileAt || now - Date.parse(st.lastReconcileAt) > RECONCILE_MS) st = { ...st, phase: "reconcile", recordType: "contact", cursor: null, since: null, runStartedAt: new Date().toISOString() };
    else if (!st.lastPollAt || now - Date.parse(st.lastPollAt) > settings.pollMinutes * 60_000) st = { ...st, phase: "poll", recordType: "contact", cursor: null, since: st.lastPollAt ? new Date(Date.parse(st.lastPollAt) - 120_000).toISOString() : null, runStartedAt: new Date().toISOString() };
    else return { skipped: "fresh" };
  }
  // Gap fill from a little before the disconnection (clock skew); re-delivered records are deduped / stale-checked.
  if (st.phase === "gap") st = { ...st, since: st.gapSince ? new Date(Date.parse(st.gapSince) - 10 * 60_000).toISOString() : null };
  const phase = st.phase;
  const kind: string = phase === "initial" ? "initial" : phase === "gap" ? "reconcile" : phase ?? "poll";
  let pages = 0;
  try {
    while (Date.now() < deadline && st.phase && st.phase !== "idle") {
      const type = st.recordType ?? "contact";
      if ((type === "contact" && !settings.records.contacts) || (type === "lead" && !settings.records.leads)) { st = next(st); continue; }
      const page = await def.pull(ctx, type, st.cursor ?? null, st.since ?? null);
      for (const ch of page.items) await applyChange(connForIngest(c), ch, { kind, historical: st.phase === "initial" });
      pages++;
      st = { ...st, cursor: page.nextCursor, processed: (st.processed ?? 0) + page.items.length };
      if (!page.nextCursor) st = next(st);
      await prisma.crmConnection.update({ where: { id: c.id }, data: { syncState: st as Prisma.InputJsonValue, lastSyncAt: new Date(), lastSyncStatus: "ok", lastError: null } });
    }
    return { pages, phase: st.phase };
  } catch (e) {
    const err = e instanceof ConnectorError ? e : new ConnectorError((e as Error).message, "transient");
    const wait = err.kind === "rate_limit" ? Math.max(err.retryAfterSec ?? 30, 1) : 120;
    await prisma.crmConnection.update({ where: { id: c.id }, data: { syncState: st as Prisma.InputJsonValue, ...(err.kind === "auth" ? { status: "error" } : {}), lastSyncStatus: err.kind, lastError: err.message.slice(0, 300), nextSyncAt: new Date(Date.now() + wait * 1000) } });
    return { pages, error: err.kind };
  }
}

function next(st: State): State {
  if (st.recordType === "contact") return { ...st, recordType: "lead", cursor: null };
  const done = new Date().toISOString();
  return { ...st, phase: "idle", recordType: "contact", cursor: null, finishedAt: st.phase === "initial" ? done : st.finishedAt, lastPollAt: st.runStartedAt ?? st.startedAt ?? done, ...(st.phase === "reconcile" || st.phase === "initial" || st.phase === "gap" ? { lastReconcileAt: st.runStartedAt ?? st.startedAt ?? done } : {}), gapSince: null };
}

/** Cron: every active connection's pull step and every business's write-back queue, within a time budget. */
export async function runCrmSync(deadline: number) {
  const { withBusiness } = await import("@/lib/tenant");
  const conns = await prisma.crmConnection.findMany({ where: { status: "active" }, select: { id: true, businessId: true } });
  const out: unknown[] = [];
  for (const c of conns) { if (Date.now() > deadline) break; out.push(await withBusiness(c.businessId, () => syncConnectionStep(c.id, Math.min(deadline, Date.now() + 20_000))).catch((e: Error) => ({ error: e.message }))); }
  const businesses = [...new Set((await prisma.crmOutbox.findMany({ where: { status: { in: ["pending", "failed"] }, nextAttemptAt: { lte: new Date() } }, select: { businessId: true }, distinct: ["businessId"], take: 50 })).map((b) => b.businessId))];
  for (const b of businesses) { if (Date.now() > deadline) break; out.push(await withBusiness(b, () => processCrmOutbox(b, Math.min(deadline, Date.now() + 15_000))).catch((e: Error) => ({ error: e.message }))); }
  return out;
}
