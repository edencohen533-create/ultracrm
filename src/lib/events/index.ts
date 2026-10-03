/**
 * Cross-module event contract + outbox worker.
 *
 * Contract (DomainEvent): id, businessId, contactId, occurredAt, source, type, payload.
 *  • `emitEvent` is called inside the same transaction as the business change –
 *    the event is committed with it (outbox). `dedupeKey` makes emission idempotent.
 *  • `processDomainEvents` claims pending events with a CAS update, runs every
 *    registered handler once (AutomationJob is unique per event+handler) and retries
 *    transient failures with backoff. A crash never loses an event and never
 *    re-runs a handler that already completed.
 *  • Late events are tolerated: handlers compare `occurredAt` with current state.
 *  • Loops: automation-originated events carry `depth`; handlers that send
 *    messages ignore events deeper than MAX_DEPTH.
 */
import { after } from "next/server";
import { db, prisma, type Db } from "@/lib/db";
import { withBusiness } from "@/lib/tenant";
import { Prisma } from "@/generated/prisma/client";
import { HANDLERS, type EventHandler } from "./handlers";

export type DomainEventType =
  | "lead.created"
  | "lead.status_changed"
  | "deal.created"
  | "deal.won"
  | "deal.lost"
  | "deal.reopened"
  | "appointment.scheduled"
  | "appointment.rescheduled"
  | "appointment.attended"
  | "contact.field_changed"
  | "call.ended"
  | "call.outcome_saved"
  /** The AI documentation of a call was stored (may arrive after the call was already written to an external CRM). */
  | "call.summary_ready"
  | "email.engagement"
  | "message.received"
  | "message.sent"
  | "contact.suppressed"
  | "contact.resubscribed"
  | "contact.tag_added"
  | "contact.created"
  | "contact.merged"
  | "message.delivery_failed"
  | "sequence.step_sent"
  | "task.created"
  | "cart.abandoned"
  | "dialer.queue_empty"
  /** An agent connected to the dialer (session started) / disconnected (ended or tab gone). */
  | "agent.online"
  | "agent.offline";

export type EventSource = "user" | "system" | "automation" | "webhook" | "import";

export interface EmitEventInput {
  businessId: string;
  type: DomainEventType;
  contactId?: string | null;
  actorUserId?: string | null;
  source?: EventSource;
  depth?: number;
  dedupeKey: string;
  payload?: Record<string, unknown>;
  occurredAt?: Date;
}

export const MAX_AUTOMATION_DEPTH = 2;
const MAX_ATTEMPTS = 5;
const LOCK_TTL_MS = 5 * 60_000;

/** Insert an event (outbox). Returns null when the dedupeKey was already emitted. */
export async function emitEvent(tx: Db, input: EmitEventInput) {
  // ON CONFLICT DO NOTHING (skipDuplicates): a duplicate dedupeKey is simply not inserted. A caught unique-violation
  // would instead abort the caller's Postgres transaction, whose COMMIT then silently rolls back all of its work.
  const rows = await tx.domainEvent.createManyAndReturn({
    data: [{
      businessId: input.businessId,
      type: input.type,
      contactId: input.contactId ?? null,
      actorUserId: input.actorUserId ?? null,
      source: input.source ?? "system",
      depth: input.depth ?? 0,
      dedupeKey: input.dedupeKey,
      payload: (input.payload ?? {}) as Prisma.InputJsonValue,
      occurredAt: input.occurredAt ?? new Date(),
    }],
    skipDuplicates: true,
  });
  return rows[0] ?? null;
}

/**
 * Ask for the pending events of a business to be processed after the current
 * response is sent (Next.js `after`). Outside a request scope it runs inline.
 * The minute cron is the safety net if this never runs.
 */
export function kickEventProcessing(businessId: string) {
  const run = () => processDomainEvents({ businessId }).catch((err) => console.error("[events] processing failed", err));
  try {
    after(run);
  } catch {
    void run();
  }
}

function backoffMs(attempt: number) {
  return Math.min(30 * 60_000, 15_000 * 2 ** Math.max(0, attempt - 1));
}

export interface ProcessOptions {
  businessId?: string;
  limit?: number;
  deadline?: number;
}

/** Claim + process pending events. Safe to run concurrently (CAS claim). */
export async function processDomainEvents(opts: ProcessOptions = {}) {
  const deadline = opts.deadline ?? Date.now() + 40_000;
  const now = new Date();
  const limit = opts.limit ?? 25;
  const due: Prisma.DomainEventWhereInput = {
    OR: [
      { status: "pending", OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }] },
      { status: "processing", lockedAt: { lt: new Date(now.getTime() - LOCK_TTL_MS) } },
    ],
  };
  const pick = (businessId: string, take: number) => db.domainEvent.findMany({ where: { ...due, businessId }, orderBy: [{ occurredAt: "asc" }, { id: "asc" }], take, select: { id: true, status: true } });
  let candidates: Array<{ id: string; status: string }>;
  if (opts.businessId) candidates = await pick(opts.businessId, limit);
  else {
    // Fair share across businesses: the businesses with the oldest due events, an equal slice each, interleaved –
    // one business's import or campaign backlog cannot hold back everybody else's events.
    const groups = await db.domainEvent.groupBy({ by: ["businessId"], where: due, _min: { occurredAt: true }, orderBy: { _min: { occurredAt: "asc" } }, take: limit });
    const per = Math.max(1, Math.ceil(limit / Math.max(1, groups.length)));
    const lists = await Promise.all(groups.map((g) => pick(g.businessId, per)));
    candidates = [];
    for (let i = 0; candidates.length < limit && lists.some((l) => l.length > i); i++) for (const l of lists) if (l[i] && candidates.length < limit) candidates.push(l[i]);
  }
  let processed = 0;
  let failed = 0;
  for (const c of candidates) {
    if (Date.now() >= deadline) break;
    const claimed = await db.domainEvent.updateMany({
      where: { id: c.id, status: c.status as "pending" | "processing", ...(c.status === "processing" ? { lockedAt: { lt: new Date(Date.now() - LOCK_TTL_MS) } } : {}) },
      data: { status: "processing", lockedAt: new Date(), attempts: { increment: 1 } },
    });
    if (!claimed.count) continue;
    const event = await db.domainEvent.findUniqueOrThrow({ where: { id: c.id } });
    const result = await withBusiness(event.businessId, () => runHandlers(event));
    processed++;
    if (result.failed) failed++;
  }
  return { processed, failed, candidates: candidates.length };
}

async function runHandlers(event: Prisma.DomainEventGetPayload<object>) {
  const handlers = HANDLERS.filter((h) => h.types.includes(event.type as DomainEventType));
  const done = new Set((await prisma.automationJob.findMany({ where: { eventId: event.id, status: "done" }, select: { handler: true } })).map((j) => j.handler));
  let anyFailed = false;
  let lastError: string | null = null;
  for (const handler of handlers) {
    if (done.has(handler.name)) continue;
    try {
      const result = await handler.run(event);
      await upsertJob({
        where: { eventId_handler: { eventId: event.id, handler: handler.name } },
        create: { businessId: event.businessId, eventId: event.id, handler: handler.name, status: "done", result: (result ?? {}) as Prisma.InputJsonValue, completedAt: new Date() },
        update: { status: "done", result: (result ?? {}) as Prisma.InputJsonValue, error: null, completedAt: new Date() },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") continue; // another worker completed this handler
      anyFailed = true;
      lastError = err instanceof Error ? err.message : String(err);
      console.error(`[events] handler ${handler.name} failed for ${event.type}`, err);
      await upsertJob({
        where: { eventId_handler: { eventId: event.id, handler: handler.name } },
        create: { businessId: event.businessId, eventId: event.id, handler: handler.name, status: "failed", error: lastError.slice(0, 1000) },
        update: { status: "failed", error: lastError.slice(0, 1000) },
      }).catch(() => undefined);
    }
  }
  if (!anyFailed) {
    await db.domainEvent.update({ where: { id: event.id }, data: { status: "done", processedAt: new Date(), lockedAt: null, lastError: null } });
    return { failed: false };
  }
  const exhausted = event.attempts >= MAX_ATTEMPTS;
  await db.domainEvent.update({
    where: { id: event.id },
    data: exhausted
      ? { status: "failed", lockedAt: null, lastError }
      : { status: "pending", lockedAt: null, lastError, nextAttemptAt: new Date(Date.now() + backoffMs(event.attempts)) },
  });
  return { failed: true };
}

/** AutomationJob upsert that survives a concurrent writer (unique event+handler). */
async function upsertJob(args: Parameters<typeof prisma.automationJob.upsert>[0]) {
  try {
    await prisma.automationJob.upsert(args);
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      await prisma.automationJob.update({ where: args.where, data: args.update });
      return;
    }
    throw err;
  }
}

/** Test/ops helper: wait until no pending/processing events remain for a business. */
export async function waitForEvents(businessId: string, timeoutMs = 15_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const open = await db.domainEvent.count({ where: { businessId, status: { in: ["pending", "processing"] } } });
    if (!open) return true;
    await processDomainEvents({ businessId });
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

export type { EventHandler };
