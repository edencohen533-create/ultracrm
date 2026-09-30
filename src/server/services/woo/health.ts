/**
 * The connection status screen, each part on its own (never one green light for everything):
 * API access (a real check, per resource), initial import, webhooks (none / configured / waiting for a signed event /
 * verified / needs manual setup / failed) and the last verified event, the last successful sync, failures and actions,
 * and the additional sources (payments, receipts / documents, shipping, bundles) as SEEN in real orders.
 * No new events is not treated as a failure. Freshness is exposed for the AI (not "real time" when stale / failing).
 */
import type { StoreConnection } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import type { SyncState } from "./sync";
import type { Access } from "./connect";
import { manualWebhookInstructions } from "./connect";

const HOUR = 3600_000;
/** Data is "fresh" only with a working connection and a verified event / successful sync in the last 24h. */
export function storeFreshness(s: Pick<StoreConnection, "apiStatus" | "webhookStatus" | "lastVerifiedEventAt" | "lastSyncAt" | "isActive">) {
  const last = Math.max(s.lastVerifiedEventAt?.getTime() ?? 0, s.lastSyncAt?.getTime() ?? 0);
  const fresh = s.isActive && s.apiStatus !== "failed" && s.webhookStatus !== "failed" && last > 0 && Date.now() - last < 24 * HOUR;
  return { fresh, asOf: last ? new Date(last).toISOString() : null };
}

export async function storeHealth(s: StoreConnection, opts: { revealManualSecret?: boolean } = {}) {
  const [failed, pending, recentFailures] = await Promise.all([
    prisma.storeEvent.count({ where: { storeId: s.id, status: "failed" } }),
    prisma.storeEvent.count({ where: { storeId: s.id, status: { in: ["pending", "processing"] } } }),
    prisma.storeEvent.findMany({ where: { storeId: s.id, status: "failed" }, orderBy: { receivedAt: "desc" }, take: 5, select: { id: true, topic: true, resourceId: true, error: true, receivedAt: true, attempts: true } }),
  ]);
  const caps = (s.capabilities ?? {}) as Record<string, string[]>;
  const sync = s.syncState as SyncState | null;
  const docs = caps.documents ?? [];
  const actions: string[] = [];
  if (s.platform === "woocommerce") {
    if (s.apiStatus !== "ok") actions.push("לחבר את ה-API של החנות ולהריץ בדיקת חיבור");
    if (s.webhookStatus === "manual_required") actions.push("להגדיר את ה-Webhooks ידנית בחנות (או ליצור מפתח Read/Write ולחבר שוב)");
    if (s.webhookStatus === "failed") actions.push("לתקן את הגדרת ה-Webhooks (\"הגדר Webhooks\")");
    if (s.apiStatus === "ok" && !s.lastSyncAt && sync?.mode !== "initial") actions.push("להריץ ייבוא ראשוני של לקוחות, מוצרים והזמנות");
    if (sync?.status === "paused" || sync?.status === "error") actions.push("להמשיך את הסנכרון שנעצר");
    if (failed) actions.push(`לבדוק ${failed} אירועים שנכשלו ("עבד מחדש")`);
  }
  return {
    api: { status: s.apiStatus, checkedAt: s.apiCheckedAt, error: s.apiError, access: (s.apiAccess ?? null) as Access | null },
    webhooks: {
      status: s.webhookStatus === "configured" ? "waiting_verification" : s.webhookStatus,
      error: s.webhookError, lastVerifiedEventAt: s.lastVerifiedEventAt,
      note: s.webhookStatus === "configured" ? "הוגדר – ממתין לאירוע חתום ראשון מהחנות (למשל עדכון הזמנה). היעדר אירועים אינו תקלה." : null,
      manual: s.webhookStatus === "manual_required" ? { ...manualWebhookInstructions(s), secret: opts.revealManualSecret ? manualWebhookInstructions(s).secret : null } : null,
    },
    sync: sync ? { mode: sync.mode, status: sync.status, scope: sync.scope, resources: sync.resources, startedAt: sync.startedAt, finishedAt: sync.finishedAt ?? null, error: sync.error ?? null, nextAt: sync.nextAt ?? null, errors: sync.errors.slice(-5) } : null,
    lastSyncAt: s.lastSyncAt, lastSyncError: s.lastSyncError,
    events: { failed, pending, recentFailures },
    sources: {
      payments: caps.payment?.length ? { status: "seen", detail: caps.payment } : { status: "unknown", detail: [] },
      receipts: docs.some((d) => d.includes("receipt")) ? { status: "links_seen", detail: docs, note: "קישורים ממטא-דאטה של תוסף – לא אומתו כקבלה חשבונאית" } : { status: "not_connected", detail: docs, note: "לא זוהה מקור קבלות בחנות. אפשר לחבר מערכת חשבוניות דרך POST /api/v1/orders (שדה receipt)." },
      shipping: caps.shipping?.length ? { status: "seen", detail: caps.shipping, note: "מספרי מעקב ללא פירוט פריטים – אינם הוכחה לפריט מסוים" } : { status: "not_connected", detail: [], note: "לא זוהה תוסף משלוחים. אפשר לשלוח משלוחים (כולל פריטים) דרך POST /api/v1/orders." },
      bundles: caps.bundles?.length ? { status: "seen", detail: caps.bundles } : { status: "unknown", detail: [] },
    },
    freshness: storeFreshness(s),
    actions,
  };
}
