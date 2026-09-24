import { z } from "zod";
import { withAuth, parseBody } from "@/lib/api";
import { ok } from "@/lib/response";
import { endSession, pauseSession, resumeSession, startSession } from "@/lib/dialer/session";

export const dynamic = "force-dynamic";

const startSchema = z.object({
  mode: z.enum(["manual", "preview", "power"]),
  listId: z.string().optional(),
  browserSessionId: z.string().min(8),
  countdownSeconds: z.number().int().min(0).max(60).optional(),
});

export const POST = withAuth(async ({ req, user }) => {
  const body = await parseBody(req, startSchema);
  return ok(await startSession(user, body));
});

const patchSchema = z.object({ sessionId: z.string(), browserSessionId: z.string(), action: z.enum(["pause", "resume"]) });

export const PATCH = withAuth(async ({ req, user }) => {
  const b = await parseBody(req, patchSchema);
  if (b.action === "pause") await pauseSession(user, b.sessionId, b.browserSessionId);
  else await resumeSession(user, b.sessionId, b.browserSessionId);
  return ok({ status: b.action === "pause" ? "paused" : "active" });
});

const endSchema = z.object({ sessionId: z.string(), browserSessionId: z.string() });

export const DELETE = withAuth(async ({ req, user }) => {
  const b = await parseBody(req, endSchema);
  await endSession(user, b.sessionId, b.browserSessionId);
  return ok({ status: "ended" });
});
