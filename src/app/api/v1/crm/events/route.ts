import { z } from "zod";
import { ApiError } from "@/lib/response";
import { prisma } from "@/lib/db";
import { withIntegration } from "@/server/crm-sync/public-api";

export const dynamic = "force-dynamic";
const TYPES = ["call.outcome_saved", "call.summary_ready", "message.received", "message.sent", "task.created", "contact.suppressed", "lead.status_changed"];

/**
 * Our events for records of this connection (calls, AI summaries, messages, follow-ups, blocks, status changes),
 * oldest first, cursor paging (`after` = the last event id you processed). Each event carries its stable id – safe
 * to reprocess. Content is limited to what the business allows (no message bodies / recordings).
 */
export async function GET(req: Request) {
  return withIntegration(req, "events:read", async (a) => {
    const q = z.object({ after: z.string().max(64).optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }).safeParse(Object.fromEntries(new URL(req.url).searchParams));
    if (!q.success) throw new ApiError("פרמטרים לא תקינים", 400, "validation");
    const links = await prisma.externalRecordLink.findMany({ where: { businessId: a.business.id, connectionId: a.connection.id, recordType: "contact", localId: { not: null }, deletedAt: null }, select: { localId: true, externalId: true } });
    const byContact = new Map(links.map((l) => [l.localId!, l.externalId]));
    const after = q.data.after ? await prisma.domainEvent.findFirst({ where: { id: q.data.after, businessId: a.business.id }, select: { createdAt: true, id: true } }) : null;
    if (q.data.after && !after) throw new ApiError("סמן (after) לא מוכר", 400, "invalid_cursor");
    const rows = await prisma.domainEvent.findMany({
      where: { businessId: a.business.id, type: { in: TYPES }, contactId: { in: [...byContact.keys()] }, ...(after ? { OR: [{ createdAt: { gt: after.createdAt } }, { createdAt: after.createdAt, id: { gt: after.id } }] } : {}) },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }], take: q.data.limit + 1, select: { id: true, type: true, occurredAt: true, createdAt: true, contactId: true, payload: true },
    });
    const items = rows.slice(0, q.data.limit).map((e) => {
      const p = (e.payload ?? {}) as Record<string, unknown>;
      // Only non-sensitive fields: ids, outcome / status keys, timing. Message text and recordings never leave this way.
      const data = Object.fromEntries(Object.entries(p).filter(([k]) => ["callId", "outcome", "leadId", "from", "to", "taskId", "scope", "channel", "direction", "source", "talkSeconds"].includes(k)));
      return { id: e.id, type: e.type, occurredAt: e.occurredAt, contactExternalId: e.contactId ? byContact.get(e.contactId) ?? null : null, data };
    });
    return { items, nextCursor: rows.length > q.data.limit ? items[items.length - 1].id : null };
  });
}
