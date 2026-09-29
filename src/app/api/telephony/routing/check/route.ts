import { z } from "zod";
import { withAuth, parseBody } from "@/lib/api";
import { ok } from "@/lib/response";
import { checkProvider } from "@/server/services/telephony-admin-service";

export const dynamic = "force-dynamic";

/** Read-only configuration check of a provider account (no calls, no purchases). Owner only. */
export const POST = withAuth(async ({ req }) => {
  const { provider } = await parseBody(req, z.object({ provider: z.enum(["telnyx", "mock"]) }));
  return ok(await checkProvider(provider));
}, { minRole: "owner", module: "telephony" });
