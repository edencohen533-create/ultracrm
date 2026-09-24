import { withAuth } from "@/lib/api";
import { prisma } from "@/lib/db";
import { ok } from "@/lib/response";
import { telephonyStatus } from "@/lib/telephony";

export const dynamic = "force-dynamic";

export const GET = withAuth(async ({ user }) => {
  const [me, business] = await Promise.all([
    prisma.user.findUnique({ where: { id: user.id }, select: { id: true, fullName: true, email: true, role: true, presence: true, teamId: true, sipUsername: true } }),
    prisma.business.findUnique({ where: { id: user.businessId }, select: { id: true, name: true, timezone: true } }),
  ]);
  return ok({ user: me, business, telephony: telephonyStatus() });
});
