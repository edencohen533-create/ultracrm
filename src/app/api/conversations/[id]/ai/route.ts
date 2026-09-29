import { z } from "zod";
import { withAuth, parseBody } from "@/lib/api";
import { ok, ApiError } from "@/lib/response";
import { auth } from "@/lib/auth-compat";
import { getConversationForUser } from "@/server/services/conversation-service";
import { setConversationAiMode } from "@/server/ai/service-agent";

export const dynamic = "force-dynamic";
const schema = z.object({ mode: z.enum(["human", "ai"]) });
/** "קח טיפול" (human) / "החזר ל-AI" (ai) – only for users who may see the conversation. */
export const POST = withAuth(async ({ req, user, params }) => {
  const session = await auth();
  if (!session?.user || !(await getConversationForUser(session, params.id))) throw new ApiError("השיחה לא נמצאה", 404, "not_found");
  const { mode } = await parseBody(req, schema);
  const c = await setConversationAiMode(user.businessId, user.id, params.id, mode);
  if (!c) throw new ApiError("השיחה לא נמצאה", 404, "not_found");
  return ok({ aiMode: c.aiMode });
}, { perm: "whatsapp.reply" });
