import { z } from "zod";
import { withAuth, parseBody } from "@/lib/api";
import { ok } from "@/lib/response";
import { checkProvider } from "@/server/services/telephony-admin-service";

export const dynamic = "force-dynamic";

/** Read-only configuration check of a provider account (no calls, no purchases). Owner only. */
export const POST = withAuth(async ({ req, user }) => {
  const { provider } = await parseBody(req, z.object({ provider: z.enum(["telnyx", "mock", "zadarma"]) }));
  return ok(await checkProvider(provider, user.businessId, user));
}, { minRole: "owner", module: "telephony" });
