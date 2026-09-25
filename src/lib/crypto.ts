/**
 * Secrets at rest (provider access tokens, app secrets, 2FA pins) are sealed with
 * AES-256-GCM under ENCRYPTION_KEY (32 bytes, hex or base64). Values are stored as
 * `enc:v1:<iv>:<tag>:<ciphertext>` (base64url). Plain legacy values are accepted on read.
 */
import crypto from "node:crypto";

const PREFIX = "enc:v1:";

function key(): Buffer | null {
  const raw = process.env.ENCRYPTION_KEY?.trim();
  if (!raw) return null;
  const buf = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
  if (buf.length !== 32) throw new Error("ENCRYPTION_KEY must be 32 bytes (64 hex chars or base64)");
  return buf;
}

export function encryptionConfigured() {
  return key() !== null;
}

export function sealSecret(plain: string): string {
  const k = key();
  if (!k) throw new Error("ENCRYPTION_KEY is not configured – refusing to store a provider secret in clear");
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", k, iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return `${PREFIX}${iv.toString("base64url")}:${cipher.getAuthTag().toString("base64url")}:${ct.toString("base64url")}`;
}

export function isSealed(value: unknown): value is string {
  return typeof value === "string" && value.startsWith(PREFIX);
}

export function openSecret(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  if (!isSealed(value)) return value; // legacy plaintext
  const k = key();
  if (!k) throw new Error("ENCRYPTION_KEY is not configured – cannot read a sealed secret");
  const [iv, tag, ct] = value.slice(PREFIX.length).split(":");
  const decipher = crypto.createDecipheriv("aes-256-gcm", k, Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ct, "base64url")), decipher.final()]).toString("utf8");
}

/** Mask for display: last 4 characters only. */
export function maskSecret(value: string | null | undefined) {
  if (!value) return null;
  return `${"•".repeat(8)}${value.slice(-4)}`;
}
