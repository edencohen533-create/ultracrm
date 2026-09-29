import { z } from "zod";
import { withAuth, parseBody } from "@/lib/api";
import { ok } from "@/lib/response";
import { setZadarmaExtensions } from "@/server/services/zadarma-admin-service";

export const dynamic = "force-dynamic";

/** Map agents to their Zadarma PBX extensions. Owner only. */
export const PUT = withAuth(async ({ req, user }) => {
  const b = await parseBody(req, z.object({ items: z.array(z.object({ userId: z.string().min(1), extension: z.string().max(8).nullable() })).max(500) }));
  return ok(await setZadarmaExtensions(user.businessId, user.id, b.items));
}, { minRole: "owner", module: "telephony" });
