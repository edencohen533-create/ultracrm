/**
 * Unified activity timeline of a contact: calls, messages, notes, tasks,
 * lead / deal changes and cross-module events, merged by time.
 */
import { prisma } from "@/lib/db";
import { visibleUserIds, type SessionUser } from "@/lib/auth";
import { OUTCOME_BY_KEY } from "@/lib/outcomes";

export interface TimelineItem {
  id: string;
  kind: "call" | "message" | "note" | "task" | "lead" | "deal" | "event";
  at: string;
  title: string;
  body?: string | null;
  meta?: Record<string, unknown>;
  actor?: string | null;
  href?: string;
}

export async function contactTimeline(user: SessionUser, contactId: string, limit = 100): Promise<TimelineItem[]> {
  const ids = await visibleUserIds(user);
  const businessId = user.businessId;
  const [calls, messages, notes, tasks, leads, deals, events] = await Promise.all([
    prisma.call.findMany({ where: { contactId, businessId, ...(ids ? { userId: { in: ids } } : {}) }, orderBy: { createdAt: "desc" }, take: limit, select: { id: true, createdAt: true, direction: true, answeredAt: true, endedAt: true, talkSeconds: true, telephonyResult: true, outcome: true, outcomeNote: true, callbackAt: true, recordingStatus: true, user: { select: { fullName: true } } } }),
    prisma.message.findMany({ where: { businessId, conversation: { contactId } }, orderBy: { createdAt: "desc" }, take: limit, select: { id: true, createdAt: true, direction: true, type: true, body: true, status: true, category: true, channel: true, conversationId: true, sentByUser: { select: { fullName: true } } } }),
    prisma.note.findMany({ where: { businessId, contactId }, orderBy: { createdAt: "desc" }, take: limit, select: { id: true, createdAt: true, body: true, conversationId: true, author: { select: { fullName: true } } } }),
    prisma.task.findMany({ where: { businessId, contactId, ...(ids ? { userId: { in: ids } } : {}) }, orderBy: { createdAt: "desc" }, take: limit, select: { id: true, createdAt: true, dueAt: true, status: true, type: true, title: true, note: true, doneAt: true, user: { select: { fullName: true } } } }),
    prisma.lead.findMany({ where: { businessId, contactId }, orderBy: { createdAt: "desc" }, take: 20, select: { id: true, createdAt: true, status: true, title: true, source: true, closedAt: true, owner: { select: { fullName: true } } } }),
    prisma.deal.findMany({ where: { businessId, contactId }, orderBy: { createdAt: "desc" }, take: 20, select: { id: true, createdAt: true, title: true, stage: true, status: true, amount: true, currency: true, closedAt: true, owner: { select: { fullName: true } } } }),
    prisma.domainEvent.findMany({ where: { businessId, contactId, type: { in: ["contact.suppressed", "contact.resubscribed", "lead.status_changed", "deal.won"] } }, orderBy: { occurredAt: "desc" }, take: 30, select: { id: true, occurredAt: true, type: true, payload: true, source: true } }),
  ]);
  const items: TimelineItem[] = [];
  for (const c of calls) {
    const result = c.telephonyResult ? ({ answered: "נענתה", no_answer: "אין מענה", busy: "תפוס", failed: "נכשלה", cancelled: "בוטלה", rejected: "נדחתה" } as Record<string, string>)[c.telephonyResult] : "בתהליך";
    items.push({ id: `call:${c.id}`, kind: "call", at: c.createdAt.toISOString(), title: `${c.direction === "inbound" ? "שיחה נכנסת" : "שיחה יוצאת"} · ${result}${c.outcome ? ` · ${OUTCOME_BY_KEY[c.outcome]?.label ?? c.outcome}` : ""}`, body: c.outcomeNote, actor: c.user.fullName, meta: { talkSeconds: c.talkSeconds, callbackAt: c.callbackAt?.toISOString() ?? null, recording: c.recordingStatus === "saved" ? `/api/recordings/${c.id}` : null, ended: Boolean(c.endedAt) } });
  }
  for (const m of messages) {
    items.push({ id: `message:${m.id}`, kind: "message", at: m.createdAt.toISOString(), title: `${m.direction === "INBOUND" ? "הודעה נכנסת" : "הודעה יוצאת"} · ${m.channel === "whatsapp" ? "WhatsApp" : m.channel} · ${m.status}`, body: m.body, actor: m.sentByUser?.fullName ?? null, href: `/inbox/${m.conversationId}`, meta: { type: m.type, category: m.category } });
  }
  for (const n of notes) items.push({ id: `note:${n.id}`, kind: "note", at: n.createdAt.toISOString(), title: "הערה פנימית", body: n.body, actor: n.author.fullName, href: n.conversationId ? `/inbox/${n.conversationId}` : undefined });
  for (const t of tasks) items.push({ id: `task:${t.id}`, kind: "task", at: t.createdAt.toISOString(), title: `משימה · ${t.title ?? t.type} · ${t.status === "open" ? "פתוחה" : t.status === "done" ? "בוצעה" : "בוטלה"}`, body: t.note, actor: t.user.fullName, meta: { dueAt: t.dueAt.toISOString(), status: t.status, taskId: t.id } });
  for (const l of leads) items.push({ id: `lead:${l.id}`, kind: "lead", at: l.createdAt.toISOString(), title: `ליד נוצר${l.title ? ` · ${l.title}` : ""} · ${l.status}`, body: l.source ? `מקור: ${l.source}` : null, actor: l.owner?.fullName ?? null, href: `/leads/${l.id}` });
  for (const d of deals) items.push({ id: `deal:${d.id}`, kind: "deal", at: d.createdAt.toISOString(), title: `עסקה · ${d.title} · ${d.stage}`, body: `${d.amount.toString()} ${d.currency}`, actor: d.owner?.fullName ?? null, href: `/deals/${d.id}` });
  for (const e of events) {
    const p = (e.payload ?? {}) as Record<string, unknown>;
    items.push({ id: `event:${e.id}`, kind: "event", at: e.occurredAt.toISOString(), title: e.type === "contact.suppressed" ? `הסרה מדיוור (${p.scope === "all" ? "לא ליצור קשר" : "שיווקי"}) · מקור: ${p.source}` : e.type === "contact.resubscribed" ? "הסכמה מחודשת לדיוור" : e.type, body: typeof p.reason === "string" ? p.reason : null, meta: p });
  }
  items.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  return items.slice(0, limit);
}
