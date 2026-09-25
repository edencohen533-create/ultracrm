export interface OutboundMessagePayload {
  conversationId: string;
  to: string;
  type: "TEXT" | "IMAGE" | "VIDEO" | "AUDIO" | "DOCUMENT" | "TEMPLATE";
  body?: string;
  mediaUrl?: string;
  mediaId?: string;
  fileName?: string;
  templateId?: string;
  templateVariables?: Record<string, string>;
}

export interface SendResult {
  providerMessageId: string;
  status: "ACCEPTED" | "SENT" | "FAILED";
  error?: string;
}

export interface MessageStatusResult {
  status: "SENT" | "DELIVERED" | "READ" | "FAILED";
}

/**
 * Every WhatsApp integration (mock today, Meta Cloud API / Telnyx later)
 * implements this interface. Services and API routes only ever depend on
 * this shape, resolved through the provider registry — never on a concrete
 * implementation — so swapping providers touches no calling code.
 */
export interface WhatsAppProvider {
  readonly credentialId?: string;
  readonly requiresVerifiedInbound?: boolean;
  sendMessage(payload: OutboundMessagePayload): Promise<SendResult>;
  sendTemplate(payload: OutboundMessagePayload): Promise<SendResult>;
  uploadMedia(file: Buffer, mimeType: string): Promise<{ mediaUrl: string; mediaId?: string }>;
  downloadMedia?(mediaId: string, range?: string): Promise<Response>;
  getMessageStatus(providerMessageId: string): Promise<MessageStatusResult>;
  /** POST webhook signature verification (e.g. X-Hub-Signature-256). */
  verifyWebhook(headers: Headers, rawBody: string): boolean;
  /** GET webhook handshake (Meta's hub.mode/hub.verify_token/hub.challenge). Returns the challenge to echo back, or null to reject. */
  verifyWebhookChallenge(mode: string | null, token: string | null, challenge: string | null): string | null;
  receiveWebhook(payload: unknown): Promise<void>;
}
