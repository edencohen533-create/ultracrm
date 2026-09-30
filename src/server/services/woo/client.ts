/**
 * WooCommerce REST API v3 client (https://woocommerce.github.io/woocommerce-rest-api-docs/):
 * HTTP Basic auth with the REST consumer key / secret over HTTPS, JSON, X-WP-Total / X-WP-TotalPages pagination.
 * Every request goes through safeFetch (public HTTPS only, DNS pinned, no redirects) – the customer's URL can never
 * reach our network. Errors are mapped to actionable Hebrew messages; nothing secret is ever logged or returned.
 */
import { ApiError } from "@/lib/response";
import { assertPublicHttpsUrl, safeFetch } from "@/lib/safe-url";

export interface WooCredentials { siteUrl: string; consumerKey: string; consumerSecret: string }
export class WooError extends ApiError {
  constructor(message: string, public kind: "unreachable" | "not_woocommerce" | "auth" | "permission" | "blocked" | "rate_limited" | "server" | "redirect" | "bad_response", status = 400, public retryAfterMs?: number) {
    super(message, status, `woo_${kind}`);
  }
  get transient() { return this.kind === "rate_limited" || this.kind === "server" || this.kind === "unreachable"; }
}

type Transport = (url: string, init: RequestInit & { timeoutMs?: number }) => Promise<Response>;
let transport: Transport = safeFetch;
/** Tests only: replace the network (the SSRF-safe transport is always used in the app). */
export function setWooTransportForTests(t: Transport | null) { transport = t ?? safeFetch; }

export function wooOrigin(siteUrl: string) { return assertPublicHttpsUrl(siteUrl, "כתובת האתר").origin; }

export async function wooRequest<T = unknown>(creds: WooCredentials, path: string, init: { method?: string; body?: unknown; query?: Record<string, string | number | undefined> } = {}) {
  const origin = wooOrigin(creds.siteUrl);
  const qs = Object.entries(init.query ?? {}).filter(([, v]) => v !== undefined && v !== "").map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join("&");
  const url = `${origin}/wp-json/wc/v3${path}${qs ? `?${qs}` : ""}`;
  const auth = `Basic ${Buffer.from(`${creds.consumerKey.trim()}:${creds.consumerSecret.trim()}`).toString("base64")}`;
  let res: Response;
  try {
    res = await transport(url, { method: init.method ?? "GET", headers: { Authorization: auth, Accept: "application/json", ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}) }, body: init.body !== undefined ? JSON.stringify(init.body) : undefined, timeoutMs: 20_000 });
  } catch (e) {
    if (e instanceof ApiError) throw new WooError(e.message, "unreachable", 400);
    const m = (e as Error).message ?? "";
    throw new WooError(/certificate|SSL|TLS/i.test(m) ? "תעודת האבטחה (SSL) של האתר אינה תקינה – נדרש https תקין" : /ENOTFOUND|getaddrinfo/i.test(m) ? "הדומיין לא נמצא – בדוק את כתובת החנות" : "החנות לא זמינה כרגע (אין תשובה מהשרת)", "unreachable", 502);
  }
  const text = await res.text();
  let body: unknown = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = null; }
  const code = (body && typeof body === "object" ? (body as { code?: string }).code : undefined) ?? "";
  if (res.status >= 300 && res.status < 400) throw new WooError("החנות הפנתה לכתובת אחרת – השתמש בכתובת הראשית של האתר (https, עם/בלי www כפי שמוגדר באתר)", "redirect");
  if (res.status === 429) { const ra = Number(res.headers.get("retry-after")); throw new WooError("החנות הגבילה את קצב הבקשות – ננסה שוב אוטומטית", "rate_limited", 429, Number.isFinite(ra) && ra > 0 ? ra * 1000 : 60_000); }
  if (res.status === 401) throw new WooError(code === "woocommerce_rest_authentication_error" || /consumer|key|signature/i.test(code) ? "מפתח ה-API אינו תקין (Consumer key / secret שגויים או שבוטלו)" : "החנות דחתה את פרטי ה-API – בדוק את המפתחות, שהם של משתמש מנהל, ושהשרת מעביר את כותרת Authorization", "auth", 400);
  if (res.status === 403) throw new WooError(/^woocommerce_rest_cannot|rest_forbidden/.test(code) ? "למפתח אין הרשאה לפעולה הזו" : "הבקשה נחסמה על ידי האתר (חומת אש / Cloudflare / תוסף אבטחה) – יש לאשר גישה ל-/wp-json/wc/v3", code ? "permission" : "blocked", 400);
  if (res.status === 404) throw new WooError(code === "rest_no_route" || !code ? "לא נמצא WooCommerce REST API בכתובת הזו (בדוק את הכתובת, ש-WooCommerce פעיל ושה-Permalinks אינם 'Plain')" : "המשאב לא נמצא בחנות", code === "rest_no_route" || !code ? "not_woocommerce" : "bad_response", 400);
  if (res.status >= 500) throw new WooError(`שרת החנות החזיר שגיאה (${res.status}) – ננסה שוב`, "server", 502);
  if (!res.ok) throw new WooError(`החנות החזירה שגיאה ${res.status}`, "bad_response", 502);
  if (body === null && text) throw new WooError("החנות החזירה תשובה שאינה JSON (ייתכן דף חסימה או תחזוקה)", "blocked", 502);
  return { data: body as T, total: Number(res.headers.get("x-wp-total") ?? "") || null, totalPages: Number(res.headers.get("x-wp-totalpages") ?? "") || null };
}
