/**
 * Meta Ads sync (read only) per connected ad account:
 *  • history: from `syncFrom` forward in 7-day chunks; `syncedThrough` moves only after a chunk is stored, so a
 *    failure resumes from the same place and days outside [syncFrom, syncedThrough] are "missing", never zero;
 *  • refresh: once caught up, the last 3 days every hour and the last 14 days once a day (Meta restates recent days);
 *  • delivery is fetched at AD level only (`level=ad`, `time_increment=1`) and a re-fetched range REPLACES its rows –
 *    campaign / ad set totals are sums of their ads, so spend is never counted twice;
 *  • structure (campaign / ad set / ad names, status, thumbnail) every 6 hours; renamed objects keep their history;
 *  • throttling → the account waits (Meta's estimate, else exponential backoff); an auth failure marks the connection
 *    so the manager reconnects; a missing permission on an account marks only that account.
 */
import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { openSecret } from "@/lib/crypto";
import { getBusinessSettings } from "@/lib/settings";
import { zonedParts } from "@/lib/business-day";
import { addDays } from "@/lib/reports/compare";
import { adsGetAll, AdsApiError, metaLeadsOf } from "./meta-api";
import { markAuthProblem } from "./meta-connection";

const CHUNK_DAYS = 7;
const day = (d: Date) => d.toISOString().slice(0, 10);
const asDate = (s: string) => new Date(`${s}T00:00:00.000Z`);

interface InsightRow { date_start: string; ad_id: string; ad_name?: string; adset_id: string; adset_name?: string; campaign_id: string; campaign_name?: string; spend?: string; impressions?: string; clicks?: string; inline_link_clicks?: string; actions?: Array<{ action_type?: string; value?: string }>; account_currency?: string }

type Account = Awaited<ReturnType<typeof prisma.metaAdAccount.findFirstOrThrow>>;

async function todayFor(a: Account) { return zonedParts(a.timezoneName ?? (await getBusinessSettings(a.businessId)).timezone, new Date()).date; }

/** Names / structure seen for an object; a changed name is appended to its history. */
async function upsertEntity(a: Account, level: "campaign" | "adset" | "ad", externalId: string, fields: { name?: string; campaignExternalId?: string | null; adsetExternalId?: string | null; effectiveStatus?: string | null; thumbnailUrl?: string | null; previewUrl?: string | null }) {
  const cur = await prisma.metaAdEntity.findUnique({ where: { businessId_level_externalId: { businessId: a.businessId, level, externalId } } });
  const name = (fields.name ?? cur?.name ?? externalId).slice(0, 300);
  const history = (cur?.nameHistory as Array<{ name: string; until: string }> | null) ?? [];
  const data = { name, adAccountRowId: a.id, lastSeenAt: new Date(), ...(fields.campaignExternalId !== undefined ? { campaignExternalId: fields.campaignExternalId } : {}), ...(fields.adsetExternalId !== undefined ? { adsetExternalId: fields.adsetExternalId } : {}), ...(fields.effectiveStatus !== undefined ? { effectiveStatus: fields.effectiveStatus } : {}), ...(fields.thumbnailUrl !== undefined ? { thumbnailUrl: fields.thumbnailUrl } : {}), ...(fields.previewUrl !== undefined ? { previewUrl: fields.previewUrl } : {}) };
  if (!cur) return prisma.metaAdEntity.create({ data: { businessId: a.businessId, level, externalId, ...data } });
  return prisma.metaAdEntity.update({ where: { id: cur.id }, data: { ...data, ...(fields.name && fields.name !== cur.name ? { nameHistory: [...history, { name: cur.name, until: new Date().toISOString() }].slice(-20) } : {}) } });
}

const safeUrl = (v: unknown) => { if (typeof v !== "string") return null; try { const u = new URL(v); return u.protocol === "https:" && /(^|\.)(fbcdn\.net|facebook\.com|fb\.me|fbsbx\.com|instagram\.com)$/.test(u.hostname) ? u.href : null; } catch { return null; } };

async function syncStructure(a: Account, token: string) {
  const act = `act_${a.accountId}`;
  const [campaigns, adsets, ads] = [
    await adsGetAll<{ id: string; name?: string; effective_status?: string }>(`${act}/campaigns`, token, { fields: "id,name,effective_status", limit: "200" }),
    await adsGetAll<{ id: string; name?: string; effective_status?: string; campaign_id?: string }>(`${act}/adsets`, token, { fields: "id,name,effective_status,campaign_id", limit: "200" }),
    await adsGetAll<{ id: string; name?: string; effective_status?: string; campaign_id?: string; adset_id?: string; preview_shareable_link?: string; creative?: { thumbnail_url?: string; image_url?: string } }>(`${act}/ads`, token, { fields: "id,name,effective_status,campaign_id,adset_id,preview_shareable_link,creative{thumbnail_url,image_url}", limit: "200" }),
  ];
  for (const c of campaigns) await upsertEntity(a, "campaign", c.id, { name: c.name, effectiveStatus: c.effective_status ?? null });
  for (const s of adsets) await upsertEntity(a, "adset", s.id, { name: s.name, effectiveStatus: s.effective_status ?? null, campaignExternalId: s.campaign_id ?? null });
  for (const d of ads) await upsertEntity(a, "ad", d.id, { name: d.name, effectiveStatus: d.effective_status ?? null, campaignExternalId: d.campaign_id ?? null, adsetExternalId: d.adset_id ?? null, thumbnailUrl: safeUrl(d.creative?.thumbnail_url ?? d.creative?.image_url), previewUrl: safeUrl(d.preview_shareable_link) });
  await prisma.metaAdAccount.update({ where: { id: a.id }, data: { structureSyncedAt: new Date() } });
  return campaigns.length + adsets.length + ads.length;
}

/** Fetch [from, to] at ad level and replace the stored rows of that range (idempotent; restated days are corrected). */
export async function syncRange(a: Account, token: string, from: string, to: string) {
  const rows = await adsGetAll<InsightRow>(`act_${a.accountId}/insights`, token, {
    level: "ad", time_increment: "1", time_range: JSON.stringify({ since: from, until: to }), use_unified_attribution_setting: "true", limit: "500",
    fields: "date_start,ad_id,ad_name,adset_id,adset_name,campaign_id,campaign_name,spend,impressions,clicks,inline_link_clicks,actions,account_currency",
  }, 200);
  const currency = rows.find((r) => r.account_currency)?.account_currency ?? a.currency ?? "USD";
  const data = rows.map((r) => ({
    businessId: a.businessId, adAccountRowId: a.id, date: asDate(r.date_start), campaignId: r.campaign_id, adsetId: r.adset_id, adId: r.ad_id,
    spend: new Prisma.Decimal(r.spend ?? "0"), impressions: Number(r.impressions ?? 0), clicks: Number(r.clicks ?? 0), linkClicks: Number(r.inline_link_clicks ?? 0), metaLeads: metaLeadsOf(r.actions), currency: r.account_currency ?? currency,
  }));
  // Same (ad, day) twice in one answer would be a Meta paging overlap – keep one.
  const unique = [...new Map(data.map((d) => [`${d.adId}:${day(d.date)}`, d])).values()];
  await prisma.$transaction(async (tx) => {
    await tx.metaAdInsightDaily.deleteMany({ where: { adAccountRowId: a.id, date: { gte: asDate(from), lte: asDate(to) } } });
    if (unique.length) await tx.metaAdInsightDaily.createMany({ data: unique });
  });
  // Names from delivery rows cover ads that were deleted since (the structure edges list only live objects).
  const seen = new Map<string, InsightRow>(); for (const r of rows) seen.set(r.ad_id, r);
  for (const r of seen.values()) {
    const known = await prisma.metaAdEntity.findUnique({ where: { businessId_level_externalId: { businessId: a.businessId, level: "ad", externalId: r.ad_id } }, select: { id: true } });
    if (!known) {
      await upsertEntity(a, "campaign", r.campaign_id, { name: r.campaign_name });
      await upsertEntity(a, "adset", r.adset_id, { name: r.adset_name, campaignExternalId: r.campaign_id });
      await upsertEntity(a, "ad", r.ad_id, { name: r.ad_name, campaignExternalId: r.campaign_id, adsetExternalId: r.adset_id });
    }
  }
  if (!a.currency && currency) await prisma.metaAdAccount.update({ where: { id: a.id }, data: { currency } });
  return unique.length;
}

/** One unit of work for an account (a history chunk, or a refresh). Returns what was done. */
export async function syncAccountStep(accountRowId: string, opts: { force?: boolean } = {}) {
  const a = await prisma.metaAdAccount.findUniqueOrThrow({ where: { id: accountRowId } });
  if (a.status === "disconnected" || a.status === "auth_error" || a.status === "no_access") return { skipped: a.status };
  if (!opts.force && a.nextSyncAt && a.nextSyncAt > new Date()) return { skipped: "waiting" };
  const conn = await prisma.metaAdConnection.findUnique({ where: { businessId: a.businessId } });
  const token = conn && conn.status === "active" ? openSecret(conn.tokenSealed) : undefined;
  if (!token) { await prisma.metaAdAccount.update({ where: { id: a.id }, data: { status: "auth_error", lastSyncStatus: "auth_error", lastSyncError: "אין חיבור Meta פעיל" } }); return { skipped: "no_token" }; }

  const today = await todayFor(a);
  const syncFrom = a.syncFrom ? day(a.syncFrom) : addDays(today, -30);
  let from: string; let to: string; let kind: string;
  if (!a.syncedThrough || day(a.syncedThrough) < today) {
    from = a.syncedThrough ? addDays(day(a.syncedThrough), 1) : syncFrom;
    to = [addDays(from, CHUNK_DAYS - 1), today].sort()[0];
    kind = "history";
  } else {
    const hourAgo = Date.now() - 3600_000; const dayAgo = Date.now() - 86400_000;
    const lastRefresh = await prisma.metaSyncRun.findFirst({ where: { adAccountRowId: a.id, kind: "refresh14", status: "ok" }, orderBy: { startedAt: "desc" }, select: { startedAt: true } });
    if (!lastRefresh || lastRefresh.startedAt.getTime() < dayAgo) { from = [addDays(today, -13), syncFrom].sort().reverse()[0]; kind = "refresh14"; }
    else if (opts.force || !a.lastSyncAt || a.lastSyncAt.getTime() < hourAgo) { from = [addDays(today, -2), syncFrom].sort().reverse()[0]; kind = "refresh3"; }
    else return { skipped: "fresh" };
    to = today;
  }
  const run = await prisma.metaSyncRun.create({ data: { businessId: a.businessId, adAccountRowId: a.id, kind, rangeFrom: asDate(from), rangeTo: asDate(to) } });
  try {
    if (!a.structureSyncedAt || Date.now() - a.structureSyncedAt.getTime() > 6 * 3600_000) await syncStructure(a, token);
    const rows = await syncRange(a, token, from, to);
    const through = kind === "history" ? to : a.syncedThrough ? day(a.syncedThrough) : to;
    await prisma.metaAdAccount.update({ where: { id: a.id }, data: { syncedThrough: asDate(through), lastSyncAt: new Date(), lastSyncStatus: "ok", lastSyncError: null, failures: 0, nextSyncAt: null, status: "active" } });
    await prisma.metaSyncRun.update({ where: { id: run.id }, data: { status: "ok", rows, finishedAt: new Date() } });
    return { kind, from, to, rows };
  } catch (e) {
    const err = e instanceof AdsApiError ? e : new AdsApiError((e as Error).message, "transient", null);
    const failures = a.failures + 1;
    if (err.kind === "auth") await markAuthProblem(a.businessId, err.message);
    else {
      const waitSec = err.kind === "throttle" ? Math.max(err.retryAfterSec ?? 0, 300 * 2 ** Math.min(failures - 1, 4)) : 60 * 2 ** Math.min(failures - 1, 6);
      await prisma.metaAdAccount.update({ where: { id: a.id }, data: {
        status: err.kind === "permission" ? "no_access" : err.kind === "throttle" ? "throttled" : "active",
        lastSyncStatus: err.kind === "throttle" ? "throttled" : err.kind === "permission" ? "no_access" : "failed", lastSyncError: err.message.slice(0, 300), failures, nextSyncAt: new Date(Date.now() + waitSec * 1000),
      } });
    }
    await prisma.metaSyncRun.update({ where: { id: run.id }, data: { status: err.kind === "throttle" ? "throttled" : err.kind === "auth" ? "auth_error" : "failed", error: err.message.slice(0, 300), finishedAt: new Date() } });
    return { kind, from, to, error: err.kind, message: err.message };
  }
}

/** Cron: work through every business's due accounts within a time budget (history chunks keep going while time is left). */
export async function runMetaSync(opts: { deadline: number; businessId?: string }) {
  const { withBusiness } = await import("@/lib/tenant");
  const accounts = await prisma.metaAdAccount.findMany({ where: { ...(opts.businessId ? { businessId: opts.businessId } : {}), status: { in: ["active", "throttled"] }, OR: [{ nextSyncAt: null }, { nextSyncAt: { lte: new Date() } }] }, orderBy: { lastSyncAt: { sort: "asc", nulls: "first" } }, select: { id: true, businessId: true } });
  const results: Array<{ accountRowId: string; result: unknown }> = [];
  for (const acc of accounts) {
    for (let i = 0; i < 20 && Date.now() < opts.deadline; i++) {
      const r = await withBusiness(acc.businessId, () => syncAccountStep(acc.id)).catch((e: Error) => ({ error: "crashed", message: e.message }));
      results.push({ accountRowId: acc.id, result: r });
      if (!r || "skipped" in r || "error" in r || (r as { kind?: string }).kind !== "history") break;
    }
    if (Date.now() > opts.deadline) break;
  }
  return results;
}
