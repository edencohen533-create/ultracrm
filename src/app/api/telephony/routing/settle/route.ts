import { z } from "zod";
import { withAuth, parseBody } from "@/lib/api";
import { ok } from "@/lib/response";
import { settleAttempt } from "@/server/services/telephony-admin-service";

export const dynamic = "force-dynamic";

/** Record how an unconfirmed dial attempt ended (after checking the provider's call log). Owner only. */
export const POST = withAuth(async ({ req, user }) => {
  const b = await parseBody(req, z.object({ attemptId: z.string().min(1), resolution: z.enum(["no_call", "call_happened"]), note: z.string().max(200).optional() }));
  return ok(await settleAttempt(user.businessId, user.id, b.attemptId, b.resolution, b.note));
}, { minRole: "owner", module: "telephony" });
