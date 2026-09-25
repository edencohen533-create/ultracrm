/**
 * Unified activity timeline of a contact: calls, messages, notes, tasks,
 * lead / deal changes and cross-module events, merged by time.
 */
import { prisma } from "@/lib/db";
import { visibleUserIds, type SessionUser } from "@/lib/auth";
import { conversationScope, noteScope, ownerScope } from "./access";
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
  const [calls, messages, notes, tasks, leads, deals, events, runs] = await Promise.all([
    prisma.call.findMany({ where: { contactId, businessId, ...(ids ? { userId: { in: ids } } : {}) }, orderBy: { createdAt: "desc" }, take: limit, select: { id: true, createdAt: true, direction: true, answeredAt: true, endedAt: true, talkSeconds: true, telephonyResult: true, outcome: true, outcomeNote: true, callbackAt: true, recordingStatus: true, user: { select: { fullName: true } } } }),
    prisma.message.findMany({ where: { businessId, conversation: { contactId, ...conversationScope(user) } }, orderBy: { createdAt: "desc" }, take: limit, select: { id: true, createdAt: true, direction: true, type: true, body: true, status: true, category: true, channel: true, conversationId: true, subject: true, toIdentifier: true, openedAt: true, clickedAt: true, bounceType: true, errorReason: true, campaignRecipient: { select: { campaign: { select: { id: true, name: true } } } }, sentByUser: { select: { fullName: true } } } }),
    prisma.note.findMany({ where: { businessId, contactId, ...noteScope(user, ids) }, orderBy: { createdAt: "desc" }, take: limit, select: { id: true, createdAt: true, body: true, conversationId: true, author: { select: { fullName: true } } } }),
    prisma.task.findMany({ where: { businessId, contactId, ...(ids ? { userId: { in: ids } } : {}) }, orderBy: { createdAt: "desc" }, take: limit, select: { id: true, createdAt: true, dueAt: true, status: true, type: true, title: true, note: true, doneAt: true, user: { select: { fullName: true } } } }),
    prisma.lead.findMany({ where: { businessId, contactId, ...ownerScope(ids) }, orderBy: { createdAt: "desc" }, take: 20, select: { id: true, createdAt: true, status: true, title: true, source: true, closedAt: true, owner: { select: { fullName: true } } } }),
    prisma.deal.findMany({ where: { businessId, contactId, ...ownerScope(ids) }, orderBy: { createdAt: "desc" }, take: 20, select: { id: true, createdAt: true, title: true, stage: true, status: true, amount: true, currency: true, closedAt: true, owner: { select: { fullName: true } } } }),
    prisma.domainEvent.findMany({ where: { businessId, contactId, type: { in: ["contact.suppressed", "contact.resubscribed", ...(ids ? [] : ["lead.status_changed", "deal.won"]), "contact.merged"] } }, orderBy: { occurredAt: "desc" }, take: 30, select: { id: true, occurredAt: true, type: true, payload: true, source: true } }),
    prisma.sequenceRun.findMany({ where: { businessId, contactId }, orderBy: { startedAt: "desc" }, take: 20, select: { id: true, startedAt: true, status: true, stopReason: true, stepIndex: true, log: true, completedAt: true, sequence: { select: { name: true } } } }),
  ]);
  const items: TimelineItem[] = [];
  for (const r of runs) {
    const log = Array.isArray(r.log) ? (r.log as Array<{ step: number; channel: string; messageId: string | null; skipped: string | null; at: string }>) : [];
    const st: Record<string, string> = { PENDING: "ממתין לשלב הבא", RUNNING: "בביצוע", COMPLETED: "הושלם", STOPPED: "נעצר", FAILED: "נכשל" };
    items.push({ id: `sequence:${r.id}`, kind: "event", at: r.startedAt.toISOString(), title: `רצף אוטומטי · ${r.sequence.name} · ${st[r.status] ?? r.status}${r.stopReason ? ` (${r.stopReason})` : ""}`, body: log.map((l) => `שלב ${l.step + 1} (${l.channel}): ${l.skipped ? `דולג – ${l.skipped}` : l.messageId ? "נשלח" : "בוצע"}`).join("\n") || null, meta: { status: r.status, stepIndex: r.stepIndex } });
  }
  for (const c of calls) {
    const result = c.telephonyResult ? ({ answered: "נענתה", no_answer: "אין מענה", busy: "תפוס", failed: "נכשלה", cancelled: "בוטלה", rejected: "נדחתה" } as Record<string, string>)[c.telephonyResult] : "בתהליך";
    items.push({ id: `call:${c.id}`, kind: "call", at: c.createdAt.toISOString(), title: `${c.direction === "inbound" ? "שיחה נכנסת" : "שיחה יוצאת"} · ${result}${c.outcome ? ` · ${OUTCOME_BY_KEY[c.outcome]?.label ?? c.outcome}` : ""}`, body: c.outcomeNote, actor: c.user.fullName, meta: { talkSeconds: c.talkSeconds, callbackAt: c.callbackAt?.toISOString() ?? null, recording: c.recordingStatus === "saved" ? `/api/recordings/${c.id}` : null, ended: Boolean(c.endedAt) } });
  }
  const CHANNEL: Record<string, string> = { whatsapp: "WhatsApp", sms: "SMS", email: "אימייל" };
  const STATUS: Record<string, string> = { QUEUED: "בתור", UNKNOWN: "לא ודאי", ACCEPTED: "הועבר לספק", SENT: "נשלח", DELIVERED: "נמסר", READ: "נקרא", FAILED: "נכשל", BOUNCED: "הוקפץ", CANCELLED: "בוטל" };
  for (const m of messages) {
    const flags = [m.openedAt ? "נפתח (אות מהספק)" : null, m.clickedAt ? "הקלקה" : null, m.bounceType ? `bounce ${m.bounceType}` : null].filter(Boolean).join(" · ");
    items.push({ id: `message:${m.id}`, kind: "message", at: m.createdAt.toISOString(), title: `${m.direction === "INBOUND" ? "הודעה נכנסת" : "הודעה יוצאת"} · ${CHANNEL[m.channel] ?? m.channel} · ${STATUS[m.status] ?? m.status}${m.category === "marketing" ? " · שיווקי" : ""}${m.campaignRecipient?.campaign ? ` · קמפיין: ${m.campaignRecipient.campaign.name}` : ""}${flags ? ` · ${flags}` : ""}`, body: m.subject ? `${m.subject}\n${m.body ?? ""}`.trim() : m.body, actor: m.sentByUser?.fullName ?? null, href: `/inbox/${m.conversationId}`, meta: { type: m.type, category: m.category, channel: m.channel, to: m.toIdentifier, openedAt: m.openedAt?.toISOString() ?? null, clickedAt: m.clickedAt?.toISOString() ?? null, error: m.errorReason, campaignId: m.campaignRecipient?.campaign?.id ?? null } });
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
