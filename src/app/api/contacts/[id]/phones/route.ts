import { z } from "zod";
import { withAuth, parseBody } from "@/lib/api";
import { ok } from "@/lib/response";
import { addContactPhone, removeContactPhone } from "@/lib/crm/contacts";

export const dynamic = "force-dynamic";

export const POST = withAuth(async ({ req, user, params }) => {
  const b = await parseBody(req, z.object({ phone: z.string().min(3).max(30), label: z.string().max(40).optional() }));
  return ok(await addContactPhone(user, params.id, b.phone, b.label), 201);
});

export const DELETE = withAuth(async ({ req, user, params }) => {
  const b = await parseBody(req, z.object({ phoneId: z.string().min(1) }));
  await removeContactPhone(user, params.id, b.phoneId);
  return ok({ removed: true });
});
