import { assertTenantReferences } from "@/lib/tenant-references";
import { z } from "zod";
import { withAuth, parseBody } from "@/lib/api";
import { ok } from "@/lib/response";
import { prisma } from "@/lib/db";
import { listQueueStats } from "@/lib/dialer/queue";
import { contactFilterSchema } from "@/lib/crm/contacts";
import { addLeadsToList } from "@/lib/lists";
import type { Prisma } from "@/generated/prisma/client";

export const dynamic = "force-dynamic";

/** Lists visible to this user (agents: only lists assigned to them or unassigned). */
export const GET = withAuth(async ({ user }) => {
  const lists = await prisma.dialList.findMany({
    where: {
      businessId: user.businessId,
      ...(user.role === "agent" ? { OR: [{ agents: { none: {} } }, { agents: { some: { userId: user.id } } }] } : {}),
    },
    orderBy: [{ isActive: "desc" }, { priority: "desc" }, { createdAt: "desc" }],
    include: { agents: { include: { user: { select: { id: true, fullName: true } } } }, script: { select: { id: true, title: true } }, phoneNumber: { select: { id: true, e164: true, label: true } } },
  });
  const visible = lists.filter((l) => { const owner = (l.filterJson as { leadOwnerUserId?: string } | null)?.leadOwnerUserId; return user.role !== "agent" || !owner || owner === user.id; });
  const stats = await Promise.all(visible.map((l) => listQueueStats(l.id)));
  return ok(visible.map((l, i) => ({ ...l, stats: stats[i] })));
}, { perm: "telephony.use" });

const createSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(500).optional(),
  /** 1 = lowest … 10 = highest (orders lists; never the leads inside a list). */
  priority: z.number().int().min(1).max(10).optional(),
  maxAttempts: z.number().int().min(1).max(20).nullable().optional(),
  unansweredLimit: z.number().int().min(0).max(50).nullable().optional(),
  retryIntervalMinutes: z.number().int().min(1).max(10080).nullable().optional(),
  scriptId: z.string().nullable().optional(),
  phoneNumberId: z.string().nullable().optional(),
  isDynamic: z.boolean().optional(),
  /** new_prospects = acquisition (existing customers never dialed), existing_customers = renewals / upsell, all. */
  audience: z.enum(["new_prospects", "existing_customers", "all"]).optional(),
  agentIds: z.array(z.string()).optional(),
  /** Build the list from a saved CRM filter right away. */
  filter: contactFilterSchema.optional(),
  contactIds: z.array(z.string()).max(10000).optional(),
});

export const POST = withAuth(async ({ req, user }) => {
  const b = await parseBody(req, createSchema);
  await assertTenantReferences(user.businessId, { userIds: b.agentIds, scriptId: b.scriptId, phoneNumberId: b.phoneNumberId });
  const list = await prisma.dialList.create({
    data: {
      businessId: user.businessId,
      name: b.name.trim(),
      description: b.description || null,
      priority: b.priority ?? 5,
      maxAttempts: b.maxAttempts ?? null,
      unansweredLimit: b.unansweredLimit ?? null,
      retryIntervalMinutes: b.retryIntervalMinutes ?? null,
      scriptId: b.scriptId ?? null,
      phoneNumberId: b.phoneNumberId ?? null,
      isDynamic: Boolean(b.isDynamic && b.filter),
      audience: b.audience ?? "new_prospects",
      filterJson: (b.filter as Prisma.InputJsonValue | undefined) ?? undefined,
      agents: b.agentIds?.length ? { create: b.agentIds.map((userId) => ({ userId })) } : undefined,
    },
  });
  let added = 0;
  if (b.filter || b.contactIds?.length) {
    added = await addLeadsToList(user.businessId, list.id, b.filter, b.contactIds);
  }
  return ok({ ...list, added }, 201);
}, { minRole: "manager", perm: "telephony.team_settings" });
