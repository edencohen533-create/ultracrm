import { withAuth, parseBody } from "@/lib/api";
import { ok } from "@/lib/response";
import { audit } from "@/lib/audit";
import { importLeads, leadImportSchema } from "@/lib/crm/lead-import";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Manager: import a chunk of lead rows (the browser parses Excel/CSV and sends up to 500 rows per request). */
export const POST = withAuth(async ({ req, user }) => {
  const b = await parseBody(req, leadImportSchema);
  const r = await importLeads(user, b);
  await audit(user.businessId, user.id, "lead", "import", "lead.imported", { rows: b.rows.length, owner: b.owner, created: r.created, exists: r.exists, invalid: r.invalid });
  return ok(r);
}, { minRole: "manager", perm: "crm.create" });
