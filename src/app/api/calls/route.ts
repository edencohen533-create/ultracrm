import { z } from "zod";
import { withAuth, parseQuery } from "@/lib/api";
import { ok } from "@/lib/response";
import { prisma } from "@/lib/db";
import { visibleUserIds } from "@/lib/auth";
import { phoneDigits } from "@/lib/phone";
import type { Prisma } from "@/generated/prisma/client";
import { getBusinessSettings } from "@/lib/settings";
import { zonedDateTime } from "@/lib/business-day";
import { addDays } from "@/lib/reports/compare";

const DAY = /^\d{4}-\d{2}-\d{2}$/;

export const dynamic = "force-dynamic";

const q = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  userId: z.string().optional(),
  listId: z.string().optional(),
  contactId: z.string().optional(),
  /** Business-local days (YYYY-MM-DD, inclusive) – the same day boundaries the reports use. */
  fromDate: z.string().regex(DAY).optional(),
  toDate: z.string().regex(DAY).optional(),
  /** The report metric a link came from: outbound = placed outbound calls (agent leg), answered = of those, answered. */
  metric: z.enum(["outbound", "answered"]).optional(),
  outcome: z.string().optional(),
  telephonyResult: z.string().optional(),
  q: z.string().max(100).optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

/** Call history (חייגן → היסטוריית שיחות) with cursor paging. Visibility follows the user's data scope (agent: own calls). */
export const GET = withAuth(async ({ req, user }) => {
  const f = parseQuery(req, q);
  const visible = await visibleUserIds(user);
  const where: Prisma.CallWhereInput = { businessId: user.businessId };
  if (visible) where.userId = { in: visible };
  if (f.userId) where.userId = visible && !visible.includes(f.userId) ? "__none__" : f.userId;
  if (f.listId) where.listId = f.listId;
  if (f.outcome) where.outcome = f.outcome as Prisma.CallWhereInput["outcome"];
  if (f.telephonyResult) where.telephonyResult = f.telephonyResult as Prisma.CallWhereInput["telephonyResult"];
  if (f.contactId) where.contactId = f.contactId;
  if (f.metric) { where.direction = "outbound"; where.agentLegId = { not: null }; if (f.metric === "answered") where.answeredAt = { not: null }; }
  if (f.fromDate || f.toDate) {
    const tz = (await getBusinessSettings(user.businessId)).timezone;
    const gte = f.fromDate ? zonedDateTime(tz, f.fromDate, "00:00") : null;
    const lt = f.toDate ? zonedDateTime(tz, addDays(f.toDate, 1), "00:00") : null;
    where.createdAt = { ...(gte ? { gte } : {}), ...(lt ? { lt } : {}) };
  } else if (f.from || f.to) where.createdAt = { ...(f.from ? { gte: new Date(f.from) } : {}), ...(f.to ? { lte: new Date(f.to) } : {}) };
  if (f.q) {
    const d = phoneDigits(f.q);
    where.OR = [{ contact: { fullName: { contains: f.q, mode: "insensitive" } } }, ...(d.length >= 3 ? [{ toE164: { contains: d.replace(/^0/, "") } }] : [])];
  }
  const items = await prisma.call.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: f.limit + 1,
    ...(f.cursor ? { cursor: { id: f.cursor }, skip: 1 } : {}),
    select: {
      id: true, createdAt: true, answeredAt: true, endedAt: true, talkSeconds: true, status: true, telephonyResult: true, outcome: true, statusDef: { select: { label: true } }, outcomeNote: true, callbackAt: true,
      recordingStatus: true, recordingPurgedAt: true, mode: true, direction: true, toE164: true, fromE164: true, hangupCause: true,
      coachSession: { select: { documentationStatus: true } },
      user: { select: { id: true, fullName: true } }, contact: { select: { id: true, fullName: true } }, list: { select: { id: true, name: true } },
    },
  });
  const nextCursor = items.length > f.limit ? items[f.limit - 1].id : null;
  return ok({ items: items.slice(0, f.limit), nextCursor });
}, { perm: "telephony.use" });
