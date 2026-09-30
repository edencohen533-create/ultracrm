import { withAuth } from "@/lib/api";
import { ok } from "@/lib/response";
import { prisma } from "@/lib/db";
import { getBusinessSettings } from "@/lib/settings";
import { CALL_SELECTION_TEXT, DEAL_CONDITION_TEXT } from "@/server/coach/sales";
import { providerStatus } from "@/server/coach/providers";

export const dynamic = "force-dynamic";

/** "Learn automatically from recordings of closed deals": settings, the exact filter, and what happened per deal. */
export const GET = withAuth(async ({ user }) => {
  const s = (await getBusinessSettings(user.businessId)).coach;
  const rows = await prisma.salesDealLearning.findMany({ where: { businessId: user.businessId }, orderBy: { updatedAt: "desc" }, take: 30 });
  const deals = await prisma.deal.findMany({ where: { id: { in: rows.map((r) => r.dealId) } }, select: { id: true, title: true, status: true, closedAt: true, contact: { select: { fullName: true } } } });
  return ok({
    settings: { learnFromRecordings: s.learnFromRecordings, learnDealCondition: s.learnDealCondition ?? "won", autoPublish: s.autoPublish ?? { enabled: false, kinds: [] }, documentFromRecordings: Boolean(s.documentFromRecordings) },
    conditions: DEAL_CONDITION_TEXT, selection: CALL_SELECTION_TEXT, providers: providerStatus(),
    deals: rows.map((r) => ({ ...r, deal: deals.find((d) => d.id === r.dealId) ?? null })),
  });
}, { minRole: "manager", module: "telephony" });
