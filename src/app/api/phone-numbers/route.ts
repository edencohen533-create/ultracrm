import { z } from "zod";
import { withAuth, parseBody } from "@/lib/api";
import { ok, ApiError } from "@/lib/response";
import { prisma } from "@/lib/db";
import { normalizePhone } from "@/lib/phone";
import { Prisma } from "@/generated/prisma/client";

export const dynamic = "force-dynamic";

export const GET = withAuth(async ({ user }) => {
  const items = await prisma.phoneNumber.findMany({ where: { businessId: user.businessId }, orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }] });
  return ok(items);
});

const schema = z.object({ phone: z.string().min(3), label: z.string().max(80).optional(), isDefault: z.boolean().optional() });

export const POST = withAuth(async ({ req, user }) => {
  const b = await parseBody(req, schema);
  const e164 = normalizePhone(b.phone);
  if (!e164) throw new ApiError("מספר טלפון לא תקין", 400, "invalid_phone");
  const count = await prisma.phoneNumber.count({ where: { businessId: user.businessId } });
  const n = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${"phone-number:" + e164}, 0))`);
    if (await tx.phoneNumber.findFirst({ where: { e164 } })) throw new ApiError("המספר כבר רשום במערכת", 409, "number_already_registered");
    if (b.isDefault || count === 0) await tx.phoneNumber.updateMany({ where: { businessId: user.businessId }, data: { isDefault: false } });
    return tx.phoneNumber.create({ data: { businessId: user.businessId, e164, label: b.label || null, isDefault: Boolean(b.isDefault) || count === 0 } });
  });
  return ok(n, 201);
}, { minRole: "admin" });
