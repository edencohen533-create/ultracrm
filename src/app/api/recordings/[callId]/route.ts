import { NextResponse } from "next/server";
import { withAuth } from "@/lib/api";
import { ApiError } from "@/lib/response";
import { prisma } from "@/lib/db";
import { assertCanSeeUser } from "@/lib/auth";
import { adapterFor } from "@/lib/telephony";
import { audit } from "@/lib/audit";
import { can, effectiveAccess } from "@/lib/access/engine";

export const dynamic = "force-dynamic";

/**
 * Streams a recording through the server. The provider URL is fetched with the
 * server API key and never handed to the browser – no public links.
 * Access: the call's agent, their manager, or an admin of the same business.
 * ?download=1 → a file download ("הורד הקלטה"), which also needs telephony.recordings_download.
 */
export const GET = withAuth(async ({ req, user, params }) => {
  const download = new URL(req.url).searchParams.get("download") === "1";
  if (download && !can(await effectiveAccess(user.businessId, user.id), "telephony.recordings_download" as never)) throw new ApiError("אין לך הרשאה להוריד הקלטות", 403, "forbidden");
  const call = await prisma.call.findFirst({ where: { id: params.callId, businessId: user.businessId } });
  if (!call) throw new ApiError("שיחה לא נמצאה", 404, "not_found");
  await assertCanSeeUser(user, call.userId);
  if (call.recordingStatus === "recording") throw new ApiError("ההקלטה עדיין לא זמינה – היא נשמרת בסיום השיחה", 409, "recording_pending");
  if (call.recordingStatus !== "saved" || !call.recordingId) throw new ApiError(call.recordingPurgedAt ? "ההקלטה כבר אינה נשמרת – נמחקה לפי מדיניות השמירה של העסק" : "אין הקלטה לשיחה זו", 404, call.recordingPurgedAt ? "recording_purged" : "no_recording");
  // The recording lives at the provider that carried the call.
  const src = await adapterFor(call.provider).getRecordingDownloadUrl(call.recordingId);
  if (!src) throw new ApiError("ההקלטה אינה זמינה כרגע", 404, "recording_unavailable");
  const upstream = await fetch(src.url);
  if (!upstream.ok || !upstream.body) throw new ApiError("שגיאה בהורדת ההקלטה", 502, "recording_fetch_failed");
  await audit(user.businessId, user.id, "call", call.id, download ? "recording.downloaded" : "recording.played");
  return new NextResponse(upstream.body, {
    headers: {
      "Content-Type": src.contentType,
      "Cache-Control": "private, no-store",
      "Content-Disposition": `${download ? "attachment" : "inline"}; filename="call-${call.id}.${src.contentType === "audio/wav" ? "wav" : "mp3"}"`,
    },
  });
}, { perm: "telephony.recordings" });
