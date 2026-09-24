import { z } from "zod";
import { withAuth, parseBody } from "@/lib/api";
import { ok } from "@/lib/response";
import { skipLead } from "@/lib/dialer/queue";

export const dynamic = "force-dynamic";

const schema = z.object({ leadId: z.string(), lockToken: z.string(), reason: z.string().min(1).max(200) });

export const POST = withAuth(async ({ req, user }) => {
  const b = await parseBody(req, schema);
  await skipLead(user.businessId, user.id, b.leadId, b.lockToken, b.reason);
  return ok({ skipped: true });
});
