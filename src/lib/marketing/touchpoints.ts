/**
 * Inquiry touchpoints – where each inquiry came from, recorded at intake (API / forms, screen, import, click-to-WhatsApp
 * referral) and never overwritten: the first touchpoint of a contact is its acquisition source, each later one is the
 * source of that new inquiry. Only stable identifiers attribute to an ad (Meta ad / ad set / campaign ids, numeric);
 * a campaign or ad NAME, a UTM label or a click id alone never implies an ad (basis says what the row can rely on).
 */
import { z } from "zod";
import type { Prisma } from "@/generated/prisma/client";

const META_ID = /^\d{3,30}$/;
const str = (v: unknown, max = 300) => (typeof v === "string" || typeof v === "number") && String(v).trim() ? String(v).trim().slice(0, max) : undefined;
const metaId = (v: unknown) => { const s = str(v, 40)?.replace(/^act_/, ""); return s && META_ID.test(s) ? s : undefined; };

export const CHANNELS = ["meta_lead_form", "landing_page", "whatsapp_ad", "whatsapp", "api", "import", "manual", "store", "other"] as const;
export type Channel = (typeof CHANNELS)[number];

export const touchInputSchema = z.object({
  channel: z.enum(CHANNELS).optional(),
  source: z.string().max(100).optional(), medium: z.string().max(100).optional(),
  adAccountId: z.string().max(40).optional(), campaignId: z.string().max(40).optional(), adsetId: z.string().max(40).optional(), adId: z.string().max(40).optional(),
  formId: z.string().max(40).optional(), metaLeadId: z.string().max(40).optional(),
  utm: z.object({ source: z.string().max(200).optional(), medium: z.string().max(200).optional(), campaign: z.string().max(300).optional(), content: z.string().max(300).optional(), term: z.string().max(300).optional() }).partial().optional(),
  landingUrl: z.string().max(2000).optional(), referrer: z.string().max(2000).optional(),
  fbclid: z.string().max(500).optional(), fbc: z.string().max(500).optional(), gclid: z.string().max(500).optional(), ctwaClid: z.string().max(500).optional(),
  occurredAt: z.coerce.date().optional(),
}).partial();
export type TouchInput = z.infer<typeof touchInputSchema>;

/** Flat keys as forms / Make / Zapier / Meta URL parameters send them (ad_id, adset_id, campaign_id, leadgen_id, utm_*…). */
export function touchFromFields(fields: unknown): TouchInput {
  const f = fields && typeof fields === "object" ? (fields as Record<string, unknown>) : {};
  const pick = (...keys: string[]) => { for (const k of keys) { const v = str(f[k], 2000); if (v) return v; } return undefined; };
  return {
    adId: pick("ad_id", "adId", "metaAdId", "facebook_ad_id", "fb_ad_id"), adsetId: pick("adset_id", "adsetId", "ad_set_id", "metaAdsetId"), campaignId: pick("campaign_id", "campaignId", "metaCampaignId"),
    adAccountId: pick("ad_account_id", "adAccountId", "account_id"), formId: pick("form_id", "formId"), metaLeadId: pick("leadgen_id", "leadgenId", "meta_lead_id"),
    utm: { source: pick("utm_source"), medium: pick("utm_medium"), campaign: pick("utm_campaign"), content: pick("utm_content"), term: pick("utm_term") },
    landingUrl: pick("landing_url", "landingUrl", "page_url", "pageUrl"), referrer: pick("referrer", "referer"),
    fbclid: pick("fbclid"), fbc: pick("fbc", "_fbc"), gclid: pick("gclid"),
  };
}

const clean = <T extends Record<string, unknown>>(o: T) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== "")) as Partial<T>;

/** Validated touchpoint fields: ids must be numeric Meta ids; channel / basis from what is really there. */
export function normalizeTouch(t: TouchInput, fallback: Channel) {
  const ids = { adAccountId: metaId(t.adAccountId), campaignId: metaId(t.campaignId), adsetId: metaId(t.adsetId), adId: metaId(t.adId), formId: metaId(t.formId), metaLeadId: metaId(t.metaLeadId) };
  const utm = clean({ source: str(t.utm?.source, 200), medium: str(t.utm?.medium, 200), campaign: str(t.utm?.campaign), content: str(t.utm?.content), term: str(t.utm?.term) });
  const clickIds = clean({ fbclid: str(t.fbclid, 500), fbc: str(t.fbc, 500), gclid: str(t.gclid, 500), ctwa_clid: str(t.ctwaClid, 500) });
  let landingUrl = str(t.landingUrl, 2000); if (landingUrl) { try { const u = new URL(landingUrl); landingUrl = /^https?:$/.test(u.protocol) ? u.href : undefined; } catch { landingUrl = undefined; } }
  const hasMeta = Boolean(ids.adId || ids.adsetId || ids.campaignId);
  const channel: Channel = t.channel ?? (ids.metaLeadId || ids.formId ? "meta_lead_form" : landingUrl || Object.keys(utm).length ? "landing_page" : fallback);
  const basis = hasMeta ? "meta_ids" : Object.keys(utm).length ? "utm_only" : Object.keys(clickIds).length ? "click_id_only" : "none";
  return { channel, source: str(t.source, 100) ?? null, medium: str(t.medium, 100) ?? null, ...Object.fromEntries(Object.entries(ids).map(([k, v]) => [k, v ?? null])) as Record<keyof typeof ids, string | null>, utm, clickIds, landingUrl: landingUrl ?? null, referrer: str(t.referrer, 2000) ?? null, basis };
}

type Tx = Pick<Prisma.TransactionClient, "leadTouchpoint">;

/** Record an inquiry. Idempotent per dedupe key (the same Meta lead / message / lead id delivered twice = one row). */
export async function recordTouchpoint(db: Tx, input: { businessId: string; contactId: string; leadId?: string | null; touch: TouchInput; fallback: Channel; dataSource: string; dedupeKey?: string | null; occurredAt?: Date }) {
  const n = normalizeTouch(input.touch, input.fallback);
  const data = { businessId: input.businessId, contactId: input.contactId, leadId: input.leadId ?? null, ...n, utm: n.utm as Prisma.InputJsonValue, clickIds: n.clickIds as Prisma.InputJsonValue, dataSource: input.dataSource, dedupeKey: input.dedupeKey ?? null, occurredAt: input.occurredAt ?? input.touch.occurredAt ?? new Date() };
  if (!data.dedupeKey) return db.leadTouchpoint.create({ data });
  const existing = await db.leadTouchpoint.findUnique({ where: { businessId_dedupeKey: { businessId: input.businessId, dedupeKey: data.dedupeKey } } });
  return existing ?? db.leadTouchpoint.create({ data });
}

/** What a lead keeps as its own source snapshot (lead.sourceAttribution) – ids as received, never looked up by name. */
export function touchSnapshot(t: TouchInput, fallback: Channel) {
  const n = normalizeTouch(t, fallback);
  return { adId: n.adId, adsetId: n.adsetId, campaignId: n.campaignId, adAccountId: n.adAccountId, formId: n.formId, leadgenId: n.metaLeadId, channel: n.channel, basis: n.basis, utm: n.utm, sourceType: n.metaLeadId ? "lead_ads_submitted" : "submitted", verifiedByMeta: false };
}

export const hasTouchData = (t: TouchInput) => normalizeTouch(t, "other").basis !== "none" || Boolean(t.channel);

/**
 * Historical completion: every lead from before touchpoints existed gets one, at its creation time, from what the lead
 * itself stored (its source snapshot of submitted ids, its source text). No lookup by name / date – a lead without
 * saved ids stays "not attributed". Idempotent (dedupe key lead:<id>), batched.
 */
export async function backfillLeadTouchpoints(businessId: string, limit = 5000) {
  const { prisma } = await import("@/lib/db");
  const leads = await prisma.lead.findMany({ where: { businessId, touchpoints: { none: {} } }, orderBy: { createdAt: "asc" }, take: limit, select: { id: true, contactId: true, createdAt: true, source: true, sourceAttribution: true } });
  if (!leads.length) return 0;
  const rows = leads.map((l) => {
    const snap = (l.sourceAttribution ?? {}) as Record<string, unknown>;
    const n = normalizeTouch({ adId: str(snap.adId), adsetId: str(snap.adsetId), campaignId: str(snap.campaignId), adAccountId: str(snap.adAccountId), formId: str(snap.formId), metaLeadId: str(snap.leadgenId), source: l.source ?? undefined }, "other");
    return { businessId, contactId: l.contactId, leadId: l.id, ...n, utm: n.utm as Prisma.InputJsonValue, clickIds: n.clickIds as Prisma.InputJsonValue, dataSource: "backfill_lead", dedupeKey: `lead:${l.id}`, occurredAt: l.createdAt };
  });
  const r = await prisma.leadTouchpoint.createMany({ data: rows, skipDuplicates: true });
  return r.count;
}
