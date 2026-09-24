import { prisma } from "@/lib/db";
import { createInboundMessage } from "@/server/services/message-service";
import { MessageType } from "@/generated/prisma/client";
import type { SendResult, WhatsAppProvider } from "./whatsapp-provider";

const PLACEHOLDER_MEDIA_URLS: Record<string, string> = {
  IMAGE: "https://placehold.co/600x400?text=Solina",
  VIDEO: "https://storage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4",
  AUDIO: "https://file-examples.com/storage/fe1f8f3f0d6b8d8e17b1e3d/2017/11/file_example_MP3_700KB.mp3",
  DOCUMENT: "https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf",
};

export class MockWhatsAppProvider implements WhatsAppProvider {
  readonly requiresVerifiedInbound = false;
  readonly credentialId: string | undefined = undefined;
  async sendMessage(): Promise<SendResult> {
    return { providerMessageId: `mock_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, status: "SENT" };
  }

  async sendTemplate(): Promise<SendResult> {
    return this.sendMessage();
  }

  async uploadMedia(_file: Buffer, mimeType: string): Promise<{ mediaUrl: string; mediaId?: string }> {
    const type = Object.keys(PLACEHOLDER_MEDIA_URLS).find((key) => mimeType.startsWith(key.toLowerCase()));
    return { mediaUrl: PLACEHOLDER_MEDIA_URLS[type ?? "IMAGE"] };
  }

  async getMessageStatus() {
    return { status: "DELIVERED" as const };
  }

  verifyWebhook(): boolean {
    // The mock has no external caller, so any "webhook" is implicitly trusted.
    return true;
  }

  verifyWebhookChallenge(_mode: string | null, _token: string | null, challenge: string | null): string | null {
    return challenge;
  }

  async receiveWebhook(): Promise<void> {
    // Not used by the mock — inbound messages go through simulateInbound()
    // instead. Kept to satisfy the WhatsAppProvider interface for parity
    // with a real provider's webhook handler.
  }

  /**
   * Powers the Settings → Demo Simulator: injects an inbound message for a
   * contact through the exact same path a real WhatsApp webhook will use.
   */
  async simulateInbound(params: { contactId: string; body: string; type?: MessageType }) {
    const contact = await prisma.contact.findUniqueOrThrow({ where: { id: params.contactId } });

    const mediaUrl =
      params.type && params.type !== MessageType.TEXT ? PLACEHOLDER_MEDIA_URLS[params.type] : undefined;

    return createInboundMessage({
      contactId: contact.id,
      body: params.body,
      type: params.type ?? MessageType.TEXT,
      mediaUrl,
    });
  }
}
