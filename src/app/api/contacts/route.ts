import { assertTenantReferences } from "@/lib/tenant-references";
import { z } from "zod";
import { withAuth, parseBody, parseQuery } from "@/lib/api";
import { ok, ApiError } from "@/lib/response";
import { prisma } from "@/lib/db";
import { normalizePhone } from "@/lib/phone";
import { contactFilterSchema, contactInputSchema, contactWhere } from "@/lib/contacts";

export const dynamic = "force-dynamic";

const listSchema = contactFilterSchema.extend({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export const GET = withAuth(async ({ req, user }) => {
  const f = parseQuery(req, listSchema);
  const where = contactWhere(user.businessId, f);
  const [total, items] = await Promise.all([
    prisma.contact.count({ where }),
    prisma.contact.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (f.page - 1) * f.limit,
      take: f.limit,
      include: {
        owner: { select: { id: true, fullName: true } },
        _count: { select: { calls: true } },
        calls: { orderBy: { createdAt: "desc" }, take: 1, select: { createdAt: true, outcome: true, telephonyResult: true } },
      },
    }),
  ]);
  const dnc = await prisma.dncEntry.findMany({ where: { businessId: user.businessId, phoneE164: { in: items.map((c) => c.phoneE164) } }, select: { phoneE164: true } });
  const dncSet = new Set(dnc.map((d) => d.phoneE164));
  return ok({
    items: items.map((c) => ({ ...c, isDnc: dncSet.has(c.phoneE164), lastCall: c.calls[0] ?? null, calls: undefined })),
    total,
    page: f.page,
    limit: f.limit,
  });
});

export const POST = withAuth(async ({ req, user }) => {
  const b = await parseBody(req, contactInputSchema);
  await assertTenantReferences(user.businessId, { userIds: [b.ownerUserId] });
  const e164 = normalizePhone(b.phone);
  if (!e164) throw new ApiError("מספר טלפון לא תקין", 400, "invalid_phone");
  const exists = await prisma.contact.findUnique({ where: { businessId_phoneE164: { businessId: user.businessId, phoneE164: e164 } } });
  if (exists) throw new ApiError("איש קשר עם מספר זה כבר קיים", 409, "duplicate_phone", { contactId: exists.id });
  const c = await prisma.contact.create({
    data: {
      businessId: user.businessId,
      fullName: b.fullName.trim(),
      phoneE164: e164,
      phoneRaw: b.phone,
      email: b.email || null,
      company: b.company || null,
      city: b.city || null,
      source: b.source || "manual",
      notes: b.notes || null,
      ownerUserId: b.ownerUserId || user.id,
    },
  });
  return ok(c, 201);
});
