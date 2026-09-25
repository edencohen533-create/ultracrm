import { withAuth, parseBody } from "@/lib/api";
import { ok } from "@/lib/response";
import { createNote, noteInputSchema } from "@/lib/crm/pipeline";

export const dynamic = "force-dynamic";

export const POST = withAuth(async ({ req, user }) => ok(await createNote(user, await parseBody(req, noteInputSchema)), 201));
