import { z } from "zod";
import { withAuth, parseQuery } from "@/lib/api";
import { ok, ApiError } from "@/lib/response";
import { prisma } from "@/lib/db";
import { listQueueStats } from "@/lib/dialer/queue";
import { OUTCOME_BY_KEY } from "@/lib/outcomes";

export const dynamic = "force-dynamic";

/** Real numbers for one dialer session (shown when a list runs out or the agent ends the session). */
export const GET = withAuth(async ({ req, user }) => {
  const { sessionId } = parseQuery(req, z.object({ sessionId: z.string() }));
  const s = await prisma.dialerSession.findFirst({ where: { id: sessionId, userId: user.id } });
  if (!s) throw new ApiError("סשן לא נמצא", 404, "not_found");
  const calls = await prisma.call.findMany({ where: { sessionId: s.id }, select: { answeredAt: true, talkSeconds: true, outcome: true, ringingAt: true, createdAt: true, endedAt: true, outcomeSavedAt: true } });
  const outcomes: Record<string, number> = {};
  for (const c of calls) if (c.outcome) outcomes[c.outcome] = (outcomes[c.outcome] ?? 0) + 1;
  const connected = calls.filter((c) => c.answeredAt);
  const wrap = calls.filter((c) => c.endedAt && c.outcomeSavedAt).map((c) => (c.outcomeSavedAt!.getTime() - c.endedAt!.getTime()) / 1000);
  const queue = s.listId ? await listQueueStats(s.listId) : null;
  return ok({
    session: { id: s.id, mode: s.mode, status: s.status, startedAt: s.startedAt, endedAt: s.endedAt, dialsCount: s.dialsCount },
    dials: calls.length,
    connected: connected.length,
    talkSeconds: connected.reduce((a, c) => a + (c.talkSeconds ?? 0), 0),
    avgWrapUpSeconds: wrap.length ? Math.round(wrap.reduce((a, b) => a + b, 0) / wrap.length) : 0,
    outcomes: Object.entries(outcomes).map(([k, v]) => ({ key: k, label: OUTCOME_BY_KEY[k as keyof typeof OUTCOME_BY_KEY]?.label ?? k, count: v })),
    queue,
  });
});
