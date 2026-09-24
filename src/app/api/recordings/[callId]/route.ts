import { NextResponse } from "next/server";
import { withAuth } from "@/lib/api";
import { ApiError } from "@/lib/response";
import { prisma } from "@/lib/db";
import { assertCanSeeUser } from "@/lib/auth";
import { getTelephony } from "@/lib/telephony";
import { audit } from "@/lib/audit";

export const dynamic = "force-dynamic";

/**
 * Streams a recording through the server. The provider URL is fetched with the
 * server API key and never handed to the browser – no public links.
 * Access: the call's agent, their manager, or an admin of the same business.
 */
export const GET = withAuth(async ({ user, params }) => {
  const call = await prisma.call.findFirst({ where: { id: params.callId, businessId: user.businessId } });
  if (!call) throw new ApiError("שיחה לא נמצאה", 404, "not_found");
  await assertCanSeeUser(user, call.userId);
  if (call.recordingStatus !== "saved" || !call.recordingId) throw new ApiError("אין הקלטה לשיחה זו", 404, "no_recording");
  const src = await getTelephony().getRecordingDownloadUrl(call.recordingId);
  if (!src) throw new ApiError("ההקלטה אינה זמינה כרגע", 404, "recording_unavailable");
  const upstream = await fetch(src.url);
  if (!upstream.ok || !upstream.body) throw new ApiError("שגיאה בהורדת ההקלטה", 502, "recording_fetch_failed");
  await audit(user.businessId, user.id, "call", call.id, "recording.played");
  return new NextResponse(upstream.body, {
    headers: {
      "Content-Type": src.contentType,
      "Cache-Control": "private, no-store",
      "Content-Disposition": `inline; filename="call-${call.id}.${src.contentType === "audio/wav" ? "wav" : "mp3"}"`,
    },
  });
});
