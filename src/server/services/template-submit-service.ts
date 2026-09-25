import { prisma } from "@/lib/db";
import { requireBusinessId } from "@/lib/tenant";
import { submitTemplateSchema } from "@/lib/validation/template";
import { templateParameterKeys } from "@/lib/campaigns";
import { metaConfigOf, GRAPH_VERSION } from "@/lib/meta/graph";

export class TemplateSubmissionError extends Error {}

export async function submitMetaTemplate(input: unknown) {
  const data = submitTemplateSchema.parse(input);
  const credential = await prisma.providerCredential.findFirst({ where: { isActive: true, provider: "meta_whatsapp_cloud_api", sendingBlocked: false }, orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }] });
  const config = credential ? metaConfigOf(credential.config) : undefined;
  if (!config?.businessAccountId) throw new TemplateSubmissionError("יש לחבר חשבון Meta ולהגדיר Business Account ID לפני הגשה");
  const variables = templateParameterKeys(data.body);
  // Reserve the unique name before the external call, preventing concurrent submissions.
  let local;
  try {
    local = await prisma.template.create({ data: { businessId: requireBusinessId(), name: data.name, language: data.language, category: data.category, body: data.body, variables, status: "DRAFT", providerAccountId: config.businessAccountId, syncError: "ההגשה בתהליך; אם אינה מסתיימת יש לסנכרן מול Meta לפני ניסיון נוסף" } });
  } catch (error) {
    if ((error as { code?: string }).code === "P2002") throw new TemplateSubmissionError("כבר קיימת תבנית בשם ובשפה אלה. יש לסנכרן או לבחור שם חדש");
    throw error;
  }
  try {
    const response = await fetch(`https://graph.facebook.com/${config.apiVersion ?? GRAPH_VERSION}/${config.businessAccountId}/message_templates`, {
      method: "POST", headers: { Authorization: `Bearer ${config.accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: data.name, language: data.language, category: data.category, components: [{ type: "BODY", text: data.body, ...(variables.length ? { example: { body_text: [variables.map((key) => data.examples[key])] } } : {}) }] }),
      signal: AbortSignal.timeout(15000), redirect: "error",
    });
    const result = await response.json().catch(() => null);
    if (!response.ok) {
      // Do not echo remote errors which can contain credentials or request details.
      const reason = `Meta דחתה את ההגשה (קוד ${Number(result?.error?.code) || response.status}). בדוק את התוכן והרשאות whatsapp_business_management`;
      await prisma.template.update({ where: { id: local.id }, data: { status: "REJECTED", syncError: reason } });
      throw new TemplateSubmissionError(reason);
    }
    if (typeof result?.id !== "string" || !/^\d+$/.test(result.id)) throw new Error("Missing template ID");
    return await prisma.template.update({ where: { id: local.id }, data: {
      providerTemplateId: result.id, status: result.status === "APPROVED" ? "APPROVED" : "PENDING_APPROVAL", syncError: null,
    } });
  } catch (error) {
    if (error instanceof TemplateSubmissionError) throw error;
    throw new TemplateSubmissionError("לא ניתן לאמת את תוצאת ההגשה. התבנית נשמרה; יש לסנכרן מול Meta לפני ניסיון נוסף");
  }
}
