import { withAuth } from "@/lib/api";
import { ok } from "@/lib/response";
import { callForCoach } from "@/app/api/coach/_access";
import { coachStatus, sessionState } from "@/server/coach/session";

export const dynamic = "force-dynamic";

/** Polled by the coach card during a call: status + the current (not superseded, not dismissed) recommendation. */
export const GET = withAuth(async ({ user, params }) => {
  const call = await callForCoach(user, params.callId);
  const [status, session] = await Promise.all([coachStatus(user.id), sessionState(call.id)]);
  return ok({ status, session, callEnded: Boolean(call.endedAt) });
}, { module: "telephony" });
