import { requireBusinessId } from "@/lib/tenant";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { templateParameterKeys } from "@/lib/campaigns";
import { metaConfigOf, GRAPH_VERSION } from "@/lib/meta/graph";
import type { TemplateStatus } from "@/generated/prisma/client";

const remoteTemplate = z.object({
  id: z.string().min(1), name: z.string().min(1), language: z.string().min(1),
  status: z.string(), category: z.enum(["MARKETING", "UTILITY", "AUTHENTICATION"]),
  components: z.array(z.object({ type: z.string(), text: z.string().optional() }).passthrough()),
});
const pageSchema = z.object({ data: z.array(remoteTemplate), paging: z.object({ next: z.string().optional(), cursors: z.object({ after: z.string().optional() }).optional() }).optional() });
export class TemplateSyncError extends Error {}

export function mapRemoteTemplate(template: z.infer<typeof remoteTemplate>) {
  const body = template.components.find((component) => component.type === "BODY")?.text ?? "";
  const unsupported = template.components.some((component) => !["BODY", "FOOTER"].includes(component.type)) || !body ||
    [...body.matchAll(/\{\{([^}]+)\}\}/g)].some((match) => !/^\d+$/.test(match[1])) ||
    templateParameterKeys(body).some((key, index) => Number(key) !== index + 1);
  const status: TemplateStatus = unsupported ? "DRAFT" : template.status === "APPROVED" ? "APPROVED" : template.status === "PENDING" ? "PENDING_APPROVAL" : "REJECTED";
  return {
    name: template.name, language: template.language, category: template.category, body,
    variables: templateParameterKeys(body), status, providerTemplateId: template.id,
    syncError: unsupported ? "התבנית מכילה רכיבים שאינם נתמכים עדיין (נתמכים גוף טקסט, משתנים ממוספרים וכותרת תחתונה)" : null,
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
