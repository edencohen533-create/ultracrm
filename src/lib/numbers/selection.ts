/**
 * Outbound caller-id selection, executed INSIDE the call-creation transaction under the
 * business number-pool lock, so parallel agents never exceed per-number limits.
 *
 * Policy per dial list (campaign): fixed | agent | round_robin | load.
 *  • Only owned, active, not paused, provider-verified (≤24h) numbers are eligible – no caller-id spoofing.
 *  • A lead keeps the number it was last called from when that number is still eligible (sticky).
 *  • Fixed/agent policies stop instead of silently switching to another number.
 *  • A spam-marked prior number requires manager review before continuing with that lead – rotation is
 *    never used to get around a spam mark.
 *  • DNC / suppression apply before this step and cover every number of the business.
 */
import { z } from "zod";
import { Prisma } from "@/generated/prisma/client";
import { ApiError } from "@/lib/response";
import { businessDayStart } from "@/lib/business-day";
import { numberConfig } from "./providers";

export const numberPolicySchema = z.object({ mode: z.enum(["fixed", "agent", "round_robin", "load"]).default("fixed"), numberIds: z.array(z.string()).max(100).default([]) });
export type NumberPolicy = z.infer<typeof numberPolicySchema>;
export const VERIFICATION_TTL_MS = 24 * 3600_000;

export async function lockNumberPool(tx: Prisma.TransactionClient, businessId: string) {
  await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${"number-pool:" + businessId}, 0))`);
}

export function connectionFresh(connection: { status: string; fingerprint: string | null; checkedAt: Date | null } | null, businessId: string) {
  const cfg = numberConfig(businessId);
  return Boolean(cfg.configured && connection?.status === "verified" && connection.fingerprint === cfg.fingerprint && connection.checkedAt && Date.now() - connection.checkedAt.getTime() < VERIFICATION_TTL_MS);
}

export async function selectOutboundNumber(tx: Prisma.TransactionClient, input: { businessId: string; userId: string; listId?: string | null; phoneNumberId?: string | null; toE164: string; simulation: boolean }) {
  await lockNumberPool(tx, input.businessId);
  const list = input.listId ? await tx.dialList.findFirst({ where: { id: input.listId, businessId: input.businessId } }) : null;
  const policy = numberPolicySchema.parse(list?.numberPolicy ?? {});
  if (list && input.phoneNumberId && policy.mode !== "fixed") throw new ApiError("בחירת המספר נקבעת לפי מדיניות הקמפיין", 409, "campaign_number_policy");
  if (list?.phoneNumberId && input.phoneNumberId && list.phoneNumberId !== input.phoneNumberId) throw new ApiError("המספר אינו תואם לקמפיין", 409, "campaign_number_policy");
  const explicit = input.phoneNumberId ?? (policy.mode === "fixed" ? list?.phoneNumberId : null);
  const all = await tx.phoneNumber.findMany({ where: { businessId: input.businessId }, orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }, { id: "asc" }] });
  if (input.phoneNumberId && !all.some((n) => n.id === input.phoneNumberId)) throw new ApiError("מספר יוצא לא מורשה", 400, "invalid_from_number");
  let pool = all.filter((n) => (explicit ? n.id === explicit : (!policy.numberIds.length || policy.numberIds.includes(n.id))));
  if (policy.mode === "agent") pool = pool.filter((n) => n.assignedUserId === input.userId);
  // Fixed policies stop when their designated number is unavailable; only rotation policies may pick another pool member.
  if (policy.mode === "fixed" || policy.mode === "agent") pool = pool.slice(0, 1);
  if (!input.simulation) {
    const connection = await tx.numberConnection.findUnique({ where: { businessId: input.businessId } });
    if (!connectionFresh(connection, input.businessId)) throw new ApiError("יש לאמת מחדש את חיבור המספרים לספק לפני חיוג אמיתי", 409, "number_connection_stale");
    const settings = (await tx.business.findUniqueOrThrow({ where: { id: input.businessId } })).settings as Record<string, unknown>;
    if (typeof settings.numberProviderChannelLimit === "number" && settings.numberProviderChannelLimit > 0 && await tx.call.count({ where: { businessId: input.businessId, endedAt: null } }) >= settings.numberProviderChannelLimit) throw new ApiError("מגבלת השיחות המקבילות של הספק הושגה", 409, "provider_channel_limit");
  }
  const business = await tx.business.findUniqueOrThrow({ where: { id: input.businessId } });
  const start = businessDayStart(business.timezone, new Date());
  const counts = await tx.call.groupBy({ by: ["phoneNumberId"], where: { businessId: input.businessId, direction: "outbound", createdAt: { gte: start } }, _count: { _all: true } });
  const live = await tx.call.groupBy({ by: ["phoneNumberId"], where: { businessId: input.businessId, endedAt: null }, _count: { _all: true } });
  const daily = new Map(counts.map((n) => [n.phoneNumberId, n._count._all])), active = new Map(live.map((n) => [n.phoneNumberId, n._count._all]));
  const eligible = pool.filter((n) => n.isActive && !n.outboundPaused
    && (input.simulation || (n.verificationStatus === "verified" && n.verifiedAt && Date.now() - n.verifiedAt.getTime() < VERIFICATION_TTL_MS))
    && (!n.maxConcurrent || (active.get(n.id) ?? 0) < n.maxConcurrent)
    && (!n.maxDailyAttempts || (daily.get(n.id) ?? 0) < n.maxDailyAttempts));
  if (!eligible.length) throw new ApiError("אין מספר יוצא כשיר: בדוק שיוך, השהיה, אימות בעלות ומגבלות שימוש", 409, "no_eligible_number");
  // Never use spam status to trigger replacement. If the lead's established number is reported as spam,
  // require human review instead of rotating that lead to a new caller id.
  const previous = await tx.call.findFirst({ where: { businessId: input.businessId, direction: "outbound", toE164: input.toE164, phoneNumberId: { not: null } }, orderBy: { createdAt: "desc" } });
  const prior = all.find((n) => n.id === previous?.phoneNumberId);
  if (prior?.reputationStatus === "spam" && prior.reputationReview !== "resolved") throw new ApiError("המספר ששימש לליד מסומן כספאם; נדרשת בדיקת מנהל לפני המשך", 409, "reputation_review_required");
  const sticky = eligible.find((n) => n.id === previous?.phoneNumberId);
  let selected = sticky; let reason = sticky ? "sticky_lead" : policy.mode;
  if (!selected) {
    if (policy.mode === "round_robin") eligible.sort((a, b) => (a.lastSelectedAt?.getTime() ?? 0) - (b.lastSelectedAt?.getTime() ?? 0) || a.id.localeCompare(b.id));
    if (policy.mode === "load") eligible.sort((a, b) => (active.get(a.id) ?? 0) / (a.maxConcurrent ?? 1) - (active.get(b.id) ?? 0) / (b.maxConcurrent ?? 1) || (daily.get(a.id) ?? 0) - (daily.get(b.id) ?? 0) || a.id.localeCompare(b.id));
    selected = eligible[0]; if (explicit) reason = "fixed";
  }
  await tx.phoneNumber.update({ where: { id: selected.id }, data: { lastSelectedAt: new Date() } });
  return { number: selected, reason };
}
