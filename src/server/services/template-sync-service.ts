import { requireBusinessId } from "@/lib/tenant";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { templateParameterKeys } from "@/lib/campaigns";
import { metaConfigOf, GRAPH_VERSION } from "@/lib/meta/graph";
import type { Prisma, TemplateStatus } from "@/generated/prisma/client";

const remoteTemplate = z.object({
  id: z.string().min(1), name: z.string().min(1), language: z.string().min(1),
  status: z.string(), category: z.enum(["MARKETING", "UTILITY", "AUTHENTICATION"]),
  components: z.array(z.object({ type: z.string(), text: z.string().optional(), format: z.string().optional(), buttons: z.array(z.object({ type: z.string(), text: z.string().optional(), url: z.string().optional(), phone_number: z.string().optional(), example: z.unknown().optional() }).passthrough()).optional() }).passthrough()),
});
const pageSchema = z.object({ data: z.array(remoteTemplate), paging: z.object({ next: z.string().optional(), cursors: z.object({ after: z.string().optional() }).optional() }).optional() });
export class TemplateSyncError extends Error {}

const SUPPORTED_BUTTONS = new Set(["QUICK_REPLY", "URL", "PHONE_NUMBER", "COPY_CODE"]);
const SUPPORTED_HEADERS = new Set(["TEXT", "IMAGE", "VIDEO", "DOCUMENT"]);

/**
 * Supported Meta structures: BODY (numbered params), FOOTER, HEADER (text without params, or
 * IMAGE/VIDEO/DOCUMENT supplied as a link at send time) and BUTTONS (quick reply, static or
 * dynamic URL, phone number, copy code). Anything else is imported as unsendable with a reason.
 */
export function mapRemoteTemplate(template: z.infer<typeof remoteTemplate>) {
  const body = template.components.find((component) => component.type === "BODY")?.text ?? "";
  const header = template.components.find((component) => component.type === "HEADER");
  const headerFormat = header?.format?.toUpperCase() ?? (header ? "TEXT" : null);
  const buttonComponent = template.components.find((component) => component.type === "BUTTONS");
  const buttons = (buttonComponent?.buttons ?? []).map((b) => ({ type: b.type.toUpperCase(), text: b.text ?? "", url: b.url ?? null, phone: b.phone_number ?? null, dynamic: b.type.toUpperCase() === "URL" && /\{\{\d+\}\}/.test(b.url ?? "") }));
  const reasons: string[] = [];
  if (!body) reasons.push("אין גוף טקסט");
  if ([...body.matchAll(/\{\{([^}]+)\}\}/g)].some((match) => !/^\d+$/.test(match[1])) || templateParameterKeys(body).some((key, index) => Number(key) !== index + 1)) reasons.push("משתני גוף לא ממוספרים ברצף");
  if (template.components.some((component) => !["BODY", "FOOTER", "HEADER", "BUTTONS"].includes(component.type))) reasons.push("רכיב לא מוכר");
  if (header && (!headerFormat || !SUPPORTED_HEADERS.has(headerFormat))) reasons.push(`כותרת מסוג ${headerFormat ?? "?"} אינה נתמכת`);
  if (headerFormat === "TEXT" && /\{\{/.test(header?.text ?? "")) reasons.push("כותרת טקסט עם משתנה אינה נתמכת עדיין");
  if (buttons.some((b) => !SUPPORTED_BUTTONS.has(b.type))) reasons.push("סוג כפתור לא נתמך");
  const unsupported = reasons.length > 0;
  const status: TemplateStatus = unsupported ? "DRAFT" : template.status === "APPROVED" ? "APPROVED" : template.status === "PENDING" ? "PENDING_APPROVAL" : template.status === "PAUSED" ? "PAUSED" : template.status === "DISABLED" ? "DISABLED" : "REJECTED";
  return {
    name: template.name, language: template.language, category: template.category, body,
    variables: templateParameterKeys(body), status, providerTemplateId: template.id,
    components: template.components as unknown as Prisma.InputJsonValue, headerFormat, buttons: buttons as unknown as Prisma.InputJsonValue,
    syncError: unsupported ? `התבנית מכילה רכיבים שאינם נתמכים: ${reasons.join(", ")}` : null,
  };
}

export async function syncMetaTemplates() {
  const credential = await prisma.providerCredential.findFirst({ where: { isActive: true, provider: "meta_whatsapp_cloud_api", sendingBlocked: false }, orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }] });
  if (!credential) throw new TemplateSyncError("יש לחבר תחילה את Meta בהגדרות וואטסאפ");
  const config = metaConfigOf(credential.config);
  if (!config.businessAccountId || !/^\d+$/.test(config.businessAccountId)) throw new TemplateSyncError("יש להגדיר WhatsApp Business Account ID בהגדרות החיבור");
  const templates: z.infer<typeof remoteTemplate>[] = [];
  let cursor: string | undefined;
  const seen = new Set<string>();
  // Build every page URL ourselves; never send credentials to paging.next.
  for (let page = 0; page < 20; page++) {
    const url = new URL(`https://graph.facebook.com/${config.apiVersion ?? GRAPH_VERSION}/${config.businessAccountId}/message_templates`);
    url.searchParams.set("fields", "id,name,language,status,category,components"); url.searchParams.set("limit", "100");
    if (cursor) url.searchParams.set("after", cursor);
    const response = await fetch(url, { headers: { Authorization: `Bearer ${config.accessToken}` }, signal: AbortSignal.timeout(10000), redirect: "error", cache: "no-store" });
    if (!response.ok) throw new TemplateSyncError("Meta לא אפשרה קריאת תבניות. יש לבדוק את הרשאות החשבון וה־Token");
    const parsed = pageSchema.safeParse(await response.json());
    if (!parsed.success) throw new TemplateSyncError("התקבלה תשובת תבניות לא תקינה מ־Meta");
    templates.push(...parsed.data.data);
    if (!parsed.data.paging?.next) break;
    cursor = parsed.data.paging.cursors?.after;
    if (!cursor || seen.has(cursor) || page === 19) throw new TemplateSyncError("לא ניתן להשלים את כל עמודי התבניות; לא נשמר סנכרון חלקי");
    seen.add(cursor);
  }
  const mapped = templates.map(mapRemoteTemplate);
  await prisma.$transaction(async (tx) => {
    await tx.template.updateMany({ where: { providerAccountId: config.businessAccountId, providerTemplateId: { notIn: mapped.map((template) => template.providerTemplateId) } }, data: { status: "REJECTED", syncError: "התבנית אינה קיימת עוד בחשבון Meta" } });
    for (const template of mapped) {
      await tx.template.upsert({ where: { businessId_name_language: { businessId: requireBusinessId(), name: template.name, language: template.language } },
        create: { businessId: requireBusinessId(), ...template, providerAccountId: config.businessAccountId }, update: { ...template, providerAccountId: config.businessAccountId },
      });
    }
  }, { timeout: 30000 });
  return { synced: mapped.length, sendable: mapped.filter((template) => template.status === "APPROVED").length, unsupported: mapped.filter((template) => template.syncError).length };
}
