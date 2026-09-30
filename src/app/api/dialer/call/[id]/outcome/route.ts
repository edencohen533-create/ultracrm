import { z } from "zod";
import { withAuth, parseBody } from "@/lib/api";
import { ok } from "@/lib/response";
import { saveOutcome } from "@/lib/dialer/calls";

export const dynamic = "force-dynamic";

/**
 * Wrap-up: the CRM status the agent chose (`statusId` – business handling, the CRM's own statuses) and/or a technical
 * telephony result (`outcome`: no answer / busy / wrong number / do-not-contact). A follow-up status needs `followUp`
 * (the business's local date + time). Older clients may still send the previous business outcomes.
 */
const schema = z.object({
  outcome: z.enum(["answered_interested", "answered_not_interested", "callback", "no_answer", "busy", "wrong_number", "sale", "dnc"]).optional(),
  statusId: z.string().min(1).optional(),
  followUp: z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), time: z.string().regex(/^\d{2}:\d{2}$/) }).optional(),
  note: z.string().max(4000).optional(),
  callbackUserId: z.string().min(1).optional(),
  callbackAt: z.string().datetime({ offset: true }).optional(),
  contactUpdates: z
    .object({ fullName: z.string().min(1).max(120).optional(), email: z.string().email().or(z.literal("")).optional(), company: z.string().max(120).optional(), city: z.string().max(80).optional() })
    .optional(),
});

export const POST = withAuth(async ({ req, user, params }) => {
  const b = await parseBody(req, schema);
  const call = await saveOutcome(user, {
    callId: params.id,
    outcome: b.statusId ? undefined : b.outcome,
    statusId: b.statusId,
    followUp: b.followUp,
    note: b.note,
    callbackUserId: b.callbackUserId,
    callbackAt: b.callbackAt ? new Date(b.callbackAt) : undefined,
    contactUpdates: b.contactUpdates,
  });
  return ok(call);
}, { module: "telephony" });
