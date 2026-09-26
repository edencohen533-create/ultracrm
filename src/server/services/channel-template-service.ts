/**
 * SMS / email templates (no provider approval – APPROVED on save). Merge tags are validated,
 * SMS segment metrics computed, and email designs rendered to HTML + plain text on save.
 */
import { z } from "zod";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { ApiError } from "@/lib/response";
import type { SessionUser } from "@/lib/auth";
import { designText, emailDesignSchema, renderEmailHtml, renderEmailText } from "@/lib/email/blocks";
import { mergeTagsOf, validateMergeTags } from "@/lib/merge-tags";
import { smsMetrics, SMS_MAX_SEGMENTS } from "@/lib/sms";
import type { Prisma } from "@/generated/prisma/client";

export const channelTemplateSchema = z.discriminatedUnion("channel", [
  z.object({ channel: z.literal("sms"), id: z.string().optional(), name: z.string().trim().min(1).max(120), category: z.enum(["MARKETING", "UTILITY"]).default("MARKETING"), body: z.string().trim().min(1).max(1600) }),
  z.object({ channel: z.literal("email"), id: z.string().optional(), name: z.string().trim().min(1).max(120), category: z.enum(["MARKETING", "UTILITY"]).default("MARKETING"), subject: z.string().trim().min(1).max(200), preheader: z.string().trim().max(200).optional(), design: emailDesignSchema }),
]);
export type ChannelTemplateInput = z.infer<typeof channelTemplateSchema>;

export async function listChannelTemplates(channel?: "sms" | "email") {
  return prisma.template.findMany({ where: { channel: channel ?? { in: ["sms", "email"] }, internal: false }, orderBy: [{ channel: "asc" }, { name: "asc" }], select: { id: true, channel: true, name: true, category: true, status: true, body: true, subject: true, preheader: true, design: true, html: true, text: true, variables: true, updatedAt: true, _count: { select: { campaigns: true } } } });
}

export async function saveChannelTemplate(user: SessionUser, input: ChannelTemplateInput) {
  const problems: string[] = [];
  let data: Prisma.TemplateUncheckedCreateInput;
  if (input.channel === "sms") {
    problems.push(...validateMergeTags(input.body));
    const m = smsMetrics(input.body + "\nלהסרה השיבו הסר");
    if (m.segments > SMS_MAX_SEGMENTS) problems.push(`ההודעה ארוכה מדי: ${m.segments} מקטעים (מותר עד ${SMS_MAX_SEGMENTS})`);
    data = { businessId: user.businessId, channel: "sms", name: input.name, language: "he", category: input.category, body: input.body, variables: mergeTagsOf(input.body).map((t) => t.tag), status: "APPROVED" };
  } else {
    problems.push(...validateMergeTags(input.subject), ...validateMergeTags(designText(input.design)));
    const html = renderEmailHtml(input.design, { preheader: input.preheader });
    const text = renderEmailText(input.design);
    data = { businessId: user.businessId, channel: "email", name: input.name, language: "he", category: input.category, body: text, subject: input.subject, preheader: input.preheader ?? null, design: input.design as unknown as Prisma.InputJsonValue, html, text, variables: [...new Set([...mergeTagsOf(input.subject), ...mergeTagsOf(text)].map((t) => t.tag))], status: "APPROVED" };
  }
  if (problems.length) throw new ApiError(problems.join(" · "), 400, "template_invalid", { problems });
  const dupe = await prisma.template.findFirst({ where: { name: input.name, language: "he", ...(input.id ? { id: { not: input.id } } : {}) }, select: { id: true } });
  if (dupe) throw new ApiError("קיימת תבנית בשם זה", 409, "duplicate_name");
  let row;
  if (input.id) {
    const existing = await prisma.template.findFirst({ where: { id: input.id, channel: input.channel, internal: false } });
    if (!existing) throw new ApiError("התבנית לא נמצאה", 404, "not_found");
    const inUse = await prisma.campaign.count({ where: { templateId: existing.id, status: { in: ["SCHEDULED", "RUNNING", "PAUSED"] } } });
    if (inUse) throw new ApiError("התבנית בשימוש בקמפיין פעיל. שכפל אותה או המתן לסיום הקמפיין", 409, "template_in_use");
    const { businessId: _b, ...update } = data;
    row = await prisma.template.update({ where: { id: existing.id }, data: update });
  } else {
    row = await prisma.template.create({ data });
  }
  await audit(user.businessId, user.id, "template", row.id, input.id ? "template.updated" : "template.created", { channel: input.channel, name: input.name });
  return row;
}

export async function deleteChannelTemplate(user: SessionUser, id: string) {
  const t = await prisma.template.findFirst({ where: { id, channel: { in: ["sms", "email"] }, internal: false }, include: { _count: { select: { campaigns: true, sequenceSteps: true } } } });
  if (!t) throw new ApiError("התבנית לא נמצאה", 404, "not_found");
  if (t._count.campaigns || t._count.sequenceSteps) throw new ApiError("התבנית משויכת לקמפיינים או לרצפים ולא ניתן למחוק אותה", 409, "template_in_use");
  await prisma.template.delete({ where: { id: t.id } });
  await audit(user.businessId, user.id, "template", t.id, "template.deleted", { channel: t.channel, name: t.name });
}
