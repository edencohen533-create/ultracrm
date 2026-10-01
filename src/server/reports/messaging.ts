/**
 * "ביצועי דיוור" (Marketing & sales): outbound messages per sender (number / sender identity) and channel, by delivery
 * status, for a period in the business's timezone. Moved here from the old Analytics tab with the same status
 * definitions. A status a channel cannot report is null ("לא זמין"), never 0: SMS and email have no read receipts
 * (email opens are a separate signal, not READ).
 */
import { Prisma } from "@/generated/prisma/client";
import { prisma, dbSchema } from "@/lib/db";
import type { SessionUser } from "@/lib/auth";
import { ApiError } from "@/lib/response";
import { getBusinessSettings } from "@/lib/settings";
import { resolvePeriods } from "@/lib/reports/compare";

type Channel = "whatsapp" | "sms" | "email";
/** What each channel's provider reports back. */
export const CHANNEL_CAPS: Record<Channel, { delivered: boolean; read: boolean }> = { whatsapp: { delivered: true, read: true }, sms: { delivered: true, read: false }, email: { delivered: true, read: false } };
const T = (t: string) => Prisma.raw(`"${dbSchema()}"."${t}"`);

export interface SenderRow { id: string; label: string; channel: Channel; isActive: boolean; sent: number; delivered: number | null; read: number | null; failed: number; unknown: number; pending: number }

/** Channels the business has and the user may view (server-side, per channel). */
async function messagingChannels(user: SessionUser): Promise<Channel[]> {
  const { effectiveAccess, can, businessCanUse } = await import("@/lib/access/engine");
  const a = await effectiveAccess(user.businessId, user.id);
  const out: Channel[] = [];
  for (const ch of ["whatsapp", "sms", "email"] as const) if ((await businessCanUse(user.businessId, ch as never).catch(() => false)) && can(a, `${ch}.view` as never)) out.push(ch);
  return out;
}

export async function messagingPerformance(user: SessionUser, q: { from: string; to: string }) {
  const tz = (await getBusinessSettings(user.businessId)).timezone;
  let p;
  try { p = resolvePeriods({ tz, from: q.from, to: q.to, compare: "none" }).current; } catch (e) { throw new ApiError((e as Error).message, 400, "bad_range"); }
  const channels = await messagingChannels(user);
  if (!channels.length) return { from: p.from, to: p.to, timezone: tz, partial: p.partial, channels, caps: CHANNEL_CAPS, rows: [] as SenderRow[], totals: [] as SenderRow[] };
  const end = new Date(p.end.getTime() - 1);
  const raw = await prisma.$queryRaw<Array<{ cred: string; channel: Channel; status: string; n: number }>>(Prisma.sql`
    SELECT m.provider_credential_id AS cred, m.channel::text AS channel, m.status::text AS status, count(*)::int AS n
    FROM ${T("messages")} m
    WHERE m.business_id = ${user.businessId} AND m.direction = 'OUTBOUND' AND m.provider_credential_id IS NOT NULL
      AND m.created_at >= ${p.start} AND m.created_at <= ${end} AND m.channel::text = ANY(${channels})
    GROUP BY 1, 2, 3`);
  const creds = await prisma.providerCredential.findMany({ where: { businessId: user.businessId, id: { in: [...new Set(raw.map((r) => r.cred))] } }, select: { id: true, label: true, displayPhoneNumber: true, channel: true, isActive: true } });
  const build = (id: string, label: string, channel: Channel, isActive: boolean, rows: typeof raw): SenderRow => {
    const c = (s: string[]) => rows.filter((r) => s.includes(r.status)).reduce((t, r) => t + r.n, 0);
    const cap = CHANNEL_CAPS[channel];
    // Same definitions as the old Analytics table: sent = accepted by the provider or later; failed = failed / bounced.
    return { id, label, channel, isActive, sent: c(["ACCEPTED", "SENT", "DELIVERED", "READ"]), delivered: cap.delivered ? c(["DELIVERED", "READ"]) : null, read: cap.read ? c(["READ"]) : null, failed: c(["FAILED", "BOUNCED"]), unknown: c(["UNKNOWN"]), pending: c(["QUEUED"]) };
  };
  const rows = creds.map((c) => build(c.id, c.label || c.displayPhoneNumber || `ללא שם · ${c.id.slice(-6)}`, (raw.find((r) => r.cred === c.id)?.channel ?? c.channel) as Channel, c.isActive, raw.filter((r) => r.cred === c.id)))
    .sort((a, b) => a.channel.localeCompare(b.channel) || b.sent - a.sent);
  const known = new Set(creds.map((c) => c.id));
  const totals = channels.map((ch) => build(`total:${ch}`, ch, ch, true, raw.filter((r) => r.channel === ch && known.has(r.cred))));
  return { from: p.from, to: p.to, timezone: tz, partial: p.partial, channels, caps: CHANNEL_CAPS, rows, totals };
}
