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
  let decoded: unknown;
  try { decoded = JSON.parse(b64url(payload).toString("utf8")); } catch { throw new SignedRequestError("invalid JSON"); }
  if (!decoded || typeof decoded !== "object") throw new SignedRequestError("invalid payload");
  const data = decoded as { user_id?: string; algorithm?: string; issued_at?: number };
  if (data.algorithm && (typeof data.algorithm !== "string" || data.algorithm.toUpperCase() !== "HMAC-SHA256")) throw new SignedRequestError("unsupported algorithm");
  if (typeof data.user_id !== "string" || !data.user_id || data.user_id.length > 200) throw new SignedRequestError("no user_id");
  return data as { user_id: string };
}

/** Disconnect + erase every connection linked to the Meta user. Idempotent. */
export async function handleMetaUserRemoval(kind: "data_deletion" | "deauthorize", metaUserId: string) {
  return withoutBusiness(() => db.$transaction(async (tx) => {
    const fingerprint = "sha256:" + crypto.createHash("sha256").update(metaUserId).digest("hex");
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${fingerprint}, 0))`;
    const creds = await tx.providerCredential.findMany({ where: { provider: "meta_whatsapp_cloud_api", metaUserIds: { has: metaUserId } }, select: { id: true, businessId: true, displayPhoneNumber: true } });
    // Meta retries a request we already completed: nothing is linked any more, so answer with the code already issued.
    if (!creds.length) {
      const recent = await tx.metaDeletionRequest.findFirst({ where: { kind, metaUserId: { in: [metaUserId, fingerprint] }, createdAt: { gt: new Date(Date.now() - 24 * 3600_000) } }, orderBy: { createdAt: "desc" } });
      if (recent) {
        if (recent.metaUserId === metaUserId) return tx.metaDeletionRequest.update({ where: { id: recent.id }, data: { metaUserId: fingerprint } });
        return recent;
      }
    }
    if (kind === "data_deletion" && creds.length) await tx.whatsAppSignupSession.deleteMany({ where: { credentialId: { in: creds.map(c => c.id) } } });
    await tx.metaDeletionRequest.updateMany({ where: { metaUserId }, data: { metaUserId: fingerprint } });
    for (const c of creds) {
      await tx.providerCredential.update({ where: { id: c.id }, data: { isActive: false, isDefault: false, status: "revoked", sendingBlocked: true, lastConnectionError: kind === "deauthorize" ? "Meta: האפליקציה הוסרה על ידי המשתמש" : "Meta: בקשת מחיקת נתונים", config: {}, ...(kind === "data_deletion" ? { metaUserIds: [], wabaId: null, phoneNumberId: null, metaBusinessId: null, displayPhoneNumber: null, wabaName: null, verifiedName: null, grantedScopes: [] } : {}) } });
      await audit(c.businessId, null, "whatsapp", c.id, kind === "deauthorize" ? "whatsapp.meta_deauthorized" : "whatsapp.meta_data_deleted", { phone: c.displayPhoneNumber ? `…${c.displayPhoneNumber.slice(-4)}` : null, tokensErased: true }, tx);
    }
    const code = crypto.randomBytes(16).toString("hex").toUpperCase();
    const row = await tx.metaDeletionRequest.create({ data: { kind, confirmationCode: code, metaUserId: fingerprint, status: creds.length ? "completed" : "no_data", businessIds: [...new Set(creds.map((c) => c.businessId))], details: { connections: creds.length }, completedAt: new Date() } });
    return row;
  }, { timeout: 30000 }));
}

export async function deletionStatus(code: string) {
  return withoutBusiness(() => db.metaDeletionRequest.findUnique({ where: { confirmationCode: code.trim().toUpperCase() }, select: { kind: true, status: true, createdAt: true, completedAt: true, confirmationCode: true } }));
}
