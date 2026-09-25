import { z } from "zod";
import { withAuth, parseBody } from "@/lib/api";
import { ok, ApiError } from "@/lib/response";
import { callForCoach } from "@/app/api/coach/_access";
import { addSegments, coachStatus, sessionState } from "@/server/coach/session";

export const dynamic = "force-dynamic";

const schema = z.object({
  segments: z.array(z.object({
    speaker: z.enum(["customer", "agent", "unknown"]),
    text: z.string().trim().min(1).max(4000),
    startMs: z.number().int().min(0).optional(),
    endMs: z.number().int().min(0).optional(),
    source: z.enum(["browser_stt", "simulation", "telnyx_stream"]).default("browser_stt"),
  })).min(1).max(50),
});

/**
 * Layer 1 entry point for already-transcribed text (browser speech recognition, a media-stream worker, or the
 * simulation input on the coach card). Audio goes to ../audio. Only the call's agent (or their manager) may feed a call.
 */
export const POST = withAuth(async ({ req, user, params }) => {
  const call = await callForCoach(user, params.callId);
  if (call.endedAt) throw new ApiError("השיחה הסתיימה", 409, "call_ended");
  const status = await coachStatus(user.id);
  if (!status.enabled) throw new ApiError(status.reason ?? "המאמן כבוי", 409, "coach_disabled");
  const b = await parseBody(req, schema);
  if (b.segments.some((s) => s.source === "simulation") && process.env.NODE_ENV === "production" && process.env.COACH_ALLOW_SIMULATION_INPUT !== "1") {
    throw new ApiError("קלט הדמיה אינו זמין בייצור", 403, "simulation_disabled");
  }
  const r = await addSegments(call.id, b.segments);
  return ok({ created: r.created, analyzed: r.analyzed, state: await sessionState(call.id), status });
}, { module: "telephony" });
