import { assertTenantReferences } from "@/lib/tenant-references";
import { z } from "zod";
import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { normalizePhone, phoneDigits } from "@/lib/phone";

/** A saved CRM filter – used both for the contacts screen and for building dial lists. */
export const contactFilterSchema = z.object({
  q: z.string().max(100).optional(),
  source: z.string().max(100).optional(),
  city: z.string().max(80).optional(),
  ownerUserId: z.string().optional(),
  createdAfter: z.string().optional(),
  createdBefore: z.string().optional(),
  neverCalled: z.enum(["true", "false"]).optional(),
  notInListId: z.string().optional(),
});
export type ContactFilter = z.infer<typeof contactFilterSchema>;

export function contactWhere(businessId: string, f: ContactFilter): Prisma.ContactWhereInput {
  const where: Prisma.ContactWhereInput = { businessId };
  if (f.q) {
    const digits = phoneDigits(f.q);
    where.OR = [
      { fullName: { contains: f.q, mode: "insensitive" } },
      { company: { contains: f.q, mode: "insensitive" } },
      { email: { contains: f.q, mode: "insensitive" } },
      ...(digits.length >= 3 ? [{ phoneE164: { contains: digits.replace(/^0/, "") } }, { phoneRaw: { contains: digits } }] : []),
    ];
  }
  if (f.source) where.source = f.source;
  if (f.city) where.city = { contains: f.city, mode: "insensitive" };
  if (f.ownerUserId) where.ownerUserId = f.ownerUserId;
  if (f.createdAfter || f.createdBefore) {
    where.createdAt = { ...(f.createdAfter ? { gte: new Date(f.createdAfter) } : {}), ...(f.createdBefore ? { lte: new Date(f.createdBefore) } : {}) };
  }
  if (f.neverCalled === "true") where.calls = { none: {} };
  if (f.notInListId) where.leads = { none: { listId: f.notInListId } };
  return where;
}

export const contactInputSchema = z.object({
  fullName: z.string().min(1).max(120),
  phone: z.string().min(1).max(30),
  email: z.string().email().or(z.literal("")).optional(),
  company: z.string().max(120).optional(),
  city: z.string().max(80).optional(),
  source: z.string().max(100).optional(),
  notes: z.string().max(4000).optional(),
  ownerUserId: z.string().optional(),
  customFields: z.record(z.string(), z.unknown()).optional(),
});

/** Import rows; duplicates (same normalized number) are merged, invalid numbers skipped. */
export async function importContacts(businessId: string, rows: z.infer<typeof contactInputSchema>[], defaultSource?: string) {
  await assertTenantReferences(businessId, { userIds: rows.map(r => r.ownerUserId) });
  let created = 0,
    updated = 0,
    invalid = 0;
  const errors: Array<{ row: number; phone: string; reason: string }> = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const e164 = normalizePhone(r.phone);
    if (!e164) {
      invalid++;
      errors.push({ row: i + 1, phone: r.phone, reason: "מספר טלפון לא תקין" });
      continue;
    }
    const data = {
      fullName: r.fullName.trim(),
      phoneRaw: r.phone,
      email: r.email || null,
      company: r.company || null,
      city: r.city || null,
      source: r.source || defaultSource || null,
      notes: r.notes || null,
      ownerUserId: r.ownerUserId || null,
      customFields: (r.customFields as Prisma.InputJsonValue | undefined) ?? undefined,
    };
    const existing = await prisma.contact.findUnique({ where: { businessId_phoneE164: { businessId, phoneE164: e164 } }, select: { id: true } });
    if (existing) {
      await prisma.contact.update({ where: { id: existing.id }, data: { ...data, source: data.source ?? undefined, ownerUserId: data.ownerUserId ?? undefined } });
      updated++;
    } else {
      await prisma.contact.create({ data: { ...data, businessId, phoneE164: e164 } });
      created++;
    }
  }
  return { created, updated, invalid, errors: errors.slice(0, 200) };
}
