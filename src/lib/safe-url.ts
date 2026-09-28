/**
 * Outbound URLs chosen by a customer (store API, webhook endpoints) must not reach our own network (SSRF):
 * https only, a public host name – no IP literals, localhost, internal suffixes or credentials in the URL.
 * Requests are made with redirect: "manual", so a public host cannot bounce us to an internal one.
 */
import { ApiError } from "@/lib/response";
import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { isIP } from "node:net";

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

/** Only globally routable destinations. IPv4-mapped IPv6 and special-use IPv6 are rejected. */
export function isPublicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b, c] = address.split(".").map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113));
  }
  if (isIP(address) !== 6) return false;
  const normalized = new URL(`http://[${address}]/`).hostname.slice(1, -1).toLowerCase();
  // Global unicast only; exclude IETF special-use, documentation and 6to4 ranges.
  return /^[23][0-9a-f]{3}:/.test(normalized) && !/^2001:(?::|[01]?[0-9a-f]{1,2}:|db8:)/.test(normalized) &&
    !normalized.startsWith("2002:") && !normalized.startsWith("3fff:");
}

/** Resolve once and connect to that verified IP; a second DNS lookup would permit rebinding. */
export async function safeFetch(raw: string, init: RequestInit & { timeoutMs?: number } = {}) {
  const url = assertPublicHttpsUrl(raw);
  const signal = AbortSignal.any([AbortSignal.timeout(init.timeoutMs ?? 10_000), ...(init.signal ? [init.signal] : [])]);
  const addresses = await Promise.race([
    lookup(url.hostname, { all: true, verbatim: true }),
    new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })),
  ]);
  signal.throwIfAborted();
  if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) {
    throw new ApiError("הכתובת אינה מצביעה לרשת ציבורית", 400, "private_destination");
  }
  if (init.body != null && typeof init.body !== "string" && !(init.body instanceof URLSearchParams)) {
    throw new Error("safeFetch supports string or URLSearchParams bodies only");
  }
  const headers = Object.fromEntries(new Headers(init.headers).entries());
  headers.host = url.host;
  // Buffer a bounded response so redirects are never followed and decompression cannot expand without a limit.
  headers["accept-encoding"] = "identity";
  return new Promise<Response>((resolve, reject) => {
    const req = request({
      protocol: "https:", hostname: addresses[0].address, family: addresses[0].family,
      servername: url.hostname, port: 443, path: url.pathname + url.search,
      method: init.method ?? "GET", headers, signal, agent: false,
    }, res => {
      const chunks: Buffer[] = []; let size = 0;
      res.on("error", reject);
      res.on("aborted", () => reject(new Error("Upstream response aborted")));
      res.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > 20 * 1024 * 1024) { res.destroy(new Error("Upstream response exceeds 20 MB")); return; }
        chunks.push(chunk);
      });
      res.on("end", () => {
        const responseHeaders = new Headers();
        for (const [key, value] of Object.entries(res.headers)) {
          if (value !== undefined) responseHeaders.set(key, Array.isArray(value) ? value.join(", ") : value);
        }
        const status = res.statusCode ?? 502;
        resolve(new Response([204, 205, 304].includes(status) || init.method === "HEAD" ? null : Buffer.concat(chunks), { status, headers: responseHeaders }));
      });
    });
    req.on("error", reject);
    req.end(init.body == null ? undefined : init.body.toString());
  });
}
