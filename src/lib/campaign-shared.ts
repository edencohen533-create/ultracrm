/**
 * Campaign helpers WITHOUT zod – labels, template variables, pace labels, buckets. Client components import this file
 * (keeps the validation library out of the browser bundle); server code keeps using "@/lib/campaigns" (re-exports it).
 */
import { bi, uiLang } from "@/lib/i18n-labels";
import { renderMergeTags } from "./merge-tags";

export interface Throttle { batchSize: number; intervalMinutes: number }
export const throttleLabel = (t: Throttle | null | undefined) => uiLang() === "en"
  ? (!t ? "All recipients in sequence (within the business window and rate)" : `${t.batchSize.toLocaleString("en-GB")} recipients every ${t.intervalMinutes === 60 ? "hour" : t.intervalMinutes === 30 ? "half hour" : t.intervalMinutes % 60 === 0 ? `${t.intervalMinutes / 60} hours` : `${t.intervalMinutes} minutes`}`)
  : !t ? "כל הנמענים ברצף (בכפוף לחלון ולקצב העסק)" : `${t.batchSize.toLocaleString("he-IL")} נמענים כל ${t.intervalMinutes === 60 ? "שעה" : t.intervalMinutes === 30 ? "חצי שעה" : t.intervalMinutes % 60 === 0 ? `${t.intervalMinutes / 60} שעות` : `${t.intervalMinutes} דקות`}`;
export const CHANNEL_LABELS: Record<string, string> = bi({ whatsapp: "WhatsApp", sms: "SMS", email: "אימייל" }, { whatsapp: "WhatsApp", sms: "SMS", email: "Email" });

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
  // "h1" = the value of a text-header variable (templates whose header is "…{{1}}…").
  if (Object.keys(variables).some((key) => !keys.includes(key) && key !== "h1")) {
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
export const campaignStatusLabels: Record<string, string> = bi({
  DRAFT: "טיוטה", SCHEDULED: "מתוזמן", RUNNING: "בשליחה", PAUSED: "מושהה", COMPLETED: "הסתיים", CANCELLED: "בוטל",
}, { DRAFT: "Draft", SCHEDULED: "Scheduled", RUNNING: "Sending", PAUSED: "Paused", COMPLETED: "Completed", CANCELLED: "Cancelled" });
export const recipientStatusLabels: Record<string, string> = bi({
  QUEUED: "בתור", PROCESSING: "בשליחה", SENT: "נשלח", FAILED: "נכשל", SKIPPED: "דולג", UNKNOWN: "דורש בדיקה",
}, { QUEUED: "Queued", PROCESSING: "Sending", SENT: "Sent", FAILED: "Failed", SKIPPED: "Skipped", UNKNOWN: "Needs review" });
export const deliveryStatusLabels: Record<string, string> = bi({
  QUEUED: "בתור", UNKNOWN: "תוצאה לא ודאית", ACCEPTED: "הועבר לספק", SENT: "נשלח", DELIVERED: "נמסר", READ: "נקרא", FAILED: "נכשל", BOUNCED: "הוקפץ (bounce)", CANCELLED: "בוטל",
}, { QUEUED: "Queued", UNKNOWN: "Uncertain result", ACCEPTED: "Handed to provider", SENT: "Sent", DELIVERED: "Delivered", READ: "Read", FAILED: "Failed", BOUNCED: "Bounced", CANCELLED: "Cancelled" });

/** Campaign list filter buckets ("סינון לפי סטטוס"). "failed" = a campaign the system stopped (statusReason) or whose sends all failed. */
export type CampaignBucket = "all" | "draft" | "scheduled" | "running" | "sent" | "failed";
export const CAMPAIGN_BUCKET_LABELS: Record<CampaignBucket, string> = bi({ all: "הכול", draft: "טיוטה", scheduled: "מתוזמן", running: "בתהליך", sent: "נשלח", failed: "נכשל" }, { all: "All", draft: "Draft", scheduled: "Scheduled", running: "In progress", sent: "Sent", failed: "Failed" });
export function campaignBucket(c: { status: string; statusReason?: string | null; counts?: Record<string, number>; scheduledAt?: string | Date | null }): Exclude<CampaignBucket, "all"> | "cancelled" {
  if (c.status === "DRAFT") return "draft";
  // "Send now" is stored as SCHEDULED at the current time until the worker claims it – that is already in progress.
  if (c.status === "SCHEDULED") return c.scheduledAt && new Date(c.scheduledAt).getTime() <= Date.now() ? "running" : "scheduled";
  if (c.status === "RUNNING" || c.status === "PAUSED") return c.statusReason ? "failed" : "running";
  if (c.status === "CANCELLED") return "cancelled";
  const counts = c.counts ?? {};
  const sent = counts.SENT ?? 0; const failed = (counts.FAILED ?? 0) + (counts.UNKNOWN ?? 0);
  return sent === 0 && (failed > 0 || (counts.SKIPPED ?? 0) > 0) ? "failed" : "sent";
}
