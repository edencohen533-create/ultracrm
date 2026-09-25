import { z } from "zod";
import { withAuth, parseBody } from "@/lib/api";
import { ok } from "@/lib/response";
import { mergeContacts } from "@/lib/crm/contacts";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Merge another contact INTO this one (this one survives). Managers/owners only; never automatic. */
export const POST = withAuth(async ({ req, user, params }) => {
  const b = await parseBody(req, z.object({ duplicateId: z.string().min(1) }));
  return ok(await mergeContacts(user, params.id, b.duplicateId));
}, { minRole: "manager", module: "crm" });
