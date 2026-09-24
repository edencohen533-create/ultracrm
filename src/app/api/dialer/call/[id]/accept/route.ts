import { withAuth } from "@/lib/api";
import { ok, ApiError } from "@/lib/response";
import { acceptInbound } from "@/lib/dialer/inbound";
import { reconcileCall } from "@/lib/dialer/calls";

export const dynamic = "force-dynamic";

/** Agent accepted an inbound call. In simulation this connects the agent leg; with Telnyx the browser answer does. */
export const POST = withAuth(async ({ user, params }) => {
  const c = await acceptInbound(user.id, params.id);
  if (!c) throw new ApiError("שיחה לא נמצאה", 404, "not_found");
  return ok(await reconcileCall(c.id));
});
