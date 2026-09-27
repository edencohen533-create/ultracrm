import { withAuth, parseBody } from "@/lib/api";
import { ok, ApiError } from "@/lib/response";
import { prisma } from "@/lib/db";
import { CATEGORIES, createSource, MAX_FILE_BYTES, sourceInputSchema, type Category } from "@/server/ai/knowledge";
import { assertCanManage, getAiSettings } from "@/server/ai/settings";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export const GET = withAuth(async ({ user }) => {
  assertCanManage(user, (await getAiSettings(user.businessId)).ai);
  const rows = await prisma.knowledgeSource.findMany({ where: { businessId: user.businessId }, orderBy: { updatedAt: "desc" }, take: 300, select: { id: true, title: true, category: true, kind: true, audience: true, status: true, processing: true, error: true, url: true, fileName: true, sizeBytes: true, createdAt: true, updatedAt: true, approvedAt: true, _count: { select: { chunks: true } } } });
  return ok({ categories: CATEGORIES, items: rows.map(({ _count, ...r }) => ({ ...r, chunks: _count.chunks })) });
});

/** JSON {title, category, kind: text|link, content|url} or multipart (file, title, category). New = draft + internal. */
export const POST = withAuth(async ({ req, user }) => {
  assertCanManage(user, (await getAiSettings(user.businessId)).ai);
  if ((req.headers.get("content-type") ?? "").startsWith("multipart/form-data")) {
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) throw new ApiError("לא נבחר קובץ", 400, "no_file");
    if (file.size > MAX_FILE_BYTES) throw new ApiError("הקובץ גדול מ-5MB", 400, "file_too_large");
    const category = String(form.get("category") ?? "docs") as Category;
    if (!(category in CATEGORIES)) throw new ApiError("קטגוריה לא תקינה", 400, "validation");
    const src = await createSource(user, { kind: "file", title: String(form.get("title") || file.name).slice(0, 200), category, fileName: file.name, mimeType: file.type || "application/octet-stream", bytes: Buffer.from(await file.arrayBuffer()) });
    return ok(src, 201);
  }
  return ok(await createSource(user, await parseBody(req, sourceInputSchema)), 201);
});
