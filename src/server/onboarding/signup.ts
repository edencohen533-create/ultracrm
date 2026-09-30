/**
 * Self-service signup: a NEW isolated business with its owner account – no modules until the first verified payment
 * (a subscription row in state "none" means "nothing included", never the legacy "everything"). Rate limited per IP.
 * No email verification yet (no platform email provider) – listed as a launch requirement in docs/SAAS_READINESS.md.
 */
import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { ApiError } from "@/lib/response";
import { withoutBusiness } from "@/lib/tenant";

export const signupSchema = z.object({
  businessName: z.string().trim().min(2).max(80), fullName: z.string().trim().min(2).max(80),
  email: z.string().trim().toLowerCase().email().max(200), password: z.string().min(10).max(200),
  acceptTerms: z.literal(true), path: z.enum(["own_crm", "external_crm"]).default("own_crm"),
});
const hits = new Map<string, number[]>();
function limited(ip: string) { const now = Date.now(); const a = (hits.get(ip) ?? []).filter((t) => now - t < 3600_000); a.push(now); hits.set(ip, a); return a.length > 5; }

export async function signup(input: unknown, ip: string) {
  if (limited(crypto.createHash("sha256").update(ip).digest("hex"))) throw new ApiError("יותר מדי הרשמות מהכתובת הזו – נסו שוב בעוד שעה", 429, "rate_limited");
  const b = signupSchema.parse(input);
  if (!/[A-Za-z]/.test(b.password) || !/\d/.test(b.password)) throw new ApiError("הסיסמה צריכה לכלול אותיות וספרות (10 תווים לפחות)", 400, "weak_password");
  return withoutBusiness(async () => {
    if (await db.account.findUnique({ where: { email: b.email }, select: { id: true } })) throw new ApiError("כבר קיים חשבון עם האימייל הזה – התחברו", 409, "account_exists");
    const passwordHash = await bcrypt.hash(b.password, 12);
    return db.$transaction(async (tx) => {
      const account = await tx.account.create({ data: { email: b.email, fullName: b.fullName, passwordHash, claimedAt: new Date() } });
      const slug = `${b.businessName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 30) || "biz"}-${crypto.randomBytes(3).toString("hex")}`;
      const business = await tx.business.create({ data: { name: b.businessName, slug, accessStatus: "setup", billingStatus: "subscription", modules: {}, settings: { onboarding: { path: b.path, startedAt: new Date().toISOString() } } as Prisma.InputJsonValue } });
      await tx.subscription.create({ data: { businessId: business.id, status: "none" } });
      const user = await tx.user.create({ data: { businessId: business.id, accountId: account.id, email: b.email, fullName: b.fullName, role: "owner" } });
      await tx.auditLog.create({ data: { businessId: business.id, actorId: user.id, entityType: "business", entityId: business.id, action: "business.signed_up", payload: { path: b.path } } });
      return { account, business, user };
    });
  });
}
