/**
 * Apply provider webhook events for SMS / email.
 *  • every event is recorded once in ProviderWebhookEvent (provider + eventId) → duplicates are no-ops
 *  • statuses only move forward (a late SENT after DELIVERED is ignored; FAILED never overrides DELIVERED)
 *  • opens/clicks are stored as signals (openedAt/clickedAt) – never as READ
 *  • hard bounce → the address is marked and never retried; complaint → global marketing suppression
 *  • inbound SMS → inbox message on the contact; "הסר"/STOP → global suppression; unclear → held for review
 *  • delivery failures emit `message.delivery_failed` (cross-channel sequences listen to it)
 */
import { Prisma, type MessageStatus, type ProviderCredential } from "@/generated/prisma/client";
import { db, prisma } from "@/lib/db";
import { withBusiness } from "@/lib/tenant";
import { audit } from "@/lib/audit";
import { emitEvent, kickEventProcessing } from "@/lib/events";
import { suppressContact } from "@/lib/suppression";
import { isAmbiguousUnsubscribe, isUnsubscribe } from "@/lib/message-policy";
import { normalizePhone } from "@/lib/phone";
import { publishMessageStatus } from "@/lib/realtime/publish";
import type { ProviderEvent } from "@/server/channels/types";

const RANK: Record<MessageStatus, number> = { QUEUED: 0, UNKNOWN: 0, ACCEPTED: 1, SENT: 2, DELIVERED: 3, READ: 4, FAILED: 9, BOUNCED: 9, CANCELLED: 9 };

/** Returns "applied" | "duplicate" | "ignored" per event. */
export async function ingestProviderEvents(credential: ProviderCredential, events: ProviderEvent[], eventIdPrefix = "") {
  const results: Array<{ eventId: string; outcome: string }> = [];
  for (const ev of events) {
    const eventId = `${eventIdPrefix}${ev.eventId}`;
    try {
      await db.providerWebhookEvent.create({ data: { businessId: credential.businessId, credentialId: credential.id, provider: credential.provider, eventId, type: ev.kind === "status" ? ev.status : ev.kind, occurredAt: "at" in ev ? ev.at : null } });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") { results.push({ eventId, outcome: "duplicate" }); continue; }
      throw err;
    }
    const outcome = await withBusiness(credential.businessId, async () => {
      if (ev.kind === "ignored") return "ignored";
      if (ev.kind === "inbound") return applyInbound(credential, ev);
      return applyStatus(credential, ev);
    });
    await db.providerWebhookEvent.updateMany({ where: { provider: credential.provider, eventId }, data: { result: { outcome } } });
    results.push({ eventId, outcome });
  }
  await db.providerCredential.update({ where: { id: credential.id }, data: { lastWebhookAt: new Date() } });
  return results;
}

async function applyStatus(credential: ProviderCredential, ev: Extract<ProviderEvent, { kind: "status" }>): Promise<string> {
  const message = await prisma.message.findFirst({ where: { providerMessageId: ev.providerMessageId, providerCredentialId: credential.id, direction: "OUTBOUND" }, include: { conversation: { select: { contactId: true } }, campaignRecipient: { select: { campaignId: true } } } });
  if (!message) return "unknown_message";
  const businessId = credential.businessId;
  const contactId = message.conversation.contactId;
  const costData = ev.cost ? { costAmount: new Prisma.Decimal(ev.cost.amount), costCurrency: ev.cost.currency } : {};
  const segData = ev.segments ? { segments: ev.segments } : {};

  if (ev.status === "OPENED" || ev.status === "CLICKED") {
    await prisma.message.update({ where: { id: message.id }, data: ev.status === "OPENED" ? { openedAt: message.openedAt ?? ev.at } : { clickedAt: message.clickedAt ?? ev.at, openedAt: message.openedAt ?? ev.at } });
    return "engagement";
  }
  if (ev.status === "COMPLAINED") {
    await prisma.message.update({ where: { id: message.id }, data: { complainedAt: message.complainedAt ?? ev.at } });
    await suppressContact({ businessId, contactId, identifier: message.toIdentifier ?? undefined, scope: "marketing", source: "email", reason: "תלונת ספאם מהספק", evidence: `message:${message.id}` });
    await prisma.suppression.updateMany({ where: { businessId, contactId, revokedAt: null, messageId: null, source: "email" }, data: { messageId: message.id } });
    return "complaint";
  }
  const next: MessageStatus = ev.status === "BOUNCED" ? "BOUNCED" : ev.status;
  const terminalLate = RANK[next] >= 9 && message.status === "DELIVERED";
  if (terminalLate || (RANK[next] <= RANK[message.status] && RANK[message.status] < 9) || RANK[message.status] >= 9) {
    // Still record cost / segments reported late.
    if (Object.keys(costData).length || Object.keys(segData).length) await prisma.message.update({ where: { id: message.id }, data: { ...costData, ...segData } });
    return "out_of_order";
  }
  await prisma.message.update({ where: { id: message.id }, data: {
    status: next, ...costData, ...segData,
    ...(next === "SENT" ? { sentAt: message.sentAt ?? ev.at } : {}),
    ...(next === "DELIVERED" ? { deliveredAt: ev.at, sentAt: message.sentAt ?? ev.at } : {}),
    ...(next === "FAILED" ? { failedAt: ev.at, errorReason: ev.detail ?? "provider failure" } : {}),
    ...(next === "BOUNCED" ? { bouncedAt: ev.at, bounceType: ev.bounceType ?? "soft", errorReason: ev.detail ?? "bounce" } : {}),
  } });
  await publishMessageStatus({ type: "message_status", conversationId: message.conversationId, messageId: message.id, status: next }).catch(() => undefined);
  if (next === "BOUNCED" && ev.bounceType === "hard" && message.toIdentifier) await markHardBounce(businessId, contactId, message.toIdentifier, ev.at);
  if (next === "FAILED" || next === "BOUNCED") {
    await emitEvent(prisma, { businessId, type: "message.delivery_failed", contactId, source: "webhook", occurredAt: ev.at, dedupeKey: `message.delivery_failed:${message.id}`, payload: { messageId: message.id, channel: message.channel, category: message.category, campaignId: message.campaignRecipient?.campaignId ?? null, permanent: Boolean(ev.permanent), detail: ev.detail ?? null } });
    kickEventProcessing(businessId);
  }
  return `status:${next}`;
}

async function markHardBounce(businessId: string, contactId: string, identifier: string, at: Date) {
  const email = identifier.toLowerCase();
  await prisma.contact.updateMany({ where: { id: contactId, email }, data: { emailStatus: "hard_bounce", emailBouncedAt: at } });
  await prisma.contactEmail.updateMany({ where: { contactId, email }, data: { status: "hard_bounce", bouncedAt: at } });
  await audit(businessId, null, "contact", contactId, "contact.email_hard_bounce", { identifier: email });
}

async function applyInbound(credential: ProviderCredential, ev: Extract<ProviderEvent, { kind: "inbound" }>): Promise<string> {
  const businessId = credential.businessId;
  const dupe = await prisma.message.findUnique({ where: { inboundKey: `${credential.provider}:${ev.providerMessageId}` }, select: { id: true } });
  if (dupe) return "duplicate_inbound";
  const phone = normalizePhone(ev.from.startsWith("+") ? ev.from : `+${ev.from}`) ?? ev.from;
  const { findOrCreateContactByPhone } = await import("@/lib/crm/contacts");
  const contact = await findOrCreateContactByPhone(businessId, phone, { fullName: phone, phoneRaw: ev.from, source: "sms" });
  const result = await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "contacts" WHERE id = ${contact.id} FOR UPDATE`;
    const conversation = await tx.conversation.findFirst({ where: { contactId: contact.id, channel: "sms", providerCredentialId: credential.id, status: { in: ["OPEN", "PENDING"] } }, orderBy: { createdAt: "desc" } })
      ?? await tx.conversation.create({ data: { businessId, contactId: contact.id, channel: "sms", providerCredentialId: credential.id, source: "MANUAL" } });
    const message = await tx.message.create({ data: { businessId, conversationId: conversation.id, channel: "sms", category: "service", direction: "INBOUND", type: "TEXT", body: ev.body, status: "SENT", providerCredentialId: credential.id, providerMessageId: ev.providerMessageId, inboundKey: `${credential.provider}:${ev.providerMessageId}`, toIdentifier: ev.to, createdAt: ev.at } });
    await tx.conversation.update({ where: { id: conversation.id }, data: { lastMessageAt: ev.at, lastInboundAt: ev.at, unreadCount: { increment: 1 } } });
    let unsubscribe: "clear" | "review" | null = null;
    if (isUnsubscribe(ev.body)) {
      unsubscribe = "clear";
      await suppressContact({ businessId, contactId: contact.id, scope: "marketing", source: "sms", reason: `תשובת SMS: "${ev.body.trim().slice(0, 40)}"`, evidence: `message:${message.id}` }, tx);
      const { applyUnsubscribeAutomation } = await import("@/lib/unsubscribe-automation");
      await applyUnsubscribeAutomation(businessId, contact.id, tx);
    } else if (isAmbiguousUnsubscribe(ev.body)) {
      unsubscribe = "review";
      await suppressContact({ businessId, contactId: contact.id, scope: "marketing", source: "sms", reason: `בקשה לא ברורה – ממתינה לבדיקה: "${ev.body.trim().slice(0, 60)}"`, evidence: `message:${message.id}`, pendingReview: true }, tx);
    }
    if (unsubscribe) await tx.suppression.updateMany({ where: { businessId, contactId: contact.id, revokedAt: null, messageId: null }, data: { messageId: message.id } });
    await emitEvent(tx, { businessId, type: "message.received", contactId: contact.id, source: "webhook", occurredAt: ev.at, dedupeKey: `message.received:${message.id}`, payload: { messageId: message.id, conversationId: conversation.id, channel: "sms", type: "TEXT", body: ev.body.slice(0, 200) } });
    return { conversation, message, unsubscribe };
  });
  kickEventProcessing(businessId);
  return result.unsubscribe ? `inbound:${result.unsubscribe}` : "inbound";
}
