import { z } from "zod";
import { withAuth, parseBody } from "@/lib/api";
import { ok } from "@/lib/response";
import { saveOutcome } from "@/lib/dialer/calls";

export const dynamic = "force-dynamic";

const schema = z.object({
  outcome: z.enum(["answered_interested", "answered_not_interested", "callback", "no_answer", "busy", "wrong_number", "sale", "dnc"]),
  note: z.string().max(4000).optional(),
  callbackAt: z.string().datetime({ offset: true }).optional(),
  contactUpdates: z
    .object({ fullName: z.string().min(1).max(120).optional(), email: z.string().email().or(z.literal("")).optional(), company: z.string().max(120).optional(), city: z.string().max(80).optional() })
    .optional(),
});

export const POST = withAuth(async ({ req, user, params }) => {
  const b = await parseBody(req, schema);
  const call = await saveOutcome(user, {
    callId: params.id,
    outcome: b.outcome,
    note: b.note,
    callbackAt: b.callbackAt ? new Date(b.callbackAt) : undefined,
    contactUpdates: b.contactUpdates,
  });
  return ok(call);
});
