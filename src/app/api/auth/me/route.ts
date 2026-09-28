import { withAuth } from "@/lib/api";
import { prisma } from "@/lib/db";
import { membershipsForAccount } from "@/lib/auth";
import { getEntitlements } from "@/lib/modules";
import { effectiveAccess } from "@/lib/access/engine";
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
  const access = await effectiveAccess(user.businessId, user.id);
  return ok({
    user: me,
    business,
    businesses: memberships.map((m) => ({ id: m.business.id, name: m.business.name, slug: m.business.slug, role: m.role, active: m.businessId === user.businessId })),
    modules: entitlements.modules,
    /** What THIS user may do (package ∩ assigned permissions) – the UI hides what is not allowed; the server enforces it. */
    access: { scope: access.scope, template: access.template, suspended: access.suspended, modules: access.modules },
    plan: { key: entitlements.planKey, name: entitlements.planName },
    telephony: telephonyStatus(),
  });
});
