/**
 * Campaign builder ("יצירת קמפיין"): a CampaignDraft collects the wizard's steps and is turned into a real
 * Campaign (with a frozen audience) when it is built at the review step. Rebuilding replaces the previously built
 * DRAFT campaign. Email/SMS drafts own a hidden working Template row (internal=true) rendered from the draft.
 */
import { z } from "zod";
import { prisma } from "@/lib/db";
import { audit } from "@/lib/audit";
import { requireBusinessId } from "@/lib/tenant";
import { ApiError } from "@/lib/response";
import type { Prisma } from "@/generated/prisma/client";
import { designText, emailDesignSchema, renderEmailHtml, renderEmailText, defaultEmailDesign, type EmailDesign } from "@/lib/email/blocks";
import { mergeTagsOf, validateMergeTags } from "@/lib/merge-tags";
import { smsMetrics, SMS_MAX_SEGMENTS } from "@/lib/sms";
import { CampaignError, createCampaign, deleteDraftCampaign, sendCampaignTest } from "./campaign-service";
import { sendChannelTest } from "./channel-send-service";

export type DraftChannel = "whatsapp" | "sms" | "email";
export const DRAFT_STEPS: Record<DraftChannel, string[]> = { email: ["info", "audience", "template", "content", "review"], whatsapp: ["info", "audience", "template", "content", "review"], sms: ["info", "audience", "content", "review"] };

/** Everything the wizard may store. Partial on purpose: each step validates its own fields at build time. */
export const draftDataSchema = z.object({
  subject: z.string().max(200).optional(),
  preheader: z.string().max(200).optional(),
  senderCredentialId: z.string().nullable().optional(),
  senderId: z.string().max(40).nullable().optional(),
  replyTo: z.string().max(200).nullable().optional(),
  listIds: z.array(z.string().min(1)).max(20).optional(),
  excludedListIds: z.array(z.string().min(1)).max(20).optional(),
  templateId: z.string().nullable().optional(),
  /** email: which gallery item the design came from (template id | "starter:<key>" | "blank") */
  designSource: z.string().max(80).nullable().optional(),
  design: z.unknown().optional(),
  body: z.string().max(1600).optional(),
  variables: z.record(z.string(), z.string().max(1024)).optional(),
  mediaUrl: z.string().max(2000).nullable().optional(),
  buttonParams: z.record(z.string(), z.string().max(500)).nullable().optional(),
  category: z.enum(["MARKETING", "UTILITY"]).optional(),
  scheduledAt: z.string().nullable().optional(),
  testTo: z.string().max(200).optional(),
}).passthrough();
export type DraftData = z.infer<typeof draftDataSchema>;

export const draftPatchSchema = z.object({ name: z.string().trim().min(1).max(120).optional(), step: z.string().max(20).optional(), data: draftDataSchema.optional() });

function view(d: { id: string; channel: string; name: string; step: string; data: unknown; templateId: string | null; campaignId: string | null; createdAt: Date; updatedAt: Date; campaign?: { status: string; scheduledAt: Date | null } | null }) {
  return { id: d.id, channel: d.channel as DraftChannel, name: d.name, step: d.step, data: (d.data ?? {}) as DraftData, templateId: d.templateId, campaignId: d.campaignId, campaignStatus: d.campaign?.status ?? null, createdAt: d.createdAt, updatedAt: d.updatedAt, steps: DRAFT_STEPS[d.channel as DraftChannel] };
}

export async function listDrafts(channel?: DraftChannel) {
  const rows = await prisma.campaignDraft.findMany({ where: { ...(channel ? { channel } : {}), campaignId: null }, orderBy: { updatedAt: "desc" }, take: 100, include: { campaign: { select: { status: true, scheduledAt: true } } } });
  return rows.map(view);
}

export async function getDraft(id: string) {
  const d = await prisma.campaignDraft.findUnique({ where: { id }, include: { campaign: { select: { status: true, scheduledAt: true } } } });
  if (!d) throw new CampaignError("הטיוטה לא נמצאה");
  return view(d);
}

export async function createDraft(channel: DraftChannel, actorUserId: string, name?: string) {
  const data: DraftData = channel === "email" ? { design: defaultEmailDesign(), designSource: "blank", category: "MARKETING" } : { category: "MARKETING" };
  const d = await prisma.campaignDraft.create({ data: { businessId: requireBusinessId(), channel, name: name?.trim() || "קמפיין ללא שם", data: data as Prisma.InputJsonValue, createdById: actorUserId } });
  await audit(d.businessId, actorUserId, "campaign", d.id, "campaign.draft_created", { channel });
  return getDraft(d.id);
}

/** Open a legacy DRAFT campaign (created before the wizard) in the builder. */
export async function draftFromCampaign(campaignId: string, actorUserId: string) {
  const existing = await prisma.campaignDraft.findFirst({ where: { campaignId }, orderBy: { updatedAt: "desc" } });
  if (existing) return getDraft(existing.id);
  const c = await prisma.campaign.findUnique({ where: { id: campaignId }, include: { template: true } });
  if (!c) throw new CampaignError("הקמפיין לא נמצא");
  if (c.status !== "DRAFT") throw new CampaignError("ניתן לערוך רק טיוטה");
  const listIds = (Array.isArray(c.listIds) && (c.listIds as string[]).length ? c.listIds : [c.listId]) as string[];
  const data: DraftData = {
    listIds, excludedListIds: (c.excludedListIds as string[]) ?? [], senderCredentialId: c.providerCredentialId, senderId: c.senderId, variables: (c.variables as Record<string, string>) ?? {},
    mediaUrl: c.mediaUrl, buttonParams: (c.buttonParams as Record<string, string> | null) ?? null, category: c.template.category === "UTILITY" ? "UTILITY" : "MARKETING", scheduledAt: c.scheduledAt?.toISOString() ?? null,
    ...(c.channel === "whatsapp" ? { templateId: c.templateId } : c.channel === "sms" ? { body: c.template.body, templateId: c.templateId } : { subject: c.template.subject ?? "", preheader: c.template.preheader ?? "", design: c.template.design ?? defaultEmailDesign(), designSource: c.templateId, templateId: c.templateId }),
  };
  const d = await prisma.campaignDraft.create({ data: { businessId: requireBusinessId(), channel: c.channel, name: c.name, step: "review", data: data as Prisma.InputJsonValue, campaignId: c.id, templateId: c.template.internal ? c.templateId : null, createdById: actorUserId } });
  return getDraft(d.id);
}

export async function updateDraft(id: string, patch: z.infer<typeof draftPatchSchema>) {
  const d = await prisma.campaignDraft.findUnique({ where: { id }, select: { data: true, channel: true } });
  if (!d) throw new CampaignError("הטיוטה לא נמצאה");
  if (patch.step && !DRAFT_STEPS[d.channel as DraftChannel].includes(patch.step)) throw new CampaignError("שלב לא תקין");
  const data = { ...(d.data as Record<string, unknown>), ...(patch.data ?? {}) };
  await prisma.campaignDraft.update({ where: { id }, data: { ...(patch.name ? { name: patch.name } : {}), ...(patch.step ? { step: patch.step } : {}), data: data as Prisma.InputJsonValue } });
  return getDraft(id);
}

export async function deleteDraft(id: string, actorUserId: string) {
  const d = await prisma.campaignDraft.findUnique({ where: { id }, include: { campaign: { select: { status: true } } } });
  if (!d) throw new CampaignError("הטיוטה לא נמצאה");
  await prisma.$transaction(async (tx) => {
    if (d.campaignId && d.campaign?.status === "DRAFT") { await tx.campaignDraft.update({ where: { id }, data: { campaignId: null } }); await tx.campaign.delete({ where: { id: d.campaignId } }); }
    if (d.templateId) await tx.template.deleteMany({ where: { id: d.templateId, internal: true, campaigns: { none: {} } } });
    await tx.campaignDraft.delete({ where: { id } });
  });
  await audit(requireBusinessId(), actorUserId, "campaign", id, "campaign.draft_deleted", { name: d.name });
}

/** Per-step validation used by the review screen (each row can send the user back to its step). */
export function draftChecks(d: ReturnType<typeof view>) {
  const data = d.data; const problems: Array<{ step: string; message: string }> = [];
  if (!d.name.trim() || d.name === "קמפיין ללא שם") problems.push({ step: "info", message: "יש לתת שם לקמפיין" });
  if (d.channel === "email" && !data.subject?.trim()) problems.push({ step: "info", message: "חסרה שורת נושא" });
  if (d.channel !== "whatsapp" && !data.senderCredentialId) problems.push({ step: "info", message: "יש לבחור שולח (חיבור פעיל)" });
  if (d.channel === "sms" && !data.senderId) problems.push({ step: "info", message: "יש לבחור מספר/שם שולח מאושר" });
  if (!data.listIds?.length) problems.push({ step: "audience", message: "יש לבחור לפחות קהל אחד" });
  if (d.channel === "whatsapp" && !data.templateId) problems.push({ step: "template", message: "יש לבחור תבנית מאושרת" });
  if (d.channel === "email") {
    const parsed = emailDesignSchema.safeParse(data.design);
    if (!parsed.success) problems.push({ step: "content", message: "תוכן המייל אינו תקין: " + parsed.error.issues[0]?.message });
    else { const p = [...validateMergeTags(data.subject ?? ""), ...validateMergeTags(designText(parsed.data))]; if (p.length) problems.push({ step: "content", message: p.join(" · ") }); }
  }
  if (d.channel === "sms") {
    if (!data.body?.trim()) problems.push({ step: "content", message: "יש לכתוב את תוכן ההודעה" });
    else { const p = validateMergeTags(data.body); if (p.length) problems.push({ step: "content", message: p.join(" · ") }); const m = smsMetrics(data.body + "\nלהסרה השיבו הסר"); if (m.segments > SMS_MAX_SEGMENTS) problems.push({ step: "content", message: `ההודעה ארוכה מדי (${m.segments} מקטעים)` }); }
  }
  return problems;
}

/** Create/refresh the hidden working template for email/SMS drafts. */
async function syncWorkingTemplate(d: ReturnType<typeof view>) {
  const data = d.data; const businessId = requireBusinessId();
  const name = `[קמפיין] ${d.name.slice(0, 70)} · ${d.id.slice(-6)}-${Date.now().toString(36)}`;
  let payload: Prisma.TemplateUncheckedCreateInput;
  if (d.channel === "email") {
    const design = emailDesignSchema.parse(data.design) as EmailDesign;
    const html = renderEmailHtml(design, { preheader: data.preheader || null });
    payload = { businessId, channel: "email", name, language: "he", category: data.category ?? "MARKETING", body: renderEmailText(design), subject: data.subject ?? "", preheader: data.preheader || null, design: design as unknown as Prisma.InputJsonValue, html, text: renderEmailText(design), variables: mergeTagsOf(`${data.subject ?? ""}\n${designText(design)}`).map((t) => t.tag), status: "APPROVED", internal: true };
  } else if (d.channel === "sms") {
    payload = { businessId, channel: "sms", name, language: "he", category: data.category ?? "MARKETING", body: data.body ?? "", variables: mergeTagsOf(data.body ?? "").map((t) => t.tag), status: "APPROVED", internal: true };
  } else return data.templateId!;
  const { businessId: _b, name: _n, ...update } = payload;
  if (d.templateId) {
    const inUse = await prisma.campaign.count({ where: { templateId: d.templateId, status: { in: ["SCHEDULED", "RUNNING", "PAUSED", "COMPLETED"] } } });
    if (!inUse) { await prisma.template.update({ where: { id: d.templateId }, data: update }); return d.templateId; }
  }
  const t = await prisma.template.create({ data: payload });
  await prisma.campaignDraft.update({ where: { id: d.id }, data: { templateId: t.id } });
  return t.id;
}

/** Turn the draft into a DRAFT campaign with a frozen audience (replacing a previously built one). */
export async function buildDraft(id: string, actorUserId: string) {
  const d = await getDraft(id);
  const problems = draftChecks(d);
  if (problems.length) throw new ApiError(problems.map((p) => p.message).join(" · "), 400, "draft_invalid", { problems });
  const data = d.data;
  const prev = d.campaignId ? await prisma.campaign.findUnique({ where: { id: d.campaignId }, select: { status: true } }) : null;
  if (prev && prev.status !== "DRAFT") throw new CampaignError("הקמפיין כבר נשלח או תוזמן – לא ניתן לבנות אותו מחדש");
  if (prev && d.campaignId) await deleteDraftCampaign(d.campaignId, actorUserId);
  const templateId = await syncWorkingTemplate(d);
  const listIds = data.listIds!;
  const campaign = await createCampaign({
    channel: d.channel, name: d.name, listId: listIds[0], listIds, excludedListIds: data.excludedListIds ?? [], templateId,
    providerCredentialId: data.senderCredentialId ?? null, senderId: d.channel === "sms" ? data.senderId ?? null : null,
    variables: data.variables ?? {}, mediaUrl: d.channel === "whatsapp" ? data.mediaUrl ?? null : null, buttonParams: d.channel === "whatsapp" ? data.buttonParams ?? null : null,
  }, actorUserId);
  await prisma.campaignDraft.update({ where: { id }, data: { campaignId: campaign.id, templateId, step: "review" } });
  return { campaignId: campaign.id };
}

/** Test send from inside the builder (email/SMS render the draft; WhatsApp needs the built campaign). */
export async function testDraft(id: string, user: { id: string; businessId: string; fullName: string }, to: string) {
  const d = await getDraft(id);
  const problems = draftChecks(d).filter((p) => p.step !== "audience");
  if (problems.length) throw new ApiError(problems.map((p) => p.message).join(" · "), 400, "draft_invalid", { problems });
  if (d.channel === "whatsapp") {
    if (!d.campaignId) throw new CampaignError("לשליחת בדיקה ב-WhatsApp יש לבנות את הקמפיין קודם (שלב הבקרה)");
    return sendCampaignTest(user, d.campaignId, to);
  }
  const templateId = await syncWorkingTemplate(d);
  await prisma.campaignDraft.update({ where: { id }, data: { data: { ...(d.data as Record<string, unknown>), testTo: to } as Prisma.InputJsonValue } });
  return sendChannelTest(user, { channel: d.channel, credentialId: d.data.senderCredentialId ?? null, templateId, variables: d.data.variables ?? {}, to, senderId: d.data.senderId ?? null });
}
