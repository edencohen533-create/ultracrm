import { z } from "zod";
import { withAuth, parseBody } from "@/lib/api";
import { ok, ApiError } from "@/lib/response";
import { callForCoach } from "@/app/api/coach/_access";
import { coachStatus } from "@/server/coach/session";
import { askCoach, chatHistory } from "@/server/coach/chat";
import { CoachProviderError } from "@/server/coach/providers";

export const dynamic = "force-dynamic";

/** The call's chat so far (agent of the call or their manager). */
export const GET = withAuth(async ({ user, params }) => {
  const call = await callForCoach(user, params.callId);
  return ok({ messages: await chatHistory(call.id), status: await coachStatus(user.id) });
}, { module: "telephony" });

const schema = z.object({ question: z.string().trim().min(2).max(1000) });

/** "נתקעתי? שאל את ה-AI": one free-text question → one spoken-style answer + optional follow-up. */
export const POST = withAuth(async ({ req, user, params }) => {
  const call = await callForCoach(user, params.callId);
  const status = await coachStatus(user.id);
  if (!status.enabled) throw new ApiError(status.reason ?? "המאמן כבוי", 409, "coach_disabled");
  if (!status.live) throw new ApiError(status.reason ?? "המאמן לא זמין", 409, "coach_unavailable");
  const b = await parseBody(req, schema);
  try {
    return ok(await askCoach(call.id, b.question));
  } catch (e) {
    if (e instanceof CoachProviderError) throw new ApiError(`ספק ה-AI לא זמין כרגע: ${e.message}`, 503, "coach_provider");
    throw e;
  }
}, { module: "telephony" });
