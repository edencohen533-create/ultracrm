import { withAuth } from "@/lib/api";
import { ok } from "@/lib/response";
import { db } from "@/lib/db";
import { withoutBusiness } from "@/lib/tenant";
import { requirePlatformAdmin, accessAudit } from "@/lib/access/manage";
import { runReconciliation } from "@/server/billing/reconcile";

export const dynamic = "force-dynamic";
export const maxDuration = 60;
export const GET = withAuth(async ({ user }) => { await requirePlatformAdmin(user); return ok(await withoutBusiness(() => db.reconciliationRun.findMany({ orderBy: { createdAt: "desc" }, take: 50 }))); });
/** Upload a provider report (CSV) and compare it with the usage ledger – findings only, no automatic change. */
export const POST = withAuth(async ({ req, user }) => {
  await requirePlatformAdmin(user);
  const r = await withoutBusiness(async () => runReconciliation(user.accountId, await req.json()));
  await accessAudit({ businessId: null, actorAccountId: user.accountId, action: "platform.reconciliation_run", after: r.summary });
  return ok(r, 201);
});
