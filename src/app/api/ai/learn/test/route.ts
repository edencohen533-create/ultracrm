import { z } from "zod";
import { withAuth, parseBody } from "@/lib/api";
import { ok } from "@/lib/response";
import { draftSchema, testDraft } from "@/server/ai/learn";

export const dynamic = "force-dynamic";
export const maxDuration = 60;
const schema = z.object({ draft: draftSchema, question: z.string().trim().min(2).max(500) });
/** "בדוק תשובה לדוגמה": how the service agent would use the draft – nothing is saved, published or sent. */
export const POST = withAuth(async ({ req, user }) => { const b = await parseBody(req, schema); return ok(await testDraft(user, b.draft, b.question)); });
