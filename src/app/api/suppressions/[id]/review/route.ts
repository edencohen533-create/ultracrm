import { z } from "zod";
import { withAuth, parseBody } from "@/lib/api";
import { ok } from "@/lib/response";
import { reviewSuppression } from "@/lib/suppression";

export const dynamic = "force-dynamic";
/** Resolve an unsubscribe request held for review: confirm (keep block) or dismiss (documented). */
export const POST = withAuth(async ({ req, user, params }) => {
  const b = await parseBody(req, z.object({ action: z.enum(["confirm", "dismiss"]), note: z.string().max(500).default("") }));
  return ok(await reviewSuppression(user.businessId, params.id, b.action, user.id, b.note));
}, { minRole: "manager" });
