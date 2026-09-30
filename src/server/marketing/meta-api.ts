/**
 * Meta Marketing API (read only) for the marketing report: ad accounts, structure and ad-level insights.
 * Official flow (developers.facebook.com/docs/marketing-api): permission `ads_read`; Insights edge
 * `act_{id}/insights` with `level=ad`, `time_increment=1`, cursor paging; throttling answers with codes
 * 4 / 17 / 613 / 80000–80014 and usage headers (X-Business-Use-Case-Usage → estimated_time_to_regain_access).
 * Nothing here creates, edits or pauses anything at Meta.
 */
import { GRAPH_BASE } from "@/lib/meta/graph";

export type AdsErrorKind = "auth" | "throttle" | "permission" | "transient" | "invalid";
export class AdsApiError extends Error {
  constructor(message: string, readonly kind: AdsErrorKind, readonly code: number | null, readonly retryAfterSec: number | null = null) {
    super(message);
    this.name = "AdsApiError";
  }
}

const THROTTLE = new Set([4, 17, 32, 613, 80000, 80001, 80002, 80003, 80004, 80005, 80006, 80008, 80009, 80014]);
const AUTH = new Set([102, 190, 463, 467]);
const PERMISSION = new Set([10, 200, 270, 272, 275, 278, 294]);

/** Seconds until Meta lets the app call again, from the usage headers (null = unknown). */
export function retryAfterFrom(headers: Headers): number | null {
  for (const h of ["x-business-use-case-usage", "x-ad-account-usage"]) {
    const raw = headers.get(h);
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw) as Record<string, Array<{ estimated_time_to_regain_access?: number }>> | { reset_time_duration?: number };
      if ("reset_time_duration" in parsed && typeof parsed.reset_time_duration === "number") return parsed.reset_time_duration;
      let max = 0;
      for (const v of Object.values(parsed)) if (Array.isArray(v)) for (const x of v) max = Math.max(max, Number(x.estimated_time_to_regain_access ?? 0) * 60);
      if (max > 0) return max;
    } catch { /* malformed header – ignore */ }
  }
  return null;
}

export function classifyAdsError(status: number, err: { message?: string; code?: number; error_subcode?: number } | undefined, headers: Headers): AdsApiError {
  const code = err?.code ?? null;
  const msg = (err?.message ?? `HTTP ${status}`).slice(0, 300);
  if (code !== null && THROTTLE.has(code)) return new AdsApiError(msg, "throttle", code, retryAfterFrom(headers));
  if ((code !== null && AUTH.has(code)) || status === 401) return new AdsApiError(msg, "auth", code);
  if ((code !== null && PERMISSION.has(code)) || status === 403) return new AdsApiError(msg, "permission", code);
  if (status >= 500 || code === 1 || code === 2) return new AdsApiError(msg, "transient", code);
  return new AdsApiError(msg, "invalid", code);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** GET against the Graph API with the business's token. Transient failures are retried (backoff); others thrown classified. */
export async function adsGet<T>(path: string, token: string, query: Record<string, string | undefined> = {}, opts: { retries?: number } = {}): Promise<T> {
  const url = path.startsWith("https://") ? new URL(path) : new URL(`${GRAPH_BASE}/${path.replace(/^\//, "")}`);
  for (const [k, v] of Object.entries(query)) if (v !== undefined) url.searchParams.set(k, v);
  const retries = opts.retries ?? 2;
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {}, signal: AbortSignal.timeout(30_000), redirect: "error", cache: "no-store" });
    } catch (e) {
      if (attempt < retries) { await sleep(500 * 3 ** attempt); continue; }
      throw new AdsApiError(`Meta לא זמינה: ${(e as Error).message}`.slice(0, 300), "transient", null);
    }
    const body = (await res.json().catch(() => ({}))) as { error?: { message?: string; code?: number; error_subcode?: number } } & T;
    if (res.ok && !body.error) return body;
    const err = classifyAdsError(res.status, body.error, res.headers);
    if (err.kind === "transient" && attempt < retries) { await sleep(500 * 3 ** attempt); continue; }
    throw err;
  }
}

/** All pages of an edge (cursor paging via paging.next), bounded. */
export async function adsGetAll<T>(path: string, token: string, query: Record<string, string | undefined>, maxPages = 50): Promise<T[]> {
  const out: T[] = [];
  let next: string | null = null;
  for (let i = 0; i < maxPages; i++) {
    const page: { data?: T[]; paging?: { next?: string } } = next ? await adsGet(next, token) : await adsGet(path, token, query);
    out.push(...(page.data ?? []));
    next = page.paging?.next ?? null;
    if (!next) break;
  }
  return out;
}

/** Leads as Meta reports them for an insights row: the "lead" action (Meta's own aggregate), else the first lead type found – never summed across types. */
export function metaLeadsOf(actions: Array<{ action_type?: string; value?: string }> | undefined): number | null {
  if (!actions?.length) return null;
  for (const type of ["lead", "onsite_conversion.lead_grouped", "offsite_conversion.fb_pixel_lead"]) {
    const a = actions.find((x) => x.action_type === type);
    if (a) return Math.round(Number(a.value ?? 0));
  }
  return null;
}
