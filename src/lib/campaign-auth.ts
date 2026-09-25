import { auth } from "@/lib/auth-compat";
import { prisma } from "@/lib/db";

/** Re-check the database: disabling or demoting a user must revoke campaign access immediately. */
export async function campaignActor() {
  const session = await auth();
  if (!session?.user?.id) return null;
  const user = await prisma.user.findUnique({ where: { id: session.user.id }, select: { id: true, role: true, isActive: true } });
  return user?.isActive && (user.role === "owner" || user.role === "manager") ? user : null;
}
