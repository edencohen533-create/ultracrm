import { withAuth } from "@/lib/api";
import { ok, ApiError } from "@/lib/response";
import { prisma } from "@/lib/db";
import { processSource } from "@/server/ai/knowledge";
import { assertCanManage, getAiSettings } from "@/server/ai/settings";

export const dynamic = "force-dynamic";
export const maxDuration = 60;
/** Retry processing (links are fetched again; text sources re-chunked). Uploaded files keep their extracted text. */
export const POST = withAuth(async ({ user, params }) => {
  assertCanManage(user, (await getAiSettings(user.businessId)).ai);
  const s = await prisma.knowledgeSource.findFirst({ where: { id: params.id, businessId: user.businessId } });
  if (!s) throw new ApiError("המקור לא נמצא", 404, "not_found");
  if (s.kind === "file" && !s.content) throw new ApiError("יש להעלות את הקובץ מחדש", 409, "reupload");
  const r = await processSource(s.id);
  return ok({ ...r, source: await prisma.knowledgeSource.findUnique({ where: { id: s.id }, select: { processing: true, error: true } }) });
});
