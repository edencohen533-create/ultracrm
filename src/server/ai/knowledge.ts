/**
 * Business knowledge for "עוזר AI": text / document / link sources → extracted text → chunks → full-text retrieval.
 * New sources are DRAFT + INTERNAL. Only APPROVED sources are retrieved; the customer-service agent retrieves only
 * approved sources marked "customer". Retrieval is always filtered by business (and RLS underneath), and returns a
 * few relevant chunks – never the whole knowledge base. Source text is untrusted data (never instructions).
 */
import { z } from "zod";
import { Prisma } from "@/generated/prisma/client";
import { prisma, dbSchema } from "@/lib/db";
import { ApiError } from "@/lib/response";
import { audit } from "@/lib/audit";
import { safeFetch } from "@/lib/safe-url";
import type { SessionUser } from "@/lib/auth";

export const CATEGORIES = { business: "פרטי העסק ושעות פעילות", products: "מוצרים ושירותים", faq: "שאלות ותשובות", policy: "משלוחים, ביטולים והחזרות", guidelines: "הנחיות שירות ומכירה", docs: "מסמכים ומקורות" } as const;
export type Category = keyof typeof CATEGORIES;
export const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_LINK_BYTES = 3 * 1024 * 1024;
const MAX_TEXT = 400_000;
const T = (t: string) => Prisma.raw(`"${dbSchema()}"."${t}"`);

export const sourceInputSchema = z.object({
  title: z.string().trim().min(1).max(200),
  category: z.enum(Object.keys(CATEGORIES) as [Category, ...Category[]]),
  kind: z.enum(["text", "link"]),
  content: z.string().max(MAX_TEXT).optional(),
  url: z.string().trim().max(2000).optional(),
});

const decode = (s: string) => s.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#39;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
export function htmlToText(html: string) {
  return decode(html.replace(/<(script|style|noscript|svg|head)[\s\S]*?<\/\1>/gi, " ").replace(/<(br|\/p|\/div|\/li|\/h\d|\/tr)>/gi, "\n").replace(/<[^>]+>/g, " ")).replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n\n").trim();
}

/** Extract plain text from an uploaded file (allow-listed types only). */
export async function extractFile(bytes: Buffer, fileName: string, mime: string) {
  if (bytes.length > MAX_FILE_BYTES) throw new ApiError("הקובץ גדול מ-5MB", 400, "file_too_large");
  const ext = fileName.toLowerCase().split(".").pop() ?? "";
  if (ext === "pdf" || mime === "application/pdf") {
    const { extractText, getDocumentProxy } = await import("unpdf");
    const pdf = await getDocumentProxy(new Uint8Array(bytes));
    const { text } = await extractText(pdf, { mergePages: true });
    return String(text);
  }
  if (["txt", "md", "csv", "json"].includes(ext) || /^text\/(plain|markdown|csv)$/.test(mime)) return bytes.toString("utf8");
  if (["html", "htm"].includes(ext) || mime === "text/html") return htmlToText(bytes.toString("utf8"));
  throw new ApiError("סוג קובץ לא נתמך. אפשר להעלות PDF, TXT, MD, CSV, HTML", 400, "unsupported_type");
}

/** Fetch a public https page (SSRF-guarded, size-limited) and return its text. */
async function fetchLink(url: string) {
  const res = await safeFetch(url, { timeoutMs: 15_000, headers: { "user-agent": "UltraCRM-Knowledge/1" } });
  if (res.status >= 300 && res.status < 400) throw new Error("הקישור מפנה לכתובת אחרת – הזן את הכתובת הסופית");
  if (!res.ok) throw new Error(`הקישור החזיר שגיאה ${res.status}`);
  const len = Number(res.headers.get("content-length") ?? 0); if (len > MAX_LINK_BYTES) throw new Error("הדף גדול מדי");
  const buf = Buffer.from(await res.arrayBuffer()); if (buf.length > MAX_LINK_BYTES) throw new Error("הדף גדול מדי");
  const type = (res.headers.get("content-type") ?? "").split(";")[0].trim();
  if (type === "application/pdf") return extractFile(buf, "link.pdf", type);
  if (type === "text/html" || type === "application/xhtml+xml") return htmlToText(buf.toString("utf8"));
  if (type.startsWith("text/")) return buf.toString("utf8");
  throw new Error(`סוג תוכן לא נתמך בקישור (${type || "לא ידוע"})`);
}

/** ~700-char chunks on paragraph/sentence boundaries with a small overlap. */
export function chunkText(text: string, size = 700, overlap = 120) {
  const clean = text.replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").trim();
  if (!clean) return [];
  const parts = clean.split(/\n\n|(?<=[.!?])\s+/).map((p) => p.trim()).filter(Boolean);
  const chunks: string[] = []; let cur = "";
  for (const p of parts) {
    if ((cur + " " + p).length > size && cur) { chunks.push(cur); cur = cur.slice(-overlap) + " " + p; }
    else cur = cur ? `${cur} ${p}` : p;
    while (cur.length > size * 1.6) { chunks.push(cur.slice(0, size)); cur = cur.slice(size - overlap); }
  }
  if (cur.trim()) chunks.push(cur);
  return chunks.slice(0, 2000);
}

/** (Re)process a source: extract → chunk → replace its chunks atomically. Failure is stored and shown with retry. */
export async function processSource(sourceId: string, fileText?: string) {
  const src = await prisma.knowledgeSource.findUnique({ where: { id: sourceId } });
  if (!src) return null;
  await prisma.knowledgeSource.update({ where: { id: src.id }, data: { processing: "processing", error: null } });
  try {
    const text = src.kind === "link" ? await fetchLink(src.url ?? "") : src.kind === "file" ? (fileText ?? src.content) : src.content;
    if (!text.trim()) throw new Error("לא נמצא טקסט במקור");
    const chunks = chunkText(text.slice(0, MAX_TEXT));
    await prisma.$transaction(async (tx) => {
      await tx.knowledgeChunk.deleteMany({ where: { sourceId: src.id } });
      await tx.knowledgeChunk.createMany({ data: chunks.map((t, i) => ({ businessId: src.businessId, sourceId: src.id, position: i, text: t })) });
      await tx.knowledgeSource.update({ where: { id: src.id }, data: { processing: "ready", error: null, content: src.kind === "text" ? src.content : text.slice(0, MAX_TEXT) } });
    });
    return { chunks: chunks.length };
  } catch (e) {
    await prisma.knowledgeSource.update({ where: { id: src.id }, data: { processing: "failed", error: (e as Error).message.slice(0, 300) } });
    return { error: (e as Error).message };
  }
}

export async function createSource(user: SessionUser, input: z.infer<typeof sourceInputSchema> | { title: string; category: Category; kind: "file"; fileName: string; mimeType: string; bytes: Buffer }) {
  let fileText: string | undefined;
  const base = { businessId: user.businessId, title: input.title, category: input.category, kind: input.kind, audience: "internal", status: "draft", processing: "pending", createdById: user.id };
  let data: Prisma.KnowledgeSourceUncheckedCreateInput;
  if (input.kind === "file") {
    fileText = await extractFile(input.bytes, input.fileName, input.mimeType);
    data = { ...base, fileName: input.fileName.slice(0, 200), mimeType: input.mimeType.slice(0, 100), sizeBytes: input.bytes.length };
  } else if (input.kind === "link") {
    if (!input.url) throw new ApiError("יש להזין קישור", 400, "invalid_url");
    const { assertPublicHttpsUrl } = await import("@/lib/safe-url");
    data = { ...base, url: assertPublicHttpsUrl(input.url, "הקישור").toString() };
  } else {
    if (!input.content?.trim()) throw new ApiError("יש לכתוב תוכן", 400, "empty");
    data = { ...base, content: input.content };
  }
  const src = await prisma.knowledgeSource.create({ data });
  await audit(user.businessId, user.id, "knowledge", src.id, "knowledge.created", { kind: src.kind, category: src.category });
  await processSource(src.id, fileText);
  return prisma.knowledgeSource.findUniqueOrThrow({ where: { id: src.id } });
}

// ─── retrieval ─────────────────────────────────────────────────────────────────────────────────────────────────
const STOP = new Set(["של", "את", "על", "עם", "זה", "זו", "מה", "איך", "כמה", "יש", "אין", "לא", "כן", "אני", "אתם", "אתה", "הוא", "היא", "או", "גם", "אם", "כי", "the", "and", "for", "you", "what", "how", "is", "a", "to", "of"]);
/** Hebrew-friendly query terms: tokens + the token without a one-letter prefix (ו/ה/ב/ל/מ/ש/כ), prefix-matched. */
export function queryTerms(q: string) {
  const words = q.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 1 && !STOP.has(w));
  const terms = new Set<string>();
  for (const w of words.slice(0, 12)) { terms.add(w); if (w.length > 3 && /^[והבלמשכ]/.test(w)) terms.add(w.slice(1)); if (w.length > 4 && /^(וה|שה|וב|ול|מה|כש)/.test(w)) terms.add(w.slice(2)); }
  return [...terms].filter((t) => /^[\p{L}\p{N}]+$/u.test(t));
}

export interface Retrieved { chunkId: string; sourceId: string; title: string; category: string; audience: string; kind: string; learnMode: string | null; text: string; rank: number }
/**
 * Top chunks for a query. audience "customer" = only approved + customer-facing sources (customer-service agent);
 * "internal" = approved sources of any audience (internal assistant); "sales" = approved sources shared with the sales
 * coach. includeDrafts only for the owner's preview (never for "sales").
 */
export async function searchKnowledge(businessId: string, query: string, opts: { audience: "customer" | "internal" | "sales"; includeDrafts?: boolean; limit?: number }): Promise<Retrieved[]> {
  const terms = queryTerms(query); if (!terms.length) return [];
  const tsq = terms.map((t) => `${t}:*`).join(" | ");
  // "sales" = the sales coach: only approved sources the business explicitly shared with it (facts, not phrasing).
  const aud = opts.audience === "customer" ? Prisma.sql`AND s.audience = 'customer'` : opts.audience === "sales" ? Prisma.sql`AND s.sales_shared = true` : Prisma.empty;
  const st = opts.includeDrafts && opts.audience !== "sales" ? Prisma.empty : Prisma.sql`AND s.status = 'approved'`;
  return prisma.$queryRaw<Retrieved[]>(Prisma.sql`
    SELECT c.id AS "chunkId", s.id AS "sourceId", s.title, s.category, s.audience, s.kind, s.learn_mode AS "learnMode", c.text, ts_rank(c.tsv, to_tsquery('simple', ${tsq}))::float AS rank
    FROM ${T("knowledge_chunks")} c JOIN ${T("knowledge_sources")} s ON s.id = c.source_id
    WHERE c.business_id = ${businessId} AND s.business_id = ${businessId} AND s.processing = 'ready' ${st} ${aud}
      AND c.tsv @@ to_tsquery('simple', ${tsq})
    ORDER BY rank DESC, c.position ASC LIMIT ${opts.limit ?? 5}`);
}
