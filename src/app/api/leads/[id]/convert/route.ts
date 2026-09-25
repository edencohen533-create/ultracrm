import { z } from "zod";
import { withAuth, parseBody } from "@/lib/api";
import { ok } from "@/lib/response";
import { convertLead } from "@/lib/crm/pipeline";

export const dynamic = "force-dynamic";

export const POST = withAuth(async ({ req, user, params }) => {
  const b = await parseBody(req, z.object({ title: z.string().trim().max(160).optional(), amount: z.coerce.number().min(0).optional(), currency: z.string().length(3).optional() }));
  return ok(await convertLead(user, params.id, b), 201);
}, { module: "crm" });
