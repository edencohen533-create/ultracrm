import { z } from "zod";

const media = z.object({ id: z.string().min(1), mime_type: z.string().optional(), caption: z.string().optional(), filename: z.string().optional() });
const message = z.object({
  // BSUID (2026): `from` (phone) is omitted for username users whose number Meta may not share; `from_user_id` is always set.
  id: z.string().min(1).max(512), from: z.string().regex(/^\d{6,20}$/).optional(), from_user_id: z.string().max(128).optional(),
  timestamp: z.string().regex(/^\d+$/), type: z.string(),
  text: z.object({ body: z.string() }).optional(), image: media.optional(), video: media.optional(),
  audio: media.optional(), document: media.optional(),
  context: z.object({ id: z.string().max(512) }).passthrough().optional(),
  button: z.object({ text: z.string().max(1024), payload: z.string().max(4096).optional() }).optional(),
  interactive: z.object({ button_reply: z.object({ title: z.string().max(1024), id: z.string().max(4096).optional() }).optional(), list_reply: z.object({ title: z.string() }).optional() }).optional(),
  // Click-to-WhatsApp ads: the first message carries the ad (source_type "ad", source_id = the ad id) and ctwa_clid.
  referral: z.object({ source_url: z.string().max(2000).optional(), source_id: z.string().max(64).optional(), source_type: z.string().max(40).optional(), headline: z.string().max(500).optional(), ctwa_clid: z.string().max(500).optional() }).passthrough().optional(),
});
export const metaWebhookSchema = z.object({
  object: z.literal("whatsapp_business_account"),
  // `entry.id` is the WABA id – used to route account-level events (account_update, …).
  entry: z.array(z.object({ id: z.string().optional(), changes: z.array(z.object({
    field: z.string(), value: z.object({
      metadata: z.object({ phone_number_id: z.string() }).optional(),
      messages: z.array(message).max(1000).optional(),
      statuses: z.array(z.object({ id: z.string().min(1), status: z.string(), timestamp: z.string().regex(/^\d+$/), errors: z.array(z.object({ code: z.number().optional(), title: z.string().optional(), message: z.string().optional() }).passthrough()).optional(), pricing: z.object({ category: z.string().optional(), billable: z.boolean().optional() }).passthrough().optional() })).max(1000).optional(),
      contacts: z.array(z.object({ wa_id: z.string().optional(), user_id: z.string().optional(), profile: z.object({ name: z.string() }).passthrough().optional() })).optional(),
      // account_update / phone_number_* / business_capability_update fields
      event: z.string().optional(),
      waba_info: z.object({ waba_id: z.string().optional(), owner_business_id: z.string().optional() }).passthrough().optional(),
      display_phone_number: z.string().optional(),
      decision: z.string().optional(),
      current_limit: z.string().optional(),
      ban_info: z.object({ waba_ban_state: z.string().optional() }).passthrough().optional(),
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

/** Preserve structured callback identity separately from the display text. */
export function metaButtonReply(message: MetaInboundMessage) {
  const buttonText = message.type === 'button' ? message.button?.text : message.type === 'interactive' ? message.interactive?.button_reply?.title : undefined;
  if (!message.context?.id || !buttonText) return undefined;
  return { contextMessageId: message.context.id, buttonText, buttonId: message.button?.payload ?? message.interactive?.button_reply?.id ?? '' };
}
