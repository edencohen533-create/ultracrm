import { z } from "zod";
import { withAuth, parseBody } from "@/lib/api";
import { ok } from "@/lib/response";
import { activeMonitorFor, startMonitor } from "@/lib/dialer/monitor";

export const dynamic = "force-dynamic";

/** Join a live call as a listen-only supervisor. Server re-checks team scope and call liveness. */
export const POST = withAuth(async ({ req, user }) => {
  const b = await parseBody(req, z.object({ callId: z.string() }));
  return ok(await startMonitor(user, b.callId));
}, { minRole: "manager" });

/** The caller's active monitor, if any. */
export const GET = withAuth(async ({ user }) => ok(await activeMonitorFor(user.id)), { minRole: "manager" });
