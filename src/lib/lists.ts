import type { z } from "zod";
import { prisma } from "@/lib/db";
import { contactFilterSchema, contactWhere } from "@/lib/contacts";
import type { Prisma } from "@/generated/prisma/client";

/** Insert contacts into a list. Duplicates (same contact) and DNC numbers are skipped. */
export async function addLeadsToList(businessId: string, listId: string, filter?: z.infer<typeof contactFilterSchema>, contactIds?: string[]) {
  const where: Prisma.ContactWhereInput = contactIds?.length
    ? { businessId, id: { in: contactIds } }
    : contactWhere(businessId, filter ?? {});
  const contacts = await prisma.contact.findMany({ where, select: { id: true, phoneE164: true }, take: 20000 });
  if (contacts.length === 0) return 0;
  const dnc = await prisma.dncEntry.findMany({ where: { businessId, phoneE164: { in: contacts.map((c) => c.phoneE164) } }, select: { phoneE164: true } });
  const blocked = new Set(dnc.map((d) => d.phoneE164));
  const r = await prisma.listLead.createMany({
    data: contacts.filter((c) => !blocked.has(c.phoneE164)).map((c) => ({ businessId, listId, contactId: c.id })),
    skipDuplicates: true,
  });
  return r.count;
}
