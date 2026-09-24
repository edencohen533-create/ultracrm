import { resolveSender } from "@/server/providers/provider-registry";
import { Prisma } from "@/generated/prisma/client";
import { requireBusinessId } from "@/lib/tenant";
import bcrypt from "bcryptjs";
/** Seeded demo password – a live Meta connection is refused while any active user still has it. */
const DEMO_PASSWORD = "Demo1234!";
import { MetaConnectionError } from "./meta-connection-service";
import { checkMetaConnection } from "./meta-connection-service";
import { prisma } from "@/lib/db";
import type { MetaProviderConfigInput } from "@/lib/validation/provider";
import { writeAuditLog } from "@/lib/audit";
import { metaConfigOf, sealMetaConfig } from "@/lib/meta/graph";
import { maskSecret } from "@/lib/crypto";

async function applyNumberTeam(tx: Prisma.TransactionClient, id: string, teamId: string | null | undefined) {
  if (!teamId) return;
  // Moving a number transfers its inbox to the new team; keep message authors/history intact.
  await tx.conversation.updateMany({ where: { providerCredentialId: id, assignedAgent: { role: "agent", OR: [{ teamId: null }, { teamId: { not: teamId } }] } }, data: { assignedAgentId: null } });
}

export async function getActiveProviderSummary() {
  const active = await resolveSender(undefined, true);
  if (!active || active.provider === "mock") {
    return { provider: "mock" as const, configured: true };
  }

  const config = metaConfigOf(active.config);
  return {
    id: active.id,
    provider: active.provider,
    configured: true,
    lastCheckedAt: active.lastCheckedAt?.toISOString() ?? null,
    lastConnectionError: active.lastConnectionError,
    sendingBlocked: active.sendingBlocked,
    phoneNumberId: config.phoneNumberId ?? null,
    businessAccountId: config.businessAccountId ?? null,
    accessTokenMasked: maskSecret(config.accessToken),
    hasAppSecret: Boolean(config.appSecret),
  };
}

export async function activateMetaProvider(input: MetaProviderConfigInput, actorUserId: string, options: { label?: string; teamId?: string | null; makeDefault?: boolean } = {}) {
  const users = await prisma.user.findMany({ where: { isActive: true }, select: { account: { select: { passwordHash: true } } } });
  for (const user of users) {
    if (await bcrypt.compare(DEMO_PASSWORD, user.account.passwordHash)) throw new MetaConnectionError("לפני חיבור Meta יש להחליף את סיסמאות הדמו או להשבית את חשבונות ההדגמה בהגדרות המשתמשים");
  }
  const report = await checkMetaConnection(input);
  const credential = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${requireBusinessId()}, 774291))`;
    if (options.teamId && !await tx.team.findUnique({ where: { id: options.teamId }, select: { id: true } })) throw new MetaConnectionError("הצוות אינו קיים בעסק");
    const other = await tx.providerCredential.findFirst({ where: { isActive: true, provider: "meta_whatsapp_cloud_api", phoneNumberId: { not: input.phoneNumberId } } });
    if (other && (other.config as Record<string, unknown>).businessAccountId !== input.businessAccountId) throw new MetaConnectionError("מספרים פעילים באותו עסק חייבים להשתייך לאותו חשבון WhatsApp Business. יש לנתק את החשבון הישן לפני החלפתו");
    const existing = await tx.providerCredential.findFirst({ where: { provider: "meta_whatsapp_cloud_api", phoneNumberId: input.phoneNumberId } });
    if (existing && options.teamId !== undefined && existing.teamId !== options.teamId) await applyNumberTeam(tx, existing.id, options.teamId);
    const isDefault = options.makeDefault || !other || Boolean(existing?.isDefault);
    if (isDefault) await tx.providerCredential.updateMany({ where: { isDefault: true }, data: { isDefault: false } });
    const data = { phoneNumberId: input.phoneNumberId, wabaId: input.businessAccountId, config: sealMetaConfig(input) as Prisma.InputJsonValue, connectionMethod: "manual", status: "connected_not_ready" as const, isActive: true, isDefault, sendingBlocked: false, lastCheckedAt: new Date(), lastConnectionError: null, displayPhoneNumber: report.phoneNumber, verifiedName: report.verifiedName, subscribedAt: report.hasSubscribedApp ? new Date() : null, ...(options.label !== undefined ? { label: options.label } : {}), ...(options.teamId !== undefined ? { teamId: options.teamId } : {}) };
    return existing
      ? tx.providerCredential.update({ where: { id: existing.id }, data })
      : tx.providerCredential.create({ data: { businessId: requireBusinessId(), channel: "whatsapp", provider: "meta_whatsapp_cloud_api", ...data } });
  }).catch((error) => {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") throw new MetaConnectionError("המספר כבר משויך לחשבון אחר במערכת. נדרשת בדיקת בעלות לפני העברה");
    throw error;
  });

  await writeAuditLog({
    actorUserId,
    action: "provider.activated",
    entityType: "ProviderCredential",
    entityId: credential.id,
    metadata: { provider: "meta_whatsapp_cloud_api" },
  });

  return credential;
}

export async function activateMockProvider(actorUserId: string) {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${requireBusinessId()}, 774291))`;
    await tx.providerCredential.updateMany({ where: { isActive: true }, data: { isActive: false, isDefault: false } });
  });

  await writeAuditLog({
    actorUserId,
    action: "provider.activated",
    entityType: "ProviderCredential",
    entityId: "mock",
    metadata: { provider: "mock" },
  });
}

export async function listProviderSummaries() {
  return prisma.providerCredential.findMany({ orderBy: [{ isActive: "desc" }, { isDefault: "desc" }, { createdAt: "asc" }], select: {
    id: true, provider: true, label: true, phoneNumberId: true, displayPhoneNumber: true, teamId: true, isActive: true, isDefault: true,
    sendingBlocked: true, lastCheckedAt: true, lastWebhookAt: true, lastConnectionError: true,
  } });
}
export async function updateProvider(id: string, input: { action: "disconnect" | "default" | "details" | "reconnect"; label?: string; teamId?: string | null }, actorUserId: string) {
  if (input.action === "reconnect") {
    const saved = await prisma.providerCredential.findUnique({ where: { id } });
    if (!saved || saved.provider !== "meta_whatsapp_cloud_api") throw new MetaConnectionError("המספר אינו נגיש");
    return activateMetaProvider(metaConfigOf(saved.config) as MetaProviderConfigInput, actorUserId);
  }
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${requireBusinessId()}, 774291))`;
    const credential = await tx.providerCredential.findUnique({ where: { id } });
    if (!credential) throw new MetaConnectionError("המספר אינו נגיש");
    if (input.teamId && !await tx.team.findUnique({ where: { id: input.teamId }, select: { id: true } })) throw new MetaConnectionError("הצוות אינו קיים בעסק");
    if (input.action === "disconnect") {
      await tx.providerCredential.update({ where: { id }, data: { isActive: false, isDefault: false } });
      if (credential.isDefault) {
        const next = await tx.providerCredential.findFirst({ where: { isActive: true }, orderBy: { createdAt: "asc" } });
        if (next) await tx.providerCredential.update({ where: { id: next.id }, data: { isDefault: true } });
      }
    } else if (input.action === "default") {
      if (!credential.isActive || credential.sendingBlocked) throw new MetaConnectionError("יש לחבר ולאמת את המספר לפני בחירתו כברירת מחדל");
      await tx.providerCredential.updateMany({ where: { isDefault: true }, data: { isDefault: false } });
      await tx.providerCredential.update({ where: { id }, data: { isDefault: true } });
    } else {
      if (input.teamId !== undefined && input.teamId !== credential.teamId) await applyNumberTeam(tx, id, input.teamId);
      await tx.providerCredential.update({ where: { id }, data: { label: input.label, teamId: input.teamId } });
    }
    await tx.auditLog.create({ data: { businessId: requireBusinessId(), actorId: actorUserId, action: `provider.${input.action}`, entityType: "ProviderCredential", entityId: id, payload: { label: input.label ?? null, teamId: input.teamId ?? null } } });
  });
}
