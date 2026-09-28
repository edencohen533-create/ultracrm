/**
 * Meta "Data Deletion Request" and "Deauthorize" callbacks (App Dashboard → Settings → Basic / Facebook Login).
 * Meta POSTs `signed_request` (HMAC-SHA256 with the app secret). We verify it, find every WhatsApp connection linked
 * to that Meta user (stored at Embedded Signup), disconnect it and erase its tokens and Meta identifiers, record the
 * request with a confirmation code, and answer `{ url, confirmation_code }` – the url shows the status publicly.
 * Business-owned customer data (contacts, conversations) is the business's to delete (Settings → Account); the
 * privacy policy says so.
 */
import crypto from "node:crypto";
import { db } from "@/lib/db";
import { withoutBusiness } from "@/lib/tenant";
import { audit } from "@/lib/audit";

export class SignedRequestError extends Error {}

const b64url = (s: string) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");

/** Verify and decode Meta's signed_request. */
export function parseSignedRequest(signedRequest: string, secret: string): { user_id: string; algorithm?: string; issued_at?: number } {
  const [sig, payload] = String(signedRequest ?? "").split(".");
  if (!sig || !payload) throw new SignedRequestError("malformed signed_request");
  const expected = crypto.createHmac("sha256", secret).update(payload).digest();
  const got = b64url(sig);
  if (got.length !== expected.length || !crypto.timingSafeEqual(got, expected)) throw new SignedRequestError("bad signature");
  const data = JSON.parse(b64url(payload).toString("utf8")) as { user_id?: string; algorithm?: string; issued_at?: number };
  if (data.algorithm && data.algorithm.toUpperCase() !== "HMAC-SHA256") throw new SignedRequestError("unsupported algorithm");
  if (!data.user_id) throw new SignedRequestError("no user_id");
  return data as { user_id: string };
}

/** Disconnect + erase every connection linked to the Meta user. Idempotent. */
export async function handleMetaUserRemoval(kind: "data_deletion" | "deauthorize", metaUserId: string) {
  return withoutBusiness(async () => {
    // Meta retries the same request: answer with the code already issued instead of a new "no data" one.
    const recent = await db.metaDeletionRequest.findFirst({ where: { kind, metaUserId, createdAt: { gt: new Date(Date.now() - 24 * 3600_000) } }, orderBy: { createdAt: "desc" } });
    if (recent) return recent;
    const creds = await db.providerCredential.findMany({ where: { provider: "meta_whatsapp_cloud_api", metaUserIds: { has: metaUserId } }, select: { id: true, businessId: true, displayPhoneNumber: true } });
    for (const c of creds) {
      await db.providerCredential.update({ where: { id: c.id }, data: { isActive: false, isDefault: false, status: "revoked", sendingBlocked: true, lastConnectionError: kind === "deauthorize" ? "Meta: האפליקציה הוסרה על ידי המשתמש" : "Meta: בקשת מחיקת נתונים", config: {}, ...(kind === "data_deletion" ? { metaUserIds: [], wabaId: null, phoneNumberId: null, metaBusinessId: null, displayPhoneNumber: null, wabaName: null, verifiedName: null, grantedScopes: [] } : {}) } });
      await audit(c.businessId, null, "whatsapp", c.id, kind === "deauthorize" ? "whatsapp.meta_deauthorized" : "whatsapp.meta_data_deleted", { phone: c.displayPhoneNumber ? `…${c.displayPhoneNumber.slice(-4)}` : null, tokensErased: true }, db);
    }
    const code = crypto.randomBytes(9).toString("base64url").toUpperCase();
    const row = await db.metaDeletionRequest.create({ data: { kind, confirmationCode: code, metaUserId, status: creds.length ? "completed" : "no_data", businessIds: [...new Set(creds.map((c) => c.businessId))], details: { connections: creds.length }, completedAt: new Date() } });
    return row;
  });
}

export async function deletionStatus(code: string) {
  return withoutBusiness(() => db.metaDeletionRequest.findUnique({ where: { confirmationCode: code.trim().toUpperCase() }, select: { kind: true, status: true, createdAt: true, completedAt: true, confirmationCode: true } }));
}
