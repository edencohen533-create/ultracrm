/**
 * Proactive assistant messages (runs in the automations cron, inside the business scope):
 * daily summary, weekly summary, untreated-lead alert and sales-goal alert.
 * Every send is claimed first with a unique AssistantDelivery key, so overlapping cron runs never send twice.
 * Outside the 24h service window the transport uses the approved template (or keeps the report for the next reply).
 */
import { prisma } from "@/lib/db";
import { Prisma, type AssistantLink } from "@/generated/prisma/client";
import { getBusinessSettings, type AssistantSettings } from "@/lib/settings";
import { localParts } from "./periods";
import { runTool, type ToolCtx } from "./tools";
import { fmtAgents, fmtSnapshot } from "./format";
import { toolCtxFor } from "./inbound";
import { sendToLink } from "./transport";

const toMin = (hhmm: string) => { const [h, m] = hhmm.split(":").map(Number); return (h || 0) * 60 + (m || 0); };
const pad = (v: number) => String(v).padStart(2, "0");
/** Scheduled time reached today and not more than 3 hours ago (a late cron still sends, a stale one does not). */
const due = (nowMin: number, hhmm: string) => nowMin >= toMin(hhmm) && nowMin < toMin(hhmm) + 180;

async function claim(businessId: string, key: string, linkId: string, kind: string) {
  try { return await prisma.assistantDelivery.create({ data: { businessId, key, linkId, kind, status: "pending" } }); }
  catch (e) { if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") return null; throw e; }
}

async function deliver(link: AssistantLink, deliveryId: string, kind: string, title: string, text: string) {
  let status = "failed", detail: string | undefined;
  try {
    const r = await sendToLink(link, text, { title });
    status = r.status; detail = r.detail;
    // No window and no approved template: keep the report so it goes out the moment the owner writes.
    if (r.status === "skipped") await prisma.assistantLink.update({ where: { id: link.id }, data: { pendingReport: text.slice(0, 8000) } });
  } catch (e) { detail = (e as Error).message.slice(0, 200); }
  await prisma.assistantDelivery.update({ where: { id: deliveryId }, data: { status, detail: detail ?? null } });
  await prisma.assistantMessage.create({ data: { businessId: link.businessId, linkId: link.id, direction: "out", text: text.slice(0, 4000), intent: kind, tools: [], status: status === "sent" ? "ok" : status, error: detail ?? null, model: "scheduler" } });
  return status === "sent" || status === "template";
}

async function recipients(businessId: string, s: AssistantSettings) {
  const links = await prisma.assistantLink.findMany({ where: { businessId, status: "active" } });
  return s.recipients.length ? links.filter((l) => s.recipients.includes(l.id)) : links.filter((l) => l.scope === "business");
}

async function tool<T>(ctx: ToolCtx, name: string, args: Record<string, unknown>): Promise<T | null> {
  const r = await runTool(ctx, name, args);
  return r.ok ? (r.result as T) : null; // a failed query sends nothing rather than a report full of zeros
}

export async function processAssistantSchedules(businessId: string, now = new Date()): Promise<{ processed: number }> {
  const settings = await getBusinessSettings(businessId);
  const s = settings.assistant;
  if (!s.enabled || s.paused) return { processed: 0 };
  // Reports go out over the business's WhatsApp connection.
  const { businessCanUse } = await import("@/lib/access/engine");
  if (!(await businessCanUse(businessId, "whatsapp"))) return { processed: 0 };
  const tz = settings.timezone;
  const p = localParts(tz, now);
  const date = `${p.y}-${pad(p.m)}-${pad(p.d)}`;
  const nowMin = p.h * 60 + p.mi;
  let processed = 0;

  for (const link of await recipients(businessId, s)) {
    const ctx = await toolCtxFor(link, tz);
    if (!ctx) continue;
    ctx.now = now;

    if (s.daily.enabled && s.daily.days.includes(p.wd) && due(nowMin, s.daily.time)) {
      const d = await claim(businessId, `daily:${date}:${link.id}`, link.id, "daily");
      if (d) {
        const snap = await tool<Parameters<typeof fmtSnapshot>[0]>(ctx, "business_snapshot", { period: "today" });
        if (snap && (await deliver(link, d.id, "daily", "סיכום יומי", `🗓️ סיכום יומי\n${fmtSnapshot(snap, tz)}`))) processed++;
        else if (!snap) await prisma.assistantDelivery.update({ where: { id: d.id }, data: { status: "failed", detail: "שליפת הנתונים נכשלה" } });
      }
    }

    if (s.weekly.enabled && s.weekly.day === p.wd && due(nowMin, s.weekly.time)) {
      const d = await claim(businessId, `weekly:${date}:${link.id}`, link.id, "weekly");
      if (d) {
        const [snap, agents] = await Promise.all([tool<Parameters<typeof fmtSnapshot>[0]>(ctx, "business_snapshot", { period: "last_7_days" }), tool<Parameters<typeof fmtAgents>[0]>(ctx, "agents_performance", { period: "last_7_days" })]);
        if (snap) { if (await deliver(link, d.id, "weekly", "סיכום שבועי", ["📅 סיכום שבועי", fmtSnapshot(snap, tz), ...(agents?.agents.length ? ["", fmtAgents(agents, tz)] : [])].join("\n"))) processed++; }
        else await prisma.assistantDelivery.update({ where: { id: d.id }, data: { status: "failed", detail: "שליפת הנתונים נכשלה" } });
      }
    }

    if (s.untreatedAlert.enabled && s.untreatedAlert.minutes > 0) {
      const cutoff = new Date(now.getTime() - s.untreatedAlert.minutes * 60_000);
      const ids = ctx.scope === "own" ? [ctx.userId] : ctx.visibleIds;
      // Only leads that crossed the threshold in the last 24h – enabling the alert does not flood old backlog.
      const leads = await prisma.lead.findMany({ where: { businessId, status: "new", createdAt: { lte: cutoff, gte: new Date(cutoff.getTime() - 86400_000) }, ...(ids ? { OR: [{ ownerUserId: { in: ids } }, { ownerUserId: null }] } : {}) }, orderBy: { createdAt: "asc" }, take: 20, select: { id: true, createdAt: true, contact: { select: { fullName: true } }, owner: { select: { fullName: true } } } });
      const fresh: typeof leads = [];
      let first: { id: string } | null = null;
      for (const l of leads) { const c = await claim(businessId, `untreated:${l.id}:${link.id}`, link.id, "untreated"); if (c) { fresh.push(l); first ??= c; } }
      if (fresh.length && first) {
        const lines = [`⏳ התראה: ${fresh.length} לידים ממתינים יותר מ-${s.untreatedAlert.minutes} דקות בלי טיפול`, ...fresh.slice(0, 8).map((l) => `• ${l.contact.fullName} – ${l.owner?.fullName ?? "ללא שיוך"} (${Math.round((now.getTime() - l.createdAt.getTime()) / 60000)} דק׳)`), ...(fresh.length > 8 ? [`ועוד ${fresh.length - 8}…`] : [])];
        if (await deliver(link, first.id, "untreated", "לידים ממתינים לטיפול", lines.join("\n"))) processed++;
      }
    }

    if (s.salesGoal.enabled && s.salesGoal.amount > 0) {
      const period = s.salesGoal.period === "month" ? "this_month" : "today";
      const r = await tool<{ revenueRecorded: Array<{ amount: number }> }>(ctx, "sales_summary", { period });
      const total = r ? r.revenueRecorded.reduce((a, x) => a + x.amount, 0) : null;
      if (total !== null && total >= s.salesGoal.amount) {
        const d = await claim(businessId, `goal:${s.salesGoal.period}:${s.salesGoal.period === "month" ? date.slice(0, 7) : date}:${s.salesGoal.amount}:${link.id}`, link.id, "goal");
        if (d && (await deliver(link, d.id, "goal", "יעד המכירות הושג", `🎯 יעד המכירות ${s.salesGoal.period === "month" ? "החודשי" : "היומי"} הושג!\nנרשמו ₪${total.toLocaleString("he-IL")} מתוך יעד של ₪${s.salesGoal.amount.toLocaleString("he-IL")} (הכנסות שנרשמו מעסקאות שנסגרו).`))) processed++;
      }
    }
  }
  // Recurring summaries users asked for in free text.
  const { deliverScheduledReports } = await import("./subscriptions");
  processed += await deliverScheduledReports(businessId, now).catch((e: Error) => { console.error("custom reports failed", { businessId, error: e.message }); return 0; });
  return { processed };
}
