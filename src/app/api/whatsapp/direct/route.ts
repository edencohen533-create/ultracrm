import { z } from "zod";
import { withAuth, parseBody } from "@/lib/api";
import { ok } from "@/lib/response";
import { connectDirect, directOverview } from "@/server/services/whatsapp-direct-service";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Direct (single-business) connection status: which server settings are missing – names only, never values. */
export const GET = withAuth(async ({ user }) => ok(directOverview(user.businessId)), { minRole: "manager", perm: "whatsapp.connect" });

/** Connect the number configured in the server environment (owner only; checked again in the service). */
export const POST = withAuth(async ({ req, user }) => {
  const b = await parseBody(req, z.object({ label: z.string().trim().max(100).optional() }));
  return ok(await connectDirect(user, { label: b.label }));
}, { minRole: "manager", perm: "whatsapp.connect" });
