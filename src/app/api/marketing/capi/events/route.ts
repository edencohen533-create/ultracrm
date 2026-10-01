import { z } from "zod";
import { assertCapiAccess } from "@/app/api/marketing/capi/_access";
import { withAuth, parseQuery } from "@/lib/api";
import { ok } from "@/lib/response";
import { prisma } from "@/lib/db";

export const dynamic = "force-dynamic";
/** The log: event, rule, linked record, time, value, status (with the reason), attempts. No identifiers are returned. */
export const GET = withAuth(async ({ req, user }) => { await assertCapiAccess(user, false); 
  const f = parseQuery(req, z.object({ status: z.string().max(20).optional(), cursor: z.string().optional() }));
  const items = await prisma.metaCapiEvent.findMany({ where: { businessId: user.businessId, ...(f.status ? { status: f.status } : {}) }, orderBy: { createdAt: "desc" }, take: 51, ...(f.cursor ? { cursor: { id: f.cursor }, skip: 1 } : {}),
    select: { id: true, eventName: true, eventId: true, occurredAt: true, entityType: true, entityId: true, contactId: true, value: true, currency: true, status: true, statusReason: true, attempts: true, lastError: true, testCode: true, receivedAt: true, fbtraceId: true, createdAt: true, rule: { select: { id: true, name: true } } } });
  const contacts = await prisma.contact.findMany({ where: { id: { in: items.map((i) => i.contactId).filter((x): x is string => Boolean(x)) } }, select: { id: true, fullName: true } });
  return ok({ items: items.slice(0, 50).map((i) => ({ ...i, value: i.value === null ? null : Number(i.value), contactName: contacts.find((c) => c.id === i.contactId)?.fullName ?? null })), next: items.length > 50 ? items[49].id : null });
}, { perm: "crm.marketing_view" });
