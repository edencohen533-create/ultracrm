import { audienceSchema } from "./audiences";
import { z } from "zod";

export const distributionListSchema = z.object({
  name: z.string().trim().min(1).max(120),
  contactIds: z.array(z.string().min(1)).max(10000).transform((ids) => [...new Set(ids)]).default([]),
  segment: audienceSchema.nullable().optional(),
}).refine((input) => input.segment ? input.contactIds.length === 0 : input.contactIds.length > 0, "יש לבחור אנשי קשר או תנאי קהל, ולא את שניהם");
export const throttleSchema = z.object({ batchSize: z.number().int().min(1).max(100000), intervalMinutes: z.number().int().min(5).max(1440) });
export type { Throttle } from "./campaign-shared";
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
  /** Sending pace: at most batchSize recipients every intervalMinutes. */
  throttle: throttleSchema.nullable().optional(),
});
/** Days 0 (Sunday) … 6, hours HH:MM – the end after the start, at least one day. */
export const sendWindowSchema = z.object({ start: z.string().regex(/^\d{2}:\d{2}$/), end: z.string().regex(/^\d{2}:\d{2}$/), days: z.array(z.number().int().min(0).max(6)).min(1).max(7), timezone: z.string().max(60).optional() })
  .refine((w) => w.start < w.end, { message: "שעת הסיום חייבת להיות אחרי שעת ההתחלה" });

export const campaignActionSchema = z.object({
  action: z.enum(["start", "pause", "resume", "cancel", "unschedule", "retry_recipient"]),
  scheduledAt: z.iso.datetime({ offset: true }).optional(),
  /** IANA timezone the schedule was entered in (audit/display – the instant is authoritative). */
  scheduledTimezone: z.string().max(60).optional(),
  /** retry_recipient: which recipient; UNKNOWN outcomes additionally need an explicit attestation. */
  recipientId: z.string().min(1).optional(),
  confirmNotSent: z.boolean().optional(),
  /** start: sending pace chosen at the review step (null = no pace). */
  throttle: throttleSchema.nullable().optional(),
  /** start: this campaign's sending window (null = the business's default window). */
  sendWindow: sendWindowSchema.nullable().optional(),
  /** start: a schedule in the BUSINESS's local date + time (converted on the server with the business time zone). */
  scheduledLocal: z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), time: z.string().regex(/^\d{2}:\d{2}$/) }).optional(),
});
export * from "./campaign-shared";
