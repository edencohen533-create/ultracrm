import { z } from "zod";
import { withAuth, parseBody } from "@/lib/api";
import { ok, ApiError } from "@/lib/response";
import { db, prisma } from "@/lib/db";
import { withoutBusiness } from "@/lib/tenant";
import { lockNumberPool } from "@/lib/numbers/selection";

export const dynamic = "force-dynamic";

const schema = z.object({ label: z.string().max(80).optional(), isDefault: z.boolean().optional(), isActive: z.boolean().optional() });

export const PATCH = withAuth(async ({ req, user, params }) => {
  const b = await parseBody(req, schema);
  const n = await prisma.phoneNumber.findFirst({ where: { id: params.id, businessId: user.businessId } });
  if (!n) throw new ApiError("מספר לא נמצא", 404, "not_found");
  if (b.isActive === true && !n.isActive) {
    // With real telephony a number is activated only after inventory sync proved this business owns it.
    if (process.env.TELEPHONY_PROVIDER === "telnyx" && n.verificationStatus !== "verified") throw new ApiError("יש לאמת בעלות על המספר (סנכרון מול הספק) לפני הפעלה", 409, "number_not_verified");
    if (await withoutBusiness(() => db.phoneNumber.findFirst({ where: { e164: n.e164, isActive: true, businessId: { not: user.businessId } }, select: { id: true } }))) throw new ApiError("המספר פעיל אצל עסק אחר במערכת", 409, "number_already_registered");
  }
  const updated = await prisma.$transaction(async (tx) => {
    await lockNumberPool(tx, user.businessId);
    if (b.isDefault) await tx.phoneNumber.updateMany({ where: { businessId: user.businessId }, data: { isDefault: false } });
    return tx.phoneNumber.update({ where: { id: n.id }, data: { ...(b.label !== undefined ? { label: b.label || null } : {}), ...(b.isDefault !== undefined ? { isDefault: b.isDefault } : {}), ...(b.isActive !== undefined ? { isActive: b.isActive } : {}) } });
  });
  return ok(updated);
}, { minRole: "owner", module: "telephony" });

export const DELETE = withAuth(async ({ user, params }) => {
  const n = await prisma.phoneNumber.findFirst({ where: { id: params.id, businessId: user.businessId } });
  if (!n) throw new ApiError("מספר לא נמצא", 404, "not_found");
  await prisma.$transaction(async (tx) => { await lockNumberPool(tx, user.businessId); await tx.phoneNumber.update({ where: { id: n.id }, data: { isActive: false, isDefault: false } }); });
  return ok({ deactivated: true });
}, { minRole: "owner", module: "telephony" });
