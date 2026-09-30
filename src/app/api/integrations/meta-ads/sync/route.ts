import { withAuth } from "@/lib/api";
import { ok } from "@/lib/response";
import { prisma } from "@/lib/db";
import { assertMarketing, connectionStatus } from "@/server/marketing/meta-connection";
import { syncAccountStep } from "@/server/marketing/meta-sync";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** "סנכרן עכשיו": one step per connected account now (history chunk or refresh); the cron continues the rest. */
export const POST = withAuth(async ({ user }) => {
  await assertMarketing(user, "connect");
  const accounts = await prisma.metaAdAccount.findMany({ where: { businessId: user.businessId, status: { in: ["active", "throttled"] } }, select: { id: true, status: true } });
  const deadline = Date.now() + 40_000; const results = [];
  for (const a of accounts) { if (Date.now() > deadline) break; results.push(await syncAccountStep(a.id, { force: a.status === "active" })); } // never while Meta asked us to wait
  return ok({ results, status: await connectionStatus(user) });
}, { module: "crm" });
