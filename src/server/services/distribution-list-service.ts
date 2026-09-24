import { Prisma } from "@/generated/prisma/client";
import type { z } from "zod";
import { prisma } from "@/lib/db";
import { requireBusinessId } from "@/lib/tenant";
import { distributionListSchema } from "@/lib/campaigns";
import { AudienceError, validateAudienceReferences } from "./audience-service";
export async function saveDistributionList(input: z.infer<typeof distributionListSchema>, actorId: string, id?: string) {
  return prisma.$transaction(async (tx) => {
    if (id && !await tx.distributionList.findUnique({ where: { id }, select: { id: true } })) throw new AudienceError("הרשימה אינה נגישה");
    if (input.segment) await validateAudienceReferences(tx, input.segment);
    if (input.contactIds.length && await tx.contact.count({ where: { id: { in: input.contactIds } } }) !== input.contactIds.length) throw new AudienceError("חלק מאנשי הקשר אינם נגישים");
    const data = { name: input.name, segment: input.segment ?? Prisma.DbNull };
    const members = input.contactIds.map((contactId) => ({ contactId }));
    const list = id
      ? await tx.distributionList.update({ where: { id }, data: { ...data, members: { deleteMany: {}, ...(members.length ? { createMany: { data: members } } : {}) } } })
      : await tx.distributionList.create({ data: { businessId: requireBusinessId(), ...data, ...(members.length ? { members: { createMany: { data: members } } } : {}) } });
    await tx.auditLog.create({ data: { businessId: requireBusinessId(), actorId: actorId, action: id ? "audience.updated" : "audience.created", entityType: "DistributionList", entityId: list.id, payload: { mode: input.segment ? "segment" : "static", members: members.length } } });
    return list;
  }, { timeout: 30000 });
}
