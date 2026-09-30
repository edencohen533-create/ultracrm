import { withAuth, parseBody } from "@/lib/api";
import { ok } from "@/lib/response";
import { deletionImpact, selectionSchema } from "@/server/services/contact-bulk";

export const dynamic = "force-dynamic";

/** What deleting the selected contacts would do (owner only) – nothing changes. */
export const POST = withAuth(async ({ req, user }) => ok(await deletionImpact(user, await parseBody(req, selectionSchema))));
