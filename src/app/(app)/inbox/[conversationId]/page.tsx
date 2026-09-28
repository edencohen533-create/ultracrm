import { Tasks } from "@/components/contacts/contact-tasks";
import { organizationRequest } from "@/lib/auth-compat";
import { InternalNotes } from "@/components/inbox/internal-notes";
import Link from "next/link";
import { notFound } from "next/navigation";
import { auth } from "@/lib/auth-compat";
import { prisma } from "@/lib/db";
import { getConversationForUser } from "@/server/services/conversation-service";
import { ChatPanel } from "@/components/inbox/chat-panel";
import { ContactProfilePanel } from "@/components/inbox/contact-profile-panel";
import { ConversationActions } from "@/components/inbox/conversation-actions";
import type { MessageItem } from "@/types/domain";
import { getAiSettings } from "@/server/ai/settings";
import { AiHandlingBar } from "@/components/inbox/ai-handling-bar";
import { serverT } from "@/lib/i18n-server";

const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

export default organizationRequest(async function ConversationPage({
  params,
}: {
  params: Promise<{ conversationId: string }>;
}) {
  const { conversationId } = await params;
  const t = await serverT();
  const session = await auth();
  if (!session?.user) {
    notFound();
  }

  const conversation = await getConversationForUser(session, conversationId);
  if (!conversation) {
    notFound();
  }

  const messages: MessageItem[] = conversation.messages.map((message) => ({
    id: message.id,
    direction: message.direction,
    type: message.type,
    body: message.body,
    status: message.status,
    createdAt: message.createdAt.toISOString(),
    attachments: message.attachments.map(({ id, url, mimeType, fileName, sizeBytes }) => ({ id, url, mimeType, fileName, sizeBytes })),
    sentByUser: message.sentByUser ? { id: message.sentByUser.id, name: message.sentByUser.fullName } : null,
    aiBot: Boolean(message.requestKey?.startsWith("ai:svc:")),
  }));
  const { ai } = await getAiSettings(conversation.businessId);
  const aiEnabledHere = ai.service.enabled && ai.service.credentialIds.includes(conversation.providerCredentialId ?? "demo");

  const now = Date.now();
  const composerDisabled =
    !conversation.lastInboundAt || now - conversation.lastInboundAt.getTime() > TWENTY_FOUR_HOURS_MS;

  const senderUnavailable = conversation.providerCredential
    ? (!conversation.providerCredential.isActive || conversation.providerCredential.sendingBlocked ? t("המספר השולח מנותק או חסום. יש לפנות למנהל לחיבור מחדש", "The sending number is disconnected or blocked. Ask an admin to reconnect it.") : null)
    : await prisma.providerCredential.findFirst({ where: { isActive: true, provider: "meta_whatsapp_cloud_api" }, select: { id: true } }) ? t("שיחת הדגמה: יש לפתוח שיחה חדשה באמצעות מספר WhatsApp מחובר", "Demo conversation: start a new conversation from a connected WhatsApp number") : null;
  const agents = await prisma.user.findMany({
    where: { isActive: true, ...(session.user.role === "agent" ? { id: session.user.id } : {}), ...(conversation.providerCredential?.teamId ? { OR: [{ teamId: conversation.providerCredential.teamId }, { role: { in: ["owner", "manager"] } }] } : {}) },
    select: { id: true, fullName: true },
  });

  return (
    <div className="flex h-full flex-col">
      <Link href="/inbox" className="border-b p-2 text-sm underline md:hidden">{t("חזרה לרשימת השיחות", "Back to conversations")}</Link>
      <ConversationActions
        conversationId={conversation.id}
        status={conversation.status}
        assignedAgentId={conversation.assignedAgentId}
        agents={agents.map((a) => ({ id: a.id, name: a.fullName }))}
        isSpam={conversation.isSpam}
      />
      {(aiEnabledHere || conversation.aiMode) && <AiHandlingBar conversationId={conversation.id} aiMode={conversation.aiMode} enabledHere={aiEnabledHere} reason={conversation.aiHandoffReason} summary={conversation.aiHandoffSummary} />}
      <div className="flex items-center justify-between border-b px-3 py-2 text-sm"><span>{conversation.contact.fullName}</span><Link className="underline" href={`/contacts/${conversation.contactId}`}>{t("כרטיס לקוח והסרה מדיוור", "Contact profile & unsubscribe")}</Link></div>
      <div className="border-b px-3 py-1 text-xs text-muted-foreground">{t("מספר השיחה:", "Conversation number:")} {conversation.providerCredential ? `${conversation.providerCredential.label || "WhatsApp"} · ${conversation.providerCredential.displayPhoneNumber || t("מספר עסקי", "Business number")}` : t("הדגמה בלבד", "Demo only")}</div>
      <Tasks key={`tasks:${conversation.id}`} contactId={conversation.contactId} conversationId={conversation.id} userId={session.user.id} />
      <InternalNotes key={conversation.id} conversationId={conversation.id} notes={conversation.notes.map((note) => ({ id: note.id, body: note.body, createdAt: note.createdAt.toISOString(), author: { name: note.author.fullName } }))} />
      <div className="flex min-h-0 flex-1">
      <ChatPanel
        key={conversation.id}
        conversationId={conversation.id}
        initialMessages={messages}
        senderUnavailable={senderUnavailable}
        composerDisabled={composerDisabled}
        composerDisabledReason={t("עברו יותר מ-24 שעות מאז הודעת הלקוח האחרונה — יש לשלוח תבנית מאושרת.", "More than 24 hours have passed since the customer's last message — send an approved template.")}
      />
      <ContactProfilePanel
        contact={{
          name: conversation.contact.fullName,
          phone: conversation.contact.phoneE164,
          email: conversation.contact.email,
          consentStatus: conversation.contact.consentStatus,
          tags: conversation.contact.tags,
          customFields: Object.entries((conversation.contact.customFields as Record<string, unknown> | null) ?? {}).map(([key, value]) => ({ key, value: String(value ?? "") })),
        }}
      />
      </div>
    </div>
  );
}, "whatsapp.view");
