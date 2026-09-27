import { withAuth } from "@/lib/api";
import { ok, ApiError } from "@/lib/response";
import { prisma } from "@/lib/db";
import { conversationMessages } from "@/server/ai/engine";

export const dynamic = "force-dynamic";
export const GET = withAuth(async ({ user, params }) => ok(await conversationMessages(user, params.id)));
export const DELETE = withAuth(async ({ user, params }) => {
  const r = await prisma.aiConversation.deleteMany({ where: { id: params.id, businessId: user.businessId, userId: user.id } });
  if (!r.count) throw new ApiError("השיחה לא נמצאה", 404, "not_found");
  return ok({ deleted: true });
});
