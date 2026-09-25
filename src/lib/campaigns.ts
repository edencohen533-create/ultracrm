import { audienceSchema } from "./audiences";
import { z } from "zod";

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
  templateId: z.string().min(1),
  /** WhatsApp: numbered template parameters. SMS/email: extra merge values (e.g. custom offers). */
  variables: z.record(z.string(), z.string().trim().min(1).max(1024)).default({}),
});
export const campaignActionSchema = z.object({
  action: z.enum(["start", "pause", "resume", "cancel"]),
  scheduledAt: z.iso.datetime({ offset: true }).optional(),
  /** IANA timezone the schedule was entered in (audit/display – the instant is authoritative). */
  scheduledTimezone: z.string().max(60).optional(),
});
export const CHANNEL_LABELS: Record<string, string> = { whatsapp: "WhatsApp", sms: "SMS", email: "אימייל" };

export function templateParameterKeys(body: string): string[] {
  return [...new Set([...body.matchAll(/\{\{(\d+)\}\}/g)].map((m) => m[1]))]
    .sort((a, b) => Number(a) - Number(b));
}
export function validateTemplateVariables(body: string, variables: Record<string, string>) {
  const keys = templateParameterKeys(body);
  if (keys.some((key, i) => Number(key) !== i + 1 || (!variables[key]?.trim() || /\{[^{}]+\}/.test(variables[key].replaceAll("{name}", "sample"))))) {
    throw new Error("יש למלא את כל משתני התבנית לפי הסדר");
  }
  if (Object.keys(variables).some((key) => !keys.includes(key))) {
    throw new Error("משתנים שאינם מופיעים בתבנית");
  }
}
export function personalizeVariables(variables: Record<string, string>, name: string) {
  return Object.fromEntries(Object.entries(variables).map(([key, value]) => [key, value.replaceAll("{name}", () => name)]));
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
