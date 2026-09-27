import { ApiError } from "@/lib/response";
import type { SessionUser } from "@/lib/auth";

/** Owner manages every link; a manager manages only links of their own phone. */
export function assertCanManageLink(user: SessionUser, link: { userId: string }) {
  if (user.role !== "owner" && link.userId !== user.id) throw new ApiError("אין הרשאה לנהל את החיבור הזה", 403, "forbidden");
}
export const linkView = (l: { id: string; userId: string; phoneE164: string; status: string; scope: string; verifiedAt: Date | null; revokedAt: Date | null; lastInboundAt: Date | null; codeExpiresAt: Date | null; createdAt: Date; pendingReport?: string | null; user?: { fullName: string; role: string } | null }) => ({
  id: l.id, userId: l.userId, user: l.user?.fullName ?? null, role: l.user?.role ?? null, phone: l.phoneE164, status: l.status, scope: l.scope,
  verifiedAt: l.verifiedAt, revokedAt: l.revokedAt, lastInboundAt: l.lastInboundAt, codeExpiresAt: l.codeExpiresAt, createdAt: l.createdAt,
  windowOpen: Boolean(l.lastInboundAt && Date.now() - l.lastInboundAt.getTime() < 24 * 3600_000), hasPendingReport: Boolean(l.pendingReport),
});
