import { z } from "zod";
import { withAuth, parseBody } from "@/lib/api";
import { ok } from "@/lib/response";
import { analyzeConversation } from "@/server/ai/learn";

export const dynamic = "force-dynamic";
export const maxDuration = 60;
const schema = z.object({ conversationId: z.string().min(1), messageIds: z.array(z.string()).max(300).optional(), instruction: z.string().max(500).optional() });
/** Analyze selected messages of a conversation the user may open → redacted, unsaved draft + warnings. */
export const POST = withAuth(async ({ req, user }) => ok(await analyzeConversation(user, await parseBody(req, schema))), { perm: "whatsapp.view" });
