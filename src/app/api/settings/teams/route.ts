import { requireBusinessId } from "@/lib/tenant";
import { organizationRequest } from "@/lib/auth-compat";
import { auth } from "@/lib/auth-compat";
import { prisma } from "@/lib/db";
import { z } from "zod";
export const POST = organizationRequest(async function(request: Request) {
  const session = await auth();
  if (session?.user.role !== "owner" && session?.user.role !== "manager") return Response.json({ error: "אין הרשאה" }, { status: 403 });
  const parsed = z.object({ name: z.string().trim().min(1).max(100) }).strict().safeParse(await request.json().catch(() => null));
  if (!parsed.success) return Response.json({ error: "יש להזין שם צוות" }, { status: 400 });
  const team = await prisma.$transaction(async (tx) => {
    const created = await tx.team.create({ data: { businessId: requireBusinessId(), ...parsed.data } });
    await tx.auditLog.create({ data: { businessId: requireBusinessId(), actorId: session.user.id, action: "team.created", entityType: "Team", entityId: created.id } });
    return created;
  });
  return Response.json({ team }, { status: 201 });
});
