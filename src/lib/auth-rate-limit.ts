import { Prisma } from "@/generated/prisma/client";
import { createHash } from "node:crypto";
import { db, dbSchema } from "@/lib/db";
import { withoutBusiness } from "@/lib/tenant";
import { ApiError } from "@/lib/response";

const WINDOW_MS = 15 * 60_000;
/** Shared, atomic limits survive serverless cold starts and simultaneous requests. Keys never store raw emails/tokens. */
export async function reserveAuthAttempt(scope: string, identity: string, limit: number, windowMs = WINDOW_MS) {
  const key = createHash("sha256").update(`${scope}:${identity}`).digest("hex");
  const now = new Date();
  const expiresAt = new Date(now.getTime() + windowMs);
  const table = Prisma.raw(`"${dbSchema().replaceAll('"', '""')}"."auth_rate_limits"`);
  const rows = await withoutBusiness(() => db.$queryRaw<Array<{ attempts: number }>>`
    INSERT INTO ${table} AS limits (key, attempts, expires_at) VALUES (${key}, 1, ${expiresAt})
    ON CONFLICT (key) DO UPDATE SET
      attempts = CASE WHEN limits.expires_at <= ${now} THEN 1 ELSE limits.attempts + 1 END,
      expires_at = CASE WHEN limits.expires_at <= ${now} THEN ${expiresAt} ELSE limits.expires_at END
    WHERE limits.expires_at <= ${now} OR limits.attempts < ${limit}
    RETURNING attempts
  `);
  if (!rows.length) throw new ApiError("יותר מדי ניסיונות – נסה שוב בעוד כמה דקות", 429, "rate_limited");
}

/** Bounded expiry cleanup; invoked by the existing maintenance cron. */
export async function cleanAuthAttempts() {
  const table = Prisma.raw(`"${dbSchema().replaceAll('"', '""')}"."auth_rate_limits"`);
  return withoutBusiness(() => db.$executeRaw`DELETE FROM ${table} WHERE key IN (SELECT key FROM ${table} WHERE expires_at < NOW() ORDER BY expires_at LIMIT 10000)`);
}
