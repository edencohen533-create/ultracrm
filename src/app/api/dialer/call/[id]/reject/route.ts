import { withAuth } from "@/lib/api";
import { ok } from "@/lib/response";
import { hangupCall } from "@/lib/dialer/calls";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";

export const dynamic = "force-dynamic";

/** Agent rejected an inbound call: it is logged as missed (routing note) and hung up. */
export const POST = withAuth(async ({ user, params }) => {
  await prisma.call.updateMany({ where: { id: params.id, userId: user.id, direction: "inbound", endedAt: null }, data: { routingNote: "rejected_by_agent" } });
  await audit(user.businessId, user.id, "call", params.id, "inbound.rejected");
  return ok(await hangupCall(user, params.id));
});
