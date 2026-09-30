import { withAuth } from "@/lib/api";
import { ok } from "@/lib/response";
import { db } from "@/lib/db";
import { withoutBusiness } from "@/lib/tenant";
import { requirePlatformAdmin } from "@/lib/access/manage";

export const dynamic = "force-dynamic";
/** Platform operations: unified alerts, support tickets, last restore drill, reconciliation runs, queue counters. */
export const GET = withAuth(async ({ user }) => {
  await requirePlatformAdmin(user);
  return ok(await withoutBusiness(async () => {
    const since = new Date(Date.now() - 24 * 3600_000);
    const [alerts, tickets, drills, recon, names, stuck, deadOutbox, unrated] = await Promise.all([
      db.platformAlert.findMany({ orderBy: [{ status: "asc" }, { lastSeenAt: "desc" }], take: 200 }),
      db.supportTicket.findMany({ orderBy: { createdAt: "desc" }, take: 100 }),
      db.opsDrill.findMany({ orderBy: { finishedAt: "desc" }, take: 10 }),
      db.reconciliationRun.findMany({ orderBy: { createdAt: "desc" }, take: 10, include: { _count: { select: { items: true } } } }),
      db.business.findMany({ select: { id: true, name: true } }),
      db.domainEvent.count({ where: { status: "pending", createdAt: { lt: new Date(Date.now() - 10 * 60_000) } } }),
      db.crmOutbox.count({ where: { status: "dead" } }),
      db.usageEvent.count({ where: { status: "unrated", occurredAt: { gte: since } } }),
    ]);
    const name = new Map(names.map((b) => [b.id, b.name]));
    return { alerts: alerts.map((a) => ({ ...a, businessName: a.businessId ? name.get(a.businessId) ?? null : null })), tickets: tickets.map((t) => ({ ...t, businessName: name.get(t.businessId) ?? null })), drills, reconciliation: recon, counters: { stuckEvents: stuck, deadCrmWrites: deadOutbox, unratedUsage24h: unrated } };
  }));
});
