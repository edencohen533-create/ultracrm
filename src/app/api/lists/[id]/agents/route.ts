import { z } from "zod";
import { withAuth, parseBody } from "@/lib/api";
import { ok, ApiError } from "@/lib/response";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";

const schema = z.object({ agentIds: z.array(z.string()).max(500) });

/** Replace the set of agents assigned to a list (empty = everyone may work it). */
export const PUT = withAuth(async ({ req, user, params }) => {
  const b = await parseBody(req, schema);
  const list = await prisma.dialList.findFirst({ where: { id: params.id, businessId: user.businessId } });
  if (!list) throw new ApiError("רשימה לא נמצאה", 404, "not_found");
  const users = await prisma.user.findMany({ where: { id: { in: b.agentIds }, businessId: user.businessId }, select: { id: true } });
  await prisma.$transaction([
    prisma.dialListAgent.deleteMany({ where: { listId: list.id } }),
    prisma.dialListAgent.createMany({ data: users.map((u) => ({ listId: list.id, userId: u.id })) }),
  ]);
  return ok({ agentIds: users.map((u) => u.id) });
}, { minRole: "manager" });
