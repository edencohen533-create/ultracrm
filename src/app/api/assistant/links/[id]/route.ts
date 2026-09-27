import { withAuth } from "@/lib/api";
import { ok, ApiError } from "@/lib/response";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { assertCanManageLink } from "@/server/assistant/access";

export const dynamic = "force-dynamic";

/** Instant revocation: the phone stops being recognised on its very next message (it becomes a normal contact). */
export const DELETE = withAuth(async ({ user, params }) => {
  const link = await prisma.assistantLink.findFirst({ where: { id: params.id, businessId: user.businessId } });
  if (!link) throw new ApiError("לא נמצא", 404, "not_found");
  assertCanManageLink(user, link);
  await prisma.assistantLink.update({ where: { id: link.id }, data: { status: "revoked", revokedAt: new Date(), codeHash: null, codeExpiresAt: null, context: {}, pendingReport: null } });
  await audit(user.businessId, user.id, "AssistantLink", link.id, "assistant.link_revoked", { phoneLast4: link.phoneE164.slice(-4) });
  return ok({ revoked: true });
}, { minRole: "manager" });
