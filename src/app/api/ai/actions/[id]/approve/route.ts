import { withAuth } from "@/lib/api";
import { ok } from "@/lib/response";
import { actionView, executeAction } from "@/server/ai/actions";
import "@/server/ai/tools"; // registers the executors

export const dynamic = "force-dynamic";
export const maxDuration = 60;
/** Explicit approval → executes exactly once; the response carries the real server status. */
export const POST = withAuth(async ({ user, params }) => ok(actionView(await executeAction(user, params.id, true))));
