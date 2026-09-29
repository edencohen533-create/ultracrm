/**
 * Template header images uploaded from the computer / phone (instead of pasting a link).
 *
 *  • Meta rules (Cloud API media reference, Sept 2026): image/jpeg or image/png, at most 5 MB, 8-bit RGB / RGBA.
 *    Checked on the bytes (signature + image header), never on the browser's claim.
 *  • Stored per business (media_assets, RLS by business_id); read only through scope-checked routes.
 *  • Uploaded in chunks (≤ 1 MB per request – serverless request bodies are limited to ~4.5 MB).
 *  • To Meta: the template review sample goes through the Resumable Upload API (handle, see template-submit-service);
 *    each send uses a media id from POST /{phone-number-id}/media, cached per number until shortly before Meta's
 *    30-day expiry. A local link is never assumed to be reachable by Meta.
 */
import crypto from "node:crypto";
import { prisma } from "@/lib/db";
import { ApiError } from "@/lib/response";
import type { SessionUser } from "@/lib/auth";
import { magicBytesMatch } from "@/lib/media";
import { audit } from "@/lib/audit";

export const TEMPLATE_IMAGE_TYPES = ["image/jpeg", "image/png"] as const;
export const TEMPLATE_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const UPLOAD_CHUNK_BYTES = 1024 * 1024;
/** Meta media ids live 30 days; re-upload a day early. */
const MEDIA_ID_TTL_MS = 29 * 24 * 3600_000;

export class MediaValidationError extends ApiError {}

/** Width / height and whether the image is 8-bit RGB(A), read from the PNG IHDR / JPEG SOF header. */
export function inspectImage(buf: Buffer, mimeType: string): { width: number; height: number; ok: boolean; reason?: string } {
  if (mimeType === "image/png") {
    if (buf.length < 33 || buf.subarray(12, 16).toString("latin1") !== "IHDR") return { width: 0, height: 0, ok: false, reason: "קובץ PNG פגום" };
    const width = buf.readUInt32BE(16), height = buf.readUInt32BE(20), depth = buf[24], color = buf[25];
    if (depth !== 8) return { width, height, ok: false, reason: `תמונת PNG חייבת להיות 8 ביט (הקובץ ${depth} ביט)` };
    if (color !== 2 && color !== 6) return { width, height, ok: false, reason: color === 3 ? "תמונת PNG עם פלטת צבעים (indexed) אינה נתמכת – שמרו כ-PNG צבעוני (RGB) או JPG" : "תמונת PNG חייבת להיות צבעונית RGB או RGBA (לא גווני אפור)" };
    return { width, height, ok: true };
  }
  if (mimeType === "image/jpeg") {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i++; continue; }
      const marker = buf[i + 1];
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01 || marker === 0xff) { i += marker === 0xff ? 1 : 2; continue; }
      const len = buf.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        const precision = buf[i + 4], height = buf.readUInt16BE(i + 5), width = buf.readUInt16BE(i + 7), comps = buf[i + 9];
        if (precision !== 8) return { width, height, ok: false, reason: "תמונת JPG חייבת להיות 8 ביט" };
        if (comps !== 3) return { width, height, ok: false, reason: comps === 4 ? "תמונת JPG בפורמט CMYK אינה נתמכת – שמרו כ-RGB" : "תמונת JPG חייבת להיות צבעונית (RGB)" };
        return { width, height, ok: true };
      }
      if (marker === 0xda) break;
      i += 2 + len;
    }
    return { width: 0, height: 0, ok: false, reason: "קובץ JPG פגום" };
  }
  return { width: 0, height: 0, ok: false, reason: "סוג קובץ לא נתמך" };
}

export function assertImageDeclaration(input: { mimeType: string; sizeBytes: number }) {
  if (!(TEMPLATE_IMAGE_TYPES as readonly string[]).includes(input.mimeType)) throw new MediaValidationError("ניתן להעלות רק תמונת JPG או PNG", 400, "unsupported_type");
  if (!Number.isInteger(input.sizeBytes) || input.sizeBytes <= 0) throw new MediaValidationError("הקובץ ריק", 400, "empty_file");
  if (input.sizeBytes > TEMPLATE_IMAGE_MAX_BYTES) throw new MediaValidationError("התמונה גדולה מ-5MB – המגבלה של Meta. יש להקטין אותה", 400, "file_too_large");
}

const PUBLIC = { id: true, fileName: true, mimeType: true, sizeBytes: true, width: true, height: true, status: true, createdAt: true } as const;

export async function startImageUpload(user: SessionUser, input: { fileName: string; mimeType: string; sizeBytes: number }) {
  assertImageDeclaration(input);
  const fileName = input.fileName.replace(/[\\/\r\n\0]/g, "_").slice(0, 200) || "image";
  return prisma.mediaAsset.create({ data: { businessId: user.businessId, kind: "template_header", fileName, mimeType: input.mimeType, sizeBytes: input.sizeBytes, createdById: user.id }, select: PUBLIC });
}

async function ownAsset(user: SessionUser, id: string) {
  const a = await prisma.mediaAsset.findFirst({ where: { id, businessId: user.businessId, status: { not: "deleted" } } });
  if (!a) throw new ApiError("הקובץ לא נמצא", 404, "not_found");
  return a;
}

/** Append one chunk at `offset` (must equal the bytes received so far – a retried chunk is idempotent). */
export async function appendChunk(user: SessionUser, id: string, offset: number, chunk: Buffer) {
  const a = await ownAsset(user, id);
  if (a.status !== "uploading") throw new ApiError("ההעלאה כבר הסתיימה", 409, "upload_closed");
  const have = a.data.length;
  if (chunk.length > UPLOAD_CHUNK_BYTES) throw new MediaValidationError("חלק גדול מדי", 413, "chunk_too_large");
  if (offset + chunk.length === have && offset < have) return { received: have }; // the same chunk again
  if (offset !== have) throw new ApiError(`היסט שגוי (צפוי ${have})`, 409, "bad_offset", { expected: have });
  if (have + chunk.length > a.sizeBytes) throw new MediaValidationError("הקובץ גדול מהגודל שהוצהר", 400, "size_mismatch");
  const next = Buffer.concat([Buffer.from(a.data), chunk]);
  const r = await prisma.mediaAsset.updateMany({ where: { id: a.id, businessId: user.businessId, updatedAt: a.updatedAt, status: "uploading" }, data: { data: next } });
  if (!r.count) throw new ApiError("העלאה מקבילה לאותו קובץ – נסו שוב", 409, "concurrent_upload");
  return { received: next.length };
}

/** All bytes received → check signature, image format and size, then mark ready. A bad file is removed. */
export async function finishUpload(user: SessionUser, id: string) {
  const a = await ownAsset(user, id);
  if (a.status === "ready") return prisma.mediaAsset.findUniqueOrThrow({ where: { id: a.id }, select: PUBLIC });
  const buf = Buffer.from(a.data);
  const reject = async (msg: string, code: string) => { await prisma.mediaAsset.update({ where: { id: a.id }, data: { status: "deleted", deletedAt: new Date(), data: Buffer.alloc(0) } }); throw new MediaValidationError(msg, 400, code); };
  if (buf.length !== a.sizeBytes) throw new ApiError(`ההעלאה לא הושלמה (${buf.length}/${a.sizeBytes})`, 409, "incomplete");
  if (!magicBytesMatch(buf, a.mimeType)) await reject("תוכן הקובץ אינו תואם לסוג שלו (JPG/PNG)", "type_mismatch");
  const img = inspectImage(buf, a.mimeType);
  if (!img.ok) await reject(img.reason ?? "תמונה לא נתמכת", "unsupported_image");
  const done = await prisma.mediaAsset.update({ where: { id: a.id }, data: { status: "ready", width: img.width, height: img.height, sha256: crypto.createHash("sha256").update(buf).digest("hex") }, select: PUBLIC });
  await audit(user.businessId, user.id, "media", a.id, "media.uploaded", { kind: a.kind, mimeType: a.mimeType, sizeBytes: a.sizeBytes });
  return done;
}

export async function readyAsset(businessId: string, id: string) {
  const a = await prisma.mediaAsset.findFirst({ where: { id, businessId, status: "ready" } });
  return a;
}

/** Remove an uploaded image that no template uses (replace / remove in the builder). */
export async function deleteAsset(user: SessionUser, id: string) {
  const a = await ownAsset(user, id);
  const used = await prisma.template.count({ where: { businessId: user.businessId, headerMediaAssetId: a.id } });
  if (used) throw new ApiError("התמונה משמשת תבנית קיימת ולכן לא נמחקה", 409, "in_use");
  await prisma.mediaAsset.update({ where: { id: a.id }, data: { status: "deleted", deletedAt: new Date(), data: Buffer.alloc(0) } });
  return { deleted: true };
}

/**
 * The Meta media id of this asset for one WhatsApp number: reused while valid, otherwise uploaded now
 * (POST /{phone-number-id}/media, multipart). `upload` does the provider call (injected for tests / providers).
 */
export async function providerMediaId(businessId: string, assetId: string, credentialId: string, upload: (file: { bytes: Buffer; mimeType: string; fileName: string }) => Promise<string>) {
  const cached = await prisma.mediaProviderUpload.findUnique({ where: { assetId_credentialId: { assetId, credentialId } } });
  if (cached && cached.businessId === businessId && cached.expiresAt > new Date()) return cached.providerMediaId;
  const a = await readyAsset(businessId, assetId);
  if (!a) throw new ApiError("תמונת הכותרת אינה זמינה", 404, "media_missing");
  const mediaId = await upload({ bytes: Buffer.from(a.data), mimeType: a.mimeType, fileName: a.fileName });
  const expiresAt = new Date(Date.now() + MEDIA_ID_TTL_MS);
  await prisma.mediaProviderUpload.upsert({ where: { assetId_credentialId: { assetId, credentialId } }, create: { businessId, assetId, credentialId, providerMediaId: mediaId, expiresAt }, update: { providerMediaId: mediaId, expiresAt, createdAt: new Date() } });
  return mediaId;
}
