import { z } from "zod";
import { withAuth, parseBody } from "@/lib/api";
import { ok, ApiError } from "@/lib/response";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { CATEGORIES, processSource, type Category } from "@/server/ai/knowledge";
import { assertCanManage, getAiSettings } from "@/server/ai/settings";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function load(user: { businessId: string }, id: string) {
  const s = await prisma.knowledgeSource.findFirst({ where: { id, businessId: user.businessId } });
  if (!s) throw new ApiError("המקור לא נמצא", 404, "not_found");
  return s;
}

export const GET = withAuth(async ({ user, params }) => {
  assertCanManage(user, (await getAiSettings(user.businessId)).ai);
  const s = await load(user, params.id);
  return ok({ ...s, content: s.content.slice(0, 20000) });
});

const schema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  category: z.enum(Object.keys(CATEGORIES) as [Category, ...Category[]]).optional(),
  audience: z.enum(["internal", "customer"]).optional(),
  status: z.enum(["draft", "approved", "retired"]).optional(),
  acknowledgeConflicts: z.boolean().optional(),
  /** Explicit sharing with the sales coach (only approved sources). */
  salesShared: z.boolean().optional(),
  content: z.string().max(400_000).optional(),
});

/** Edit / approve / change audience. Editing the content re-processes it and returns the source to draft. */
export const PATCH = withAuth(async ({ req, user, params }) => {
  assertCanManage(user, (await getAiSettings(user.businessId)).ai);
  const s = await load(user, params.id);
  const b = await parseBody(req, schema);
  // Learned-from-conversation items: approval checks contradictions and retires the item they replace.
  if (b.status === "approved" && s.kind === "conversation" && b.content === undefined) {
    const { approveLearned } = await import("@/server/ai/learn");
    await approveLearned(user, s.id, Boolean(b.acknowledgeConflicts));
    return ok(await load(user, s.id));
  }
  if (b.salesShared === true && (b.status ?? s.status) !== "approved") throw new ApiError("אפשר לשתף עם מאמן המכירות רק ידע מאושר", 409, "not_approved");
  const contentChanged = b.content !== undefined && s.kind === "text" && b.content !== s.content;
  if (b.status === "approved" && s.processing !== "ready" && !contentChanged) throw new ApiError("אפשר לאשר רק מקור שעיבודו הסתיים בהצלחה", 409, "not_ready");
  const approve = b.status === "approved" && !contentChanged;
  await prisma.knowledgeSource.update({ where: { id: s.id }, data: {
    ...(b.title ? { title: b.title } : {}), ...(b.category ? { category: b.category } : {}), ...(b.audience ? { audience: b.audience } : {}), ...(b.salesShared !== undefined ? { salesShared: b.salesShared } : {}),
    ...(contentChanged ? { content: b.content, status: "draft", approvedById: null, approvedAt: null } : {}),
    ...(approve ? { status: "approved", approvedById: user.id, approvedAt: new Date() } : b.status === "draft" ? { status: "draft", approvedById: null, approvedAt: null } : b.status === "retired" ? { status: "retired" } : {}),
  } });
  if (contentChanged) await processSource(s.id);
  await audit(user.businessId, user.id, "knowledge", s.id, "knowledge.updated", { fields: Object.keys(b), approved: approve, audience: b.audience, salesShared: b.salesShared });
  return ok(await load(user, s.id));
});

export const DELETE = withAuth(async ({ user, params }) => {
  assertCanManage(user, (await getAiSettings(user.businessId)).ai);
  const s = await load(user, params.id);
  await prisma.knowledgeSource.delete({ where: { id: s.id } }); // chunks cascade – immediately gone from retrieval
  await audit(user.businessId, user.id, "knowledge", s.id, "knowledge.deleted", { title: s.title });
  return ok({ deleted: true });
});
