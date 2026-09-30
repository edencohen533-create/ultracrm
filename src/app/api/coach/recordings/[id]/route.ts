import { withAuth } from "@/lib/api";
import { ok, ApiError } from "@/lib/response";
import { prisma } from "@/lib/db";
import { deleteRecording } from "@/server/coach/sales";

export const dynamic = "force-dynamic";

/** Recording + timed transcript + every insight extracted from it (all versions' current rows). */
export const GET = withAuth(async ({ user, params }) => {
  const r = await prisma.salesRecording.findFirst({ where: { id: params.id, businessId: user.businessId, status: { not: "deleted" } },
    select: { id: true, source: true, callId: true, dealId: true, title: true, fileName: true, mimeType: true, sizeBytes: true, durationSec: true, status: true, error: true, auto: true, attempts: true, processedAt: true, createdAt: true, segments: true, costUsd: true } });
  if (!r) throw new ApiError("ההקלטה לא נמצאה", 404, "not_found");
  const insights = await prisma.salesInsight.findMany({ where: { recordingId: r.id, status: { not: "superseded" } }, orderBy: [{ startMs: "asc" }, { createdAt: "asc" }] });
  const deal = r.dealId ? await prisma.deal.findFirst({ where: { id: r.dealId }, select: { id: true, title: true, status: true, closedAt: true } }) : null;
  return ok({ recording: { ...r, costUsd: Number(r.costUsd) }, insights, deal });
}, { minRole: "manager", module: "telephony", perm: "telephony.recordings" });

export const DELETE = withAuth(async ({ user, params }) => ok(await deleteRecording(user, params.id)), { minRole: "manager", module: "telephony", perm: "telephony.recordings" });
