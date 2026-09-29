import { withAuth } from "@/lib/api";
import { ok, ApiError } from "@/lib/response";
import { prisma } from "@/lib/db";
import { visibleUserIds } from "@/lib/auth";
import { documentCall } from "@/server/coach/documentation";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** "נסה שוב" for a call whose AI documentation failed. The agent of the call, or a manager who sees that agent. */
export const POST = withAuth(async ({ user, params }) => {
  const call = await prisma.call.findFirst({ where: { id: params.id, businessId: user.businessId }, select: { id: true, userId: true } });
  if (!call) throw new ApiError("שיחה לא נמצאה", 404, "not_found");
  const ids = await visibleUserIds(user);
  if (call.userId !== user.id && (user.role === "agent" || (ids && !ids.includes(call.userId)))) throw new ApiError("שיחה לא נמצאה", 404, "not_found");
  const result = await documentCall(call.id, { retry: true });
  const s = await prisma.coachSession.findUnique({ where: { callId: call.id }, select: { documentationStatus: true, documentationError: true, documentedAt: true } });
  return ok({ result, status: s?.documentationStatus ?? null, error: s?.documentationError ?? null, documentedAt: s?.documentedAt ?? null });
}, { perm: ["telephony.use", "crm.view"] });
