/**
 * Meta WhatsApp messaging limit (official docs, Sept 2026): the number of UNIQUE WhatsApp users a business can deliver
 * messages to outside a customer-service window in a moving 24-hour window. It is set per business portfolio and
 * shared by all its numbers; tiers 250 → 2,000 → 10,000 → 100,000 → unlimited (read from
 * `whatsapp_business_manager_messaging_limit`; older accounts may still report TIER_1K).
 *
 * UltraCRM counts, conservatively, every contact that received a template (business-initiated) message in the last
 * 24 hours. A contact already counted does not use the limit again. Unknown tier on a real Meta connection → Meta's
 * starting limit (250). The simulation provider has no platform limit.
 */
import { prisma, type Db } from "@/lib/db";

const TIERS: Record<string, number | null> = { TIER_50: 50, TIER_250: 250, TIER_1K: 1000, TIER_2K: 2000, TIER_10K: 10000, TIER_100K: 100000, TIER_UNLIMITED: null };
export const META_START_LIMIT = 250;

/** Numeric limit of a tier string; null = unlimited; undefined = unknown. */
export function tierLimit(tier: string | null | undefined): number | null | undefined {
  if (!tier) return undefined;
  const k = tier.toUpperCase().replace(/\s/g, "");
  return k in TIERS ? TIERS[k] : undefined;
}

export interface WhatsAppCapacity { limit: number | null; tier: string | null; source: "meta" | "default"; used: number; remaining: number | null; recent: Set<string> }

/** Capacity for the business right now, or null when no real Meta connection is active (no platform limit). */
export async function whatsappCapacity(businessId: string, db: Db = prisma): Promise<WhatsAppCapacity | null> {
  const creds = await db.providerCredential.findMany({ where: { businessId, channel: "whatsapp", provider: "meta_whatsapp_cloud_api", isActive: true }, select: { messagingLimitTier: true } });
  if (!creds.length) return null;
  // Shared per portfolio: all numbers report the same tier – take the most permissive known value.
  const known = creds.map((c) => ({ tier: c.messagingLimitTier, limit: tierLimit(c.messagingLimitTier) })).filter((x) => x.limit !== undefined);
  const best = known.find((x) => x.limit === null) ?? known.sort((a, b) => (b.limit as number) - (a.limit as number))[0];
  const limit = best ? (best.limit as number | null) : META_START_LIMIT;
  const rows = await db.$queryRaw<Array<{ contact_id: string }>>`
    SELECT DISTINCT c.contact_id FROM messages m JOIN conversations c ON c.id = m.conversation_id
    WHERE m.business_id = ${businessId} AND m.direction = 'OUTBOUND' AND m.channel = 'whatsapp' AND m.template_id IS NOT NULL
      AND m.status NOT IN ('FAILED', 'CANCELLED') AND m.created_at > now() - interval '24 hours'`;
  const recent = new Set(rows.map((r) => r.contact_id));
  return { limit, tier: best?.tier ?? null, source: best ? "meta" : "default", used: recent.size, remaining: limit === null ? null : Math.max(0, limit - recent.size), recent };
}

/** Recipients per day the campaign can actually reach: the user's pace, capped by the Meta limit. */
export function effectivePerDay(throttle: { batchSize: number; intervalMinutes: number } | null, limit: number | null | undefined) {
  const pace = throttle ? Math.floor(throttle.batchSize * (1440 / throttle.intervalMinutes)) : Number.POSITIVE_INFINITY;
  return limit == null ? pace : Math.min(pace, limit);
}
