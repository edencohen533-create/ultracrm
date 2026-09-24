import { prisma } from "@/lib/db";
import { automationRuleSchema, type AutomationRuleInput } from "@/lib/validation/automation";
import { eligibilityError, MARKETING_INTERVAL_MS } from "@/lib/message-policy";
import { personalizeVariables, renderTemplate, validateTemplateVariables } from "@/lib/campaigns";
import { resolveSender } from "@/server/providers/provider-registry";

export class AutomationPreviewError extends Error {}
/** Read-only validation shared by creation, activation and dry-run. */
export async function validateAutomationReferences(rule: AutomationRuleInput) {
  const config = rule.actionConfig;
  if (rule.actionType === "ASSIGN_AGENT" && !await prisma.user.findFirst({ where: { id: String(config.agentId), isActive: true }, select: { id: true } })) throw new AutomationPreviewError("הנציג אינו פעיל או אינו נגיש בעסק זה");
  if (rule.actionType === "SEND_CANNED_REPLY" && !await prisma.cannedReply.findUnique({ where: { id: String(config.cannedReplyId) }, select: { id: true } })) throw new AutomationPreviewError("התגובה המוכנה אינה נגישה בעסק זה");
  if (rule.actionType === "SEND_TEMPLATE") {
    const template = await prisma.template.findUnique({ where: { id: String(config.templateId) } });
    if (!template || template.status !== "APPROVED") throw new AutomationPreviewError("התבנית אינה נגישה או אינה מאושרת");
    try { validateTemplateVariables(template.body, (config.variables ?? {}) as Record<string, string>); }
    catch (error) { throw new AutomationPreviewError((error as Error).message); }
  }
}

/** Never calls executeAction, providers, writes, or marketing reservations. */
export async function previewAutomation(input: unknown, conversationId: string) {
  const rule = automationRuleSchema.parse(input);
  await validateAutomationReferences(rule);
  const conversation = await prisma.conversation.findUnique({ where: { id: conversationId }, include: { contact: true, providerCredential: { select: { teamId: true } } } });
  if (!conversation) throw new AutomationPreviewError("השיחה אינה נגישה בעסק זה");
  const reasons: string[] = [];
  const now = new Date();
  let body: string | null = null;
  let provider = "לא נדרשת שליחה";
  const config = rule.actionConfig;
  if (rule.actionType === "ASSIGN_AGENT") {
    const agent = await prisma.user.findUniqueOrThrow({ where: { id: String(config.agentId) }, select: { role: true, teamId: true } });
    if (agent.role === "agent" && conversation.providerCredential?.teamId && agent.teamId !== conversation.providerCredential.teamId) reasons.push("הנציג אינו שייך לצוות של המספר");
  }
  if (rule.actionType === "SEND_TEMPLATE" || rule.actionType === "SEND_CANNED_REPLY") {
    const windowOpen = !!conversation.lastInboundAt && now.getTime() - conversation.lastInboundAt.getTime() < 86400000;
    let marketing = false;
    let templateBinding: { providerTemplateId: string | null; providerAccountId: string | null } | null = null;
    if (conversation.assignedAgentId) reasons.push("נציג מטפל בשיחה ולכן המענה האוטומטי נעצר");
    if (rule.actionType === "SEND_TEMPLATE") {
      const template = await prisma.template.findUniqueOrThrow({ where: { id: String(config.templateId) } });
      templateBinding = template;
      marketing = template.category === "MARKETING";
      const variables = personalizeVariables((config.variables ?? {}) as Record<string, string>, conversation.contact.fullName);
      if (Object.values(variables).some((value) => /\{[^{}]+\}/.test(value))) reasons.push("נותרו משתנים לא פתורים");
      body = renderTemplate(template.body, variables);
    } else {
      body = (await prisma.cannedReply.findUniqueOrThrow({ where: { id: String(config.cannedReplyId) } })).body;
      if (!windowOpen) reasons.push("חלון המענה הסתיים; נדרשת תבנית מאושרת");
    }
    const eligibility = eligibilityError(conversation.contact, marketing, windowOpen);
    if (eligibility) reasons.push(eligibility);
    if (marketing && conversation.contact.lastMarketingAt && now.getTime() - conversation.contact.lastMarketingAt.getTime() < MARKETING_INTERVAL_MS) reasons.push("נוצלה מגבלת התדירות השיווקית המקומית");
    try {
      const sender = await resolveSender(conversation.providerCredentialId);
      provider = sender?.provider === "meta_whatsapp_cloud_api" ? "Meta — לא בוצעה פנייה לספק" : "Mock — הדגמה";
      if ((!sender || sender.provider === "mock") && conversation.source === "WHATSAPP") reasons.push("חיבור WhatsApp נותק");
      if (sender?.provider === "meta_whatsapp_cloud_api" && templateBinding) {
        const account = (sender.config as { businessAccountId?: string }).businessAccountId;
        if (!templateBinding.providerTemplateId || !account || templateBinding.providerAccountId !== account) reasons.push("התבנית אינה משויכת לחשבון Meta של המספר");
      }
      if (sender?.provider === "meta_whatsapp_cloud_api" && rule.actionType === "SEND_CANNED_REPLY" && !await prisma.message.findFirst({ where: { conversationId, direction: "INBOUND", inboundKey: { not: null }, createdAt: { gt: new Date(now.getTime() - 86400000) } }, select: { id: true } })) reasons.push("אין הודעה נכנסת מאומתת בחלון המענה");
    } catch { reasons.push("המספר מנותק, חסום או אינו נגיש"); }
  }
  return { mode: "DRY_RUN" as const, allowedLocally: reasons.length === 0, reasons, actionType: rule.actionType, body, provider, checkedAt: now.toISOString(), delayMinutes: rule.trigger === "NO_REPLY_TIMEOUT" ? Number(rule.triggerConfig.minutes) : 0, notice: "בדיקה מקומית בלבד: הטריגר מדומה, לא נשמרו שינויים ולא נשלחו הודעות. הרשאות, תבנית וזכאות נבדקות שוב בביצוע; אישור הספק לא נבדק." };
}
