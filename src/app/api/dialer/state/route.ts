import { withAuth, parseQuery } from "@/lib/api";
import { z } from "zod";
import { ok } from "@/lib/response";
import { prisma } from "@/lib/db";
import { telephonyStatus } from "@/lib/telephony";
import { currentSession, reapStaleSessions } from "@/lib/dialer/session";
import { currentLockedLead, listQueueStats } from "@/lib/dialer/queue";
import { activeCallFor, pendingWrapUpFor } from "@/lib/dialer/calls";
import { getBusinessSettings } from "@/lib/settings";
import { activeMonitorFor } from "@/lib/dialer/monitor";

export const dynamic = "force-dynamic";

const q = z.object({ browserSessionId: z.string().optional() });

/** Single poll endpoint for the agent workspace. */
export const GET = withAuth(async ({ req, user }) => {
  const { browserSessionId } = parseQuery(req, q);
  if (Math.random() < 0.1) await reapStaleSessions(user.businessId).catch(() => 0);

  const [session, lead, activeCall, settings, me] = await Promise.all([
    currentSession(user.id),
    currentLockedLead(user.id),
    activeCallFor(user.id),
    getBusinessSettings(user.businessId),
    prisma.user.findUnique({ where: { id: user.id }, select: { presence: true, sipUsername: true } }),
  ]);
  const wrapUp = activeCall ? null : await pendingWrapUpFor(user.id);
  const monitor = user.role === "agent" ? null : await activeMonitorFor(user.id);
  // Presence of the browser: the poll itself proves the tab is alive (throttled write).
  await prisma.user.updateMany({ where: { id: user.id, OR: [{ lastSeenAt: null }, { lastSeenAt: { lt: new Date(Date.now() - 20_000) } }] }, data: { lastSeenAt: new Date() } });
  const queue = session?.listId ? await listQueueStats(session.listId) : null;
  const script = lead?.list.scriptId
    ? await prisma.script.findFirst({ where: { id: lead.list.scriptId, businessId: user.businessId }, select: { id: true, title: true, body: true } })
    : await prisma.script.findFirst({ where: { businessId: user.businessId, isDefault: true }, select: { id: true, title: true, body: true } });
  const draft = lead ? await prisma.noteDraft.findUnique({ where: { userId_contactId: { userId: user.id, contactId: lead.contactId } }, select: { body: true } }) : null;

  return ok({
    now: new Date().toISOString(),
    session: session
      ? { ...session, ownedByThisTab: browserSessionId ? session.browserSessionId === browserSessionId : null }
      : null,
    lead,
    activeCall,
    wrapUpCall: wrapUp,
    monitor,
    presence: me?.presence ?? "offline",
    sipUsername: me?.sipUsername ?? null,
    queue,
    script,
    draft: draft?.body ?? null,
    settings: { wrapUpSeconds: settings.wrapUpSeconds, autoDialCountdownSeconds: settings.autoDialCountdownSeconds, lockTtlSeconds: settings.lockTtlSeconds, dialWindow: settings.dialWindow },
    telephony: telephonyStatus(),
  });
});
