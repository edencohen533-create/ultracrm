import { z } from "zod";
import { withAuth, parseBody } from "@/lib/api";
import { ok } from "@/lib/response";
import { cancelSignup } from "@/server/services/embedded-signup-service";

export const dynamic = "force-dynamic";

export const POST = withAuth(async ({ req, user }) => {
  const b = await parseBody(req, z.object({ state: z.string().min(20).max(200), reason: z.string().max(300).optional(), step: z.string().max(100).optional() }));
  return ok(await cancelSignup(user, b.state, b.reason, b.step));
}, { minRole: "manager", module: "messaging" });
