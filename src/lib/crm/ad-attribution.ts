/** Snapshot submitted identifiers; campaign names and UTM labels never imply an ad ID. */
export function adAttribution(fields: unknown) {
  const f =
    fields && typeof fields === "object"
      ? (fields as Record<string, unknown>)
      : {};
  const id = (...keys: string[]) => {
    for (const key of keys) {
      const v = f[key];
      if (typeof v === "string" && /^\d{3,30}$/.test(v)) return v;
    }
    return null;
  };
  return {
    adId: id("metaAdId", "ad_id", "facebook_ad_id"),
    adsetId: id("adset_id", "metaAdsetId"),
    campaignId: id("campaign_id", "metaCampaignId"),
    leadgenId: id("leadgen_id"),
    sourceType: id("leadgen_id") ? "lead_ads_submitted" : "submitted",
    verifiedByMeta: false,
  };
}
