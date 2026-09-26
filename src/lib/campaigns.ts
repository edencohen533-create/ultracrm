import { audienceSchema } from "./audiences";
import { z } from "zod";
import { renderMergeTags } from "./merge-tags";

export const distributionListSchema = z.object({
  name: z.string().trim().min(1).max(120),
  contactIds: z.array(z.string().min(1)).max(10000).transform((ids) => [...new Set(ids)]).default([]),
  segment: audienceSchema.nullable().optional(),
}).refine((input) => input.segment ? input.contactIds.length === 0 : input.contactIds.length > 0, "יש לבחור אנשי קשר או תנאי קהל, ולא את שניהם");
export const campaignSchema = z.object({
  channel: z.enum(["whatsapp", "sms", "email"]).default("whatsapp"),
  excludedListIds: z.array(z.string().min(1)).max(20).transform((ids) => [...new Set(ids)]).optional(),
  providerCredentialId: z.string().min(1).nullable().optional(),
  /** SMS sender value (number / alphanumeric id) from the connected provider. */
  senderId: z.string().trim().min(1).max(40).nullable().optional(),
  name: z.string().trim().min(1).max(120),
  listId: z.string().min(1),
  /** Additional audiences (union with listId). */
  listIds: z.array(z.string().min(1)).max(20).optional(),
  templateId: z.string().min(1),
  /** WhatsApp: numbered template parameters. SMS/email: extra merge values (e.g. custom offers). */
  variables: z.record(z.string(), z.string().trim().min(1).max(1024)).default({}),
  /** WhatsApp: public https link for a template with an IMAGE/VIDEO/DOCUMENT header. */
  mediaUrl: z.string().trim().url().max(2000).regex(/^https:\/\//, "קישור המדיה חייב להתחיל ב-https://").nullable().optional(),
  /** WhatsApp: dynamic URL-button suffix per button index. */
  buttonParams: z.record(z.string().regex(/^\d+$/), z.string().trim().min(1).max(500)).nullable().optional(),
});
export const campaignActionSchema = z.object({
  action: z.enum(["start", "pause", "resume", "cancel", "unschedule", "retry_recipient"]),
  scheduledAt: z.iso.datetime({ offset: true }).optional(),
  /** IANA timezone the schedule was entered in (audit/display – the instant is authoritative). */
  scheduledTimezone: z.string().max(60).optional(),
  /** retry_recipient: which recipient; UNKNOWN outcomes additionally need an explicit attestation. */
  recipientId: z.string().min(1).optional(),
  confirmNotSent: z.boolean().optional(),
});
export const CHANNEL_LABELS: Record<string, string> = { whatsapp: "WhatsApp", sms: "SMS", email: "אימייל" };

export function templateParameterKeys(body: string): string[] {
  return [...new Set([...body.matchAll(/\{\{(\d+)\}\}/g)].map((m) => m[1]))]
    .sort((a, b) => Number(a) - Number(b));
}
export function validateTemplateVariables(body: string, variables: Record<string, string>) {
  const keys = templateParameterKeys(body);
  // Allowed inside a value: the legacy {name} tag and named merge tags {{first_name|default}} (4.09). Anything else in braces is a typo.
  const stripTags = (v: string) => v.replaceAll("{name}", "sample").replace(/\{\{\s*[a-zA-Z_][\w.]*\s*(\|[^{}]*)?\}\}/g, "sample");
  if (keys.some((key, i) => Number(key) !== i + 1 || (!variables[key]?.trim() || /\{[^{}]+\}/.test(stripTags(variables[key]))))) {
    throw new Error("יש למלא את כל משתני התבנית לפי הסדר");
  }
  if (Object.keys(variables).some((key) => !keys.includes(key))) {
    throw new Error("משתנים שאינם מופיעים בתבנית");
  }
}
export function personalizeVariables(variables: Record<string, string>, name: string) {
  return Object.fromEntries(Object.entries(variables).map(([key, value]) => [key, value.replaceAll("{name}", () => name)]));
}
/**
 * Per-contact values for numbered WhatsApp parameters. Each value may use `{name}` (legacy) and the
 * named merge tags with defaults ({{first_name|לקוח}}, {{company|-}}, {{custom.key|x}}…).
 * Throws when a tag has neither a value nor a default – the recipient is then excluded with a reason.
 */
export function personalizeVariablesForContact(variables: Record<string, string>, contact: { fullName: string; email?: string | null; phoneE164?: string | null; company?: string | null; city?: string | null; customFields?: unknown }) {
  const out: Record<string, string> = {};
  const missing = new Set<string>();
  for (const [key, value] of Object.entries(variables)) {
    const r = renderMergeTags(value.replaceAll("{name}", () => contact.fullName), { fullName: contact.fullName, email: contact.email, phoneE164: contact.phoneE164, company: contact.company, city: contact.city, customFields: (contact.customFields ?? null) as Record<string, unknown> | null });
    r.missing.forEach((m) => missing.add(m));
    out[key] = r.text.trim();
    if (!out[key]) missing.add(key);
  }
  if (missing.size) throw new Error(`משתנים חסרים ללא ברירת מחדל: ${[...missing].join(", ")}`);
  return out;
}
export function renderTemplate(body: string, variables: Record<string, string>) {
  return body.replace(/\{\{(\d+)\}\}/g, (_, key: string) => variables[key] ?? `{{${key}}}`);
}
export const campaignStatusLabels: Record<string, string> = {
  DRAFT: "טיוטה", SCHEDULED: "מתוזמן", RUNNING: "בשליחה", PAUSED: "מושהה", COMPLETED: "הסתיים", CANCELLED: "בוטל",
};
export const recipientStatusLabels: Record<string, string> = {
  QUEUED: "בתור", PROCESSING: "בשליחה", SENT: "נשלח", FAILED: "נכשל", SKIPPED: "דולג", UNKNOWN: "דורש בדיקה",
};
export const deliveryStatusLabels: Record<string, string> = {
  QUEUED: "בתור", UNKNOWN: "תוצאה לא ודאית", ACCEPTED: "הועבר לספק", SENT: "נשלח", DELIVERED: "נמסר", READ: "נקרא", FAILED: "נכשל", BOUNCED: "הוקפץ (bounce)", CANCELLED: "בוטל",
};

/** Campaign list filter buckets ("סינון לפי סטטוס"). "failed" = a campaign the system stopped (statusReason) or whose sends all failed. */
export type CampaignBucket = "all" | "draft" | "scheduled" | "running" | "sent" | "failed";
export const CAMPAIGN_BUCKET_LABELS: Record<CampaignBucket, string> = { all: "הכול", draft: "טיוטה", scheduled: "מתוזמן", running: "בתהליך", sent: "נשלח", failed: "נכשל" };
export function campaignBucket(c: { status: string; statusReason?: string | null; counts?: Record<string, number>; scheduledAt?: string | Date | null }): Exclude<CampaignBucket, "all"> | "cancelled" {
  if (c.status === "DRAFT") return "draft";
  // "Send now" is stored as SCHEDULED at the current time until the worker claims it – that is already in progress.
  if (c.status === "SCHEDULED") return c.scheduledAt && new Date(c.scheduledAt).getTime() <= Date.now() ? "running" : "scheduled";
  if (c.status === "RUNNING" || c.status === "PAUSED") return c.statusReason ? "failed" : "running";
  if (c.status === "CANCELLED") return "cancelled";
  const counts = c.counts ?? {};
  const sent = counts.SENT ?? 0; const failed = (counts.FAILED ?? 0) + (counts.UNKNOWN ?? 0);
  return sent === 0 && failed > 0 ? "failed" : "sent";
}
