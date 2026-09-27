/**
 * Outbound URLs chosen by a customer (store API, webhook endpoints) must not reach our own network (SSRF):
 * https only, a public host name – no IP literals, localhost, internal suffixes or credentials in the URL.
 * Requests are made with redirect: "manual", so a public host cannot bounce us to an internal one.
 */
import { ApiError } from "@/lib/response";

const PRIVATE_SUFFIX = /(^|\.)(localhost|local|internal|intranet|lan|home|corp|localdomain)$/i;
export function assertPublicHttpsUrl(raw: string, label = "הכתובת"): URL {
  let u: URL;
  try { u = new URL(raw.trim().includes("://") ? raw.trim() : `https://${raw.trim()}`); } catch { throw new ApiError(`${label} אינה תקינה`, 400, "invalid_url"); }
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (u.protocol !== "https:") throw new ApiError(`${label} חייבת להתחיל ב-https://`, 400, "invalid_url");
  if (u.username || u.password) throw new ApiError(`${label} לא יכולה לכלול שם משתמש וסיסמה`, 400, "invalid_url");
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":")) throw new ApiError(`${label} חייבת להיות שם דומיין ולא כתובת IP`, 400, "invalid_url");
  if (!host.includes(".") || PRIVATE_SUFFIX.test(host)) throw new ApiError(`${label} חייבת להיות כתובת ציבורית`, 400, "invalid_url");
  if (u.port && u.port !== "443") throw new ApiError(`${label} חייבת להשתמש בפורט 443`, 400, "invalid_url");
  return u;
}

export async function safeFetch(url: string, init: RequestInit & { timeoutMs?: number } = {}) {
  assertPublicHttpsUrl(url);
  return fetch(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(init.timeoutMs ?? 10_000) });
}
