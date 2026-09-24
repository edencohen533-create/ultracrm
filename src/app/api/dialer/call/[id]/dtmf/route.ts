import { z } from "zod";
import { withAuth, parseBody } from "@/lib/api";
import { ok } from "@/lib/response";
import { sendDtmf } from "@/lib/dialer/calls";

export const dynamic = "force-dynamic";

const schema = z.object({ digits: z.string().min(1).max(32) });

export const POST = withAuth(async ({ req, user, params }) => {
  const b = await parseBody(req, schema);
  await sendDtmf(user, params.id, b.digits);
  return ok({ sent: true });
});
