/**
 * Write-back to external CRMs. Everything is DONE locally first (the call, its outcome, the follow-up, the block);
 * this queue only SYNCS it out – a failure here never touches a live call and is retried with backoff:
 *  • one row per action per connection (dedupe key) – a retry never creates a second activity / task;
 *  • an "ambiguous" failure (timeout / 5xx after sending) is looked up by its correlation id before it is retried;
 *  • a late AI summary updates the activity that was already written (never a second call);
 *  • tasks / status / blocks that came FROM the external CRM are not written back (no loops); a status write is
 *    remembered on the link so its webhook echo is ignored.
 * Only records linked to a connection are written, and only what its settings allow (content, link to details).
 */
import { Prisma, type DomainEvent } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";
import { openConfig } from "@/server/channels/registry";
import { appBase } from "@/lib/store-urls";
import { OUTCOMES } from "@/lib/outcomes";
import { connectorFor } from "./registry";
import { parseSettings } from "./settings";
import { ConnectorError, type ConnectorCtx } from "./types";

const BACKOFF_MIN = [1, 5, 30, 120, 720, 1440];
const MAX_ATTEMPTS = BACKOFF_MIN.length + 1;

async function linkedConnections(businessId: string, contactId: string) {
  const links = await prisma.externalRecordLink.findMany({ where: { businessId, recordType: "contact", localId: contactId, deletedAt: null }, select: { connectionId: true, externalId: true } });
  if (!links.length) return [];
  // A disconnected connection still gets its rows queued – they wait (not processed) and go out after reconnecting.
  const conns = await prisma.crmConnection.findMany({ where: { businessId, id: { in: links.map((l) => l.connectionId) } } });
  return conns.map((c) => ({ conn: c, settings: parseSettings(c.settings), contactExternalId: links.find((l) => l.connectionId === c.id)!.externalId }));
}

async function enqueue(businessId: string, connectionId: string, action: string, localType: string, localId: string, dedupeKey: string, payload: Record<string, unknown> = {}) {
  await prisma.crmOutbox.createMany({ data: [{ businessId, connectionId, action, localType, localId, dedupeKey, payload: payload as Prisma.InputJsonValue, correlationId: `ucrm_${connectionId.slice(-6)}_${dedupeKey}`.slice(0, 190) }], skipDuplicates: true });
}

/** Domain-event handler: queue what the connection's settings ask to be written back. */
export async function enqueueCrmWriteback(event: DomainEvent) {
  if (!event.contactId) return { queued: 0 };
  const targets = await linkedConnections(event.businessId, event.contactId);
  if (!targets.length) return { queued: 0 };
  const p = (event.payload ?? {}) as Record<string, unknown>;
  let queued = 0;
  for (const { conn, settings } of targets) {
    const w = settings.writeback;
    if (event.type === "call.outcome_saved" && w.calls && typeof p.callId === "string") { await enqueue(event.businessId, conn.id, "log_call", "call", p.callId, `call:${p.callId}`); queued++; }
    if (event.type === "call.summary_ready" && w.aiSummary && typeof p.callId === "string") { await enqueue(event.businessId, conn.id, "update_call_summary", "call", p.callId, `call:${p.callId}:summary:${event.id}`); queued++; }
    if (event.type === "task.created" && w.followUpTasks && typeof p.taskId === "string") {
      const t = await prisma.task.findFirst({ where: { id: p.taskId, businessId: event.businessId }, select: { type: true, requestKey: true } });
      if (t?.type === "callback" && !t.requestKey?.startsWith(`crm:${conn.id}:`)) { await enqueue(event.businessId, conn.id, "upsert_task", "task", p.taskId, `task:${p.taskId}`); queued++; }
    }
    if (event.type === "contact.suppressed" && w.blocks && p.source !== `crm:${conn.id}`) { await enqueue(event.businessId, conn.id, "request_block", "contact", event.contactId, `block:${event.contactId}:${event.id}`, { reason: p.reason ?? p.source ?? null, scope: p.scope ?? null }); queued++; }
    if (event.type === "lead.status_changed" && w.status && typeof p.leadId === "string" && typeof p.to === "string" && settings.statusOutMap[p.to as keyof typeof settings.statusOutMap] && event.source !== "webhook") { await enqueue(event.businessId, conn.id, "update_status", "lead", p.leadId, `status:${p.leadId}:${event.id}`, { status: settings.statusOutMap[p.to as keyof typeof settings.statusOutMap] }); queued++; }
  }
  return { queued };
}

async function extId(businessId: string, connectionId: string, recordType: string, localId: string | null | undefined) {
  if (!localId) return null;
  return (await prisma.externalRecordLink.findFirst({ where: { businessId, connectionId, recordType, localId }, select: { externalId: true } }))?.externalId ?? null;
}

async function callPayload(row: { businessId: string; connectionId: string; localId: string; correlationId: string }, s: ReturnType<typeof parseSettings>) {
  const c = await prisma.call.findFirst({ where: { id: row.localId, businessId: row.businessId }, select: { id: true, createdAt: true, direction: true, talkSeconds: true, answeredAt: true, telephonyResult: true, status: true, outcome: true, outcomeNote: true, contactId: true, user: { select: { fullName: true } }, coachSession: { select: { documentation: true } } } });
  if (!c) return null;
  const lead = c.contactId ? await prisma.lead.findFirst({ where: { businessId: row.businessId, contactId: c.contactId }, orderBy: { createdAt: "desc" }, select: { id: true } }) : null;
  const doc = c.coachSession?.documentation as { summary?: string } | null;
  return {
    correlationId: row.correlationId, contactExternalId: await extId(row.businessId, row.connectionId, "contact", c.contactId), leadExternalId: await extId(row.businessId, row.connectionId, "lead", lead?.id),
    at: c.createdAt.toISOString(), direction: c.direction, durationSec: c.answeredAt ? c.talkSeconds ?? 0 : 0, result: c.telephonyResult ?? c.status,
    outcome: OUTCOMES.find((o) => o.key === c.outcome)?.label ?? c.outcome, agent: c.user?.fullName ?? null, note: c.outcomeNote,
    aiSummary: s.writeback.aiSummary ? doc?.summary ?? null : null,
    // A link to the call inside UltraCRM – opens only for a signed-in user allowed to see it (never a public recording URL).
    detailsUrl: s.writeback.detailsLink ? `${appBase()}/calling/history?call=${c.id}` : null,
  };
}

async function run(row: Awaited<ReturnType<typeof prisma.crmOutbox.findFirstOrThrow>>, ctx: ConnectorCtx, def: NonNullable<ReturnType<typeof connectorFor>>): Promise<{ done: true; ref?: string | null; note?: string } | { done: false; wait: number; note: string }> {
  const s = ctx.settings; const p = (row.payload ?? {}) as Record<string, unknown>;
  const ambiguousBefore = row.lastError?.startsWith("[ambiguous]");
  switch (row.action) {
    case "log_call": {
      if (!def.writeCall) return { done: true, note: "המחבר אינו תומך בכתיבת פעילות" };
      if (ambiguousBefore && def.findByCorrelation) { const found = await def.findByCorrelation(ctx, "call", row.correlationId); if (found) return { done: true, ref: found, note: "נמצא במקור – לא נוצר שוב" }; }
      const body = await callPayload(row, s); if (!body) return { done: true, note: "השיחה לא נמצאה" };
      const r = await def.writeCall(ctx, body);
      await prisma.crmOutbox.update({ where: { id: row.id }, data: { payload: { ...p, summaryIncluded: Boolean(body.aiSummary) } as Prisma.InputJsonValue } });
      await prisma.externalRecordLink.upsert({ where: { businessId_connectionId_recordType_externalId: { businessId: row.businessId, connectionId: row.connectionId, recordType: "activity", externalId: r.externalId } }, create: { businessId: row.businessId, connectionId: row.connectionId, recordType: "activity", externalId: r.externalId, localId: row.localId, lastSyncedAt: new Date() }, update: { lastSyncedAt: new Date() } });
      // The follow-up this call produced (outcome "לחזור") goes out once – same dedupe key as any other write of that task.
      if (s.writeback.followUpTasks) {
        const call = await prisma.call.findUnique({ where: { id: row.localId }, select: { contactId: true, createdAt: true } });
        const tasks = call?.contactId ? await prisma.task.findMany({ where: { businessId: row.businessId, contactId: call.contactId, type: "callback", status: "open", createdAt: { gte: new Date(call.createdAt.getTime() - 60_000) }, OR: [{ requestKey: null }, { NOT: { requestKey: { startsWith: `crm:${row.connectionId}:` } } }] }, select: { id: true } }) : [];
        for (const t of tasks) await enqueue(row.businessId, row.connectionId, "upsert_task", "task", t.id, `task:${t.id}`);
      }
      return { done: true, ref: r.externalId };
    }
    case "update_call_summary": {
      const parent = await prisma.crmOutbox.findUnique({ where: { connectionId_dedupeKey: { connectionId: row.connectionId, dedupeKey: `call:${row.localId}` } } });
      if (!parent) return { done: true, note: "אין פעילות שיחה לעדכן" };
      if (parent.status !== "sent") return parent.status === "dead" || parent.status === "cancelled" ? { done: true, note: "פעילות השיחה לא נכתבה" } : { done: false, wait: 60, note: "ממתין לכתיבת פעילות השיחה" };
      const body = await callPayload(row, s); if (!body?.aiSummary) return { done: true, note: "אין סיכום לעדכן" };
      if ((parent.payload as { summaryIncluded?: boolean }).summaryIncluded && !p.force) return { done: true, note: "הסיכום כבר נכלל בפעילות" };
      if (!def.updateCall || !parent.externalRef) return { done: true, note: "המחבר אינו תומך בעדכון פעילות" };
      await def.updateCall(ctx, parent.externalRef, { correlationId: parent.correlationId, aiSummary: body.aiSummary });
      return { done: true, ref: parent.externalRef };
    }
    case "upsert_task": {
      if (!def.upsertTask) return { done: true, note: "המחבר אינו תומך במשימות" };
      const t = await prisma.task.findFirst({ where: { id: row.localId, businessId: row.businessId }, select: { id: true, dueAt: true, title: true, note: true, status: true, contactId: true, leadId: true, userId: true } });
      if (!t) return { done: true, note: "המשימה לא נמצאה" };
      const existing = row.externalRef ?? (ambiguousBefore && def.findByCorrelation ? await def.findByCorrelation(ctx, "task", row.correlationId) : null);
      const assignee = Object.entries(s.userMap).find(([, local]) => local === t.userId)?.[0] ?? null;
      const tz = (await (await import("@/lib/settings")).getBusinessSettings(row.businessId)).timezone;
      const r = await def.upsertTask(ctx, { correlationId: row.correlationId, contactExternalId: await extId(row.businessId, row.connectionId, "contact", t.contactId), leadExternalId: await extId(row.businessId, row.connectionId, "lead", t.leadId), dueAt: t.dueAt.toISOString(), timezone: tz, title: t.title ?? "פולואפ", note: t.note, assigneeExternalId: assignee, done: t.status !== "open" }, existing);
      await prisma.externalRecordLink.upsert({ where: { businessId_connectionId_recordType_externalId: { businessId: row.businessId, connectionId: row.connectionId, recordType: "task", externalId: r.externalId } }, create: { businessId: row.businessId, connectionId: row.connectionId, recordType: "task", externalId: r.externalId, localId: t.id, lastSyncedAt: new Date() }, update: { lastSyncedAt: new Date() } });
      return { done: true, ref: r.externalId };
    }
    case "update_status": {
      if (!def.updateStatus) return { done: true, note: "המחבר אינו תומך בעדכון סטטוס" };
      const leadExt = await extId(row.businessId, row.connectionId, "lead", row.localId); if (!leadExt) return { done: true, note: "הליד אינו מקושר" };
      const status = String(p.status);
      // Remember what we wrote: its webhook echo is recognised and not applied again (no loop).
      await prisma.externalRecordLink.updateMany({ where: { businessId: row.businessId, connectionId: row.connectionId, recordType: "lead", localId: row.localId }, data: { lastOutbound: { status, at: new Date().toISOString(), correlationId: row.correlationId } } });
      await def.updateStatus(ctx, leadExt, status, row.correlationId);
      return { done: true, ref: leadExt };
    }
    case "request_block": {
      if (!def.requestBlock) return { done: true, note: "המחבר אינו תומך בבקשת חסימה" };
      const cExt = await extId(row.businessId, row.connectionId, "contact", row.localId); if (!cExt) return { done: true, note: "איש הקשר אינו מקושר" };
      await def.requestBlock(ctx, cExt, String(p.reason ?? "בקשת הסרה"), row.correlationId);
      return { done: true, ref: cExt };
    }
  }
  return { done: true, note: `פעולה לא מוכרת: ${row.action}` };
}

/** Cron worker (per business): due rows of ACTIVE connections only – a disconnected / erroring one waits (kept). */
export async function processCrmOutbox(businessId: string, deadline = Date.now() + 20_000) {
  const due = await prisma.crmOutbox.findMany({ where: { businessId, status: { in: ["pending", "failed"] }, nextAttemptAt: { lte: new Date() }, connection: { status: "active" } }, orderBy: { createdAt: "asc" }, take: 50 });
  let sent = 0;
  for (const row of due) {
    if (Date.now() > deadline) break;
    const claim = await prisma.crmOutbox.updateMany({ where: { id: row.id, attempts: row.attempts, status: row.status }, data: { attempts: { increment: 1 }, nextAttemptAt: new Date(Date.now() + 10 * 60_000) } });
    if (!claim.count) continue;
    const conn = await prisma.crmConnection.findUniqueOrThrow({ where: { id: row.connectionId } });
    const def = connectorFor(conn.connectorKey);
    if (!def) { await prisma.crmOutbox.update({ where: { id: row.id }, data: { status: "dead", lastError: "המחבר אינו זמין" } }); continue; }
    const ctx: ConnectorCtx = { connectionId: conn.id, businessId, auth: openConfig(conn.authConfig) as Record<string, string>, settings: parseSettings(conn.settings) };
    const attempts = row.attempts + 1;
    try {
      const r = await run(row, ctx, def);
      if (r.done) { sent++; await prisma.crmOutbox.update({ where: { id: row.id }, data: { status: "sent", sentAt: new Date(), externalRef: r.ref ?? row.externalRef, lastError: r.note ?? null } }); }
      else await prisma.crmOutbox.update({ where: { id: row.id }, data: { attempts: row.attempts, nextAttemptAt: new Date(Date.now() + r.wait * 1000), lastError: r.note } });
    } catch (e) {
      const err = e instanceof ConnectorError ? e : new ConnectorError((e as Error).message, "transient");
      if (err.kind === "auth") await prisma.crmConnection.update({ where: { id: conn.id }, data: { status: "error", lastError: `הרשאה נדחתה בכתיבה: ${err.message}`.slice(0, 300) } });
      const dead = err.kind === "invalid" || attempts >= MAX_ATTEMPTS;
      const wait = err.kind === "rate_limit" ? Math.max(err.retryAfterSec ?? 60, 30) : (BACKOFF_MIN[attempts - 1] ?? 1440) * 60;
      await prisma.crmOutbox.update({ where: { id: row.id }, data: { status: dead ? "dead" : "failed", lastError: `[${err.kind}] ${err.message}`.slice(0, 300), nextAttemptAt: new Date(Date.now() + wait * 1000) } });
    }
  }
  return { sent };
}
