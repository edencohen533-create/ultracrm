import { z } from "zod";
import { AutomationActionType, AutomationTrigger, ConversationStatus } from "@/generated/prisma/enums";

const requiredText = z.string().trim().min(1).max(200);
export const automationRuleSchema = z.object({
  name: requiredText,
  trigger: z.enum(AutomationTrigger),
  triggerConfig: z.record(z.string(), z.unknown()),
  actionType: z.enum(AutomationActionType),
  actionConfig: z.record(z.string(), z.unknown()),
  isActive: z.boolean(),
}).superRefine((rule, ctx) => {
  const actions = {
    ASSIGN_AGENT: z.object({ agentId: requiredText }),
    ADD_TAG: z.object({ tagName: requiredText }),
    CHANGE_STATUS: z.object({ status: z.enum(ConversationStatus) }),
    ADD_INTERNAL_NOTE: z.object({ body: z.string().trim().min(1).max(4096) }),
    SEND_CANNED_REPLY: z.object({ cannedReplyId: requiredText }),
    SEND_TEMPLATE: z.object({ templateId: requiredText, variables: z.record(z.string().regex(/^\d+$/), z.string().trim().min(1).max(1024)).optional() }),
  };
  if (!actions[rule.actionType].safeParse(rule.actionConfig).success) {
    ctx.addIssue({ code: "custom", path: ["actionConfig"], message: "יש להשלים את פרטי הפעולה" });
  }
  if (rule.trigger === AutomationTrigger.NO_REPLY_TIMEOUT && !z.number().int().min(1).max(43200).safeParse(rule.triggerConfig.minutes).success) {
    ctx.addIssue({ code: "custom", path: ["triggerConfig"], message: "הזמן חייב להיות בין דקה ל־30 ימים" });
  }
  if (rule.trigger === AutomationTrigger.TAG_ADDED && !requiredText.optional().safeParse(rule.triggerConfig.tagName).success) {
    ctx.addIssue({ code: "custom", path: ["triggerConfig"], message: "שם תגית לא תקין" });
  }
});

export type AutomationRuleInput = z.infer<typeof automationRuleSchema>;
