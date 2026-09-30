import { prisma } from "@/lib/db";
import { parseSettings } from "./settings";

/**
 * When an external CRM decides assignment, automatic dialing of its records waits while its data can't be trusted:
 * the connection is disconnected / failing, or nothing was confirmed from it within the freshness window. Returns the
 * reason (Hebrew) or null. Same rule as the queue SQL filter in src/lib/dialer/queue.ts.
 */
export async function externalFreshnessBlock(businessId: string, contactId: string): Promise<string | null> {
  const links = await prisma.externalRecordLink.findMany({ where: { businessId, recordType: "contact", localId: contactId, deletedAt: null }, select: { connectionId: true } });
  if (!links.length) return null;
  const conns = await prisma.crmConnection.findMany({ where: { businessId, id: { in: links.map((l) => l.connectionId) } } });
  for (const c of conns) {
    const s = parseSettings(c.settings);
    if (s.ownerAuthority !== "external") continue;
    if (c.status === "disconnected") return `החיבור ל-CRM החיצוני "${c.name}" מנותק – חיוג אוטומטי לרשומות שלו מושהה עד חיבור מחדש`;
    if (c.status !== "active") return `החיבור ל-CRM החיצוני "${c.name}" בתקלה – לא ניתן לאמת שיוך, חיוג אוטומטי מושהה`;
    if (!c.lastSyncAt || Date.now() - c.lastSyncAt.getTime() > s.freshnessMinutes * 60_000) return `המידע מ-CRM החיצוני "${c.name}" אינו עדכני (מעל ${s.freshnessMinutes} דקות) – חיוג אוטומטי מושהה עד סנכרון`;
  }
  return null;
}
