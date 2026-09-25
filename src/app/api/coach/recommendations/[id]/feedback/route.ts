import { z } from "zod";
import { withAuth, parseBody } from "@/lib/api";
import { ok, ApiError } from "@/lib/response";
import { prisma } from "@/lib/db";
import { callForCoach } from "@/app/api/coach/_access";

export const dynamic = "force-dynamic";

/** Agent feedback: helpful / not_helpful / skipped / hidden. Feedback dismisses the card; the row stays for managers. */
export const POST = withAuth(async ({ req, user, params }) => {
  const { feedback } = await parseBody(req, z.object({ feedback: z.enum(["helpful", "not_helpful", "skipped", "hidden"]) }));
  const rec = await prisma.coachRecommendation.findUnique({ where: { id: params.id }, select: { id: true, callId: true } });
  if (!rec) throw new ApiError("המלצה לא נמצאה", 404, "not_found");
  await callForCoach(user, rec.callId);
  await prisma.coachRecommendation.update({ where: { id: rec.id }, data: { feedback } });
  return ok({ ok: true });
}, { module: "telephony" });
