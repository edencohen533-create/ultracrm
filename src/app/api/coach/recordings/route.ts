import { z } from "zod";
import { withAuth, parseBody } from "@/lib/api";
import { ok } from "@/lib/response";
import { prisma } from "@/lib/db";
import { startUpload } from "@/server/coach/sales";

export const dynamic = "force-dynamic";

/** Sales recordings of the business (uploads + linked calls) with their processing state. */
export const GET = withAuth(async ({ user }) => {
  const items = await prisma.salesRecording.findMany({ where: { businessId: user.businessId, status: { not: "deleted" } }, orderBy: { createdAt: "desc" }, take: 200,
    select: { id: true, source: true, callId: true, dealId: true, title: true, fileName: true, mimeType: true, sizeBytes: true, durationSec: true, status: true, error: true, auto: true, attempts: true, processedAt: true, createdAt: true, _count: { select: { insights: true } } } });
  return ok({ items });
}, { minRole: "manager", module: "telephony", perm: "telephony.recordings" });

/** Start a chunked upload (type + size checked here, the bytes' signature on completion). */
export const POST = withAuth(async ({ req, user }) => ok(await startUpload(user, await parseBody(req, z.object({ title: z.string().max(200).optional(), fileName: z.string().min(1).max(255), mimeType: z.string().min(1).max(100), sizeBytes: z.number().int() })))), { minRole: "manager", module: "telephony", perm: "telephony.recordings" });
