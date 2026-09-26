import { z } from "zod";
import { withAuth, parseBody, parseQuery } from "@/lib/api";
import { ok, ApiError } from "@/lib/response";
import type { Prisma } from "@/generated/prisma/client";
import { AudienceError, listAudienceWhere } from "@/server/services/audience-service";
import { prisma } from "@/lib/db";
import { contactFilterSchema, contactInputSchema, contactWhere, createContact } from "@/lib/crm/contacts";

export const dynamic = "force-dynamic";

const listSchema = contactFilterSchema.extend({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(25),
});

export const GET = withAuth(async ({ req, user }) => {
  const f = parseQuery(req, listSchema);
  let where: Prisma.ContactWhereInput = contactWhere(user.businessId, f);
  if (f.segmentId) {
    const list = await prisma.distributionList.findUnique({ where: { id: f.segmentId }, select: { id: true, segment: true } });
    if (!list) throw new ApiError("הסגמנט לא נמצא", 404, "not_found");
    try { where = { AND: [where, await listAudienceWhere(prisma as unknown as Prisma.TransactionClient, list, new Date())] }; }
    catch (e) { if (e instanceof AudienceError) throw new ApiError(e.message, 400, "segment_invalid"); throw e; }
  }
  const [total, items] = await Promise.all([
    prisma.contact.count({ where }),
    prisma.contact.findMany({
      where,
      orderBy: [{ lastActivityAt: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }],
      skip: (f.page - 1) * f.limit,
      take: f.limit,
      include: {
        owner: { select: { id: true, fullName: true } },
        tags: { include: { tag: { select: { id: true, name: true, color: true } } } },
        _count: { select: { calls: true, conversations: true, leads: { where: { status: { in: ["new", "contacted", "qualified"] } } } } },
        calls: { orderBy: { createdAt: "desc" }, take: 1, select: { createdAt: true, outcome: true, telephonyResult: true } },
      },
    }),
  ]);
  const phones = items.map((c) => c.phoneE164);
  const [dnc, suppressed] = await Promise.all([
    prisma.dncEntry.findMany({ where: { businessId: user.businessId, phoneE164: { in: phones } }, select: { phoneE164: true } }),
    prisma.suppression.findMany({ where: { businessId: user.businessId, contactId: { in: items.map((c) => c.id) }, revokedAt: null }, select: { contactId: true, scope: true } }),
  ]);
  const dncSet = new Set(dnc.map((d) => d.phoneE164));
  const supMap = new Map<string, "marketing" | "all">();
  for (const s of suppressed) if (s.contactId) supMap.set(s.contactId, s.scope === "all" || supMap.get(s.contactId) === "all" ? "all" : "marketing");
  return ok({
    items: items.map((c) => ({ ...c, tags: c.tags.map((t) => t.tag), isDnc: dncSet.has(c.phoneE164), suppression: supMap.get(c.id) ?? null, lastCall: c.calls[0] ?? null, calls: undefined })),
    total,
    page: f.page,
    limit: f.limit,
  });
});

export const POST = withAuth(async ({ req, user }) => {
  const b = await parseBody(req, contactInputSchema);
  return ok(await createContact(user, b), 201);
});
