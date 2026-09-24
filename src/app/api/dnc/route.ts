import { z } from "zod";
import { withAuth, parseBody, parseQuery } from "@/lib/api";
import { ok, ApiError } from "@/lib/response";
import { prisma } from "@/lib/db";
import { normalizePhone, phoneDigits } from "@/lib/phone";
import { addToDnc, removeFromDnc } from "@/lib/dialer/queue";

export const dynamic = "force-dynamic";

export const GET = withAuth(async ({ req, user }) => {
  const f = parseQuery(req, z.object({ q: z.string().optional(), page: z.coerce.number().int().min(1).default(1), limit: z.coerce.number().int().min(1).max(200).default(50) }));
  const where = { businessId: user.businessId, ...(f.q ? { phoneE164: { contains: phoneDigits(f.q).replace(/^0/, "") } } : {}) };
  const [total, items] = await Promise.all([
    prisma.dncEntry.count({ where }),
    prisma.dncEntry.findMany({ where, orderBy: { createdAt: "desc" }, skip: (f.page - 1) * f.limit, take: f.limit, include: { createdBy: { select: { id: true, fullName: true } } } }),
  ]);
  return ok({ items, total, page: f.page, limit: f.limit });
}, { minRole: "manager" });

export const POST = withAuth(async ({ req, user }) => {
  const b = await parseBody(req, z.object({ phone: z.string().min(3), reason: z.string().max(200).optional() }));
  const e164 = normalizePhone(b.phone);
  if (!e164) throw new ApiError("מספר טלפון לא תקין", 400, "invalid_phone");
  await addToDnc(user.businessId, user.id, e164, b.reason ?? "manual");
  return ok({ phoneE164: e164 }, 201);
});

export const DELETE = withAuth(async ({ req, user }) => {
  const b = await parseBody(req, z.object({ phone: z.string().min(3) }));
  const e164 = normalizePhone(b.phone);
  if (!e164) throw new ApiError("מספר טלפון לא תקין", 400, "invalid_phone");
  await removeFromDnc(user.businessId, user.id, e164);
  return ok({ removed: true });
}, { minRole: "manager" });
