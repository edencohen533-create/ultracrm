import { requireBusinessId } from "@/lib/tenant";
import { templateParameterKeys, validateTemplateVariables } from "@/lib/campaigns";
import { metaWebhookSchema, providerTimestamp, InvalidWebhookError, type MetaInboundMessage } from "@/lib/validation/whatsapp-webhook";
import { updateProviderMessageStatus } from "@/server/services/message-status-service";
import { MAX_DOWNLOAD_BYTES, safeMediaDownloadUrl } from "@/lib/media";
import crypto from "node:crypto";
import { GRAPH_VERSION } from "@/lib/meta/graph";
import { classifyMetaError } from "@/lib/meta/errors";
import { ProviderUnavailableError } from "@/server/providers/provider-registry";
import { db } from "@/lib/db";
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { ConversationSource, MessageStatus, MessageType } from "@/generated/prisma/client";
import { createInboundMessage } from "@/server/services/message-service";
import { normalizePhone } from "@/lib/phone";
import type {
  MessageStatusResult,
  OutboundMessagePayload,
  SendResult,
  WhatsAppProvider,
} from "./whatsapp-provider";

export interface MetaWhatsAppConfig {
  accessToken: string;
  phoneNumberId: string;
  businessAccountId?: string;
  webhookVerifyToken: string;
  appSecret?: string;
  apiVersion?: string;
  /** Two-step verification PIN used for Cloud API registration (Embedded Signup). */
  twoStepPin?: string;
}

const META_TYPE_TO_MESSAGE_TYPE: Record<string, MessageType> = {
  text: MessageType.TEXT,
  image: MessageType.IMAGE,
  video: MessageType.VIDEO,
  audio: MessageType.AUDIO,
  document: MessageType.DOCUMENT,
};

const META_STATUS_TO_MESSAGE_STATUS: Record<string, MessageStatus> = {
  sent: MessageStatus.SENT,
  delivered: MessageStatus.DELIVERED,
  read: MessageStatus.READ,
  failed: MessageStatus.FAILED,
};

/**
 * Real Meta WhatsApp Cloud API integration. Activated by setting a
 * ProviderCredential row with provider="meta_whatsapp_cloud_api" and
 * isActive=true (see Settings → חיבור וואטסאפ). Implements the same
 * WhatsAppProvider interface as the mock, so no calling code changes.
 *
 * Docs: https://developers.facebook.com/docs/whatsapp/cloud-api
 */
export class MetaWhatsAppProvider implements WhatsAppProvider {
  readonly requiresVerifiedInbound = true;
  constructor(private readonly config: MetaWhatsAppConfig, readonly credentialId?: string) {}

  private get baseUrl(): string {
    return `https://graph.facebook.com/${this.config.apiVersion ?? GRAPH_VERSION}/${this.config.phoneNumberId}`;
  }

  private toE164Digits(phone: string): string {
    return phone.replace(/^\+/, "");
  }

  private async post(path: string, body: unknown) {
    // Re-check right before each send: the connection may have been disconnected, revoked or blocked meanwhile.
    if (this.credentialId && !await prisma.providerCredential.findFirst({ where: { id: this.credentialId, isActive: true, sendingBlocked: false, phoneNumberId: this.config.phoneNumberId, status: { notIn: ["disconnected", "revoked", "error"] } }, select: { id: true } })) throw new ProviderUnavailableError("החיבור השתנה או שהשליחה חסומה – הקמפיין יושהה עד לבדיקה");
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.config.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
      redirect: "error",
    });
    const data = await res.json().catch(() => ({}));
    const classified = res.ok ? null : classifyMetaError(data?.error?.code, res.status, data?.error?.message);
    if (classified?.blocksCredential && this.credentialId) {
      await prisma.providerCredential.update({ where: { id: this.credentialId }, data: { sendingBlocked: true, status: "revoked", lastConnectionError: `Meta error ${data.error.code}: ${classified.label}`, lastCheckedAt: new Date() } });
    }
    return { ok: res.ok, data, classified };
  }

  async sendMessage(payload: OutboundMessagePayload): Promise<SendResult> {
    const to = this.toE164Digits(payload.to);
    let body: Record<string, unknown>;
    const media = payload.mediaId ? { id: payload.mediaId } : { link: payload.mediaUrl };

    switch (payload.type) {
      case "IMAGE":
        body = { messaging_product: "whatsapp", to, type: "image", image: { ...media, ...(payload.body ? { caption: payload.body } : {}) } };
        break;
      case "VIDEO":
        body = { messaging_product: "whatsapp", to, type: "video", video: { ...media, ...(payload.body ? { caption: payload.body } : {}) } };
        break;
      case "AUDIO":
        body = { messaging_product: "whatsapp", to, type: "audio", audio: media };
        break;
      case "DOCUMENT":
        body = { messaging_product: "whatsapp", to, type: "document", document: { ...media, ...(payload.body ? { caption: payload.body } : {}), ...(payload.fileName ? { filename: payload.fileName } : {}) } };
        break;
      default:
        body = { messaging_product: "whatsapp", to, type: "text", text: { body: payload.body ?? "" } };
    }

    const { ok, data, classified } = await this.post("/messages", body);
    if (!ok) {
      return { providerMessageId: "", status: "FAILED", error: classified?.label ?? data?.error?.message ?? "Meta API error", errorCode: classified?.code ?? null, retryable: Boolean(classified?.retryable) };
    }
    if (typeof data?.messages?.[0]?.id !== "string" || !data.messages[0].id) throw new Error("Meta accepted request without a message ID; outcome unknown");
    return { providerMessageId: data.messages[0].id, status: "ACCEPTED" };
  }

  async sendTemplate(payload: OutboundMessagePayload): Promise<SendResult> {
    if (!payload.templateId) {
      return { providerMessageId: "", status: "FAILED", error: "templateId is required to send a template" };
    }

    const template = await prisma.template.findUnique({ where: { id: payload.templateId } });
    if (!template || template.status !== "APPROVED" || !template.providerTemplateId || !this.config.businessAccountId || template.providerAccountId !== this.config.businessAccountId) {
      return { providerMessageId: "", status: "FAILED", error: "Template is not approved" };
    }

    const to = this.toE164Digits(payload.to);
    try { validateTemplateVariables(template.body, payload.templateVariables ?? {}); }
    catch { return { providerMessageId: "", status: "FAILED", error: "Invalid template variables" }; }
    const parameters = templateParameterKeys(template.body).map((key) => ({
      type: "text", text: payload.templateVariables![key],
    }));
    const components: Array<Record<string, unknown>> = [];
    // Header media: the template declares IMAGE/VIDEO/DOCUMENT; the send supplies a public link.
    const headerFormat = (template.headerFormat ?? "").toUpperCase();
    if (["IMAGE", "VIDEO", "DOCUMENT"].includes(headerFormat)) {
      if (!payload.templateMedia?.link) return { providerMessageId: "", status: "FAILED", error: "לתבנית זו נדרש קובץ מדיה לכותרת", errorCode: "template_media_required", retryable: false };
      const key = headerFormat.toLowerCase();
      components.push({ type: "header", parameters: [{ type: key, [key]: { link: payload.templateMedia.link, ...(key === "document" && payload.templateMedia.filename ? { filename: payload.templateMedia.filename } : {}) } }] });
    }
    if (parameters.length > 0) components.push({ type: "body", parameters });
    // Dynamic URL buttons: Meta expects one component per button with its index and the suffix text.
    const buttons = (template.buttons as Array<{ type: string; dynamic?: boolean }> | null) ?? [];
    buttons.forEach((b, index) => {
      if (b.type === "URL" && b.dynamic) {
        const suffix = payload.templateButtonParams?.[String(index)];
        if (suffix) components.push({ type: "button", sub_type: "url", index: String(index), parameters: [{ type: "text", text: suffix }] });
      }
    });
    const missingButton = buttons.some((b, index) => b.type === "URL" && b.dynamic && !payload.templateButtonParams?.[String(index)]);
    if (missingButton) return { providerMessageId: "", status: "FAILED", error: "לכפתור הקישור בתבנית נדרש ערך", errorCode: "template_button_param_required", retryable: false };

    const { ok, data, classified } = await this.post("/messages", {
      messaging_product: "whatsapp",
      to,
      type: "template",
      template: {
        name: template.name,
        language: { code: template.language },
        ...(components.length > 0 ? { components } : {}),
      },
    });

    if (!ok) {
      return { providerMessageId: "", status: "FAILED", error: classified?.label ?? data?.error?.message ?? "Meta API error", errorCode: classified?.code ?? null, retryable: Boolean(classified?.retryable) };
    }
    if (typeof data?.messages?.[0]?.id !== "string" || !data.messages[0].id) throw new Error("Meta accepted request without a message ID; outcome unknown");
    return { providerMessageId: data.messages[0].id, status: "ACCEPTED" };
  }

  async uploadMedia(file: Buffer, mimeType: string): Promise<{ mediaUrl: string; mediaId?: string }> {
    const form = new FormData();
    form.append("messaging_product", "whatsapp");
    form.append("type", mimeType);
    form.append("file", new Blob([new Uint8Array(file)], { type: mimeType }));

    const res = await fetch(`${this.baseUrl}/media`, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.config.accessToken}` },
      body: form,
      signal: AbortSignal.timeout(15000),
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data?.error?.message ?? "Meta media upload failed");
    }
    if (typeof data.id !== "string" || !/^\d+$/.test(data.id)) throw new Error("Missing Meta media ID");
    return { mediaUrl: `meta:${data.id}`, mediaId: data.id };
  }

  async downloadMedia(mediaId: string, range?: string): Promise<Response> {
    if (!/^\d+$/.test(mediaId)) throw new Error("Invalid media ID");
    const headers = { Authorization: `Bearer ${this.config.accessToken}` };
    const metadata = await fetch(`https://graph.facebook.com/${this.config.apiVersion ?? GRAPH_VERSION}/${mediaId}?phone_number_id=${encodeURIComponent(this.config.phoneNumberId)}`, {
      headers, redirect: "error", cache: "no-store", signal: AbortSignal.timeout(10000),
    });
    if (!metadata.ok) throw new Error("Media is no longer available");
    const data = await metadata.json();
    if (Number(data.file_size) > MAX_DOWNLOAD_BYTES) throw new Error("Media exceeds download limit");
    const url = safeMediaDownloadUrl(data.url);
    const response = await fetch(url, { headers: { ...headers, ...(range ? { Range: range } : {}) }, redirect: "error", cache: "no-store", signal: AbortSignal.timeout(15000) });
    if (!response.ok || !response.body) throw new Error("Media download failed");
    if (Number(response.headers.get("content-length")) > MAX_DOWNLOAD_BYTES) { await response.body.cancel(); throw new Error("Media exceeds download limit"); }
    return response;
  }

  async getMessageStatus(): Promise<MessageStatusResult> {
    // Meta has no pull endpoint for message status — it arrives via the
    // "statuses" webhook events, handled in receiveWebhook() below.
    throw new Error("Meta does not provide a message status lookup; use webhook evidence");
  }

  verifyWebhook(headers: Headers, rawBody: string): boolean {
    if (!this.config.appSecret) {
      return false;
    }

    const signatureHeader = headers.get("x-hub-signature-256");
    if (!signatureHeader) return false;

    const expected =
      "sha256=" + crypto.createHmac("sha256", this.config.appSecret).update(rawBody, "utf8").digest("hex");

    const a = Buffer.from(signatureHeader);
    const b = Buffer.from(expected);
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  }

  verifyWebhookChallenge(mode: string | null, token: string | null, challenge: string | null): string | null {
    if (mode === "subscribe" && token === this.config.webhookVerifyToken) {
      return challenge;
    }
    return null;
  }

  async receiveWebhook(payload: unknown): Promise<void> {
    const parsed = metaWebhookSchema.safeParse(payload);
    if (!parsed.success) throw new InvalidWebhookError("Invalid webhook payload");
    for (const entry of parsed.data.entry) {
      for (const change of entry.changes) {
        const value = change.value;
        if (change.field !== "messages" || value.metadata?.phone_number_id !== this.config.phoneNumberId) continue;
        for (const message of value.messages ?? []) {
          const contactName = value.contacts?.find((contact) => contact.wa_id === message.from)?.profile?.name;
          await this.handleInboundMessage(message, contactName);
        }
        for (const status of value.statuses ?? []) {
          const mapped = META_STATUS_TO_MESSAGE_STATUS[status.status];
          if (!mapped) continue;
          // Event ledger: every status callback is recorded once; Meta retries (same wamid+status+timestamp) are no-ops.
          const eventId = `${status.id}:${status.status}:${status.timestamp}`;
          try { await db.providerWebhookEvent.create({ data: { businessId: requireBusinessId(), credentialId: this.credentialId ?? null, provider: "meta_whatsapp_cloud_api", eventId, type: status.status, occurredAt: providerTimestamp(status.timestamp), result: status.errors?.length ? ({ errors: status.errors } as unknown as Prisma.InputJsonValue) : undefined } }); }
          catch (err) { if ((err as { code?: string }).code === "P2002") continue; throw err; }
          const failure = status.errors?.[0];
          const classified = failure ? classifyMetaError(failure.code, null, failure.message ?? failure.title) : null;
          try {
            await updateProviderMessageStatus(status.id, mapped, providerTimestamp(status.timestamp), this.credentialId, classified ? { reason: classified.label, code: classified.code } : undefined);
          } catch (err) {
            // Do not keep a ledger row for a status that was never applied – Meta's retry must be able to re-deliver it.
            await db.providerWebhookEvent.deleteMany({ where: { provider: "meta_whatsapp_cloud_api", eventId } }).catch(() => undefined);
            throw err;
          }
        }
      }
    }
  }

  private async handleInboundMessage(message: MetaInboundMessage, contactName: string | undefined) {
    const phone = normalizePhone(`+${message.from}`) ?? `+${message.from}`;

    // The CRM contact is the single source of truth: find by any linked phone, otherwise create one card (race-safe).
    const { findOrCreateContactByPhone } = await import("@/lib/crm/contacts");
    const contact = await findOrCreateContactByPhone(requireBusinessId(), phone, { fullName: contactName ?? phone, phoneRaw: `+${message.from}`, source: "whatsapp" });

    const type = META_TYPE_TO_MESSAGE_TYPE[message.type] ?? MessageType.TEXT;
    const text =
      message.text?.body ??
      message.button?.text ??
      message.interactive?.button_reply?.title ??
      message.interactive?.list_reply?.title ??
      message.image?.caption ??
      message.video?.caption ??
      message.document?.caption ??
      `[${message.type}]`;

    const attachment = message.image ?? message.video ?? message.audio ?? message.document;
    await createInboundMessage({
      contactId: contact.id,
      providerCredentialId: this.credentialId,
      providerMessageId: message.id,
      receivedAt: providerTimestamp(message.timestamp),
      media: attachment ? { providerMediaId: attachment.id, mimeType: attachment.mime_type ?? "application/octet-stream", fileName: attachment.filename } : undefined,
      body: text,
      type,
      source: ConversationSource.WHATSAPP,
    });
  }

}
