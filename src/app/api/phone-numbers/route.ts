import { z } from "zod";
import { withAuth, parseBody } from "@/lib/api";
import { ok, ApiError } from "@/lib/response";
import { db, prisma } from "@/lib/db";
import { withoutBusiness } from "@/lib/tenant";
import { normalizePhone } from "@/lib/phone";
import { Prisma } from "@/generated/prisma/client";

export const dynamic = "force-dynamic";

export const GET = withAuth(async ({ user }) => {
  // Agents pick a caller ID; provider data, purchase costs and reputation details are for managers.
  const where = { businessId: user.businessId }, orderBy = [{ isDefault: "desc" as const }, { createdAt: "asc" as const }];
  if (user.role === "agent") return ok(await prisma.phoneNumber.findMany({ where, orderBy, select: { id: true, e164: true, label: true, isDefault: true, isActive: true, outboundPaused: true, assignedUserId: true } }));
  return ok(await prisma.phoneNumber.findMany({ where, orderBy }));
}, { module: "telephony" });

const schema = z.object({ phone: z.string().min(3), label: z.string().max(80).optional(), isDefault: z.boolean().optional() });

export const POST = withAuth(async ({ req, user }) => {
  const b = await parseBody(req, schema);
  const e164 = normalizePhone(b.phone);
  if (!e164) throw new ApiError("מספר טלפון לא תקין", 400, "invalid_phone");
  const count = await prisma.phoneNumber.count({ where: { businessId: user.businessId } });
  const n = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${"phone-number:" + e164}, 0))`);
    // The duplicate check must see EVERY business (the scoped client / RLS only show this one): a number another
    // business uses can never be registered here, or its inbound calls would be split or diverted.
    if (await tx.phoneNumber.findFirst({ where: { e164, businessId: user.businessId } })) throw new ApiError("המספר כבר רשום בעסק", 409, "number_already_registered");
    if (await withoutBusiness(() => db.phoneNumber.findFirst({ where: { e164, businessId: { not: user.businessId }, OR: [{ isActive: true }, { verificationStatus: "verified" }] }, select: { id: true } }))) throw new ApiError("המספר רשום אצל עסק אחר במערכת – לא ניתן להוסיף אותו", 409, "number_already_registered");
    if (b.isDefault || count === 0) await tx.phoneNumber.updateMany({ where: { businessId: user.businessId }, data: { isDefault: false } });
    // With real telephony a manually added number stays inactive until inventory sync proves ownership.
    return tx.phoneNumber.create({ data: { businessId: user.businessId, e164, isActive: process.env.TELEPHONY_PROVIDER !== "telnyx", label: b.label || null, isDefault: Boolean(b.isDefault) || count === 0 } });
  });
  return ok(n, 201);
}, { minRole: "owner", module: "telephony" });
