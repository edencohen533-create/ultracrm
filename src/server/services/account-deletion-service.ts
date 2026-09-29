/**
 * Self-service deletion (Meta / privacy requirement):
 *  • deleteMyUser – any user erases their personal details. The membership is deactivated and anonymised; the
 *    account itself (email, name, password) is erased when it belongs to no other active business. Business records
 *    stay (they belong to the business) without identifying the person. The last active owner cannot do this.
 *  • requestBusinessDeletion – the owner (typing the business name) schedules deletion of the business and ALL its
 *    data in 14 days. WhatsApp/SMS/email connections are disconnected and their tokens erased immediately.
 *    cancelBusinessDeletion undoes the schedule (connections must be reconnected).
 *  • purgeDueBusinesses – the daily retention job deletes businesses whose date has come, and accounts left with
 *    no business.
 */
import crypto from "node:crypto";
import { db } from "@/lib/db";
import { withoutBusiness } from "@/lib/tenant";
import { ApiError } from "@/lib/response";
import { audit } from "@/lib/audit";
import type { SessionUser } from "@/lib/auth";

export const BUSINESS_DELETION_DAYS = 14;

export async function deleteMyUser(user: SessionUser) {
  return withoutBusiness(async () => {
    if (user.role === "owner") {
      const owners = await db.user.count({ where: { businessId: user.businessId, role: "owner", isActive: true, id: { not: user.id } } });
      if (!owners) throw new ApiError("אתה הבעלים היחיד של העסק – העבר בעלות למשתמש אחר או מחק את העסק כולו", 409, "last_owner");
    }
    const anon = `deleted-${crypto.randomBytes(6).toString("hex")}`;
    await db.$transaction(async (tx) => {
      await tx.user.update({ where: { id: user.id }, data: { isActive: false, fullName: "משתמש שנמחק", email: `${anon}@deleted.invalid`, personalPhone: null } });
      // The user's own WhatsApp links (their phone number) are personal data – removed.
      for (const l of await tx.assistantLink.findMany({ where: { userId: user.id }, select: { id: true } })) await tx.assistantLink.update({ where: { id: l.id }, data: { status: "revoked", revokedAt: new Date(), phoneE164: `deleted-${l.id}`, context: {}, pendingReport: null } });
      const other = await tx.user.count({ where: { accountId: user.accountId, isActive: true, id: { not: user.id } } });
      if (!other) await tx.account.update({ where: { id: user.accountId }, data: { email: `${anon}@deleted.invalid`, fullName: "משתמש שנמחק", passwordHash: crypto.randomBytes(32).toString("hex"), sessionVersion: { increment: 1 } } });
      else await tx.account.update({ where: { id: user.accountId }, data: { sessionVersion: { increment: 1 } } });
      await audit(user.businessId, null, "user", user.id, "user.self_deleted", { accountErased: !other }, tx);
    });
    return { ok: true };
  });
}

async function eraseConnections(businessId: string) {
  const creds = await db.providerCredential.findMany({ where: { businessId }, select: { id: true } });
  await db.providerCredential.updateMany({ where: { businessId }, data: { isActive: false, isDefault: false, sendingBlocked: true, config: {}, metaUserIds: [], lastConnectionError: "העסק ממתין למחיקה" } });
  await db.metaAdConnection.deleteMany({ where: { businessId } });
  await db.whatsAppSignupSession.deleteMany({ where: { businessId } });
  return creds.length;
}

export async function requestBusinessDeletion(user: SessionUser, confirmName: string) {
  if (user.role !== "owner") throw new ApiError("רק בעל העסק יכול למחוק את העסק", 403, "forbidden");
  return withoutBusiness(async () => {
    const biz = await db.business.findUniqueOrThrow({ where: { id: user.businessId }, select: { name: true, deletionScheduledFor: true } });
    if (confirmName.trim() !== biz.name.trim()) throw new ApiError("שם העסק שהוקלד אינו תואם", 400, "confirm_mismatch");
    const when = biz.deletionScheduledFor ?? new Date(Date.now() + BUSINESS_DELETION_DAYS * 86400_000);
    await db.business.update({ where: { id: user.businessId }, data: { deletionRequestedAt: new Date(), deletionScheduledFor: when, deletionRequestedById: user.id } });
    const erased = await eraseConnections(user.businessId);
    await audit(user.businessId, user.id, "business", user.businessId, "business.deletion_requested", { scheduledFor: when.toISOString(), connectionsErased: erased }, db);
    return { scheduledFor: when, connectionsErased: erased };
  });
}

export async function cancelBusinessDeletion(user: SessionUser) {
  if (user.role !== "owner") throw new ApiError("רק בעל העסק יכול לבטל", 403, "forbidden");
  await withoutBusiness(async () => {
    await db.business.update({ where: { id: user.businessId }, data: { deletionRequestedAt: null, deletionScheduledFor: null, deletionRequestedById: null } });
    await audit(user.businessId, user.id, "business", user.businessId, "business.deletion_cancelled", {}, db);
  });
}

export async function businessDeletionStatus(businessId: string) {
  return withoutBusiness(() => db.business.findUniqueOrThrow({ where: { id: businessId }, select: { name: true, deletionRequestedAt: true, deletionScheduledFor: true } }));
}

/** Permanently delete businesses whose scheduled date passed (daily retention job). */
export async function purgeDueBusinesses(now = new Date()) {
  return withoutBusiness(async () => {
    const due = await db.business.findMany({ where: { deletionScheduledFor: { lte: now } }, select: { id: true, users: { select: { accountId: true } } } });
    let deleted = 0;
    for (const b of due) {
      // Each business on its own: one failure must not keep every other due business from being purged.
      try {
      const accountIds = [...new Set(b.users.map((u) => u.accountId))];
      await db.campaignRecipient.deleteMany({ where: { campaign: { businessId: b.id } } });
      await db.campaign.deleteMany({ where: { businessId: b.id } });
      await db.conversation.deleteMany({ where: { businessId: b.id } });
      await db.marketingSequence.deleteMany({ where: { businessId: b.id } });
      await db.providerWebhookEvent.deleteMany({ where: { businessId: b.id } });
      await db.providerCredential.deleteMany({ where: { businessId: b.id } });
      await db.business.delete({ where: { id: b.id } });
      // Accounts that belonged only to this business go too (personal data).
      for (const accountId of accountIds) if (!(await db.user.count({ where: { accountId } }))) await db.account.delete({ where: { id: accountId } }).catch(() => undefined);
      deleted++;
      } catch (e) { console.error("[purge] business failed", b.id, (e as Error).message); }
    }
    return deleted;
  });
}
