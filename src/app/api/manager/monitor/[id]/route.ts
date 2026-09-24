import { z } from "zod";
import { withAuth, parseBody } from "@/lib/api";
import { ok } from "@/lib/response";
import { monitorState, stopMonitor, switchMode } from "@/lib/dialer/monitor";

export const dynamic = "force-dynamic";

export const GET = withAuth(async ({ user, params }) => ok(await monitorState(user, params.id)), { minRole: "manager" });

/** Explicit mode switch: { mode: "listen" | "whisper" }. Whisper is never the default. */
export const PATCH = withAuth(async ({ req, user, params }) => {
  const b = await parseBody(req, z.object({ mode: z.enum(["listen", "whisper"]) }));
  return ok(await switchMode(user, params.id, b.mode));
}, { minRole: "manager" });

/** Leave: only the supervisor leg is hung up; agent and customer stay connected. */
export const DELETE = withAuth(async ({ user, params }) => ok(await stopMonitor(user, params.id)), { minRole: "manager" });
