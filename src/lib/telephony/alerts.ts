/**
 * Manager alert when calls move between providers or a provider trips: the switch-log row is the in-app record
 * (Settings → Connections); owners and managers linked to the WhatsApp assistant also get a message. Sent once per
 * log row (claimed with notifiedAt) and once per recipient (AssistantDelivery key).
 */
import { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db";

const ALERT_KINDS = new Set(["auto_failover", "auto_recovery", "breaker_open"]);
const NAME: Record<string, string> = { telnyx: "Telnyx", zadarma: "Zadarma", mock: "Simulation" };
const CLASS_HE: Record<string, string> = {
  provider_outage: "תקלה אצל הספק", account: "בעיה בחשבון הספק (יתרה / חסימה / תצורה)", auth: "שגיאת הרשאה – מפתח API שגוי או בוטל",
  timeout: "הספק לא ענה בזמן", rate_limit: "מגבלת קצב", capacity: "מגבלת קיבולת", invalid_request: "בקשה שגויה",
};

export function switchAlertText(log: { kind: string; fromProvider: string | null; toProvider: string | null; reason: string | null }) {
  const from = log.fromProvider ? NAME[log.fromProvider] ?? log.fromProvider : "";
  const to = log.toProvider ? NAME[log.toProvider] ?? log.toProvider : "";
  const cls = (log.reason ?? "").split(":")[0];
  const why = CLASS_HE[cls] ?? log.reason ?? "";
  if (log.kind === "auto_failover") return `⚠️ טלפוניה: שיחות חדשות עוברות מ-${from} לספק הגיבוי ${to}. שיחות פעילות נשארות בספק שלהן.\nסיבה: ${why}`;
  if (log.kind === "auto_recovery") return `✅ טלפוניה: שיחות חדשות חזרו לספק הראשי ${to}.`;
  return `⚠️ טלפוניה: הספק ${from} הושבת זמנית לשיחות חדשות.\nסיבה: ${why}${cls === "auth" || cls === "account" ? "\nנדרשת פעולה בחשבון הספק – זה לא יתוקן מעצמו." : ""}`;
}

export async function notifySwitch(logId: string) {
  const claimed = await prisma.telephonySwitchLog.updateMany({ where: { id: logId, notifiedAt: null, kind: { in: [...ALERT_KINDS] } }, data: { notifiedAt: new Date() } });
  if (!claimed.count) return { skipped: true };
  const log = await prisma.telephonySwitchLog.findUniqueOrThrow({ where: { id: logId } });
  const managers = await prisma.user.findMany({ where: { businessId: log.businessId, isActive: true, role: { in: ["owner", "manager"] } }, select: { id: true } });
  const recipients = managers.map((m) => m.id);
  const delivery: Array<{ to: string; channel: string; status: string; detail?: string }> = recipients.map((to) => ({ to, channel: "app", status: "shown" }));
  const text = switchAlertText(log);
  const links = await prisma.assistantLink.findMany({ where: { businessId: log.businessId, status: "active", userId: { in: recipients } } });
  if (links.length) {
    const { sendToLink } = await import("@/server/assistant/transport");
    for (const link of links) {
      const key = `telephony-switch:${log.id}:${link.id}`;
      try { await prisma.assistantDelivery.create({ data: { businessId: log.businessId, key, kind: "telephony_switch", status: "pending", linkId: link.id } }); }
      catch (e) { if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") continue; throw e; }
      const r = await sendToLink(link, text, { title: "התראת טלפוניה" }).catch((e: Error) => ({ status: "failed" as const, detail: e.message.slice(0, 200) }));
      await prisma.assistantDelivery.updateMany({ where: { businessId: log.businessId, key }, data: { status: r.status, detail: r.detail ?? null } });
      delivery.push({ to: link.userId, channel: "whatsapp", status: r.status, detail: r.detail });
    }
  }
  await prisma.telephonySwitchLog.update({ where: { id: log.id }, data: { delivery: delivery as Prisma.InputJsonValue } });
  return { recipients: recipients.length, whatsapp: links.length };
}

/** Send after the response when running inside a request; inline otherwise (tests, cron). Never throws. */
export async function queueSwitchAlert(logId: string) {
  const run = () => notifySwitch(logId).catch((e: Error) => console.error("[telephony] switch alert failed", e.message));
  try {
    const { after } = await import("next/server");
    after(run);
  } catch {
    await run();
  }
}
