import { z } from "zod";
import { withAuth, parseBody } from "@/lib/api";
import { ok } from "@/lib/response";
import { heartbeat } from "@/lib/dialer/session";

export const dynamic = "force-dynamic";

const schema = z.object({ sessionId: z.string().nullable(), browserSessionId: z.string() });

export const POST = withAuth(async ({ req, user }) => {
  const b = await parseBody(req, schema);
  return ok(await heartbeat(user, b.sessionId, b.browserSessionId));
});
