import { NextResponse } from "next/server";
import { withAuth } from "@/lib/api";
import { ApiError } from "@/lib/response";
import { audit } from "@/lib/audit";
import { can, effectiveAccess } from "@/lib/access/engine";
import { recordingAudio } from "@/server/coach/sales";

export const dynamic = "force-dynamic";

/** Streams the audio through the server (no public link). ?download=1 needs the download permission too. */
export const GET = withAuth(async ({ req, user, params }) => {
  const download = new URL(req.url).searchParams.get("download") === "1";
  if (download && !can(await effectiveAccess(user.businessId, user.id), "telephony.recordings_download" as never)) throw new ApiError("אין לך הרשאה להוריד הקלטות", 403, "forbidden");
  const a = await recordingAudio(user, params.id);
  await audit(user.businessId, user.id, "coach", params.id, download ? "recording.downloaded" : "recording.played", { salesRecording: true });
  return new NextResponse(a.body as BodyInit, { headers: { "Content-Type": a.contentType, "Cache-Control": "private, no-store", "Content-Disposition": `${download ? "attachment" : "inline"}; filename="${encodeURIComponent(a.fileName)}"` } });
}, { minRole: "manager", module: "telephony", perm: "telephony.recordings" });
