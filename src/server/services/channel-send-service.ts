/**
 * Outbound SMS / email – the single send path for campaigns, sequences and tests.
 *
 * Guarantees (same as the WhatsApp path):
 *  • idempotent by `requestKey` (a retried worker never sends twice; an UNKNOWN result is never retried)
 *  • the message row is persisted (QUEUED) before the provider is called
 *  • global suppression + consent are checked when queuing AND again right before the provider call
 *  • the shared 24h marketing frequency cap (contact.lastMarketingAt) is reserved atomically
 *  • provider timeouts leave the message UNKNOWN (never assumed failed, never auto-resent)
 *  • provider unreachable → ChannelUnavailableError (the caller pauses, nothing is marked failed)
 */
import { prisma } from "@/lib/db";
import { requireBusinessId } from "@/lib/tenant";
import { audit } from "@/lib/audit";
import { emitEvent, kickEventProcessing } from "@/lib/events";
import { consumeQuota } from "@/lib/modules";
import { ApiError } from "@/lib/response";
import { MARKETING_INTERVAL_MS } from "@/lib/message-policy";
import { sendBlockReason } from "@/lib/suppression";
import { renderMergeTags, type MergeContact } from "@/lib/merge-tags";
import { smsMetrics, SMS_MAX_SEGMENTS } from "@/lib/sms";
import { rewriteTrackedLinks, signUnsubscribeToken, unsubscribeUrl } from "@/lib/unsubscribe-token";
import { MessagePolicyError } from "./message-service";
import { activeChannelCredential, ChannelUnavailableError, emailProviderFor, smsProviderFor } from "@/server/channels/registry";
import { ChannelProviderError, ChannelRequestTimeout, type SmsSender } from "@/server/channels/types";
import { Prisma, type Message, type ProviderCredential, type Template } from "@/generated/prisma/client";

export type MarketingChannel = "sms" | "email";

export interface ChannelSendInput {
  channel: MarketingChannel;
  contactId: string;
  credentialId?: string | null;
  templateId: string;
  variables?: Record<string, string>;
  category: "marketing" | "service";
  requestKey: string;
  sentByUserId: string | null;
  campaignRecipientId?: string;
  campaignId?: string;
  /** SMS sender value (number / alphanumeric) – defaults to the credential's first sender. */
  senderId?: string | null;
  automated?: boolean;
  eventDepth?: number;
  /** Set when a cross-channel sequence step sends – such sends never trigger another sequence. */
  sequenceRunId?: string;
}

export const CHANNEL_LABEL: Record<"whatsapp" | "sms" | "email", string> = { whatsapp: "WhatsApp", sms: "SMS", email: "אימייל" };

function pickSender(c: ProviderCredential, wanted?: string | null): SmsSender {
  const senders = ((c.senders as SmsSender[] | null) ?? []).filter((s) => s.value);
  if (!senders.length) throw new MessagePolicyError("לספק ה-SMS אין שולח מאושר. בדוק את החיבור בהגדרות");
  const s = wanted ? senders.find((x) => x.value === wanted || x.id === wanted) : senders[0];
  if (!s) throw new MessagePolicyError("השולח שנבחר אינו זמין יותר בחיבור");
  return s;
}

/** Deliverable email of a contact: primary unless hard-bounced, otherwise the first healthy extra address. */
export async function deliverableEmail(contact: { id: string; email: string | null; emailStatus: string | null }) {
  if (contact.email && contact.emailStatus !== "hard_bounce") return contact.email;
  const extra = await prisma.contactEmail.findFirst({ where: { contactId: contact.id, OR: [{ status: null }, { status: { not: "hard_bounce" } }] }, orderBy: { createdAt: "asc" } });
  return extra?.email ?? null;
}

export function smsFooter(marketing: boolean, sender: SmsSender, url: string) {
  if (!marketing) return "";
  return sender.inbound ? "\nלהסרה השיבו הסר" : `\nלהסרה: ${url}`;
}

export async function sendChannelMessage(input: ChannelSendInput): Promise<{ message: Message }> {
  const businessId = requireBusinessId();
  const existing = await prisma.message.findUnique({ where: { requestKey: input.requestKey } });
  if (existing) {
    if (["QUEUED", "UNKNOWN"].includes(existing.status)) throw new MessagePolicyError("תוצאת הבקשה הקודמת אינה ודאית. אין לשלוח שוב לפני בדיקה");
    // A message we cancelled ourselves (suppressed / invalid) is a policy outcome, never a "sent" result.
    if (existing.status === "CANCELLED") throw new MessagePolicyError(existing.errorReason ?? "ההודעה בוטלה");
    return { message: existing };
  }
  const template = await prisma.template.findUnique({ where: { id: input.templateId } });
  if (!template || template.channel !== input.channel || template.status !== "APPROVED") throw new MessagePolicyError("התבנית אינה זמינה לערוץ זה");
  const marketing = input.category === "marketing" || template.category === "MARKETING";
  const contact = await prisma.contact.findUnique({ where: { id: input.contactId } });
  if (!contact) throw new MessagePolicyError("איש הקשר לא נמצא");
  const identifier = input.channel === "email" ? await deliverableEmail(contact) : contact.phoneE164;
  if (!identifier) throw new MessagePolicyError(input.channel === "email" ? "אין כתובת אימייל תקינה לאיש הקשר" : "אין מספר טלפון");

  // Consent + global suppression (every channel) – first gate.
  const blocked = await sendBlockReason(businessId, contact.id, marketing ? "marketing" : "service");
  if (blocked) throw new MessagePolicyError(blocked);

  const credential = await activeChannelCredential(input.channel, input.credentialId);
  const sender = input.channel === "sms" ? pickSender(credential, input.senderId) : null;
  if (input.channel === "email" && (!credential.senderEmail || !credential.senderName)) throw new MessagePolicyError("יש להגדיר שם וכתובת שולח לאימייל בהגדרות החיבור");

  const now = new Date();
  if (marketing) {
    const reserved = await prisma.contact.updateMany({ where: { id: contact.id, isBlocked: false, consentStatus: "OPTED_IN", OR: [{ lastMarketingAt: null }, { lastMarketingAt: { lte: new Date(now.getTime() - MARKETING_INTERVAL_MS) } }] }, data: { lastMarketingAt: now } });
    if (!reserved.count) throw new MessagePolicyError("אין זכאות לדיוור או שנוצלה מגבלת התדירות המשותפת (דיוור אחד לנמען ב-24 שעות בכל הערוצים)");
  }
  try { await consumeQuota(businessId, "messages_sent"); }
  catch (err) { if (err instanceof ApiError) throw new MessagePolicyError(err.message); throw err; }

  const conversation = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "contacts" WHERE id = ${contact.id} FOR UPDATE`;
    return await tx.conversation.findFirst({ where: { contactId: contact.id, channel: input.channel, providerCredentialId: credential.id, status: { in: ["OPEN", "PENDING"] } }, orderBy: { createdAt: "desc" } })
      ?? await tx.conversation.create({ data: { businessId, contactId: contact.id, channel: input.channel, providerCredentialId: credential.id, source: "MANUAL" } });
  });

  // Persist first; the unsubscribe link is bound to this message id.
  const queued = await prisma.message.create({ data: {
    businessId, conversationId: conversation.id, channel: input.channel, category: marketing ? "marketing" : "service", direction: "OUTBOUND", type: "TEMPLATE",
    status: "QUEUED", requestKey: input.requestKey, providerCredentialId: credential.id, sentByUserId: input.sentByUserId, templateId: template.id, toIdentifier: identifier, createdAt: now,
  } });
  if (input.campaignRecipientId) await prisma.campaignRecipient.update({ where: { id: input.campaignRecipientId }, data: { messageId: queued.id, identifier } });

  const url = unsubscribeUrl(signUnsubscribeToken({ b: businessId, c: contact.id, i: identifier, m: queued.id, ch: input.channel }));
  const mergeContact: MergeContact = { fullName: contact.fullName, email: contact.email, phoneE164: contact.phoneE164, company: contact.company, city: contact.city, customFields: contact.customFields as Record<string, unknown> | null };
  const extra = { ...(input.variables ?? {}), unsubscribe_url: url };
  const rendered = renderChannelContent(template, mergeContact, extra, { marketing, sender, url });
  if (rendered.missing.length) {
    await prisma.message.update({ where: { id: queued.id }, data: { status: "CANCELLED", errorReason: `משתנים חסרים ללא ברירת מחדל: ${rendered.missing.join(", ")}`, failedAt: new Date() } });
    throw new MessagePolicyError(`משתנים חסרים ללא ברירת מחדל: ${rendered.missing.join(", ")}`);
  }
  if (input.channel === "sms" && rendered.segments! > SMS_MAX_SEGMENTS) {
    await prisma.message.update({ where: { id: queued.id }, data: { status: "CANCELLED", errorReason: `ההודעה ארוכה מדי (${rendered.segments} מקטעים)`, failedAt: new Date() } });
    throw new MessagePolicyError(`ההודעה ארוכה מדי (${rendered.segments} מקטעים, מותר עד ${SMS_MAX_SEGMENTS})`);
  }
  await prisma.message.update({ where: { id: queued.id }, data: { body: input.channel === "sms" ? rendered.body : rendered.text, subject: rendered.subject ?? null, segments: rendered.segments ?? null, encoding: rendered.encoding ?? null } });

  // Worker-side guard immediately before the provider call: a suppression recorded a moment ago wins.
  const latest = await sendBlockReason(businessId, contact.id, marketing ? "marketing" : "service");
  if (latest) {
    await prisma.message.update({ where: { id: queued.id }, data: { status: "CANCELLED", errorReason: latest, failedAt: new Date() } });
    throw new MessagePolicyError(latest);
  }

  let result;
  try {
    if (input.channel === "sms") {
      result = await smsProviderFor(credential).send({ to: identifier, from: sender!.value, body: rendered.body!, idempotencyKey: input.requestKey });
    } else {
      result = await emailProviderFor(credential).send({
        to: identifier, fromName: credential.senderName!, fromEmail: credential.senderEmail!, replyTo: credential.replyTo, subject: rendered.subject!, html: marketing ? rewriteTrackedLinks(rendered.html!, queued.id) : rendered.html!, text: rendered.text!, idempotencyKey: input.requestKey,
        headers: marketing ? { "List-Unsubscribe": `<${url}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" } : undefined,
        tags: { business: businessId, message: queued.id, ...(input.campaignId ? { campaign: input.campaignId } : {}) },
      });
    }
  } catch (err) {
    if (err instanceof ChannelRequestTimeout) {
      await prisma.message.update({ where: { id: queued.id }, data: { status: "UNKNOWN", errorReason: "הספק לא ענה בזמן; ייתכן שההודעה נשלחה. אין לנסות שוב אוטומטית" } });
      throw new MessagePolicyError("הספק לא ענה בזמן; תוצאה לא ודאית");
    }
    if (err instanceof ChannelProviderError && err.status !== null) {
      const retryable = !err.permanent && (err.status === 429 || err.status >= 500);
      await prisma.message.update({ where: { id: queued.id }, data: { status: "FAILED", errorReason: err.message.slice(0, 500), errorCode: `http_${err.status}`, retryable, failedAt: new Date() } });
      await audit(businessId, input.sentByUserId, "message", queued.id, "message.failed", { channel: input.channel, error: err.message.slice(0, 300) });
      return { message: await prisma.message.findUniqueOrThrow({ where: { id: queued.id } }) };
    }
    // Network / unreachable: nothing reached the provider. Remove the row so the caller can requeue and a
    // later retry (same requestKey) sends exactly once; the reserved frequency-cap slot is released too.
    if (input.campaignRecipientId) await prisma.campaignRecipient.updateMany({ where: { id: input.campaignRecipientId, messageId: queued.id }, data: { messageId: null } });
    await prisma.message.delete({ where: { id: queued.id } });
    if (marketing) await prisma.contact.updateMany({ where: { id: contact.id, lastMarketingAt: now }, data: { lastMarketingAt: null } });
    throw new ChannelUnavailableError(err instanceof Error ? err.message : "provider unavailable");
  }

  const message = await prisma.message.update({ where: { id: queued.id }, data: {
    status: result.status === "FAILED" ? "FAILED" : "ACCEPTED", providerMessageId: result.providerMessageId || null, errorReason: result.error ?? null,
    acceptedAt: result.status !== "FAILED" ? new Date() : null, failedAt: result.status === "FAILED" ? new Date() : null,
    segments: result.segments ?? rendered.segments ?? null, encoding: result.encoding ?? rendered.encoding ?? null,
    costAmount: result.cost ? new Prisma.Decimal(result.cost.amount) : null, costCurrency: result.cost?.currency ?? null,
  } });
  await prisma.conversation.update({ where: { id: conversation.id }, data: result.status === "FAILED" ? {} : { lastMessageAt: now } });
  await audit(businessId, input.sentByUserId, "message", message.id, result.status === "FAILED" ? "message.failed" : "message.accepted", { channel: input.channel, to: identifier, campaignId: input.campaignId ?? null, providerError: result.error ?? null });
  if (result.status !== "FAILED") {
    await emitEvent(prisma, { businessId, type: "message.sent", contactId: contact.id, actorUserId: input.automated ? null : input.sentByUserId, source: input.automated ? "automation" : "user", depth: input.eventDepth ?? 0, dedupeKey: `message.sent:${message.id}`, payload: { messageId: message.id, conversationId: conversation.id, channel: input.channel, category: marketing ? "marketing" : "service", templateId: template.id, campaignId: input.campaignId ?? null, sequenceRunId: input.sequenceRunId ?? null } });
    kickEventProcessing(businessId);
  }
  return { message };
}

export interface RenderedContent { body?: string; subject?: string; html?: string; text?: string; segments?: number; encoding?: string; missing: string[]; defaulted: string[] }

/** Render a channel template for one contact (used for sends, previews and tests). */
export function renderChannelContent(template: Pick<Template, "channel" | "body" | "subject" | "html" | "text">, contact: MergeContact, extra: Record<string, string>, opts: { marketing: boolean; sender?: SmsSender | null; url: string }): RenderedContent {
  if (template.channel === "sms") {
    const r = renderMergeTags(template.body, contact, extra);
    const body = r.text.trim() + smsFooter(opts.marketing, opts.sender ?? { id: "x", type: "number", value: "", inbound: false }, opts.url);
    const m = smsMetrics(body);
    return { body, segments: m.segments, encoding: m.encoding, missing: r.missing, defaulted: r.defaulted };
  }
  const subject = renderMergeTags(template.subject ?? "", contact, extra);
  const html = renderMergeTags(template.html ?? "", contact, extra);
  const text = renderMergeTags(template.text ?? template.body, contact, extra);
  return { subject: subject.text, html: html.text, text: text.text, missing: [...new Set([...subject.missing, ...html.missing, ...text.missing])], defaulted: [...new Set([...subject.defaulted, ...html.defaulted, ...text.defaulted])] };
}

/** Test send to an explicitly configured test recipient only. No contact, no Message row, never customers. */
export async function sendChannelTest(user: { id: string; businessId: string; fullName: string }, input: { channel: MarketingChannel; credentialId?: string | null; templateId: string; variables?: Record<string, string>; to: string; senderId?: string | null }) {
  const credential = await activeChannelCredential(input.channel, input.credentialId);
  const allowed = ((credential.testRecipients as string[] | null) ?? []).map((s) => s.trim().toLowerCase());
  const to = input.to.trim().toLowerCase();
  if (!allowed.includes(to)) throw new ApiError("שליחת בדיקה מותרת רק לנמעני בדיקה שהוגדרו במפורש בהגדרות החיבור", 403, "test_recipient_not_allowed", { allowed });
  const template = await prisma.template.findUnique({ where: { id: input.templateId } });
  if (!template || template.channel !== input.channel) throw new ApiError("התבנית אינה זמינה לערוץ זה", 400, "template_invalid");
  const sample: MergeContact = { fullName: user.fullName, email: to.includes("@") ? to : null, phoneE164: to.includes("@") ? null : to, company: null, city: null, customFields: {} };
  const url = unsubscribeUrl("test-preview");
  const sender = input.channel === "sms" ? pickSender(credential, input.senderId) : null;
  const rendered = renderChannelContent(template, sample, { ...(input.variables ?? {}), unsubscribe_url: url }, { marketing: template.category === "MARKETING", sender, url });
  if (rendered.missing.length) throw new ApiError(`משתנים חסרים ללא ברירת מחדל: ${rendered.missing.join(", ")}`, 400, "variables_missing");
  const key = `test:${credential.id}:${Date.now()}`;
  let result;
  try {
    result = input.channel === "sms"
      ? await smsProviderFor(credential).send({ to, from: sender!.value, body: rendered.body!, idempotencyKey: key })
      : await emailProviderFor(credential).send({ to, fromName: credential.senderName ?? user.fullName, fromEmail: credential.senderEmail ?? "", replyTo: credential.replyTo, subject: `[בדיקה] ${rendered.subject ?? ""}`, html: rendered.html!, text: rendered.text!, idempotencyKey: key });
  } catch (err) {
    const message = err instanceof ChannelRequestTimeout ? "הספק לא ענה בזמן" : (err as Error).message;
    await audit(user.businessId, user.id, "provider", credential.id, "channel.test_failed", { channel: input.channel, to, error: message.slice(0, 300) });
    throw new ApiError(message, 502, "test_send_failed");
  }
  await prisma.providerCredential.update({ where: { id: credential.id }, data: { lastOutboundTestAt: new Date() } });
  await audit(user.businessId, user.id, "provider", credential.id, "channel.test_sent", { channel: input.channel, to, providerMessageId: result.providerMessageId, status: result.status, error: result.error ?? null });
  if (result.status === "FAILED") throw new ApiError(result.error ?? "הספק דחה את הודעת הבדיקה", 502, "test_send_failed");
  return { providerMessageId: result.providerMessageId, status: result.status, segments: rendered.segments ?? result.segments ?? null, simulated: credential.provider.startsWith("mock") };
}

/**
 * Free-text SERVICE reply on an existing SMS conversation (inbox composer). No template, no
 * marketing footer; blocked only by a "do not contact" suppression / hard block. Same guarantees:
 * requestKey idempotency, persist-before-provider, timeout → UNKNOWN.
 */
export async function sendServiceSms(input: { conversationId: string; body: string; sentByUserId: string; requestKey?: string }): Promise<{ message: Message }> {
  const businessId = requireBusinessId();
  if (input.requestKey) {
    const existing = await prisma.message.findUnique({ where: { requestKey: input.requestKey } });
    if (existing) {
      if (["QUEUED", "UNKNOWN"].includes(existing.status)) throw new MessagePolicyError("תוצאת הבקשה הקודמת אינה ודאית. אין לשלוח שוב לפני בדיקה");
      return { message: existing };
    }
  }
  const conversation = await prisma.conversation.findUnique({ where: { id: input.conversationId }, include: { contact: true } });
  if (!conversation || conversation.channel !== "sms") throw new MessagePolicyError("השיחה אינה שיחת SMS");
  if (!conversation.providerCredentialId) throw new MessagePolicyError("לשיחה אין ספק SMS משויך");
  const body = input.body.trim();
  if (!body) throw new MessagePolicyError("אין תוכן לשליחה");
  const m = smsMetrics(body);
  if (m.segments > SMS_MAX_SEGMENTS) throw new MessagePolicyError(`ההודעה ארוכה מדי (${m.segments} מקטעים)`);
  const blocked = await sendBlockReason(businessId, conversation.contactId, "service");
  if (blocked) throw new MessagePolicyError(blocked);
  const credential = await activeChannelCredential("sms", conversation.providerCredentialId);
  // Reply from the sender the customer wrote to; fall back to the first inbound-capable sender.
  const lastInbound = await prisma.message.findFirst({ where: { conversationId: conversation.id, direction: "INBOUND" }, orderBy: { createdAt: "desc" }, select: { toIdentifier: true } });
  const senders = ((credential.senders as SmsSender[] | null) ?? []);
  const sender = senders.find((s) => s.value === lastInbound?.toIdentifier) ?? senders.find((s) => s.inbound) ?? senders[0];
  if (!sender) throw new MessagePolicyError("לספק ה-SMS אין שולח זמין");
  try { await consumeQuota(businessId, "messages_sent"); }
  catch (err) { if (err instanceof ApiError) throw new MessagePolicyError(err.message); throw err; }
  const now = new Date();
  const queued = await prisma.message.create({ data: { businessId, conversationId: conversation.id, channel: "sms", category: "service", direction: "OUTBOUND", type: "TEXT", body, status: "QUEUED", requestKey: input.requestKey, providerCredentialId: credential.id, sentByUserId: input.sentByUserId, toIdentifier: conversation.contact.phoneE164, segments: m.segments, encoding: m.encoding, createdAt: now } });
  let result;
  try { result = await smsProviderFor(credential).send({ to: conversation.contact.phoneE164, from: sender.value, body, idempotencyKey: input.requestKey ?? `msg:${queued.id}` }); }
  catch (err) {
    if (err instanceof ChannelRequestTimeout) { await prisma.message.update({ where: { id: queued.id }, data: { status: "UNKNOWN", errorReason: "הספק לא ענה בזמן; ייתכן שההודעה נשלחה" } }); throw new MessagePolicyError("הספק לא ענה בזמן; תוצאה לא ודאית"); }
    const reason = err instanceof Error ? err.message.slice(0, 500) : "provider error";
    await prisma.message.update({ where: { id: queued.id }, data: { status: "FAILED", errorReason: reason, failedAt: new Date() } });
    throw new MessagePolicyError(reason);
  }
  const message = await prisma.message.update({ where: { id: queued.id }, data: { status: result.status === "FAILED" ? "FAILED" : "ACCEPTED", providerMessageId: result.providerMessageId || null, errorReason: result.error ?? null, acceptedAt: result.status !== "FAILED" ? new Date() : null, failedAt: result.status === "FAILED" ? new Date() : null, costAmount: result.cost ? new Prisma.Decimal(result.cost.amount) : null, costCurrency: result.cost?.currency ?? null } });
  if (result.status !== "FAILED") await prisma.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: now } });
  await audit(businessId, input.sentByUserId, "message", message.id, result.status === "FAILED" ? "message.failed" : "message.accepted", { channel: "sms", to: conversation.contact.phoneE164 });
  if (result.status !== "FAILED") {
    await emitEvent(prisma, { businessId, type: "message.sent", contactId: conversation.contactId, actorUserId: input.sentByUserId, source: "user", dedupeKey: `message.sent:${message.id}`, payload: { messageId: message.id, conversationId: conversation.id, channel: "sms", category: "service", templateId: null } });
    kickEventProcessing(businessId);
  }
  return { message };
}
