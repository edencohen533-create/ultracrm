import { withAuth } from "@/lib/api";
import { ok, ApiError } from "@/lib/response";
import { prisma } from "@/lib/db";
import { assertCanManageLink } from "@/server/assistant/access";
import { sendToLink } from "@/server/assistant/transport";
import { clockIn } from "@/server/assistant/periods";
import { getBusinessSettings } from "@/lib/settings";

export const dynamic = "force-dynamic";

/** Test message to a verified phone (free text inside the 24h window, otherwise the approved template). */
export const POST = withAuth(async ({ user, params }) => {
  const link = await prisma.assistantLink.findFirst({ where: { id: params.id, businessId: user.businessId } });
  if (!link) throw new ApiError("לא נמצא", 404, "not_found");
  assertCanManageLink(user, link);
  if (link.status !== "active") throw new ApiError("המספר עדיין לא אומת", 409, "not_verified");
  const { timezone } = await getBusinessSettings(user.businessId);
  const text = `✅ הודעת בדיקה מהעוזר האישי (${clockIn(timezone)}). החיבור עובד – אפשר לשאול למשל "איך הולך היום?"`;
  const r = await sendToLink(link, text, { title: "הודעת בדיקה" }).catch((e: Error) => ({ status: "failed" as const, detail: e.message }));
  await prisma.assistantMessage.create({ data: { businessId: user.businessId, linkId: link.id, direction: "out", text, intent: "test", tools: [], status: r.status === "sent" ? "ok" : r.status, error: r.detail ?? null, model: "test" } });
  return ok(r);
}, { minRole: "manager" });
