import { z } from "zod";
import { withAuth, parseBody } from "@/lib/api";
import { ok, ApiError } from "@/lib/response";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import type { Prisma } from "@/generated/prisma/client";

export const dynamic = "force-dynamic";

const schema = z.object({ name: z.string().min(1).max(120).optional(), withLeads: z.boolean().default(true) });

/** Copy a list's settings (and optionally its open leads, reset to pending). */
export const POST = withAuth(async ({ req, user, params }) => {
  const b = await parseBody(req, schema);
  const src = await prisma.dialList.findFirst({ where: { id: params.id, businessId: user.businessId }, include: { agents: true } });
  if (!src) throw new ApiError("רשימה לא נמצאה", 404, "not_found");
  const copy = await prisma.dialList.create({
    data: {
      businessId: user.businessId,
      name: b.name ?? `${src.name} (עותק)`,
      description: src.description,
      priority: src.priority,
      maxAttempts: src.maxAttempts,
      retryIntervalMinutes: src.retryIntervalMinutes,
      dialWindowJson: (src.dialWindowJson as Prisma.InputJsonValue) ?? undefined,
      filterJson: (src.filterJson as Prisma.InputJsonValue) ?? undefined,
      scriptId: src.scriptId,
      phoneNumberId: src.phoneNumberId,
      isDynamic: src.isDynamic,
      agents: { create: src.agents.map((a) => ({ userId: a.userId })) },
    },
  });
  let copied = 0;
  if (b.withLeads) {
    const leads = await prisma.listLead.findMany({ where: { listId: src.id, status: { in: ["pending", "callback", "locked", "exhausted"] } }, select: { contactId: true, priority: true } });
    const r = await prisma.listLead.createMany({ data: leads.map((l) => ({ businessId: user.businessId, listId: copy.id, contactId: l.contactId, priority: l.priority })), skipDuplicates: true });
    copied = r.count;
  }
  await audit(user.businessId, user.id, "list", copy.id, "list.duplicated", { from: src.id, copied });
  return ok({ ...copy, copied }, 201);
}, { minRole: "manager" });
