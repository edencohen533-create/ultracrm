/**
 * The one server-side answer to "may this user dial this person now?" – for manual and automatic dialing alike.
 * Called when a call starts (startCall) and again right before the customer's phone rings (dialLeadLeg); the queue's
 * SQL filter applies the same rules so the queue never hands out what this would refuse. Hiding a button is never the
 * check. Every refusal carries a Hebrew reason the agent can act on.
 *
 * Checks, in order: ownership (open lead owner / handling agent / pending transfer), existing customer vs. the
 * campaign's purpose, someone else already dialing or talking to the person, follow-up time, and the business's
 * cool-down after another agent's contact. Do-not-contact is checked by callBlockReason next to this (same moments).
 */
import { prisma } from "@/lib/db";
import { ApiError } from "@/lib/response";
import { visibleUserIds, type SessionUser } from "@/lib/auth";
import { getBusinessSettings } from "@/lib/settings";
import { customerFactsOne, customerLine, type CustomerFacts } from "@/lib/crm/customer-identity";

export interface DialActor { id: string; businessId: string; role: SessionUser["role"]; teamId: string | null }

export async function dialEligibility(actor: DialActor | SessionUser, opts: { contactId: string; auto: boolean; listId?: string | null; exceptCallId?: string | null }): Promise<CustomerFacts> {
  const { businessId } = actor;
  const facts = await customerFactsOne(businessId, opts.contactId);
  if (!facts) throw new ApiError("איש קשר לא נמצא", 404, "not_found");
  // A transfer requested during THIS call waits for it (applied when it is documented) – it only stops new calls.
  const pending = opts.exceptCallId ? null : await prisma.lead.findFirst({ where: { businessId, contactId: opts.contactId, pendingTransferToUserId: { not: null } }, select: { id: true } });
  if (pending) throw new ApiError("הליד בהעברה לנציג אחר – אי אפשר לחייג אליו עד שההעברה תושלם", 409, "transfer_pending");

  // 1. Ownership. Automatic dialing: only my own people. Manual: mine, or (manager) of an agent I manage.
  const visible = opts.auto ? [actor.id] : await visibleUserIds(actor as SessionUser);
  const mayWork = (ownerId: string) => ownerId === actor.id || !visible || visible.includes(ownerId);
  if (facts.openLeads.length) {
    // An unassigned lead: manual only – and one waiting for a manager's decision (review) only by a manager.
    const allowed = facts.openLeads.some((l) => (l.ownerUserId ? mayWork(l.ownerUserId) : !opts.auto && !(l.reviewReason && actor.role === "agent")));
    if (!allowed && facts.openLeads.some((l) => !l.ownerUserId && l.reviewReason)) throw new ApiError(`${customerLine(facts)} – ממתין לשיוך על ידי מנהל`, 409, "customer_needs_review");
    if (!allowed) {
      const who = facts.openLeads.find((l) => l.ownerName)?.ownerName;
      throw new ApiError(facts.openLeads.every((l) => !l.ownerUserId) ? "ליד ללא שיוך לא נכנס לחיוג אוטומטי – יש לשייך אותו לנציג" : `הליד משויך לנציג אחר${who ? ` (${who})` : ""}`, 409, "lead_not_assigned_to_you");
    }
  } else if (facts.handler && facts.handler.id !== actor.id && !(opts.auto ? false : mayWork(facts.handler.id))) {
    throw new ApiError(`${facts.isCustomer ? customerLine(facts) : "איש הקשר משויך לנציג אחר"} – ${facts.handler.fullName} הוא הנציג המטפל`, 409, "handled_by_other", { handlerId: facts.handler.id });
  } else if (!facts.handler && facts.isCustomer && (opts.auto || actor.role === "agent")) {
    throw new ApiError(`${customerLine(facts)} – אין נציג מטפל פעיל. הלקוח ממתין לשיוך על ידי מנהל`, 409, "customer_needs_review");
  }

  // 2. Existing customer vs. the campaign's purpose (personal queues are "all" – ownership above decides there).
  if (opts.listId) {
    const list = await prisma.dialList.findFirst({ where: { id: opts.listId, businessId }, select: { audience: true } });
    if (list?.audience === "new_prospects" && facts.isCustomer) throw new ApiError(`${customerLine(facts)} – לא מחייגים ללקוח קיים מקמפיין גיוס. אפשר מקמפיין חידושים / מכירה נוספת או ידנית על ידי הנציג המטפל`, 409, "existing_customer_in_acquisition");
    if (list?.audience === "existing_customers" && !facts.isCustomer) throw new ApiError("הקמפיין מיועד ללקוחות קיימים בלבד, ואיש קשר זה עוד לא רכש", 409, "not_a_customer");
  }

  // 3. Someone else is already dialing / talking to this person (any of their numbers) or holds them in a queue.
  const liveOther = await prisma.call.findFirst({ where: { businessId, contactId: opts.contactId, endedAt: null, userId: { not: actor.id }, ...(opts.exceptCallId ? { id: { not: opts.exceptCallId } } : {}) }, select: { user: { select: { fullName: true } } } });
  if (liveOther) throw new ApiError(`${liveOther.user?.fullName ?? "נציג אחר"} כבר בשיחה או בחיוג לאיש קשר זה`, 409, "contact_in_call");
  const held = await prisma.listLead.findFirst({ where: { businessId, contactId: opts.contactId, lockedByUserId: { not: actor.id }, OR: [{ status: "in_call" }, { status: "locked", lockExpiresAt: { gt: new Date() } }] }, select: { lockedBy: { select: { fullName: true } } } });
  if (held) throw new ApiError(`${held.lockedBy?.fullName ?? "נציג אחר"} עובד כרגע על איש קשר זה בחייגן`, 409, "contact_claimed");

  if (opts.auto) {
    // 4. Follow-ups are never dialed automatically before their time (or without one).
    const open = await prisma.task.findMany({ where: { businessId, contactId: opts.contactId, status: "open", type: "callback" }, select: { dueAt: true } });
    if (open.some((t) => t.dueAt.getTime() > Date.now())) throw new ApiError("מועד הפולואפ עוד לא הגיע", 409, "follow_up_not_due");
    if (!open.length && facts.openLeads.some((l) => l.status === "follow_up")) throw new ApiError("לפולואפ אין מועד – נדרש תזמון לפני חיוג", 409, "follow_up_unscheduled");
    // 5. Business policy: wait after another agent's recent contact (answered call / live WhatsApp conversation).
    const { contactCooldownMinutes } = await getBusinessSettings(businessId);
    if (contactCooldownMinutes > 0) {
      const since = new Date(Date.now() - contactCooldownMinutes * 60_000);
      const recent = await prisma.call.findFirst({ where: { businessId, contactId: opts.contactId, userId: { not: actor.id }, answeredAt: { gte: since } }, select: { user: { select: { fullName: true } } } });
      if (recent) throw new ApiError(`${recent.user?.fullName ?? "נציג אחר"} דיבר עם איש הקשר ב-${contactCooldownMinutes} הדקות האחרונות – לפי מדיניות העסק ממתינים`, 409, "recent_contact_other_agent");
      const chat = await prisma.conversation.findFirst({ where: { businessId, contactId: opts.contactId, assignedAgentId: { not: actor.id }, NOT: { assignedAgentId: null }, lastInboundAt: { gte: since }, status: { in: ["OPEN", "PENDING"] } }, select: { assignedAgent: { select: { fullName: true } } } });
      if (chat) throw new ApiError(`שיחת WhatsApp פעילה עם ${chat.assignedAgent?.fullName ?? "נציג אחר"} – לפי מדיניות העסק ממתינים`, 409, "active_conversation_other_agent");
    }
  }
  return facts;
}
