import crypto from "node:crypto";
import { z } from "zod";
import { withAuth, parseBody } from "@/lib/api";
import { ok, ApiError } from "@/lib/response";
import { prisma } from "@/lib/db";
import { normalizePhone } from "@/lib/phone";
import { audit } from "@/lib/audit";
import { hashCode } from "@/server/assistant/inbound";
import { linkView } from "@/server/assistant/access";

export const dynamic = "force-dynamic";
const schema = z.object({ phone: z.string().trim().min(6).max(30), userId: z.string().optional(), scope: z.enum(["business", "own"]).optional() });

/**
 * Link a phone to a user of THIS business (the logged-in session decides the business – never the message).
 * Returns a one-time 6-digit code (stored hashed, 15 min) that must be sent FROM that phone to the business number.
 * Owner may link any user; a manager only their own phone. Agents always get "own" scope.
 */
export const POST = withAuth(async ({ req, user }) => {
  const b = await parseBody(req, schema);
  const targetId = b.userId ?? user.id;
  if (targetId !== user.id && user.role !== "owner") throw new ApiError("רק בעל העסק יכול לחבר מספר של משתמש אחר", 403, "forbidden");
  const target = await prisma.user.findFirst({ where: { id: targetId, businessId: user.businessId, isActive: true }, select: { id: true, role: true } });
  if (!target) throw new ApiError("משתמש לא נמצא", 404, "not_found");
  const phone = normalizePhone(b.phone);
  if (!phone) throw new ApiError("מספר טלפון לא תקין", 400, "invalid_phone");
  const own = await prisma.providerCredential.findFirst({ where: { businessId: user.businessId, channel: "whatsapp", isActive: true }, select: { displayPhoneNumber: true } });
  if (own?.displayPhoneNumber && normalizePhone(own.displayPhoneNumber) === phone) throw new ApiError("זה המספר של העסק עצמו – יש לחבר את הטלפון האישי", 400, "own_number");
  const existing = await prisma.assistantLink.findUnique({ where: { businessId_phoneE164: { businessId: user.businessId, phoneE164: phone } } });
  if (existing && existing.status !== "revoked" && existing.userId !== targetId && user.role !== "owner") throw new ApiError("המספר כבר מחובר למשתמש אחר", 409, "conflict");
  const scope = target.role === "agent" ? "own" : b.scope ?? (target.role === "owner" ? "business" : "business");
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
  const data = { userId: targetId, status: "pending", scope, codeHash: hashCode(user.businessId, code), codeExpiresAt: new Date(Date.now() + 15 * 60_000), verifiedAt: null, revokedAt: null, context: {}, pendingReport: null, createdById: user.id };
  const link = existing
    ? await prisma.assistantLink.update({ where: { id: existing.id }, data, include: { user: { select: { fullName: true, role: true } } } })
    : await prisma.assistantLink.create({ data: { businessId: user.businessId, phoneE164: phone, ...data }, include: { user: { select: { fullName: true, role: true } } } });
  await audit(user.businessId, user.id, "AssistantLink", link.id, "assistant.link_code_issued", { forUser: targetId, phoneLast4: phone.slice(-4), scope });
  return ok({ link: linkView(link), code, businessNumber: own?.displayPhoneNumber ?? null }, 201);
}, { minRole: "manager" });
