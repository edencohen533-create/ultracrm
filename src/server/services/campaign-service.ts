import { MAX_AUDIENCE_SIZE } from "@/lib/audiences";
import { resolveAudience, AudienceError } from "./audience-service";
import { resolveSender, ProviderUnavailableError } from "@/server/providers/provider-registry";
import { activeSenderSnapshot, templateFingerprint } from "./campaign-snapshot";
import { prisma } from "@/lib/db";
import { requireBusinessId } from "@/lib/tenant";
import { consumeQuota } from "@/lib/modules";
import { ApiError } from "@/lib/response";
import { audit } from "@/lib/audit";
import { campaignSchema, validateTemplateVariables, personalizeVariablesForContact, renderTemplate } from "@/lib/campaigns";
import { smsMetrics } from "@/lib/sms";
import { activeChannelCredential, ChannelUnavailableError } from "@/server/channels/registry";
import { deliverableEmail, renderChannelContent, sendChannelTest } from "./channel-send-service";
import { createHash } from "node:crypto";
import type { z } from "zod";
import type { CampaignStatus, Prisma, ProviderCredential, Template } from "@/generated/prisma/client";
import type { SmsSender } from "@/server/channels/types";

export class CampaignError extends Error {}

const SAMPLE_URL = "https://…/u/…";

/** Cost estimate for a draft. `known=false` when no unit price is configured – the UI must say so. */
export function estimateCampaignCost(channel: string, credential: Pick<ProviderCredential, "unitPrice" | "unitPriceCurrency"> | null, template: Pick<Template, "body" | "channel">, recipients: number, marketing = true) {
  const unit = credential?.unitPrice ? Number(credential.unitPrice) : null;
  let perRecipient = 1;
  let segments: number | null = null;
  if (channel === "sms") {
    const m = smsMetrics(template.body.replace(/\{\{[^}]*\}\}/g, "ישראל ישראלי") + (marketing ? "\nלהסרה השיבו הסר" : ""));
    segments = m.segments; perRecipient = m.segments;
  }
  // WhatsApp: Meta bills per conversation category (marketing/utility/authentication) by country – no verified
  // rate card is available here, so only a manually configured unit price yields an estimate.
  return { channel, recipients, segments, perRecipient, unitPrice: unit, currency: credential?.unitPriceCurrency ?? null, units: perRecipient * recipients, total: unit !== null ? Number((unit * perRecipient * recipients).toFixed(4)) : null, known: unit !== null, basis: channel === "whatsapp" ? "מחיר ידני לשיחה שיווקית (Meta מחייבת לפי קטגוריית שיחה ומדינה)" : channel === "sms" ? "מחיר ידני למקטע" : "מחיר ידני לאימייל" };
}

export async function createCampaign(input: z.infer<typeof campaignSchema>, actorUserId: string) {
  const channel = input.channel ?? "whatsapp";
  let providerCredentialId: string | null = null;
  let senderSnapshot: string;
  let channelCredential: ProviderCredential | null = null;
  let sender: SmsSender | null = null;
  if (channel === "whatsapp") {
    let wa;
    try { wa = await resolveSender(input.providerCredentialId); }
    catch (error) { if (error instanceof ProviderUnavailableError) throw new CampaignError(error.message); throw error; }
    providerCredentialId = wa?.id ?? null;
    senderSnapshot = await activeSenderSnapshot(providerCredentialId);
  } else {
    try { channelCredential = await activeChannelCredential(channel, input.providerCredentialId); }
    catch (error) { if (error instanceof ChannelUnavailableError) throw new CampaignError(error.message); throw error; }
    providerCredentialId = channelCredential.id;
    senderSnapshot = await activeSenderSnapshot(providerCredentialId);
    if (channel === "sms") {
      const senders = ((channelCredential.senders as SmsSender[] | null) ?? []);
      sender = (input.senderId ? senders.find((s) => s.value === input.senderId || s.id === input.senderId) : senders[0]) ?? null;
      if (!sender) throw new CampaignError("יש לבחור שולח מאושר מתוך החיבור (מספר או שולח אלפאנומרי)");
    }
    if (channel === "email" && !channelCredential.provider.startsWith("mock") && channelCredential.domainStatus !== "verified") throw new CampaignError("הדומיין השולח טרם אומת אצל הספק. השלם את רשומות ה-DNS ואמת אותו לפני יצירת קמפיין");
  }
  return prisma.$transaction(async (tx) => {
    const template = await tx.template.findUnique({ where: { id: input.templateId } });
    if (!template || template.status !== "APPROVED") throw new CampaignError("יש לבחור תבנית מאושרת");
    if (template.channel !== channel) throw new CampaignError("התבנית אינה שייכת לערוץ שנבחר");
    if (channel === "whatsapp") {
      const wa = providerCredentialId ? await tx.providerCredential.findUnique({ where: { id: providerCredentialId } }) : null;
      if (wa?.provider === "meta_whatsapp_cloud_api" && template.providerAccountId !== (wa.config as Record<string, unknown>).businessAccountId) throw new CampaignError("התבנית אינה שייכת לחשבון WhatsApp של המספר השולח. יש לסנכרן תבניות");
      try { validateTemplateVariables(template.body, input.variables); }
      catch (error) { throw new CampaignError((error as Error).message); }
      const headerFormat = (template.headerFormat ?? "").toUpperCase();
      if (["IMAGE", "VIDEO", "DOCUMENT"].includes(headerFormat) && !input.mediaUrl) throw new CampaignError(`התבנית כוללת כותרת ${headerFormat === "IMAGE" ? "תמונה" : headerFormat === "VIDEO" ? "וידאו" : "מסמך"} – יש לצרף קישור https ציבורי לקובץ`);
      if (!["IMAGE", "VIDEO", "DOCUMENT"].includes(headerFormat) && input.mediaUrl) throw new CampaignError("התבנית אינה כוללת כותרת מדיה – הסר את קישור המדיה");
      const buttons = (template.buttons as Array<{ type: string; dynamic?: boolean }> | null) ?? [];
      buttons.forEach((b, i) => { if (b.type === "URL" && b.dynamic && !input.buttonParams?.[String(i)]) throw new CampaignError(`לכפתור הקישור מס' ${i + 1} בתבנית נדרש ערך`); });
    }
    const excludedListIds = input.excludedListIds ?? [];
    const audience = await resolveAudience(tx, input.listId, excludedListIds, new Date());
    const contacts = await tx.contact.findMany({ where: audience.base, select: { id: true }, orderBy: { id: "asc" }, take: MAX_AUDIENCE_SIZE + 1 });
    if (!contacts.length) throw new CampaignError("הקהל ריק כעת. יש לבדוק את תנאי הקהל");
    if (contacts.length > MAX_AUDIENCE_SIZE) throw new CampaignError("הקהל גדול מ־10,000 אנשי קשר. יש לצמצם את התנאים לפני יצירת קמפיין");
    const excluded = audience.exclusion ? await tx.contact.findMany({ where: { AND: [audience.base, audience.exclusion] }, select: { id: true } }) : [];
    const excludedIds = new Set(excluded.map((contact) => contact.id));
    const waCredential = channel === "whatsapp" && providerCredentialId ? await tx.providerCredential.findUnique({ where: { id: providerCredentialId } }) : null;
    const estimate = estimateCampaignCost(channel, channelCredential ?? waCredential, template, contacts.length - excludedIds.size, template.category === "MARKETING");
    const { channel: _c, senderId: _s, buttonParams, mediaUrl, ...rest } = input;
    const campaign = await tx.campaign.create({ data: {
      businessId: requireBusinessId(), ...rest, channel, senderId: sender?.value ?? null, mediaUrl: mediaUrl ?? null, buttonParams: (buttonParams ?? undefined) as Prisma.InputJsonValue | undefined, excludedListIds, providerCredentialId, createdById: actorUserId, senderSnapshot, templateSnapshot: templateFingerprint(template),
      estimate: estimate as unknown as Prisma.InputJsonValue, audienceExcludedCount: excludedIds.size,
      audienceSnapshot: { frozenAt: new Date().toISOString(), lists: audience.lists.map((list) => ({ id: list.id, name: list.name, segment: list.segment })) },
      recipients: { createMany: { data: contacts.map(({ id: contactId }) => ({ contactId, ...(excludedIds.has(contactId) ? { status: "SKIPPED" as const, error: "הוחרג מהקהל ביצירת הטיוטה", completedAt: new Date() } : {}) })) } },
    } });
    await tx.auditLog.create({ data: { businessId: requireBusinessId(), actorId: actorUserId, action: "campaign.created", entityType: "Campaign", entityId: campaign.id, payload: { channel, recipients: contacts.length, templateId: template.id } } });
    return campaign;
  }, { isolationLevel: "RepeatableRead", timeout: 30000 }).catch((error) => { if (error instanceof AudienceError) throw new CampaignError(error.message); throw error; });
}

export async function changeCampaignStatus(id: string, action: "start" | "pause" | "resume" | "cancel", scheduledAt?: string, actorUserId?: string, scheduledTimezone?: string) {
  let snapshot: Record<string, unknown> | null = null;
  if (action === "start" || action === "resume") {
    // A template paused/changed at Meta after the draft was saved must be known before dispatch.
    const c = await prisma.campaign.findUnique({ where: { id }, select: { channel: true, providerCredential: { select: { provider: true } } } });
    if (c?.channel === "whatsapp" && c.providerCredential?.provider === "meta_whatsapp_cloud_api") {
      try { const { syncMetaTemplates } = await import("./template-sync-service"); await syncMetaTemplates(); } catch { /* preflight below reports a changed/unavailable template */ }
    }
    const review = await campaignPreflight(id);
    if (review.blockers.length) throw new CampaignError(review.blockers.join("; "));
    if (!review.eligible) throw new CampaignError("אין נמענים זכאים לשליחה כעת");
    snapshot = { at: new Date().toISOString(), action, eligible: review.eligible, totalQueued: review.totalQueued, exclusions: review.exclusions, sender: review.sender, cost: review.cost, simulated: review.simulated };
  }
  const from: Record<typeof action, CampaignStatus[]> = {
    start: ["DRAFT"], pause: ["SCHEDULED", "RUNNING"], resume: ["PAUSED"], cancel: ["DRAFT", "SCHEDULED", "RUNNING", "PAUSED"],
  };
  const date = scheduledAt ? new Date(scheduledAt) : new Date();
  if (scheduledAt && (action !== "start" || date.getTime() < Date.now())) {
    throw new CampaignError("מועד התזמון חייב להיות עתידי ולהיקבע בתחילת הקמפיין");
  }
  const status: CampaignStatus = action === "cancel" ? "CANCELLED" : action === "pause" ? "PAUSED" : "SCHEDULED";
  await prisma.$transaction(async (tx) => {
    const result = await tx.campaign.updateMany({
      where: { id, status: { in: from[action] } },
      data: { status, statusReason: null, ...((action === "start" || action === "resume") ? { scheduledAt: date, ...(scheduledTimezone ? { scheduledTimezone } : {}), preflightSnapshot: snapshot as Prisma.InputJsonValue } : {}) },
    });
    if (!result.count) throw new CampaignError("לא ניתן לבצע פעולה זו במצב הנוכחי של הקמפיין");
    if (action === "start") {
      try { await consumeQuota(requireBusinessId(), "campaigns_started", 1, tx); }
      catch (error) { if (error instanceof ApiError) throw new CampaignError(error.message); throw error; }
    }
    if (action === "cancel") {
      await tx.campaignRecipient.updateMany({ where: { campaignId: id, status: "QUEUED" }, data: { status: "SKIPPED", error: "הקמפיין בוטל", completedAt: new Date() } });
      // Messages persisted but not yet handed to the provider are cancelled; accepted ones are never re-labelled.
      await tx.message.updateMany({ where: { status: "QUEUED", campaignRecipient: { campaignId: id } }, data: { status: "CANCELLED", errorReason: "הקמפיין בוטל", failedAt: new Date() } });
    }
    await tx.auditLog.create({ data: { businessId: requireBusinessId(), actorId: actorUserId ?? null, action: `campaign.${action}`, entityType: "Campaign", entityId: id, payload: { scheduledAt: scheduledAt ?? null, scheduledTimezone: scheduledTimezone ?? null } } });
  });
}

export async function listCampaigns(channel?: "whatsapp" | "sms" | "email", q?: string) {
  const search = q?.trim();
  const campaigns = await prisma.campaign.findMany({
    where: { ...(channel ? { channel } : {}), ...(search ? { OR: [{ name: { contains: search, mode: "insensitive" } }, { list: { name: { contains: search, mode: "insensitive" } } }, { template: { name: { contains: search, mode: "insensitive" } } }] } : {}) },
    orderBy: { createdAt: "desc" }, take: 100,
    include: { list: { select: { name: true } }, template: { select: { name: true } }, _count: { select: { recipients: true } } },
  });
  const counts = await prisma.campaignRecipient.groupBy({
    by: ["campaignId", "status"], where: { campaignId: { in: campaigns.map((c) => c.id) } }, _count: true,
  });
  return campaigns.map((campaign) => ({ ...campaign,
    counts: Object.fromEntries(counts.filter((c) => c.campaignId === campaign.id).map((c) => [c.status, c._count])),
  }));
}

/** A snapshot for review, never a promise of eligibility at dispatch time. */
export async function campaignPreflight(id: string) {
  const campaign = await prisma.campaign.findUnique({ where: { id }, include: { template: true, recipients: { where: { status: "QUEUED" }, include: { contact: true } } } });
  if (!campaign) throw new CampaignError("הקמפיין לא נמצא");
  const sender = await activeSenderSnapshot(campaign.providerCredentialId);
  const blockers: string[] = [];
  if (!campaign.senderSnapshot || sender !== campaign.senderSnapshot || sender.startsWith("blocked:")) blockers.push("החיבור השתנה או חסום. צור טיוטה חדשה לאחר אימות החיבור");
  if (campaign.template.status !== "APPROVED" || templateFingerprint(campaign.template) !== campaign.templateSnapshot) blockers.push("התבנית השתנתה או אינה מאושרת. צור טיוטה חדשה");
  const active = campaign.providerCredentialId ? await prisma.providerCredential.findUnique({ where: { id: campaign.providerCredentialId } }) : null;
  if (campaign.channel === "email" && active && !active.provider.startsWith("mock") && active.domainStatus !== "verified") blockers.push("הדומיין השולח אינו מאומת אצל הספק");
  if (campaign.channel === "whatsapp") {
    if (["PAUSED", "DISABLED"].includes(campaign.template.status)) blockers.push(campaign.template.status === "PAUSED" ? "התבנית הושהתה על ידי Meta (איכות) – לא ניתן לשלוח עד שתופעל מחדש" : "התבנית הושבתה על ידי Meta");
    const hf = (campaign.template.headerFormat ?? "").toUpperCase();
    if (["IMAGE", "VIDEO", "DOCUMENT"].includes(hf) && !campaign.mediaUrl) blockers.push("לתבנית נדרש קובץ מדיה לכותרת");
    const btns = (campaign.template.buttons as Array<{ type: string; dynamic?: boolean }> | null) ?? [];
    if (btns.some((b, i) => b.type === "URL" && b.dynamic && !(campaign.buttonParams as Record<string, string> | null)?.[String(i)])) blockers.push("לכפתור קישור דינמי בתבנית חסר ערך");
  }
  const { getBusinessSettings } = await import("@/lib/settings");
  const settings = await getBusinessSettings(requireBusinessId());
  const capMs = settings.marketing.minHoursBetweenMarketing * 3600_000;
  const marketing = campaign.template.category === "MARKETING";
  const exclusions: Record<string, number> = {};
  const samples: { name: string; phone: string; body: string; subject?: string }[] = [];
  let eligible = 0;
  const senders = ((active?.senders as SmsSender[] | null) ?? []);
  const smsSender = campaign.channel === "sms" ? senders.find((s) => s.value === campaign.senderId) ?? senders[0] ?? null : null;
  if (campaign.channel === "sms" && !smsSender) blockers.push("השולח שנבחר אינו זמין יותר בחיבור");
  for (const { contact } of campaign.recipients) {
    let reason = contact.isBlocked ? "חסימה מלאה" : marketing && contact.consentStatus !== "OPTED_IN" ? "אין הסכמה פעילה" : marketing && contact.lastMarketingAt && Date.now() - contact.lastMarketingAt.getTime() < capMs ? `מגבלת תדירות משותפת (${settings.marketing.minHoursBetweenMarketing} שעות)` : null;
    if (!reason && campaign.channel === "email" && !(await deliverableEmail(contact))) reason = contact.emailStatus === "hard_bounce" ? "כתובת אימייל נפסלה (hard bounce)" : "אין כתובת אימייל";
    if (reason) { exclusions[reason] = (exclusions[reason] ?? 0) + 1; continue; }
    try {
      if (campaign.channel === "whatsapp") {
        const variables = personalizeVariablesForContact(campaign.variables as Record<string, string>, contact);
        validateTemplateVariables(campaign.template.body, variables);
        eligible++;
        if (samples.length < 3) samples.push({ name: contact.fullName, phone: contact.phoneE164, body: renderTemplate(campaign.template.body, variables) });
      } else {
        const r = renderChannelContent(campaign.template, { fullName: contact.fullName, email: contact.email, phoneE164: contact.phoneE164, company: contact.company, city: contact.city, customFields: contact.customFields as Record<string, unknown> | null }, { ...(campaign.variables as Record<string, string>), unsubscribe_url: SAMPLE_URL }, { marketing, sender: smsSender, url: SAMPLE_URL });
        if (r.missing.length) throw new Error(`missing ${r.missing.join(",")}`);
        eligible++;
        if (samples.length < 3) samples.push({ name: contact.fullName, phone: campaign.channel === "email" ? (await deliverableEmail(contact)) ?? "" : contact.phoneE164, body: campaign.channel === "sms" ? r.body! : r.text!, subject: r.subject });
      }
    } catch { exclusions["משתנים חסרים"] = (exclusions["משתנים חסרים"] ?? 0) + 1; }
  }
  const phoneNumberId = (active?.config as Record<string, unknown> | undefined)?.phoneNumberId;
  const senderLabel = campaign.channel === "whatsapp"
    ? (active ? `${active.label || active.provider} · ${active.displayPhoneNumber || String(phoneNumberId ?? "")}` : "הדגמה בלבד")
    : campaign.channel === "sms" ? `${active?.label || active?.provider || ""} · ${smsSender?.value ?? "—"}${active?.provider.startsWith("mock") ? " (הדמיה)" : ""}`
    : `${active?.senderName ?? ""} <${active?.senderEmail ?? ""}>${active?.provider.startsWith("mock") ? " (הדמיה)" : ""}`;
  const estimate = estimateCampaignCost(campaign.channel, active, campaign.template, eligible, marketing);
  const window = settings.marketing.window;
  return { channel: campaign.channel, eligible, audienceExcluded: campaign.audienceExcludedCount, totalQueued: campaign.recipients.length, exclusions, blockers, samples, sender: senderLabel, audiencePolicy: "קהל מוקפא ביצירת הטיוטה; זכאות, הסכמה והסרות נבדקות מחדש בכל שליחה", cost: estimate, sendWindow: campaign.channel === "whatsapp" && campaign.template.category !== "MARKETING" ? null : { ...window, timezone: window.timezone ?? settings.timezone, maxPerMinute: settings.marketing.maxPerMinute }, timezone: settings.timezone, simulated: Boolean(active?.provider.startsWith("mock")) || (campaign.channel === "whatsapp" && !active), lastTestAt: campaign.lastTestAt };
}

/** Delivery / engagement / cost report. Every figure is labelled real, estimated or unavailable. */
export async function campaignReport(id: string) {
  const campaign = await prisma.campaign.findUnique({ where: { id }, include: { template: { select: { name: true, category: true } }, providerCredential: { select: { provider: true, capabilities: true, label: true } } } });
  if (!campaign) throw new CampaignError("הקמפיין לא נמצא");
  const recipientCounts = Object.fromEntries((await prisma.campaignRecipient.groupBy({ by: ["status"], where: { campaignId: id }, _count: true })).map((r) => [r.status, r._count]));
  const messages = await prisma.message.findMany({ where: { campaignRecipient: { campaignId: id } }, select: { id: true, status: true, openedAt: true, clickedAt: true, bouncedAt: true, bounceType: true, complainedAt: true, costAmount: true, costCurrency: true, conversationId: true, acceptedAt: true } });
  const delivery: Record<string, number> = {};
  let opened = 0, clicked = 0, complained = 0, hardBounce = 0, softBounce = 0, costSum = 0, costCount = 0;
  let costCurrency: string | null = null;
  for (const m of messages) {
    delivery[m.status] = (delivery[m.status] ?? 0) + 1;
    if (m.openedAt) opened++; if (m.clickedAt) clicked++; if (m.complainedAt) complained++;
    if (m.bounceType === "hard") hardBounce++; else if (m.bounceType === "soft") softBounce++;
    if (m.costAmount !== null) { costSum += Number(m.costAmount); costCount++; costCurrency = m.costCurrency ?? costCurrency; }
  }
  const startedAt = campaign.scheduledAt ?? campaign.createdAt;
  const replies = campaign.channel === "email" ? null : await prisma.message.count({ where: { direction: "INBOUND", createdAt: { gte: startedAt }, conversationId: { in: messages.map((m) => m.conversationId) } } });
  const unsubscribes = await prisma.suppression.count({ where: { OR: [{ messageId: { in: messages.map((m) => m.id) } }, { evidence: { in: messages.map((m) => `message:${m.id}`) } }] } });
  const caps = (campaign.providerCredential?.capabilities ?? {}) as Partial<Record<string, boolean>>;
  const simulated = Boolean(campaign.providerCredential?.provider.startsWith("mock"));
  const availability = {
    delivery: simulated ? "simulated" : caps.deliveryReports === false ? "unavailable" : "real",
    opens: campaign.channel === "email" && caps.opens ? "signal" : "unavailable",
    clicks: campaign.channel === "email" && caps.clicks ? "signal" : "unavailable",
    replies: campaign.channel === "email" ? "unavailable" : caps.inbound === false ? "unavailable" : "real",
    cost: costCount ? (costCount === messages.length ? "real" : "partial") : (campaign.estimate as { known?: boolean } | null)?.known ? "estimated" : "unavailable",
  } as const;
  return {
    id: campaign.id, name: campaign.name, channel: campaign.channel, status: campaign.status, statusReason: campaign.statusReason, template: campaign.template, simulated,
    recipients: recipientCounts, delivery, engagement: { opened, clicked, complained, hardBounce, softBounce, replies, unsubscribes },
    cost: { actual: costCount ? { amount: Number(costSum.toFixed(4)), currency: costCurrency, messages: costCount } : null, estimate: campaign.estimate },
    availability,
    notes: [
      "\"הועבר לספק\" אינו הוכחה למסירה; \"נמסר\" מדווח על ידי הספק בלבד.",
      ...(campaign.channel === "email" ? ["פתיחות והקלקות הן אותות מהספק שעשויים להיות מושפעים ממנגנוני פרטיות וסריקות אוטומטיות; פתיחה אינה הוכחה לקריאה."] : []),
      ...(availability.cost === "estimated" ? ["העלות היא אומדן לפי מחיר יחידה שהוגדר ידנית, לא נתון מהספק."] : availability.cost === "unavailable" ? ["אין נתוני עלות – הספק לא דיווח ולא הוגדר מחיר יחידה."] : []),
    ],
  };
}

/** Test send of the campaign content to an explicitly configured test recipient. */
export async function sendCampaignTest(user: { id: string; businessId: string; fullName: string }, id: string, to: string) {
  const campaign = await prisma.campaign.findUnique({ where: { id }, include: { template: true } });
  if (!campaign) throw new CampaignError("הקמפיין לא נמצא");
  if (campaign.channel === "whatsapp") {
    // Test sends go ONLY to numbers explicitly allow-listed on the WhatsApp connection – never to customers.
    const { normalizePhone } = await import("@/lib/phone");
    const e164 = normalizePhone(to);
    if (!e164) throw new CampaignError("מספר בדיקה לא תקין");
    const credential = campaign.providerCredentialId ? await prisma.providerCredential.findUnique({ where: { id: campaign.providerCredentialId } }) : null;
    const allowed = ((credential?.testRecipients as string[] | null) ?? []);
    if (!allowed.includes(e164)) throw new ApiError("שליחת בדיקה מותרת רק למספרי בדיקה שהוגדרו במפורש בחיבור WhatsApp", 403, "test_recipient_not_allowed", { allowed });
    const { getActiveProvider } = await import("@/server/providers/provider-registry");
    const provider = await getActiveProvider(campaign.providerCredentialId);
    let variables: Record<string, string>;
    try { variables = personalizeVariablesForContact(campaign.variables as Record<string, string>, { fullName: user.fullName, phoneE164: e164, customFields: {} }); }
    catch (error) { throw new CampaignError((error as Error).message); }
    const result = await provider.sendTemplate({ conversationId: "", to: e164, type: "TEMPLATE", templateId: campaign.templateId, templateVariables: variables, templateMedia: campaign.mediaUrl ? { link: campaign.mediaUrl } : undefined, templateButtonParams: (campaign.buttonParams as Record<string, string> | null) ?? undefined });
    await audit(user.businessId, user.id, "campaign", id, "campaign.test_sent", { channel: "whatsapp", to: e164, providerMessageId: result.providerMessageId || null, status: result.status, error: result.error ?? null, simulated: !credential || credential.provider === "mock" });
    if (result.status === "FAILED") throw new ApiError(result.error ?? "הספק דחה את הודעת הבדיקה", 502, "test_send_failed");
    await prisma.campaign.update({ where: { id }, data: { lastTestAt: new Date() } });
    return { providerMessageId: result.providerMessageId, status: result.status, segments: null, simulated: !credential || credential.provider === "mock" };
  }
  const r = await sendChannelTest(user, { channel: campaign.channel, credentialId: campaign.providerCredentialId, templateId: campaign.templateId, variables: campaign.variables as Record<string, string>, to, senderId: campaign.senderId });
  await prisma.campaign.update({ where: { id }, data: { lastTestAt: new Date() } });
  await audit(user.businessId, user.id, "campaign", id, "campaign.test_sent", { to, providerMessageId: r.providerMessageId, simulated: r.simulated });
  return r;
}

export function campaignHash(c: { id: string; status: string }) { return createHash("sha1").update(`${c.id}:${c.status}`).digest("hex").slice(0, 8); }

/**
 * Controlled retry of one recipient (7.11). FAILED outcomes may be retried; an UNKNOWN outcome only after
 * a manager attests that the provider did NOT deliver it (`confirmNotSent`). Never blind: each attempt
 * gets its own requestKey and the worker re-runs every eligibility check.
 */
export async function retryRecipient(campaignId: string, recipientId: string, confirmNotSent: boolean, actorUserId: string | null) {
  if (!await prisma.campaign.findUnique({ where: { id: campaignId }, select: { id: true } })) throw new CampaignError("הקמפיין לא נמצא"); // tenant-scoped lookup first
  const recipient = await prisma.campaignRecipient.findFirst({ where: { id: recipientId, campaignId }, include: { campaign: { select: { status: true } }, message: { select: { status: true, errorReason: true } } } });
  if (!recipient) throw new CampaignError("הנמען לא נמצא");
  if (recipient.status === "UNKNOWN" && !confirmNotSent) throw new CampaignError("תוצאה לא ודאית: יש לוודא אצל הספק שההודעה לא נמסרה ולאשר זאת במפורש לפני ניסיון חוזר");
  if (!["FAILED", "UNKNOWN"].includes(recipient.status)) throw new CampaignError("ניתן לנסות שוב רק נמען שנכשל או שתוצאתו לא ודאית");
  if (recipient.attempts >= 10) throw new CampaignError("הגעת למספר הניסיונות המרבי לנמען זה");
  if (!["RUNNING", "PAUSED", "COMPLETED", "SCHEDULED"].includes(recipient.campaign.status)) throw new CampaignError("לא ניתן לנסות שוב בקמפיין שבוטל");
  await prisma.$transaction(async (tx) => {
    await tx.campaignRecipient.update({ where: { id: recipient.id }, data: { status: "QUEUED", claimedAt: null, completedAt: null, nextAttemptAt: null, attempts: recipient.attempts + 1, error: `ניסיון חוזר ידני (${recipient.status})` } });
    if (recipient.campaign.status === "COMPLETED") await tx.campaign.update({ where: { id: campaignId }, data: { status: "RUNNING", statusReason: null } });
    await tx.auditLog.create({ data: { businessId: requireBusinessId(), actorId: actorUserId, action: "campaign.recipient_retry", entityType: "Campaign", entityId: campaignId, payload: { recipientId, previousStatus: recipient.status, confirmNotSent, previousError: recipient.message?.errorReason ?? recipient.error ?? null } } });
  });
  return { ok: true, requeued: true };
}
