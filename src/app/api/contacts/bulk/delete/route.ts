import { z } from "zod";
import { withAuth, parseBody } from "@/lib/api";
import { ok } from "@/lib/response";
import { deleteContacts, selectionSchema } from "@/server/services/contact-bulk";

export const dynamic = "force-dynamic";

/** Owner: delete the selected contacts (history kept, blocks kept). The count must be typed to confirm. */
export const POST = withAuth(async ({ req, user }) => {
  const b = await parseBody(req, z.object({ selection: selectionSchema, confirm: z.string().max(10) }));
  return ok(await deleteContacts(user, { ...b.selection, confirm: b.confirm }));
});
