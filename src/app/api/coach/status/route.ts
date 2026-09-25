import { withAuth } from "@/lib/api";
import { ok } from "@/lib/response";
import { coachStatus } from "@/server/coach/session";

export const dynamic = "force-dynamic";

/** Is the coach on for me, and are the providers configured? (honest: missing keys are reported, never hidden) */
export const GET = withAuth(async ({ user }) => ok(await coachStatus(user.id)), { module: "telephony" });
