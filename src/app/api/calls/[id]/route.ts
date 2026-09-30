import { withAuth } from "@/lib/api";
import { ok, ApiError } from "@/lib/response";
import { prisma } from "@/lib/db";
import { visibleUserIds } from "@/lib/auth";
import { can, effectiveAccess } from "@/lib/access/engine";

export const dynamic = "force-dynamic";

/**
 * One call for the call-history drawer (חייגן → היסטוריית שיחות): details, duration, outcome, AI documentation and
 * whether the recording may be played. Same visibility as the list (the user's data scope) – an out-of-scope or other
 * business's call is "not found". The recording itself streams only through /api/recordings (telephony.recordings).
 */
export const GET = withAuth(async ({ user, params }) => {
  const call = await prisma.call.findFirst({
    where: { id: params.id, businessId: user.businessId },
    select: {
      id: true, userId: true, createdAt: true, ringingAt: true, answeredAt: true, endedAt: true, talkSeconds: true, status: true, direction: true, mode: true,
      telephonyResult: true, hangupCause: true, outcome: true, statusDef: { select: { label: true } }, outcomeNote: true, callbackAt: true, toE164: true, fromE164: true, recordingStatus: true,
      user: { select: { id: true, fullName: true } }, contact: { select: { id: true, fullName: true, phoneE164: true } }, list: { select: { id: true, name: true } },
      coachSession: { select: { documentation: true, documentationStatus: true, documentationError: true } },
    },
  });
  if (!call) throw new ApiError("שיחה לא נמצאה", 404, "not_found");
  const visible = await visibleUserIds(user);
  if (visible && !visible.includes(call.userId)) throw new ApiError("שיחה לא נמצאה", 404, "not_found");
  const access = await effectiveAccess(user.businessId, user.id);
  const { userId: _u, ...rest } = call;
  void _u;
  return ok({ ...rest, canPlayRecording: call.recordingStatus === "saved" && can(access, "telephony.recordings") });
}, { perm: "telephony.use" });
