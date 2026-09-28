import { z } from "zod";
import { withAuth, parseBody } from "@/lib/api";
import { ok } from "@/lib/response";
import { acknowledgeSignal, cancelSignal, confirmSignal } from "@/lib/dialer/availability";

export const dynamic = "force-dynamic";
const schema = z.object({ action: z.enum(["cancel", "ack", "confirm"]), date: z.string().optional(), time: z.string().optional(), now: z.boolean().optional() });
/** cancel = remove the priority · ack = seen · confirm = set the time of an unclear "later" (or "now") after review. */
export const POST = withAuth(async ({ req, user, params }) => {
  const b = await parseBody(req, schema);
  if (b.action === "cancel") await cancelSignal(user, params.id);
  else if (b.action === "ack") await acknowledgeSignal(user, params.id);
  else await confirmSignal(user, params.id, b);
  return ok({ ok: true });
}, { perm: "telephony.use" });
