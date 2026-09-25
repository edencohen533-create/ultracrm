import { z } from "zod";
import { withAuth, parseBody } from "@/lib/api";
import { ok } from "@/lib/response";
import { contactInputSchema, importContacts } from "@/lib/crm/contacts";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const schema = z.object({ rows: z.array(contactInputSchema).min(1).max(5000), source: z.string().max(100).optional() });

export const POST = withAuth(async ({ req, user }) => {
  const b = await parseBody(req, schema);
  return ok(await importContacts(user, b.rows, b.source));
}, { minRole: "manager" });
