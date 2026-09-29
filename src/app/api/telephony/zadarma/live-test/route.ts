import { z } from "zod";
import { withAuth, parseBody } from "@/lib/api";
import { ok } from "@/lib/response";
import { startZadarmaLiveTest } from "@/server/services/zadarma-admin-service";

export const dynamic = "force-dynamic";

/** One paid test call through Zadarma to an owner-approved TEST number (never a customer). Owner only. */
export const POST = withAuth(async ({ req, user }) => {
  const { to } = await parseBody(req, z.object({ to: z.string().min(6).max(30) }));
  return ok(await startZadarmaLiveTest(user, to));
}, { minRole: "owner", module: "telephony" });
