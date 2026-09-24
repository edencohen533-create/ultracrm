import { z } from "zod";
import { withAuth, parseBody } from "@/lib/api";
import { ok } from "@/lib/response";
import { transferLead } from "@/lib/dialer/queue";

export const dynamic = "force-dynamic";

const schema = z.object({ toUserId: z.string().nullable(), note: z.string().max(300).optional() });

/** Manager: hand a lead to another agent (or back to the pool with null). Audited. */
export const POST = withAuth(async ({ req, user, params }) => {
  const b = await parseBody(req, schema);
  return ok(await transferLead(user.businessId, user.id, params.id, b.toUserId, b.note));
}, { minRole: "manager" });
