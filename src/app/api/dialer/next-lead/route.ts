import { z } from "zod";
import { withAuth, parseBody } from "@/lib/api";
import { ok } from "@/lib/response";
import { ApiError } from "@/lib/response";
import { prisma } from "@/lib/db";
import { claimNextLead, assertListAccess } from "@/lib/dialer/queue";

export const dynamic = "force-dynamic";

const schema = z.object({ sessionId: z.string(), browserSessionId: z.string() });

export const POST = withAuth(async ({ req, user }) => {
  const b = await parseBody(req, schema);
  const s = await prisma.dialerSession.findFirst({ where: { id: b.sessionId, userId: user.id } });
  if (!s || s.status === "ended") throw new ApiError("הסשן הסתיים", 409, "session_ended");
  if (s.browserSessionId !== b.browserSessionId) throw new ApiError("החיוג פעיל בלשונית אחרת", 409, "session_taken");
  if (s.status === "paused") throw new ApiError("הסשן מושהה", 409, "session_paused");
  if (!s.listId) throw new ApiError("לסשן ידני אין תור לידים", 400, "manual_session");
  const live = await prisma.call.findUnique({ where: { activeForUser: user.id }, select: { id: true } });
  if (live) throw new ApiError("יש שיחה פעילה", 409, "call_active", { callId: live.id });
  const pending = await prisma.call.findFirst({ where: { userId: user.id, endedAt: { not: null }, outcomeSavedAt: null }, select: { id: true } });
  if (pending) throw new ApiError("יש שיחה שטרם תועדה – שמור תוצאה לפני המעבר לליד הבא", 409, "outcome_required", { callId: pending.id });
  await assertListAccess(user.businessId, user.id, user.role, s.listId);
  const lead = await claimNextLead(user.businessId, user.id, s.listId);
  return ok(lead);
});
