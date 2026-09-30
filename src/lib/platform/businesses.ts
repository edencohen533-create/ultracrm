/**
 * Platform management of customer businesses (platform admins only – every entry calls requirePlatformAdmin):
 *  • create a customer business: a NEW isolated business (own slug, default settings, no data, no connections,
 *    no secrets) with its owner invited by a one-time link (the owner sets their own password) – nothing is copied from
 *    any existing business;
 *  • management view WITHOUT content: owners, status, package, seats, usage counts, measured provider costs, the
 *    billing state from the source of truth (none connected → said so, no invented amounts), connection health (no
 *    secrets), support sessions and the audit trail. Conversations / customers are never listed here.
 */
import { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { withBusiness, withoutBusiness } from "@/lib/tenant";
import { ApiError } from "@/lib/response";
import type { SessionUser } from "@/lib/auth";
import { currentUsage } from "@/lib/modules";
import { QUOTA_METRICS } from "@/lib/access/catalog";
import { accessAudit, businessDetail, requirePlatformAdmin, type AccessStatus } from "@/lib/access/manage";
import { invalidateEntitlement } from "@/lib/access/engine";

const slugify = (name: string) => `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 30) || "biz"}-${Math.random().toString(36).slice(2, 8)}`;

export async function createCustomerBusiness(actor: SessionUser, input: { name: string; ownerName: string; ownerEmail: string; status: Extract<AccessStatus, "setup" | "trial" | "active">; trialUntil?: Date | null; planVersionId?: string | null; timezone?: string }) {
  await requirePlatformAdmin(actor);
  const name = input.name.trim(); const email = input.ownerEmail.trim().toLowerCase();
  if (name.length < 2) throw new ApiError("שם העסק קצר מדי", 400, "validation");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ApiError("אימייל הבעלים אינו תקין", 400, "validation");
  if (input.status === "trial" && !input.trialUntil) throw new ApiError("לניסיון יש לקבוע תאריך סיום", 400, "validation");
  const biz = await withoutBusiness(async () => {
    const pv = input.planVersionId ? await db.planVersion.findUnique({ where: { id: input.planVersionId }, select: { id: true, planId: true, plan: { select: { isArchived: true } } } }) : null;
    if (input.planVersionId && (!pv || pv.plan.isArchived)) throw new ApiError("החבילה לא נמצאה או שאינה פעילה", 400, "invalid_plan");
    // Never the legacy "no package = every module": paid modules stay OFF until a package / grant is assigned.
    return db.business.create({ data: { name, slug: slugify(name), timezone: input.timezone ?? "Asia/Jerusalem", modules: pv ? {} : { crm: true, telephony: false, whatsapp: false, sms: false, email: false }, settings: {} as Prisma.InputJsonValue, accessStatus: input.status, accessUntil: input.status === "trial" ? input.trialUntil ?? null : null, planVersionId: pv?.id ?? null, planId: pv?.planId ?? null } });
  });
  // The owner joins through the regular invite flow (inactive membership + one-time link; own password).
  const { inviteUser } = await import("@/server/services/invite-service");
  const invite = await withBusiness(biz.id, () => inviteUser(biz.id, null as unknown as string, { fullName: input.ownerName.trim() || email, email, role: "owner" }));
  invalidateEntitlement(biz.id);
  await accessAudit({ businessId: biz.id, actorAccountId: actor.accountId, action: "business.created", after: { name, ownerEmail: email, status: input.status, planVersionId: input.planVersionId ?? null } });
  return { business: { id: biz.id, name: biz.name, slug: biz.slug, accessStatus: biz.accessStatus }, inviteUrl: invite.inviteUrl, inviteExpiresAt: invite.inviteExpiresAt };
}

const monthStart = () => { const d = new Date(); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)); };

/** Management view of one business – counts and states only, never conversations / customers / secrets. */
export async function platformBusinessView(actor: SessionUser, businessId: string) {
  await requirePlatformAdmin(actor);
  const base = await businessDetail(businessId);
  return withoutBusiness(async () => {
    const since = monthStart();
    const [biz, owners, calls, talk, waOut, waIn, smsOut, emailOut, aiActions, coachCost, creds, numbers, stores, payments, hooks, failedHooks, supportSessions, platformAudit] = await Promise.all([
      db.business.findUniqueOrThrow({ where: { id: businessId }, select: { createdAt: true, statusReason: true, cancelledAt: true, deletionScheduledFor: true, timezone: true } }),
      db.user.findMany({ where: { businessId, role: "owner", isSupport: false }, select: { fullName: true, email: true, isActive: true, createdAt: true } }),
      db.call.count({ where: { businessId, createdAt: { gte: since } } }),
      db.call.aggregate({ where: { businessId, createdAt: { gte: since } }, _sum: { talkSeconds: true } }),
      db.message.count({ where: { businessId, channel: "whatsapp", direction: "OUTBOUND", createdAt: { gte: since } } }),
      db.message.count({ where: { businessId, channel: "whatsapp", direction: "INBOUND", createdAt: { gte: since } } }),
      db.message.count({ where: { businessId, channel: "sms", direction: "OUTBOUND", createdAt: { gte: since } } }),
      db.message.count({ where: { businessId, channel: "email", direction: "OUTBOUND", createdAt: { gte: since } } }),
      db.aiAction.count({ where: { businessId, createdAt: { gte: since } } }),
      db.coachSession.aggregate({ where: { businessId, lastSegmentAt: { gte: since } }, _sum: { costUsd: true } }),
      db.providerCredential.findMany({ where: { businessId }, select: { channel: true, provider: true, label: true, displayPhoneNumber: true, status: true, isActive: true, sendingBlocked: true, lastWebhookAt: true } }),
      db.phoneNumber.groupBy({ by: ["verificationStatus", "isActive"], where: { businessId }, _count: { _all: true } }),
      db.storeConnection.findMany({ where: { businessId }, select: { platform: true, name: true, isActive: true, apiStatus: true, webhookStatus: true, lastVerifiedEventAt: true, lastSyncAt: true, lastSyncError: true, _count: { select: { events: { where: { status: "failed" } } } } } }),
      db.paymentProviderConnection.findMany({ where: { businessId }, select: { provider: true, environment: true, isActive: true } }),
      db.webhookEndpoint.count({ where: { businessId, isActive: true } }),
      db.webhookDelivery.count({ where: { businessId, status: "failed" } }),
      db.supportSession.findMany({ where: { businessId }, orderBy: { startedAt: "desc" }, take: 20, select: { id: true, reason: true, startedAt: true, expiresAt: true, endedAt: true, endedReason: true, accountId: true } }),
      db.auditLog.findMany({ where: { businessId, action: { startsWith: "platform." } }, orderBy: { createdAt: "desc" }, take: 30, select: { action: true, payload: true, createdAt: true } }),
    ]);
    const quotas = [];
    for (const m of QUOTA_METRICS) quotas.push({ metric: m, used: await withBusiness(businessId, () => currentUsage(businessId, m)), limit: base.entitlement.quotas[m] ?? null });
    return {
      ...base,
      business: { ...base.business, createdAt: biz.createdAt, statusReason: biz.statusReason, cancelledAt: biz.cancelledAt, deletionScheduledFor: biz.deletionScheduledFor, timezone: biz.timezone },
      owners: owners.map((o) => ({ ...o, pendingInvite: !o.isActive })),
      usage: { period: since.toISOString().slice(0, 7), calls, talkMinutes: Math.round((talk._sum.talkSeconds ?? 0) / 60), whatsappOut: waOut, whatsappIn: waIn, smsOut, emailOut, aiActions, quotas },
      providerCosts: { aiCoachUsd: Number(coachCost._sum.costUsd ?? 0), note: "עלות ספק נמדדת כרגע רק לתמלול / אימון שיחות. עלויות טלפוניה, WhatsApp, SMS ואימייל אינן נמדדות במערכת." },
      billing: { status: base.business.billingStatus, integration: null, note: "אין אינטגרציית חיוב מחוברת – לא מוצגים סכומים שחויבו. מצב הגישה (למעלה) נפרד מהתשלום." },
      health: {
        channels: creds.map((c) => ({ channel: c.channel, provider: c.provider, label: c.label ?? c.displayPhoneNumber ?? null, status: c.status, isActive: c.isActive, sendingBlocked: c.sendingBlocked, lastWebhookAt: c.lastWebhookAt })),
        numbers: numbers.map((n) => ({ verificationStatus: n.verificationStatus, isActive: n.isActive, count: n._count._all })),
        stores: stores.map((s) => ({ platform: s.platform, name: s.name, isActive: s.isActive, apiStatus: s.apiStatus, webhookStatus: s.webhookStatus, lastVerifiedEventAt: s.lastVerifiedEventAt, lastSyncAt: s.lastSyncAt, lastSyncError: s.lastSyncError, failedEvents: s._count.events })),
        payments: payments.map((p) => ({ provider: p.provider, environment: p.environment, isActive: p.isActive })),
        outgoingWebhooks: { active: hooks, failedDeliveries: failedHooks },
      },
      supportSessions, platformAudit,
    };
  });
}

/** List for the platform screen (management fields only) with owners and dates. */
export async function platformBusinessList(actor: SessionUser) {
  await requirePlatformAdmin(actor);
  const { listBusinesses } = await import("@/lib/access/manage");
  const rows = await listBusinesses();
  return withoutBusiness(async () => {
    const [meta, owners] = await Promise.all([
      db.business.findMany({ where: { id: { in: rows.map((r) => r.id) } }, select: { id: true, createdAt: true, statusReason: true } }),
      db.user.findMany({ where: { businessId: { in: rows.map((r) => r.id) }, role: "owner", isSupport: false }, orderBy: { createdAt: "asc" }, select: { businessId: true, fullName: true, email: true, isActive: true } }),
    ]);
    return rows.map((r) => ({ ...r, createdAt: meta.find((m) => m.id === r.id)?.createdAt ?? null, statusReason: meta.find((m) => m.id === r.id)?.statusReason ?? null, owner: owners.find((o) => o.businessId === r.id) ?? null }));
  });
}
