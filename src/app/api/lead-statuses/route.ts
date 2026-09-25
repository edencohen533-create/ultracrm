import { z } from "zod";
import { withAuth, parseBody } from "@/lib/api";

import { ok, ApiError } from "@/lib/response";
import { prisma } from "@/lib/db";
import { getBusinessSettings, mergeLeadStatuses } from "@/lib/settings";
import { audit } from "@/lib/audit";
import type { Prisma } from "@/generated/prisma/client";

export const dynamic = "force-dynamic";

/** Lead status labels/order/visibility + the lead-distribution policy. Every role reads; managers (not only owners) edit. */
export const GET = withAuth(async ({ user }) => {
  const s = await getBusinessSettings(user.businessId);
  return ok({ items: s.leadStatuses, leadAssignment: s.leadAssignment });
}, { module: "crm" });

const schema = z.object({
  leadStatuses: z.array(z.object({ key: z.enum(["new", "contacted", "qualified", "unqualified", "converted", "lost"]), label: z.string().trim().min(1).max(40), hidden: z.boolean().default(false) })).max(6).optional(),
  leadAssignment: z.object({ mode: z.enum(["least_loaded", "round_robin"]).optional(), maxOpenLeadsPerAgent: z.number().int().min(0).max(10000).optional(), agentIds: z.array(z.string()).max(200).optional() }).optional(),
});

export const PATCH = withAuth(async ({ req, user }) => {
  const b = await parseBody(req, schema);
  if (b.leadAssignment?.agentIds?.length) {
    const n = await prisma.user.count({ where: { businessId: user.businessId, id: { in: b.leadAssignment.agentIds } } });
    if (n !== new Set(b.leadAssignment.agentIds).size) throw new ApiError("נציג לא קיים בעסק", 400, "invalid_agent");
  }
  const biz = await prisma.business.findUniqueOrThrow({ where: { id: user.businessId }, select: { settings: true } });
  const raw = (biz.settings && typeof biz.settings === "object" ? biz.settings : {}) as Record<string, unknown>;
  const la = (raw.leadAssignment && typeof raw.leadAssignment === "object" ? raw.leadAssignment : {}) as Record<string, unknown>;
  const next = {
    ...raw,
    ...(b.leadStatuses ? { leadStatuses: mergeLeadStatuses(b.leadStatuses) } : {}),
    ...(b.leadAssignment ? { leadAssignment: { ...la, ...b.leadAssignment } } : {}),
  };
  await prisma.business.update({ where: { id: user.businessId }, data: { settings: next as Prisma.InputJsonValue } });
  await audit(user.businessId, user.id, "settings", user.businessId, "settings.updated", { changed: { ...(b.leadStatuses ? { leadStatuses: true } : {}), ...(b.leadAssignment ? { leadAssignment: b.leadAssignment } : {}) } });
  const s = await getBusinessSettings(user.businessId);
  return ok({ items: s.leadStatuses, leadAssignment: s.leadAssignment });
}, { module: "crm", minRole: "manager" });
