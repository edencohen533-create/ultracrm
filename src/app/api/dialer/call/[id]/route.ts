import { withAuth } from "@/lib/api";
import { ok, ApiError } from "@/lib/response";
import { prisma } from "@/lib/db";
import { reconcileCall } from "@/lib/dialer/calls";

export const dynamic = "force-dynamic";

export const GET = withAuth(async ({ user, params }) => {
  const c = await prisma.call.findFirst({ where: { id: params.id, userId: user.id }, select: { id: true } });
  if (!c) throw new ApiError("שיחה לא נמצאה", 404, "not_found");
  return ok(await reconcileCall(c.id));
});
