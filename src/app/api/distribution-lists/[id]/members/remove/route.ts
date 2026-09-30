import { withAuth, parseBody } from "@/lib/api";
import { ok } from "@/lib/response";
import { removeFromList, selectionSchema } from "@/server/services/contact-bulk";

export const dynamic = "force-dynamic";

/** Remove the selected contacts from a static list (they stay in the CRM; future sends via this list are skipped). */
export const POST = withAuth(async ({ req, user, params }) => ok(await removeFromList(user, params.id, await parseBody(req, selectionSchema))));
