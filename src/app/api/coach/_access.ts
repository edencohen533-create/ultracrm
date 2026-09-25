import { prisma } from "@/lib/db";
import { ApiError } from "@/lib/response";
import type { SessionUser } from "@/lib/auth";
import { assertCanSeeUser } from "@/lib/auth";

/** The agent of the call, their manager, or an owner – same rule as recordings. */
export async function callForCoach(user: SessionUser, callId: string) {
  const call = await prisma.call.findFirst({ where: { id: callId, businessId: user.businessId }, select: { id: true, userId: true, answeredAt: true, endedAt: true, contactId: true, leadId: true } });
  if (!call) throw new ApiError("שיחה לא נמצאה", 404, "not_found");
  await assertCanSeeUser(user, call.userId);
  return call;
}
