import { z } from "zod";
import { withAuth, parseBody } from "@/lib/api";
import { ok } from "@/lib/response";
import { startCall } from "@/lib/dialer/calls";

export const dynamic = "force-dynamic";

const schema = z.object({
  idempotencyKey: z.string().min(8).max(100),
  mode: z.enum(["manual", "preview", "power"]),
  sessionId: z.string().optional(),
  browserSessionId: z.string().optional(),
  leadId: z.string().optional(),
  lockToken: z.string().optional(),
  contactId: z.string().optional(),
  phone: z.string().optional(),
  phoneNumberId: z.string().optional(),
});

export const POST = withAuth(async ({ req, user }) => {
  const b = await parseBody(req, schema);
  return ok(await startCall(user, b));
});
