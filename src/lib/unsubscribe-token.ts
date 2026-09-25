/**
 * Signed, stateless unsubscribe tokens for email links / SMS fallback links.
 * Bound to (business, contact, identifier, message). HMAC-SHA256 with a key derived from
 * ENCRYPTION_KEY (fallback JWT_SECRET). The public page validates the signature and only
 * ever shows a masked identifier – a token can never reveal or change another contact.
 */
import crypto from "node:crypto";

export interface UnsubscribePayload {
  b: string;  // businessId
  c: string;  // contactId
  i: string;  // identifier (email or E.164)
  m?: string; // messageId (evidence)
  ch: "email" | "sms";
  exp: number; // unix seconds
}

function key() {
  const secret = process.env.ENCRYPTION_KEY?.trim() || process.env.JWT_SECRET?.trim();
  if (!secret) throw new Error("ENCRYPTION_KEY / JWT_SECRET missing – cannot sign unsubscribe links");
  return crypto.createHmac("sha256", secret).update("unsubscribe-v1").digest();
}

const b64 = (b: Buffer) => b.toString("base64url");

export function signUnsubscribeToken(p: Omit<UnsubscribePayload, "exp">, ttlDays = 400): string {
  const payload = Buffer.from(JSON.stringify({ ...p, exp: Math.floor(Date.now() / 1000) + ttlDays * 86400 } satisfies UnsubscribePayload), "utf8");
  const sig = crypto.createHmac("sha256", key()).update(payload).digest();
  return `${b64(payload)}.${b64(sig)}`;
}

export function verifyUnsubscribeToken(token: string): UnsubscribePayload | null {
  const [p, s] = token.split(".");
  if (!p || !s) return null;
  try {
    const payload = Buffer.from(p, "base64url");
    const expected = crypto.createHmac("sha256", key()).update(payload).digest();
    const given = Buffer.from(s, "base64url");
    if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
    const data = JSON.parse(payload.toString("utf8")) as UnsubscribePayload;
    if (typeof data.b !== "string" || typeof data.c !== "string" || typeof data.i !== "string" || !["email", "sms"].includes(data.ch)) return null;
    if (data.exp < Math.floor(Date.now() / 1000)) return null;
    return data;
  } catch { return null; }
}

export function unsubscribeUrl(token: string) {
  const base = (process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
  return `${base}/u/${token}`;
}

/** e.g. "i***@example.com" / "+9725***01" – never the full identifier on the public page. */
export function maskIdentifier(identifier: string) {
  if (identifier.includes("@")) {
    const [user, domain] = identifier.split("@");
    return `${user.slice(0, 1)}***@${domain}`;
  }
  return `${identifier.slice(0, 5)}***${identifier.slice(-2)}`;
}
