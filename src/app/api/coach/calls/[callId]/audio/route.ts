import { withAuth } from "@/lib/api";
import { ok, ApiError } from "@/lib/response";
import { callForCoach } from "@/app/api/coach/_access";
import { addSegments, coachStatus, sessionState } from "@/server/coach/session";
import { transcribeAudio, CoachProviderError } from "@/server/coach/providers";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_BYTES = 4 * 1024 * 1024;

/**
 * Layer 1 – audio chunks from the agent's browser (one track per speaker: the remote/customer track and the mic).
 * multipart: file (audio/webm|ogg|wav|mp4), speaker (customer|agent), durationSeconds, startMs.
 * Transcribed server-side (OpenAI STT); the audio is not stored.
 */
export const POST = withAuth(async ({ req, user, params }) => {
  const call = await callForCoach(user, params.callId);
  if (call.endedAt) throw new ApiError("השיחה הסתיימה", 409, "call_ended");
  const status = await coachStatus(user.id);
  if (!status.enabled) throw new ApiError(status.reason ?? "המאמן כבוי", 409, "coach_disabled");
  if (status.providers.stt === "missing") throw new ApiError("חסר מפתח תמלול (OPENAI_API_KEY) – אין תמלול חי", 409, "stt_missing");
  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof Blob) || file.size === 0) throw new ApiError("חסר קובץ אודיו", 400, "no_audio");
  if (file.size > MAX_BYTES) throw new ApiError("מקטע האודיו גדול מדי", 413, "audio_too_large");
  const speaker = String(form?.get("speaker") ?? "unknown");
  const durationSeconds = Math.max(0, Math.min(60, Number(form?.get("durationSeconds") ?? 0)));
  const startMs = Number(form?.get("startMs") ?? 0) || null;
  try {
    const stt = await transcribeAudio(file, { mimeType: file.type || "audio/webm", durationSeconds });
    const r = await addSegments(call.id, stt.text ? [{ speaker: speaker === "customer" || speaker === "agent" ? speaker : "unknown", text: stt.text, startMs, endMs: startMs ? startMs + Math.round(durationSeconds * 1000) : null, source: "browser_stt" }] : [], { sttSeconds: stt.usage.sttSeconds, usage: stt.usage });
    return ok({ text: stt.text, created: r.created, analyzed: r.analyzed, state: await sessionState(call.id) });
  } catch (err) {
    if (err instanceof CoachProviderError) throw new ApiError(err.message, 502, "stt_failed");
    throw err;
  }
}, { module: "telephony" });
