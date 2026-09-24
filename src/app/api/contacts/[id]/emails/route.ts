import { z } from "zod";
import { withAuth, parseBody } from "@/lib/api";
import { ok } from "@/lib/response";
import { addContactEmail, removeContactEmail } from "@/lib/crm/contacts";

export const dynamic = "force-dynamic";

export const POST = withAuth(async ({ req, user, params }) => {
  const b = await parseBody(req, z.object({ email: z.string().min(3).max(200), label: z.string().max(40).optional() }));
  return ok(await addContactEmail(user, params.id, b.email, b.label), 201);
});

export const DELETE = withAuth(async ({ req, user, params }) => {
  const b = await parseBody(req, z.object({ emailId: z.string().min(1) }));
  await removeContactEmail(user, params.id, b.emailId);
  return ok({ removed: true });
});
