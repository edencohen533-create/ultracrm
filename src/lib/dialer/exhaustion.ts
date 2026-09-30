/**
 * Dial-attempt exhaustion + "no leads available" for an agent in a campaign (dial list).
 *
 *  • Quota ("ניסיונות ללא מענה לפני לא רלוונטי"): effective setting = the agent's personal dialer setting →
 *    the campaign → the business (0 = off). Attempts are the CRM attempts of the lead (`attemptStats`): one Call row
 *    with `lead_dialed_at` per real dial – a technical failure / cancelled dial / duplicate provider event never
 *    counts. Checked when an unanswered outcome is saved, inside the same transaction and under the per-lead lock.
 *    Never overrides a lead that was answered, has a future (or explicitly set) follow-up, or is qualified / closed.
 *  • Availability: counted with the SAME filter as the claim (`queueFilter`) → available / waiting (next time) /
 *    exhausted / blocked (paused, permission, window closed with nothing to wait for…).
 *  • Alert: one OPEN DialerQueueAlert per agent+list is the dedupe state; a new alert only after work came back
 *    (a successful claim closes the open row). Delivery runs from the events worker (dialer.queue_empty).
 */
import { Prisma } from "@/generated/prisma/client";
import { prisma, dbSchema } from "@/lib/db";
import { ApiError } from "@/lib/response";
import { audit } from "@/lib/audit";
import { emitEvent } from "@/lib/events";
import { visibleUserIds, type SessionUser } from "@/lib/auth";
import { getBusinessSettings, isWithinDialWindow, nextDialWindowOpening } from "@/lib/settings";
import { getAgentSettings } from "@/lib/agent-settings";
import { attemptStats } from "@/lib/crm/lead-ops";
import { assertListAccess, listDialWindow, queueFilter, queueParams } from "./queue";

type Db = Prisma.TransactionClient;
const T = (t: string) => Prisma.raw(`"${dbSchema()}"."${t}"`);
export const EXHAUSTED_REASON = "מוצו ניסיונות חיוג";

// ─── quota ────────────────────────────────────────────────────────────────────────────────────────────────────────
export async function effectiveUnansweredLimit(businessId: string, userId: string | null, listId: string | null, db: Db = prisma) {
  const personal = userId ? await getAgentSettings(businessId, userId, db) : null;
  if (personal?.unansweredToIrrelevant !== null && personal?.unansweredToIrrelevant !== undefined) return { limit: personal.unansweredToIrrelevant, source: "agent" as const };
  if (listId) {
    const list = await db.dialList.findFirst({ where: { id: listId, businessId }, select: { unansweredLimit: true } });
    if (list?.unansweredLimit !== null && list?.unansweredLimit !== undefined) return { limit: list.unansweredLimit, source: "campaign" as const };
  }
  return { limit: (await getBusinessSettings(businessId, db)).unansweredToIrrelevant ?? 0, source: "business" as const };
}

/** Quota per lead owner (agent → business; a lead may sit in several campaigns, whose own override applies while dialing). */
export async function limitsForOwners(businessId: string, ownerIds: Array<string | null>) {
  const out = new Map<string, number>();
  for (const id of new Set(ownerIds.map((x) => x ?? ""))) out.set(id, (await effectiveUnansweredLimit(businessId, id || null, null)).limit);
  return out;
}

/**
 * After an unanswered outcome: move the contact's current lead to "unqualified" when it reached the quota.
 * Runs inside the outcome transaction; the per-lead advisory lock is the same one transfers / follow-ups use.
 */
export async function exhaustLeadIfNeeded(tx: Db, input: { businessId: string; userId: string; listId: string | null; contactId: string }) {
  const { limit } = await effectiveUnansweredLimit(input.businessId, input.userId, input.listId, tx);
  if (!limit) return null;
  const current = await tx.lead.findFirst({ where: { businessId: input.businessId, contactId: input.contactId, status: { in: ["new", "contacted", "follow_up", "qualified"] } }, orderBy: { createdAt: "desc" }, select: { id: true } });
  if (!current) return null;
  await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${"lead-followup:" + current.id}, 0))`);
  return closeIfExhausted(tx, input.businessId, current.id, limit, input.userId, "outcome");
}

/** Shared by the outcome path and the manager's approved bulk apply. Returns null when the lead must be kept. */
async function closeIfExhausted(tx: Db, businessId: string, leadId: string, limit: number, actorId: string | null, via: "outcome" | "bulk") {
  const lead = await tx.lead.findFirst({ where: { id: leadId, businessId }, select: { id: true, status: true, contactId: true } });
  // Only leads nobody has talked to yet: follow-up (explicit), qualified and closed statuses are never overridden.
  if (!lead || !["new", "contacted"].includes(lead.status)) return null;
  const stats = (await attemptStats(businessId, [lead.contactId], tx)).get(lead.id);
  const attempts = stats?.count ?? 0;
  if (attempts < limit || (stats?.answered ?? 0) > 0) return null;
  const future = await tx.task.findFirst({ where: { businessId, contactId: lead.contactId, status: "open", type: "callback", dueAt: { gt: new Date() } }, select: { id: true } });
  if (future) return null;
  if (await tx.deal.findFirst({ where: { businessId, contactId: lead.contactId, status: "won" }, select: { id: true } })) return null;
  const moved = await tx.lead.updateMany({ where: { id: lead.id, status: lead.status }, data: { status: "unqualified", closeReason: EXHAUSTED_REASON, closedAt: new Date() } });
  if (!moved.count) return null;
  // Out of every dial queue (a row in a live call is left to its call – it is finished by the outcome itself).
  await tx.listLead.updateMany({ where: { businessId, contactId: lead.contactId, status: { in: ["pending", "callback", "locked"] } }, data: { status: "exhausted", nextAttemptAt: null, lockedByUserId: null, lockToken: null, lockExpiresAt: null, preferredUserId: null } });
  await emitEvent(tx, { businessId, type: "lead.status_changed", contactId: lead.contactId, actorUserId: actorId, source: "system", dedupeKey: `lead.status_changed:${lead.id}:unqualified:exhausted`, payload: { leadId: lead.id, from: lead.status, to: "unqualified", reason: EXHAUSTED_REASON } });
  await audit(businessId, actorId, "lead", lead.id, "lead.attempts_exhausted", { attempts, limit, from: lead.status, via }, tx);
  return { leadId: lead.id, attempts, limit };
}

/** Existing leads that the (new) quota would close – shown to a manager before anything changes. */
export async function exhaustionPreview(user: SessionUser, listId: string | null) {
  if (user.role === "agent") throw new ApiError("רק מנהל יכול להחיל את המכסה על לידים קיימים", 403, "forbidden");
  const ids = await visibleUserIds(user);
  const leads = await prisma.lead.findMany({
    where: { businessId: user.businessId, status: { in: ["new", "contacted"] }, ...(ids ? { ownerUserId: { in: ids } } : {}), ...(listId ? { contact: { queueLeads: { some: { listId } } } } : {}) },
    select: { id: true, contactId: true, ownerUserId: true, contact: { select: { fullName: true } } }, take: 5000,
  });
  const stats = await attemptStats(user.businessId, leads.map((l) => l.contactId));
  const limits = new Map<string, number>();
  const futures = new Set((await prisma.task.findMany({ where: { businessId: user.businessId, status: "open", type: "callback", dueAt: { gt: new Date() }, contactId: { in: leads.map((l) => l.contactId) } }, select: { contactId: true } })).map((t) => t.contactId));
  const out: Array<{ leadId: string; name: string; attempts: number; limit: number }> = [];
  for (const l of leads) {
    const key = l.ownerUserId ?? "";
    if (!limits.has(key)) limits.set(key, (await effectiveUnansweredLimit(user.businessId, l.ownerUserId, listId)).limit);
    const limit = limits.get(key)!; const s = stats.get(l.id);
    if (limit && s && s.count >= limit && !s.answered && !futures.has(l.contactId)) out.push({ leadId: l.id, name: l.contact.fullName, attempts: s.count, limit });
  }
  return { count: out.length, sample: out.slice(0, 20), leadIds: out.map((x) => x.leadId) };
}

/** Manager-approved bulk apply of the preview (re-checked lead by lead; never more than what was previewed). */
export async function applyExhaustion(user: SessionUser, listId: string | null, leadIds: string[]) {
  const preview = await exhaustionPreview(user, listId);
  const allowed = new Set(preview.leadIds);
  let moved = 0;
  for (const id of leadIds.filter((x) => allowed.has(x))) {
    const r = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${"lead-followup:" + id}, 0))`);
      const lead = await tx.lead.findFirst({ where: { id, businessId: user.businessId }, select: { ownerUserId: true } });
      const { limit } = await effectiveUnansweredLimit(user.businessId, lead?.ownerUserId ?? null, listId, tx);
      return limit ? closeIfExhausted(tx, user.businessId, id, limit, user.id, "bulk") : null;
    });
    if (r) moved++;
  }
  await audit(user.businessId, user.id, "business", user.businessId, "dialer.exhaustion_applied", { listId, requested: leadIds.length, moved });
  return { moved };
}

// ─── availability ─────────────────────────────────────────────────────────────────────────────────────────────────
export type AvailabilityState = "available" | "waiting" | "exhausted" | "blocked";
export interface Availability { state: AvailabilityState; availableNow: number; waiting: number; nextAt: string | null; reason: string | null; exhaustedCount: number; listId: string; listName: string }

export async function queueAvailability(user: Pick<SessionUser, "businessId" | "id" | "role">, listId: string): Promise<Availability> {
  const list = await prisma.dialList.findFirst({ where: { id: listId, businessId: user.businessId }, select: { id: true, name: true } });
  if (!list) throw new ApiError("רשימה לא נמצאה", 404, "not_found");
  const base = { listId, listName: list.name, availableNow: 0, waiting: 0, nextAt: null as string | null, exhaustedCount: 0 };
  const settings = await getBusinessSettings(user.businessId);
  if (settings.dialingPaused) return { ...base, state: "blocked", reason: "החיוג מושהה ברמת העסק על ידי המנהל" };
  try { await assertListAccess(user.businessId, user.id, user.role, listId); }
  catch (e) { return { ...base, state: "blocked", reason: e instanceof ApiError ? e.message : "אין גישה לקמפיין" }; }
  const q = await queueParams(user.businessId, user.id, listId);
  const count = async (timeAware: boolean) => (await prisma.$queryRaw<Array<{ n: number }>>(Prisma.sql`
    SELECT count(*)::int AS n FROM ${T("list_leads")} l JOIN ${T("contacts")} c ON c.id = l.contact_id WHERE ${queueFilter(q, { timeAware })}`))[0].n;
  const [now, later] = await Promise.all([count(true), count(false)]);
  const exhaustedCount = (await prisma.$queryRaw<Array<{ n: number }>>(Prisma.sql`
    SELECT count(DISTINCT l.contact_id)::int AS n FROM ${T("list_leads")} l
    WHERE l.list_id = ${listId} AND l.business_id = ${user.businessId}
      AND EXISTS (SELECT 1 FROM ${T("leads")} ld WHERE ld.business_id = l.business_id AND ld.contact_id = l.contact_id AND ld.owner_user_id = ${user.id}
        AND (ld.close_reason = ${EXHAUSTED_REASON} OR l.status = 'exhausted'))`))[0].n;
  const window = await listDialWindow(user.businessId, listId);
  const open = isWithinDialWindow(window);
  const waiting = Math.max(0, later - (open ? now : 0));
  if (open && now > 0) return { ...base, state: "available", availableNow: now, waiting, exhaustedCount, reason: null };
  if (later === 0) return { ...base, state: "exhausted", exhaustedCount, reason: null };
  // Something will become dialable: the earliest retry / follow-up time (or tomorrow, when only today's cap blocks it).
  const next = (await prisma.$queryRaw<Array<{ at: Date | null }>>(Prisma.sql`
    SELECT min(GREATEST(COALESCE(l.next_attempt_at, '-infinity'::timestamp),
      COALESCE((SELECT min(ft.due_at) FROM ${T("tasks")} ft WHERE ft.business_id = l.business_id AND ft.contact_id = l.contact_id AND ft.status = 'open' AND ft.type = 'callback' AND ft.due_at > timezone('UTC', now())), '-infinity'::timestamp))) AS at
    FROM ${T("list_leads")} l JOIN ${T("contacts")} c ON c.id = l.contact_id WHERE ${queueFilter(q, { timeAware: false })}`))[0]?.at;
  let nextAt = next && next.getTime() > Date.now() ? next : new Date(q.dayStart.getTime() + 24 * 3600_000);
  if (!open || !isWithinDialWindow(window, nextAt)) nextAt = nextDialWindowOpening(window, nextAt > new Date() ? nextAt : new Date()) ?? nextAt;
  return { ...base, state: "waiting", waiting: later, nextAt: nextAt.toISOString(), exhaustedCount, reason: open ? null : "מחוץ לשעות החיוג של העסק" };
}

/** Campaigns this user may work (server-side permissions), with what is dialable for them right now. */
export async function campaignsFor(user: SessionUser, excludeListId?: string) {
  const lists = await prisma.dialList.findMany({
    where: { businessId: user.businessId, isActive: true, isPaused: false, archivedAt: null, ...(excludeListId ? { id: { not: excludeListId } } : {}),
      ...(user.role === "agent" ? { OR: [{ agents: { none: {} } }, { agents: { some: { userId: user.id } } }] } : {}) },
    select: { id: true, name: true, priority: true, isDynamic: true, filterJson: true }, orderBy: [{ priority: "desc" }, { createdAt: "desc" }],
  });
  // Another agent's personal list ("הלידים של …") is never offered, not even to managers.
  const mine = lists.filter((l) => { const owner = (l.filterJson as { leadOwnerUserId?: string } | null)?.leadOwnerUserId; return !owner || owner === user.id; });
  const rows = [];
  for (const l of mine) { const a = await queueAvailability(user, l.id); if (a.state !== "blocked") rows.push({ id: l.id, name: l.name, availableNow: a.availableNow, nextAt: a.nextAt, state: a.state }); }
  return rows.sort((a, b) => b.availableNow - a.availableNow);
}

/** Follow-ups whose time came in OTHER campaigns of this agent (shown as a notice with a link back). */
export async function dueFollowUpsElsewhere(user: SessionUser, listId: string) {
  const rows = await prisma.$queryRaw<Array<{ listId: string; listName: string; n: number }>>(Prisma.sql`
    SELECT l.list_id AS "listId", dl.name AS "listName", count(*)::int AS n
    FROM ${T("list_leads")} l JOIN ${T("dial_lists")} dl ON dl.id = l.list_id
    WHERE l.business_id = ${user.businessId} AND l.list_id <> ${listId} AND l.status = 'callback' AND dl.is_active AND dl.archived_at IS NULL
      AND l.next_attempt_at <= timezone('UTC', now()) AND (l.preferred_user_id = ${user.id}
        OR EXISTS (SELECT 1 FROM ${T("leads")} ld WHERE ld.business_id = l.business_id AND ld.contact_id = l.contact_id AND ld.owner_user_id = ${user.id} AND ld.status = 'follow_up'))
    GROUP BY l.list_id, dl.name ORDER BY n DESC LIMIT 5`);
  return rows;
}

// ─── alerts ───────────────────────────────────────────────────────────────────────────────────────────────────────
/** Open the "no leads available" alert once per emptying (idempotent under concurrent refreshes). */
export async function openQueueAlert(user: Pick<SessionUser, "businessId" | "id">, a: Availability) {
  if (a.state !== "exhausted" && a.state !== "waiting") return null;
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`queue-alert:${a.listId}:${user.id}`}, 0))`);
    const open = await tx.dialerQueueAlert.findFirst({ where: { businessId: user.businessId, listId: a.listId, userId: user.id, closedAt: null }, select: { id: true } });
    if (open) return null;
    const alert = await tx.dialerQueueAlert.create({ data: { businessId: user.businessId, userId: user.id, listId: a.listId, state: a.state, exhaustedCount: a.exhaustedCount, nextAt: a.nextAt ? new Date(a.nextAt) : null } });
    await emitEvent(tx, { businessId: user.businessId, type: "dialer.queue_empty", actorUserId: user.id, source: "system", dedupeKey: `dialer.queue_empty:${alert.id}`, payload: { alertId: alert.id } });
    return alert;
  });
}

/** Work came back for this agent in this list (a lead was claimed) → the next emptying may alert again. */
export async function closeQueueAlerts(businessId: string, userId: string, listId: string) {
  await prisma.dialerQueueAlert.updateMany({ where: { businessId, userId, listId, closedAt: null }, data: { closedAt: new Date() } });
}

const fmt = (d: Date, tz: string) => new Intl.DateTimeFormat("he-IL", { timeZone: tz, dateStyle: "short", timeStyle: "short" }).format(d);

/** Events worker: notify the business's managers who may see this agent (in-app row + WhatsApp to linked managers). */
export async function notifyQueueEmpty(businessId: string, alertId: string) {
  const alert = await prisma.dialerQueueAlert.findFirst({ where: { id: alertId, businessId } });
  if (!alert || alert.notifiedAt) return { skipped: "already notified" };
  const [agent, list, settings] = await Promise.all([
    prisma.user.findFirst({ where: { id: alert.userId, businessId }, select: { id: true, fullName: true } }),
    prisma.dialList.findFirst({ where: { id: alert.listId, businessId }, select: { id: true, name: true } }),
    getBusinessSettings(businessId),
  ]);
  if (!agent || !list) return { skipped: "agent or list missing" };
  const base = (process.env.NEXT_PUBLIC_APP_URL ?? "").replace(/\/$/, "");
  const text = [
    `לנציג ${agent.fullName} אין כרגע לידים זמינים לחיוג בקמפיין ${list.name}.`,
    `לידים שמוצו ניסיונות החיוג שלהם: ${alert.exhaustedCount}`,
    alert.nextAt ? `יש עבודה עתידית – החיוג הבא צפוי ב-${fmt(alert.nextAt, settings.timezone)}` : "אין פולואפים או ניסיונות חוזרים עתידיים בקמפיין.",
    `רשימת חיוג: ${base}/calling/lists/${list.id}`, `נציג: ${base}/reports?agent=${agent.id}`,
  ].join("\n");
  // Recipients: owner + managers whose scope includes the agent – never another business.
  const managers = await prisma.user.findMany({ where: { businessId, isActive: true, role: { in: ["owner", "manager"] } }, select: { id: true, role: true, teamId: true, fullName: true, email: true, accountId: true } });
  const recipients: string[] = [];
  for (const m of managers) {
    if (m.role === "owner") { recipients.push(m.id); continue; }
    const ids = await visibleUserIds({ id: m.id, businessId, role: m.role, teamId: m.teamId, fullName: m.fullName, email: m.email, accountId: m.accountId });
    if (!ids || ids.includes(agent.id)) recipients.push(m.id);
  }
  const delivery: Array<{ to: string; channel: string; status: string; detail?: string }> = recipients.map((to) => ({ to, channel: "app", status: "shown" }));
  const links = await prisma.assistantLink.findMany({ where: { businessId, status: "active", userId: { in: recipients } } });
  if (links.length) {
    const { sendToLink } = await import("@/server/assistant/transport");
    for (const link of links) {
      const key = `queue-empty:${alert.id}:${link.id}`;
      try { await prisma.assistantDelivery.create({ data: { businessId, key, kind: "queue_empty", status: "pending", linkId: link.id } }); }
      catch (e) { if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") continue; throw e; }
      const r = await sendToLink(link, text, { title: "אין לידים זמינים לנציג" }).catch((e: Error) => ({ status: "failed" as const, detail: e.message.slice(0, 200) }));
      await prisma.assistantDelivery.updateMany({ where: { businessId, key }, data: { status: r.status, detail: r.detail ?? null } });
      delivery.push({ to: link.userId, channel: "whatsapp", status: r.status, detail: r.detail });
    }
  }
  await prisma.dialerQueueAlert.update({ where: { id: alert.id }, data: { notifiedAt: new Date(), delivery: delivery as Prisma.InputJsonValue } });
  return { recipients: recipients.length, whatsapp: links.length };
}
