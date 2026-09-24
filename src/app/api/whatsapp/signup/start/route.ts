import { withAuth } from "@/lib/api";
import { ok } from "@/lib/response";
import { startSignup } from "@/server/services/embedded-signup-service";

export const dynamic = "force-dynamic";

/** Owner/manager: open an Embedded Signup attempt bound to this business + user. */
export const POST = withAuth(async ({ user }) => {
  const r = await startSignup(user);
  return ok({ state: r.session.state, expiresAt: r.session.expiresAt.toISOString(), appId: r.appId, configId: r.configId, version: r.version, reused: r.reused });
}, { minRole: "manager", module: "messaging" });
