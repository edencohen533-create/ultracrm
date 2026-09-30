/**
 * Platform operations sweep (cron): turns raw signals into unified, deduplicated alerts (one per problem per
 * business) and resolves the ones whose condition cleared. Only counts and ids – never message contents or secrets.
 */
import { db } from "@/lib/db";
import { raiseAlert } from "./alerts";

const H = 3600_000;
type Found = { fingerprint: string; severity: "info" | "warning" | "critical"; category: string; businessId: string | null; title: string; details: Record<string, unknown> };

export async function runOpsChecks(now = new Date()) {
  const found: Found[] = [];
  const since24 = new Date(now.getTime() - 24 * H);
  const group = async <T extends { businessId: string | null; _count: { _all: number } }>(rows: Promise<T[]>, f: (r: T) => Found | null) => { for (const r of await rows) { const x = f(r); if (x) found.push(x); } };

  // Stuck work: domain events not processed for 10+ minutes; failed events.
  await group(db.domainEvent.groupBy({ by: ["businessId"], where: { status: "pending", createdAt: { lt: new Date(now.getTime() - 10 * 60_000) } }, _count: { _all: true } }), (r) => ({ fingerprint: `events:stuck:${r.businessId}`, severity: r._count._all > 50 ? "critical" : "warning", category: "queues", businessId: r.businessId, title: "אירועים תקועים בתור (מעל 10 דקות)", details: { count: r._count._all } }));
  await group(db.domainEvent.groupBy({ by: ["businessId"], where: { status: "failed", createdAt: { gte: since24 } }, _count: { _all: true } }), (r) => ({ fingerprint: `events:failed:${r.businessId}`, severity: "warning", category: "queues", businessId: r.businessId, title: "אירועים שנכשלו ב-24 השעות האחרונות", details: { count: r._count._all } }));
  await group(db.webhookDelivery.groupBy({ by: ["businessId"], where: { status: "failed", createdAt: { gte: since24 } }, _count: { _all: true } }), (r) => ({ fingerprint: `webhooks:failed:${r.businessId}`, severity: "warning", category: "integrations", businessId: r.businessId, title: "Webhooks יוצאים שנכשלו", details: { count: r._count._all } }));
  await group(db.crmOutbox.groupBy({ by: ["businessId"], where: { status: "dead" }, _count: { _all: true } }), (r) => ({ fingerprint: `crm:outbox_dead:${r.businessId}`, severity: "warning", category: "sync", businessId: r.businessId, title: "כתיבות ל-CRM חיצוני שנכשלו סופית", details: { count: r._count._all } }));
  await group(db.crmSyncEvent.groupBy({ by: ["businessId"], where: { status: "failed", createdAt: { gte: since24 } }, _count: { _all: true } }), (r) => ({ fingerprint: `crm:events_failed:${r.businessId}`, severity: "warning", category: "sync", businessId: r.businessId, title: "אירועי סנכרון CRM שנכשלו", details: { count: r._count._all } }));
  await group(db.storeEvent.groupBy({ by: ["businessId"], where: { status: "failed", receivedAt: { gte: since24 } }, _count: { _all: true } }) as unknown as Promise<Array<{ businessId: string; _count: { _all: number } }>>, (r) => ({ fingerprint: `store:events_failed:${r.businessId}`, severity: "warning", category: "sync", businessId: r.businessId, title: "אירועי חנות שנכשלו", details: { count: r._count._all } }));
  await group(db.coachSession.groupBy({ by: ["businessId"], where: { documentationStatus: "failed", createdAt: { gte: since24 } }, _count: { _all: true } }), (r) => ({ fingerprint: `ai:documentation_failed:${r.businessId}`, severity: "info", category: "ai", businessId: r.businessId, title: "תיעוד / סיכום AI של שיחות נכשל", details: { count: r._count._all } }));

  // Failure rates (with a minimum sample, so one bad call doesn't alarm).
  const calls = await db.call.groupBy({ by: ["businessId", "status"], where: { createdAt: { gte: since24 }, direction: "outbound" }, _count: { _all: true } });
  for (const b of new Set(calls.map((c) => c.businessId))) {
    const total = calls.filter((c) => c.businessId === b).reduce((s, c) => s + c._count._all, 0);
    const failed = calls.filter((c) => c.businessId === b && c.status === "failed").reduce((s, c) => s + c._count._all, 0);
    if (total >= 10 && failed / total >= 0.2) found.push({ fingerprint: `calls:failure_rate:${b}`, severity: failed / total >= 0.5 ? "critical" : "warning", category: "telephony", businessId: b, title: "שיעור כשל גבוה בחיוג", details: { failed, total, rate: Math.round((failed / total) * 100) } });
  }
  const msgs = await db.message.groupBy({ by: ["businessId", "status"], where: { createdAt: { gte: since24 }, direction: "OUTBOUND" }, _count: { _all: true } });
  for (const b of new Set(msgs.map((m) => m.businessId))) {
    const total = msgs.filter((m) => m.businessId === b).reduce((s, m) => s + m._count._all, 0);
    const failed = msgs.filter((m) => m.businessId === b && m.status === "FAILED").reduce((s, m) => s + m._count._all, 0);
    if (total >= 10 && failed / total >= 0.2) found.push({ fingerprint: `messages:failure_rate:${b}`, severity: "warning", category: "messaging", businessId: b, title: "שיעור כשל גבוה בשליחה", details: { failed, total, rate: Math.round((failed / total) * 100) } });
  }
  for (const h of await db.telephonyProviderHealth.findMany({ where: { state: { not: "closed" } }, select: { businessId: true, provider: true, state: true } })) found.push({ fingerprint: `telephony:breaker:${h.businessId}:${h.provider}`, severity: "critical", category: "telephony", businessId: h.businessId, title: `ספק הטלפוניה ${h.provider} במצב ${h.state}`, details: { provider: h.provider, state: h.state } });

  // Metering / billing gaps: answered calls ended over an hour ago without a usage row; unrated usage on paid plans.
  const gaps = await db.$queryRaw<Array<{ business_id: string; n: bigint }>>`SELECT c.business_id, count(*) n FROM calls c WHERE c.answered_at IS NOT NULL AND c.ended_at < now() - interval '1 hour' AND c.ended_at > now() - interval '3 days' AND COALESCE(c.talk_seconds, 0) > 0
    AND EXISTS (SELECT 1 FROM subscriptions s WHERE s.business_id = c.business_id AND s.status <> 'none')
    AND NOT EXISTS (SELECT 1 FROM usage_events u WHERE u.business_id = c.business_id AND u.idempotency_key = 'call:' || c.id || ':minutes') GROUP BY c.business_id`;
  for (const g of gaps) found.push({ fingerprint: `metering:gap_calls:${g.business_id}`, severity: "warning", category: "billing", businessId: g.business_id, title: "שיחות בלי רישום שימוש (פער מדידה)", details: { count: Number(g.n) } });
  await group(db.usageEvent.groupBy({ by: ["businessId"], where: { status: "unrated", occurredAt: { gte: since24 } }, _count: { _all: true } }), (r) => ({ fingerprint: `billing:unrated:${r.businessId}`, severity: "warning", category: "billing", businessId: r.businessId, title: "שימוש ללא תעריף (לא מחויב, דורש החלטה)", details: { count: r._count._all } }));

  for (const f of found) await raiseAlert(f);
  // A condition that cleared resolves its alert (same categories only – billing alerts from other flows stay).
  const seen = new Set(found.map((f) => f.fingerprint));
  const auto = ["events:", "webhooks:", "crm:", "store:", "ai:", "calls:", "messages:", "telephony:", "metering:", "billing:unrated:"];
  const open = await db.platformAlert.findMany({ where: { status: { not: "resolved" } }, select: { id: true, fingerprint: true } });
  let resolved = 0;
  for (const a of open) if (auto.some((p) => a.fingerprint.startsWith(p)) && !seen.has(a.fingerprint)) { await db.platformAlert.update({ where: { id: a.id }, data: { status: "resolved", resolvedAt: now } }); resolved++; }
  return { raised: found.length, resolved };
}
