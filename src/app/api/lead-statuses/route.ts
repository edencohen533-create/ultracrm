import { z } from "zod";
import { withDisplayName } from "@/server/services/template-service";
import { withAuth, parseBody } from "@/lib/api";

import { ok, ApiError } from "@/lib/response";
import { prisma } from "@/lib/db";
import { getBusinessSettings } from "@/lib/settings";
import { createStatus, createStatusSchema, listStatuses, updateStatuses, updateStatusesSchema } from "@/lib/crm/statuses";
import { audit } from "@/lib/audit";
import type { Prisma } from "@/generated/prisma/client";

export const dynamic = "force-dynamic";

/**
 * Lead statuses (rows with stable ids and a meaning – src/lib/crm/statuses.ts) + the lead-distribution policy.
 * Every role reads. Status structure (add / rename / reorder / reactivate / delete) – owner only; distribution – managers.
 */
export const GET = withAuth(async ({ user }) => {
  const s = await getBusinessSettings(user.businessId);
  // Managers also get the WhatsApp templates (with approval status) for the "notify the agent" option.
  const templates = user.role === "agent" ? [] : await prisma.template.findMany({ where: { businessId: user.businessId, channel: "whatsapp", internal: false }, orderBy: { name: "asc" }, select: { id: true, name: true, displayName: true, status: true, body: true } }).then((r) => r.map(withDisplayName));
  // The distribution policy is the owner's screen – nobody else sees it (also through the API).
  return ok({ items: await listStatuses(user.businessId), leadAssignment: user.role === "owner" ? s.leadAssignment : null, templates: user.role === "owner" ? templates : [], canEditStructure: user.role === "owner", timezone: s.timezone });
}, { perm: ["crm.view", "telephony.use"] });

/** Add a status (owner): a name and its meaning. */
export const POST = withAuth(async ({ req, user }) => ok(await createStatus(user, await parseBody(req, createStatusSchema)), 201), { minRole: "manager", perm: "crm.edit" });

const schema = z.object({
  /** Rename / reorder / reactivate statuses (owner). */
  items: updateStatusesSchema.shape.items.optional(),
  leadAssignment: z.object({ mode: z.enum(["least_loaded", "round_robin"]).optional(), maxOpenLeadsPerAgent: z.number().int().min(0).max(10000).optional(), agentIds: z.array(z.string()).max(200).optional(), perAgentMax: z.record(z.string(), z.number().int().min(0).max(10000)).optional(), requireOnline: z.boolean().optional(), whenNoneOnline: z.enum(["unassigned", "any_eligible"]).optional(), notifyWhatsApp: z.object({ enabled: z.boolean(), templateId: z.string().nullable() }).optional() }).optional(),
});

export const PATCH = withAuth(async ({ req, user }) => {
  const b = await parseBody(req, schema);
  if (b.leadAssignment && user.role !== "owner") throw new ApiError("חלוקת הלידים זמינה לבעל העסק בלבד", 403, "owner_only");
  const items = b.items ? await updateStatuses(user, { items: b.items }) : null;
  if (b.leadAssignment?.agentIds?.length) {
    const n = await prisma.user.count({ where: { businessId: user.businessId, id: { in: b.leadAssignment.agentIds } } });
    if (n !== new Set(b.leadAssignment.agentIds).size) throw new ApiError("נציג לא קיים בעסק", 400, "invalid_agent");
  }
  const biz = await prisma.business.findUniqueOrThrow({ where: { id: user.businessId }, select: { settings: true } });
  const raw = (biz.settings && typeof biz.settings === "object" ? biz.settings : {}) as Record<string, unknown>;
  const la = (raw.leadAssignment && typeof raw.leadAssignment === "object" ? raw.leadAssignment : {}) as Record<string, unknown>;
  const next = {
    ...raw,
    ...(b.leadAssignment ? { leadAssignment: { ...la, ...b.leadAssignment } } : {}),
  };
  if (b.leadAssignment) {
    await prisma.business.update({ where: { id: user.businessId }, data: { settings: next as Prisma.InputJsonValue } });
    await audit(user.businessId, user.id, "settings", user.businessId, "settings.updated", { changed: { leadAssignment: b.leadAssignment } });
  }
  const s = await getBusinessSettings(user.businessId);
  return ok({ items: items ?? await listStatuses(user.businessId), leadAssignment: s.leadAssignment });
}, { minRole: "manager", perm: "crm.edit" });
