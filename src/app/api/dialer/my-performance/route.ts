import { withAuth } from "@/lib/api";
import { ok } from "@/lib/response";
import { prisma } from "@/lib/db";
import { businessDayStart } from "@/lib/business-day";

export const dynamic = "force-dynamic";

/**
 * "הביצועים שלי" on the dialer screen – today's numbers for the signed-in agent only (business day, business timezone).
 * Every number comes from real rows: tasks (callbacks), deals (won today), calls (first-ever contact, answered/total, talk time).
 */
export const GET = withAuth(async ({ user }) => {
  const businessId = user.businessId;
  const biz = await prisma.business.findUnique({ where: { id: businessId }, select: { timezone: true } });
  const dayStart = businessDayStart(biz?.timezone ?? "Asia/Jerusalem");
  const dayEnd = new Date(dayStart.getTime() + 86400_000);
  const me = user.id;
  const [callbacksDone, callbacksOpen, dealsWon, calls] = await Promise.all([
    prisma.task.count({ where: { businessId, userId: me, type: "callback", status: "done", doneAt: { gte: dayStart } } }),
    prisma.task.count({ where: { businessId, userId: me, type: "callback", status: "open", dueAt: { lt: dayEnd } } }),
    prisma.deal.count({ where: { businessId, ownerUserId: me, stage: "won", closedAt: { gte: dayStart } } }),
    prisma.call.findMany({ where: { businessId, userId: me, createdAt: { gte: dayStart } }, select: { contactId: true, answeredAt: true, talkSeconds: true } }),
  ]);
  const contactIds = [...new Set(calls.map((c) => c.contactId).filter((x): x is string => Boolean(x)))];
  const seenBefore = contactIds.length
    ? new Set((await prisma.call.groupBy({ by: ["contactId"], where: { businessId, contactId: { in: contactIds }, createdAt: { lt: dayStart } } })).map((g) => g.contactId))
    : new Set<string | null>();
  const newCustomerCalls = contactIds.filter((id) => !seenBefore.has(id)).length;
  const answered = calls.filter((c) => c.answeredAt).length;
  const talkSeconds = calls.reduce((s, c) => s + (c.talkSeconds ?? 0), 0);
  return ok({
    followUps: { done: callbacksDone, total: callbacksDone + callbacksOpen },
    dealsWon,
    newCustomerCalls,
    calls: { answered, total: calls.length },
    talkSeconds,
    dayStart,
  });
}, { module: "telephony" });
