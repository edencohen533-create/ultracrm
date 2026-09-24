import { withAuth } from "@/lib/api";
import { prisma } from "@/lib/db";
import { membershipsForAccount } from "@/lib/auth";
import { getEntitlements } from "@/lib/modules";
import { ok } from "@/lib/response";
import { telephonyStatus } from "@/lib/telephony";

export const dynamic = "force-dynamic";

export const GET = withAuth(async ({ user }) => {
  const [me, business, memberships, entitlements] = await Promise.all([
    prisma.user.findUnique({ where: { id: user.id }, select: { id: true, fullName: true, email: true, role: true, presence: true, teamId: true, sipUsername: true } }),
    prisma.business.findUnique({ where: { id: user.businessId }, select: { id: true, name: true, slug: true, timezone: true } }),
    membershipsForAccount(user.accountId),
    getEntitlements(user.businessId),
  ]);
  return ok({
    user: me,
    business,
    businesses: memberships.map((m) => ({ id: m.business.id, name: m.business.name, slug: m.business.slug, role: m.role, active: m.businessId === user.businessId })),
    modules: entitlements.modules,
    plan: { key: entitlements.planKey, name: entitlements.planName },
    telephony: telephonyStatus(),
  });
});
