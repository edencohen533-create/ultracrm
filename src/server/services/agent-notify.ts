/**
 * WhatsApp to the agent's personal phone when a lead is assigned to them (new lead, automatic distribution,
 * manager transfer). Sent from the business's existing WhatsApp connection with an APPROVED template – the agent
 * rarely has an open 24h window with the business number. Deduped per lead + agent (AssistantDelivery key).
 * Template variables: {{1}} lead name, {{2}} phone, {{3}} source (as many as the template defines).
 */
import { prisma } from "@/lib/db";
import { Prisma } from "@/generated/prisma/client";
import { getBusinessSettings } from "@/lib/settings";
import { getActiveProvider } from "@/server/providers/provider-registry";

export async function notifyAgentNewLead(businessId: string, leadId: string, userId: string) {
  const { leadAssignment } = await getBusinessSettings(businessId);
  const cfg = leadAssignment.notifyWhatsApp;
  if (!cfg?.enabled) return { status: "disabled" as const };
  const { businessCanUse } = await import("@/lib/access/engine");
  if (!(await businessCanUse(businessId, "whatsapp"))) return { status: "disabled" as const };
  const [user, lead] = await Promise.all([
    prisma.user.findFirst({ where: { id: userId, businessId, isActive: true }, select: { personalPhone: true } }),
    prisma.lead.findFirst({ where: { id: leadId, businessId }, select: { source: true, contact: { select: { fullName: true, phoneE164: true } } } }),
  ]);
  if (!lead) return { status: "skipped" as const, detail: "lead missing" };
  const key = `agent-lead:${leadId}:${userId}`;
  let deliveryId: string;
  try { deliveryId = (await prisma.assistantDelivery.create({ data: { businessId, key, kind: "agent_new_lead", status: "pending" } })).id; }
  catch (e) { if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") return { status: "duplicate" as const }; throw e; }
  const finish = async (status: string, detail?: string) => { await prisma.assistantDelivery.update({ where: { id: deliveryId }, data: { status, detail: detail ?? null } }); return { status, detail }; };
  if (!user?.personalPhone) return finish("skipped", "לנציג לא הוגדר טלפון אישי");
  const tpl = cfg.templateId ? await prisma.template.findFirst({ where: { id: cfg.templateId, businessId, channel: "whatsapp" }, select: { id: true, status: true, variables: true, body: true } }) : null;
  if (!tpl || tpl.status !== "APPROVED") return finish("skipped", tpl ? `התבנית אינה מאושרת (${tpl.status})` : "לא נבחרה תבנית");
  const values = [lead.contact.fullName, lead.contact.phoneE164, lead.source ?? "—"];
  const count = Math.max(tpl.variables.length, (tpl.body.match(/\{\{\d+\}\}/g) ?? []).length);
  const templateVariables = Object.fromEntries(values.slice(0, Math.max(1, count)).map((v, i) => [String(i + 1), v]));
  try {
    const provider = await getActiveProvider();
    const r = await provider.sendTemplate({ conversationId: "", to: user.personalPhone, type: "TEMPLATE", templateId: tpl.id, templateVariables });
    return finish(r.status === "FAILED" ? "failed" : "sent", r.status === "FAILED" ? r.error ?? "הספק דחה את ההודעה" : undefined);
  } catch (e) { return finish("failed", (e as Error).message.slice(0, 200)); }
}
