/** Opt-in, clock-time SLA for an actual first dial. Status edits never count as a dial. */
import {slaDeadline} from "./sla-time";
import crypto from "node:crypto";
import { Prisma } from "@/generated/prisma/client";
import { prisma, dbSchema } from "@/lib/db";
import { firstDialForLead } from "@/lib/crm/lead-ops";
import { audit } from "@/lib/audit";
import { getBusinessSettings } from "@/lib/settings";
import { ruleFor } from "./rules";
import { send, notifyManagers } from "./engine";
const KIND = "lead_response_sla";
const T = (name: string) => Prisma.raw(`"${dbSchema()}"."${name}"`);
const OPEN = ["new", "contacted", "qualified", "follow_up"] as const;
type Proposal = { leadId: string; startedAt: string; ruleVersion: string; minutes: number };
const json = (v: unknown) => v as Prisma.InputJsonValue;
export async function runLeadResponseSla(businessId: string, now = new Date()) {
  const settings = await getBusinessSettings(businessId);
  if (!settings.aiOps.enabled) return 0;
  const rule = await ruleFor(businessId, KIND);
  let processed = 0;
  // Capture new leads in bounded pages, with a unique record per rule and lead occurrence.
  if (rule) {
    let cursor: string | undefined;
    while (true) {
      const pending = await prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT l.id FROM ${T("leads")} l
        WHERE l.business_id = ${businessId} AND l.created_at >= ${rule.updatedAt} AND l.created_at <= ${now}
          AND l.status::text = ANY(${[...OPEN]}) AND l.id > ${cursor ?? ""}
          AND NOT EXISTS (SELECT 1 FROM ${T("ops_recommendations")} r
            WHERE r.business_id = ${businessId} AND r.dedupe_key = ${"sla:" + rule.id + ":"} || l.id)
        ORDER BY l.id LIMIT 100`);
      const rows = await prisma.lead.findMany({ where: { businessId, id: { in: pending.map(p => p.id) }, contact: { isBlocked: false, consentStatus: { not: "OPTED_OUT" } } }, include: { contact: true } });
      for (const lead of rows) {
        const startedAt = lead.createdAt;
        const deadline = slaDeadline(startedAt,rule.config.minutes,rule.config.businessHoursOnly?settings.dialWindow:undefined);
        const dedupeKey = `sla:${rule.id}:${lead.id}`;
        if (await prisma.opsRecommendation.findUnique({ where: { businessId_dedupeKey: { businessId, dedupeKey } } })) continue;
        if (await prisma.dncEntry.findFirst({ where: { businessId, phoneE164: lead.contact.phoneE164 } })) continue;
        try {
          await prisma.opsRecommendation.create({ data: { businessId, ruleId: rule.id, kind: KIND, agentId: lead.ownerUserId, status: deadline ? "monitoring" : "needs_adjustment", result: deadline ? undefined : {reason:"חלון העבודה אינו מאפשר לחשב יעד בטווח שנה; יש לעדכן את שעות הפעילות או הכלל."}, code: String(crypto.randomInt(1000, 10000)), title: `יעד חיוג ראשון: ${lead.contact.fullName}`, explanation: `יעד: ניסיון חיוג ראשון בתוך ${rule.config.minutes} דקות מקבלת הליד.`, evidence: {}, proposal: json({ leadId: lead.id, startedAt: startedAt.toISOString(), ruleVersion: rule.updatedAt.toISOString(), minutes: rule.config.minutes, businessHoursOnly: rule.config.businessHoursOnly }), dedupeKey, expiresAt: deadline ?? startedAt } });
        } catch (e) { if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002")) throw e; }
      }
      if (pending.length < 100) break;
      cursor = pending[pending.length - 1].id;
    }
  }
  const records = await prisma.opsRecommendation.findMany({ where: { businessId, kind: KIND, status: { in: ["monitoring", "needs_attention"] } } });
  for (const rec of records) {
    const p = rec.proposal as unknown as Proposal;
    const lead = await prisma.lead.findFirst({ where: { id: p.leadId, businessId }, include: { contact: true } });
    const active = rule && rule.id === rec.ruleId && rule.updatedAt.toISOString() === p.ruleVersion;
    const eligible = lead && !lead.contact.isBlocked && lead.contact.consentStatus !== "OPTED_OUT" && !(await prisma.dncEntry.findFirst({ where: { businessId, phoneE164: lead.contact.phoneE164 } }));
    const sameOccurrence = lead && (lead.reopenedAt ?? lead.createdAt).toISOString() === p.startedAt;
    // Calls reference dial-list entries, not CRM leads; match the contact since this CRM occurrence.
    // A completed dial remains factual even when the lead was subsequently closed.
    const first = eligible && sameOccurrence ? await firstDialForLead(businessId, p.leadId, lead.contactId, new Date(p.startedAt), now) : null;
    let status: string | null = null, result: Record<string, unknown> | null = null;
    if (!active || !eligible || !sameOccurrence) { status = "cancelled"; result = { reason: "הכלל או הליד השתנו; המדידה הופסקה." }; }
    else if (first) { status = "completed"; result = { firstDialAt: first.toISOString(), responseSeconds: Math.max(0, Math.round((first.getTime() - new Date(p.startedAt).getTime()) / 1000)), met: first <= rec.expiresAt, reason: first <= rec.expiresAt ? "בוצע ניסיון חיוג ראשון במסגרת היעד." : "בוצע ניסיון חיוג ראשון לאחר חריגה מהיעד." }; }
    else if (!OPEN.includes(lead!.status as typeof OPEN[number])) { status = "cancelled"; result = { reason: "הליד נסגר ללא ניסיון חיוג שנמדד; לא נרשמה עמידה ביעד." }; }
    else if (rec.expiresAt <= now && rec.status === "monitoring") { status = "needs_attention"; result = { breachedAt: now.toISOString(), reason: "עבר יעד הזמן ללא ניסיון חיוג ראשון. נדרש טיפול בליד." }; }
    if (!status) {
      if (lead && lead.ownerUserId !== rec.agentId) await prisma.opsRecommendation.updateMany({ where: { id: rec.id, status: rec.status }, data: { agentId: lead.ownerUserId } });
      continue;
    }
    const changed = await prisma.opsRecommendation.updateMany({ where: { id: rec.id, status: rec.status }, data: { status, agentId: lead?.ownerUserId ?? null, result: json(result) } });
    if (!changed.count) continue;
    processed++;
    await audit(businessId, null, "ai_ops", rec.id, "ai_ops.sla_" + status, result ?? {});
    if (status === "needs_attention") {
      const moved=rule?.autonomy==="auto"&&rule.config.onBreach==="transfer_to_available"?await escalateSla({...rec,status:"needs_attention",agentId:lead?.ownerUserId??null}):false;
      const text = `${rec.title}\n${result!.reason} יעד: ${p.minutes} דקות.\n${moved?"הליד הועבר לנציג זמין לפי הכלל המאושר.":"הליד נשאר בתור הקיים שלך; לא בוצעה העברה."}`;
      const sentToday = lead?.ownerUserId ? await prisma.auditLog.count({ where: { businessId, action: "ai_ops.sla_delivery", createdAt: { gte: new Date(now.getTime() - 86400000) }, payload: { path: ["agentId"], equals: lead.ownerUserId } } }) : 0;
      const delivery = sentToday >= settings.aiOps.maxAlertsPerDay ? { status: "skipped", detail: "מכסת התראות יומית" } : lead?.ownerUserId ? await send(businessId, lead.ownerUserId, text, "ליד ממתין לחיוג ראשון") : { status: "skipped", detail: "ליד ללא שיוך" };
      // Preserve a concurrent completion result while recording delivery separately in audit.
      await audit(businessId, null, "ai_ops", rec.id, "ai_ops.sla_delivery", { agentId: lead?.ownerUserId ?? null, status: delivery.status, detail: delivery.detail ?? null });
      await notifyManagers({ ...rec, agentId: lead?.ownerUserId ?? null }, text);
    }
  }
  return processed;
}

async function escalateSla(rec:import("@/generated/prisma/client").OpsRecommendation){
 const {requiresManager}=await import("./rules");if(await requiresManager(rec.businessId,"ownership"))return false;
 const owner=await prisma.user.findFirst({where:{businessId:rec.businessId,role:"owner",isActive:true}});if(!owner)return false;
 const {agents}=await (await import("./metrics")).agentSnapshots(rec.businessId);
 const candidates=agents.filter(a=>a.id!==rec.agentId&&a.online&&!a.inCall&&a.inPool&&a.capOk).sort((a,b)=>a.openLeads-b.openLeads);
 const {effectiveAccess,can}=await import("@/lib/access/engine");
 for(const target of candidates){const access=await effectiveAccess(rec.businessId,target.id);if(!can(access,"telephony.use")||!can(access,"crm.view"))continue;
  if(await (await import("@/lib/crm/lead-ops")).transferSlaFromRule(owner,target.id,rec)){await audit(rec.businessId,owner.id,"ai_ops",rec.id,"ai_ops.sla_transferred",{toAgentId:target.id});return true;}
 }
 return false;
}
