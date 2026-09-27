import { withAuth, parseBody } from "@/lib/api";
import { ok, ApiError } from "@/lib/response";
import { prisma } from "@/lib/db";
import { conversationForLearning, saveLearned, saveSchema } from "@/server/ai/learn";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Knowledge learned from this conversation (the "הופק ממנה ידע" mark) – only for users who may open it. */
export const GET = withAuth(async ({ req, user }) => {
  const conversationId = req.nextUrl.searchParams.get("conversationId");
  if (!conversationId) throw new ApiError("חסרה שיחה", 400, "validation");
  await conversationForLearning(user, conversationId).catch((e) => { if (e instanceof ApiError && e.code === "empty") return null; throw e; });
  const items = await prisma.knowledgeSource.findMany({ where: { businessId: user.businessId, sourceConversationId: conversationId }, orderBy: { createdAt: "desc" }, select: { id: true, title: true, status: true, createdAt: true } });
  return ok({ items });
}, { module: "messaging" });

/** Save a (possibly edited) draft; publish=true only for knowledge managers. */
export const POST = withAuth(async ({ req, user }) => ok(await saveLearned(user, await parseBody(req, saveSchema)), 201), { module: "messaging" });
