import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getBusinessSettings } from "@/lib/settings";
import { getTelephony } from "@/lib/telephony";
import { audit } from "@/lib/audit";

export const dynamic = "force-dynamic";

/**
 * Scheduled job (Vercel Cron, see vercel.json): enforce each business's recording
 * retention policy and end sessions that have been silent for hours.
 * Protected by CRON_SECRET (Vercel sets the Authorization header automatically).
 */
export async function GET(req: NextRequest) {
  // Always protected: without a configured secret the job refuses to run (never open to anonymous callers).
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const telephony = getTelephony();
  const businesses = await prisma.business.findMany({ select: { id: true } });
  const report: Record<string, { recordingsDeleted: number; staleSessionsEnded: number }> = {};
  for (const b of businesses) {
    const settings = await getBusinessSettings(b.id);
    let recordingsDeleted = 0;
    if (settings.recordingRetentionDays > 0) {
      const cutoff = new Date(Date.now() - settings.recordingRetentionDays * 86400_000);
      const calls = await prisma.call.findMany({ where: { businessId: b.id, recordingStatus: "saved", recordingId: { not: null }, createdAt: { lt: cutoff } }, select: { id: true, recordingId: true }, take: 200 });
      for (const c of calls) {
        let deleted = telephony.simulation;
        if (!telephony.simulation && c.recordingId) {
          try {
            const res = await fetch(`https://api.telnyx.com/v2/recordings/${encodeURIComponent(c.recordingId)}`, { method: "DELETE", headers: { Authorization: `Bearer ${process.env.TELNYX_API_KEY}` } });
            deleted = res.ok || res.status === 404;
          } catch {
            deleted = false;
          }
        }
        if (deleted) {
          await prisma.call.update({ where: { id: c.id }, data: { recordingStatus: "none", recordingId: null } });
          recordingsDeleted++;
        }
      }
      if (recordingsDeleted) await audit(b.id, null, "automation", b.id, "automation.recordings_purged", { trigger: "cron", count: recordingsDeleted, retentionDays: settings.recordingRetentionDays, result: "ok" });
    }
    const stale = await prisma.dialerSession.updateMany({ where: { businessId: b.id, status: { in: ["active", "paused"] }, lastHeartbeatAt: { lt: new Date(Date.now() - 6 * 3600_000) } }, data: { status: "ended", endedAt: new Date() } });
    report[b.id] = { recordingsDeleted, staleSessionsEnded: stale.count };
  }
  return NextResponse.json({ ok: true, report });
}
