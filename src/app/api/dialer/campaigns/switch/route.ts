import { z } from "zod";
import { withAuth, parseBody } from "@/lib/api";
import { ok, ApiError } from "@/lib/response";
import { prisma } from "@/lib/db";
import { assertListAccess } from "@/lib/dialer/queue";
import { queueAvailability } from "@/lib/dialer/exhaustion";

export const dynamic = "force-dynamic";
const schema = z.object({ listId: z.string().min(1), browserSessionId: z.string().min(1) });

/**
 * "עבור לקמפיין": permission is checked again NOW (not trusted from the list shown earlier). Never while a call is live
 * or waiting for its outcome. Ends the current session only – dialing in the new campaign starts with an explicit
 * "הפעל חייגן". Follow-ups and queue rows of the previous campaign are not touched.
 */
export const POST = withAuth(async ({ req, user }) => {
  const b = await parseBody(req, schema);
  await assertListAccess(user.businessId, user.id, user.role, b.listId);
  const target = await prisma.dialList.findFirst({ where: { id: b.listId, businessId: user.businessId }, select: { id: true, name: true, filterJson: true } });
  const owner = (target?.filterJson as { leadOwnerUserId?: string } | null)?.leadOwnerUserId;
  if (!target || (owner && owner !== user.id)) throw new ApiError("הקמפיין אינו פתוח עבורך", 403, "forbidden");
  if (await prisma.call.findUnique({ where: { activeForUser: user.id }, select: { id: true } })) throw new ApiError("יש שיחה פעילה – סיים אותה לפני מעבר קמפיין", 409, "call_active");
  if (await prisma.call.findFirst({ where: { userId: user.id, endedAt: { not: null }, outcomeSavedAt: null }, select: { id: true } })) throw new ApiError("יש שיחה שטרם תועדה – שמור תוצאה לפני מעבר קמפיין", 409, "outcome_required");
  const s = await prisma.dialerSession.findFirst({ where: { userId: user.id, status: { in: ["active", "paused"] } } });
  if (s && s.browserSessionId !== b.browserSessionId) throw new ApiError("החיוג פעיל בלשונית אחרת", 409, "session_taken");
  if (s) {
    const { endSession } = await import("@/lib/dialer/session");
    await endSession(user, s.id, b.browserSessionId);
  }
  return ok({ listId: target.id, name: target.name, availability: await queueAvailability(user, target.id) });
}, { module: "telephony" });
