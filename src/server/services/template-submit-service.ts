import { prisma } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import { requireBusinessId } from "@/lib/tenant";
import { submitTemplateSchema, type SubmitTemplateInput } from "@/lib/validation/template";
import { templateParameterKeys } from "@/lib/campaigns";
import { metaConfigOf, GRAPH_VERSION } from "@/lib/meta/graph";
import { safeFetch } from "@/lib/safe-url";

export class TemplateSubmissionError extends Error {}

const MEDIA_LIMIT = { IMAGE: 5 * 1024 * 1024, VIDEO: 16 * 1024 * 1024, DOCUMENT: 100 * 1024 * 1024 } as const;

/** Meta requires a sample of the header media as an upload handle (Resumable Upload API of the app). */
async function uploadSampleMedia(url: string, format: "IMAGE" | "VIDEO" | "DOCUMENT", token: string, version: string) {
  const appId = process.env.META_APP_ID?.trim();
  if (!appId) throw new TemplateSubmissionError("חסר META_APP_ID – נדרש להעלאת קובץ הדוגמה לכותרת");
  let res: Response;
  try { res = await safeFetch(url, { timeoutMs: 20_000 }); } catch { throw new TemplateSubmissionError("לא ניתן להוריד את קובץ הדוגמה (קישור https ציבורי)"); }
  if (!res.ok) throw new TemplateSubmissionError(`קובץ הדוגמה לא זמין (HTTP ${res.status})`);
  const type = (res.headers.get("content-type") ?? "").split(";")[0].trim();
  const ok = format === "IMAGE" ? /^image\/(jpeg|png)$/.test(type) : format === "VIDEO" ? /^video\/mp4$/.test(type) : type === "application/pdf";
  if (!ok) throw new TemplateSubmissionError(format === "IMAGE" ? "תמונת דוגמה חייבת להיות JPG או PNG" : format === "VIDEO" ? "וידאו לדוגמה חייב להיות MP4" : "מסמך לדוגמה חייב להיות PDF");
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length > MEDIA_LIMIT[format]) throw new TemplateSubmissionError("קובץ הדוגמה גדול מדי");
  const start = await fetch(`https://graph.facebook.com/${version}/${appId}/uploads?file_length=${bytes.length}&file_type=${encodeURIComponent(type)}`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15000), redirect: "error" });
  const session = (await start.json().catch(() => null)) as { id?: string } | null;
  if (!start.ok || !session?.id?.startsWith("upload:")) throw new TemplateSubmissionError("Meta לא אפשרה להעלות את קובץ הדוגמה (בדוק META_APP_ID והרשאות)");
  const put = await fetch(`https://graph.facebook.com/${version}/${session.id}`, { method: "POST", headers: { Authorization: `OAuth ${token}`, file_offset: "0" }, body: bytes, signal: AbortSignal.timeout(60000), redirect: "error" });
  const handle = (await put.json().catch(() => null)) as { h?: string } | null;
  if (!put.ok || !handle?.h) throw new TemplateSubmissionError("העלאת קובץ הדוגמה ל-Meta נכשלה");
  return handle.h;
}

/** Meta "components" for the template (what the builder produced). Also used for the local copy (preview + sending). */
export function buildComponents(d: SubmitTemplateInput, mediaHandle?: string): Array<Record<string, unknown>> {
  if (d.category === "AUTHENTICATION") {
    const a = d.auth ?? { addSecurityRecommendation: true, otpType: "COPY_CODE" as const };
    return [
      { type: "BODY", add_security_recommendation: a.addSecurityRecommendation },
      ...(a.codeExpirationMinutes ? [{ type: "FOOTER", code_expiration_minutes: a.codeExpirationMinutes }] : []),
      { type: "BUTTONS", buttons: [{ type: "OTP", otp_type: a.otpType, text: "העתק קוד" }] },
    ];
  }
  const out: Array<Record<string, unknown>> = [];
  const h = d.header;
  if (h.format === "TEXT") out.push({ type: "HEADER", format: "TEXT", text: h.text, ...(templateParameterKeys(h.text ?? "").length ? { example: { header_text: [h.example] } } : {}) });
  else if (h.format === "LOCATION") out.push({ type: "HEADER", format: "LOCATION" });
  else if (h.format !== "NONE") out.push({ type: "HEADER", format: h.format, ...(mediaHandle ? { example: { header_handle: [mediaHandle] } } : {}) });
  const keys = templateParameterKeys(d.body);
  out.push({ type: "BODY", text: d.body, ...(keys.length ? { example: { body_text: [keys.map((k) => d.examples[k])] } } : {}) });
  if (d.footer) out.push({ type: "FOOTER", text: d.footer });
  if (d.buttons.length) out.push({ type: "BUTTONS", buttons: d.buttons.map((b) =>
    b.type === "QUICK_REPLY" ? { type: "QUICK_REPLY", text: b.text }
    : b.type === "URL" ? { type: "URL", text: b.text, url: b.url, ...(/\{\{1\}\}$/.test(b.url) ? { example: [b.example] } : {}) }
    : b.type === "PHONE_NUMBER" ? { type: "PHONE_NUMBER", text: b.text, phone_number: b.phone.startsWith("+") ? b.phone : `+${b.phone}` }
    : { type: "COPY_CODE", example: b.example }) });
  return out;
}

/** Local button list in the shape the sender/preview use. */
function localButtons(d: SubmitTemplateInput) {
  if (d.category === "AUTHENTICATION") return [{ type: "OTP", text: "העתק קוד", url: null, phone: null, dynamic: false }];
  return d.buttons.map((b) => b.type === "QUICK_REPLY" ? { type: b.type, text: b.text, url: null, phone: null, dynamic: false }
    : b.type === "URL" ? { type: b.type, text: b.text, url: b.url, phone: null, dynamic: /\{\{1\}\}$/.test(b.url) }
    : b.type === "PHONE_NUMBER" ? { type: b.type, text: b.text, url: null, phone: b.phone, dynamic: false }
    : { type: b.type, text: "העתק קוד", url: null, phone: null, dynamic: false, example: b.example });
}

export async function submitMetaTemplate(input: unknown) {
  const data = submitTemplateSchema.parse(input);
  const credential = await prisma.providerCredential.findFirst({ where: { isActive: true, provider: "meta_whatsapp_cloud_api", sendingBlocked: false }, orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }] });
  const config = credential ? metaConfigOf(credential.config) : undefined;
  if (!config?.businessAccountId) throw new TemplateSubmissionError("יש לחבר חשבון Meta ולהגדיר Business Account ID לפני הגשה");
  const version = config.apiVersion ?? GRAPH_VERSION;
  const body = data.category === "AUTHENTICATION" ? "{{1}} הוא קוד האימות שלך." : data.body;
  const variables = [...templateParameterKeys(body), ...(data.category !== "AUTHENTICATION" && data.header.format === "TEXT" && /\{\{1\}\}/.test(data.header.text ?? "") ? ["h1"] : [])];
  const headerFormat = data.category === "AUTHENTICATION" || data.header.format === "NONE" ? null : data.header.format;
  // Reserve the unique name before the external call, preventing concurrent submissions.
  let local;
  try {
    local = await prisma.template.create({ data: { businessId: requireBusinessId(), name: data.name, language: data.language, category: data.category, body, variables, status: "DRAFT", providerAccountId: config.businessAccountId, headerFormat, buttons: localButtons(data) as unknown as Prisma.InputJsonValue } });
  } catch (error) {
    if ((error as { code?: string }).code === "P2002") throw new TemplateSubmissionError("כבר קיימת תבנית בשם ובשפה אלה. יש לסנכרן או לבחור שם חדש");
    throw error;
  }
  try {
    const handle = headerFormat && ["IMAGE", "VIDEO", "DOCUMENT"].includes(headerFormat) ? await uploadSampleMedia(data.header.mediaUrl!, headerFormat as "IMAGE" | "VIDEO" | "DOCUMENT", config.accessToken, version) : undefined;
    const components = buildComponents(data, handle);
    await prisma.template.update({ where: { id: local.id }, data: { components: components as unknown as Prisma.InputJsonValue } });
    const response = await fetch(`https://graph.facebook.com/${version}/${config.businessAccountId}/message_templates`, {
      method: "POST", headers: { Authorization: `Bearer ${config.accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: data.name, language: data.language, category: data.category, components }),
      signal: AbortSignal.timeout(15000), redirect: "error",
    });
    const result = await response.json().catch(() => null);
    if (!response.ok) {
      // Meta's user-facing message is safe to show (no credentials); fall back to the code.
      const detail = typeof result?.error?.error_user_msg === "string" ? result.error.error_user_msg.slice(0, 300) : `קוד ${Number(result?.error?.code) || response.status}`;
      const reason = `Meta דחתה את ההגשה: ${detail}`;
      await prisma.template.update({ where: { id: local.id }, data: { status: "REJECTED", syncError: reason } });
      throw new TemplateSubmissionError(reason);
    }
    if (typeof result?.id !== "string" || !/^\d+$/.test(result.id)) throw new Error("Missing template ID");
    return await prisma.template.update({ where: { id: local.id }, data: {
      providerTemplateId: result.id, status: result.status === "APPROVED" ? "APPROVED" : "PENDING_APPROVAL", syncError: null,
    } });
  } catch (error) {
    if (error instanceof TemplateSubmissionError) {
      await prisma.template.updateMany({ where: { id: local.id, status: "DRAFT" }, data: { status: "REJECTED", syncError: error.message } });
      throw error;
    }
    throw new TemplateSubmissionError("לא ניתן לאמת את תוצאת ההגשה. התבנית נשמרה; יש לסנכרן מול Meta לפני ניסיון נוסף");
  }
}
