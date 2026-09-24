import { z } from "zod";

const media = z.object({ id: z.string().min(1), mime_type: z.string().optional(), caption: z.string().optional(), filename: z.string().optional() });
const message = z.object({
  id: z.string().min(1).max(512), from: z.string().regex(/^\d{6,20}$/),
  timestamp: z.string().regex(/^\d+$/), type: z.string(),
  text: z.object({ body: z.string() }).optional(), image: media.optional(), video: media.optional(),
  audio: media.optional(), document: media.optional(),
  button: z.object({ text: z.string() }).optional(),
  interactive: z.object({ button_reply: z.object({ title: z.string() }).optional(), list_reply: z.object({ title: z.string() }).optional() }).optional(),
});
export const metaWebhookSchema = z.object({
  object: z.literal("whatsapp_business_account"),
  // `entry.id` is the WABA id – used to route account-level events (account_update, …).
  entry: z.array(z.object({ id: z.string().optional(), changes: z.array(z.object({
    field: z.string(), value: z.object({
      metadata: z.object({ phone_number_id: z.string() }).optional(),
      messages: z.array(message).max(1000).optional(),
      statuses: z.array(z.object({ id: z.string().min(1), status: z.string(), timestamp: z.string().regex(/^\d+$/) })).max(1000).optional(),
      contacts: z.array(z.object({ wa_id: z.string(), profile: z.object({ name: z.string() }).optional() })).optional(),
      // account_update / phone_number_* / business_capability_update fields
      event: z.string().optional(),
      waba_info: z.object({ waba_id: z.string().optional(), owner_business_id: z.string().optional() }).passthrough().optional(),
      display_phone_number: z.string().optional(),
      decision: z.string().optional(),
      current_limit: z.string().optional(),
    }).passthrough(),
  })).max(1000) })).max(1000),
});
export type MetaInboundMessage = z.infer<typeof message>;
export class InvalidWebhookError extends Error {}
export function providerTimestamp(value: string): Date {
  const milliseconds = Number(value) * 1000;
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0 || milliseconds > 8640000000000000) throw new InvalidWebhookError("Invalid timestamp");
  return new Date(Math.min(Date.now(), milliseconds));
}
