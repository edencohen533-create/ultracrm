import { Prisma } from "@/generated/prisma/client";
import { prisma, dbSchema } from "@/lib/db";
import { visibleUserIds, type SessionUser } from "@/lib/auth";
import { getBusinessSettings } from "@/lib/settings";
import { ApiError } from "@/lib/response";
const table = (name: string) => Prisma.raw(`"${dbSchema()}"."${name}"`);
export async function salesDiagnostics(user: SessionUser, now = new Date()) {
  if (user.role === "agent")
    throw new ApiError("הדוח זמין למנהלים", 403, "forbidden");
  const ids = await visibleUserIds(user),
    settings = await getBusinessSettings(user.businessId);
  const cutoff = new Date(now.getTime() - 7 * 86400000),
    start = new Date(now.getTime() - 14 * 86400000);
  const scope = ids ? Prisma.sql`AND c.user_id = ANY(${ids})` : Prisma.empty;
  const rows = await prisma.$queryRaw<
    Array<{
      dimension: string;
      label: string;
      recent: boolean;
      attempts: number;
      answered: number;
      failedBeforeDial: number;
    }>
  >(Prisma.sql`
 WITH calls AS (
 SELECT c.*, COALESCE(c.lead_dialed_at,c.created_at) AS event_at,
 COALESCE((SELECT l.source FROM ${table("leads")} l WHERE l.business_id=c.business_id AND l.contact_id=c.contact_id AND l.created_at<=c.created_at ORDER BY l.created_at DESC,l.id DESC LIMIT 1),'ללא מקור') AS lead_source
 FROM ${table("calls")} c WHERE c.business_id=${user.businessId} ${scope} AND c.direction='outbound' AND c.ended_at IS NOT NULL
 AND COALESCE(c.lead_dialed_at,c.created_at)>=${start} AND COALESCE(c.lead_dialed_at,c.created_at)<${now}
 ), dimensions AS (
 SELECT c.*, d.dimension,d.label FROM calls c CROSS JOIN LATERAL (VALUES
 ('caller',COALESCE(NULLIF(c.from_e164,''),'ללא מספר')),
 ('source',c.lead_source),
 ('hour',to_char(timezone(${settings.timezone},timezone('UTC',c.event_at)),'HH24:00'))
 ) d(dimension,label)
 ) SELECT dimension,label,event_at>=${cutoff} AS recent,
 count(*) FILTER(WHERE lead_dialed_at IS NOT NULL)::int AS attempts,
 count(*) FILTER(WHERE lead_dialed_at IS NOT NULL AND answered_at IS NOT NULL)::int AS answered,
 count(*) FILTER(WHERE lead_dialed_at IS NULL AND (failure_reason IS NOT NULL OR status='failed'))::int AS "failedBeforeDial"
 FROM dimensions GROUP BY dimension,label,recent ORDER BY dimension,label`);
  const grouped = new Map<
    string,
    {
      dimension: string;
      label: string;
      current: { attempts: number; answered: number; failedBeforeDial: number };
      previous: {
        attempts: number;
        answered: number;
        failedBeforeDial: number;
      };
    }
  >();
  for (const row of rows) {
    const key = JSON.stringify([row.dimension, row.label]);
    const r = grouped.get(key) ?? {
      dimension: row.dimension,
      label: row.label,
      current: { attempts: 0, answered: 0, failedBeforeDial: 0 },
      previous: { attempts: 0, answered: 0, failedBeforeDial: 0 },
    };
    r[row.recent ? "current" : "previous"] = {
      attempts: row.attempts,
      answered: row.answered,
      failedBeforeDial: row.failedBeforeDial,
    };
    grouped.set(key, r);
  }
  const results = [...grouped.values()].map((r) => {
    const currentRate = r.current.attempts
        ? r.current.answered / r.current.attempts
        : null,
      previousRate = r.previous.attempts
        ? r.previous.answered / r.previous.attempts
        : null;
    const enough = r.current.attempts >= 20 && r.previous.attempts >= 20;
    return {
      ...r,
      currentRate,
      previousRate,
      drop:
        enough &&
        currentRate !== null &&
        previousRate !== null &&
        previousRate - currentRate >= 0.15,
      sufficientSample: enough,
    };
  });
  const recScope = ids ? Prisma.sql`AND agent_id=ANY(${ids})` : Prisma.empty;
  const sla = await prisma.$queryRaw<
    Array<{ status: string; count: number; met: number }>
  >(
    Prisma.sql`SELECT status,count(*)::int AS count,count(*) FILTER(WHERE result->>'met'='true')::int AS met FROM ${table("ops_recommendations")} WHERE business_id=${user.businessId} ${recScope} AND kind='lead_response_sla' AND created_at>=${start} GROUP BY status`,
  );
  return {
    from: start.toISOString(),
    split: cutoff.toISOString(),
    to: now.toISOString(),
    timezone: settings.timezone,
    rows: results,
    sla,
    definitions: {
      period: "7 הימים האחרונים לעומת 7 הקודמים; שיחות שהסתיימו בלבד",
      rate: "שיחות שנענו מתוך ניסיונות חיוג בפועל. ניסיונות חוזרים נספרים בנפרד.",
      alert:
        "ירידה של 15 נקודות אחוז לפחות, ורק כשיש 20 ניסיונות בכל תקופה. זה סימן לבדיקה, לא הוכחה לסיבה.",
      source:
        "מקור הליד שהיה קיים בעת השיחה, כפי שהוא שמור כעת; עריכת המקור עשויה לשנות את ההשוואה.",
      reputation:
        "הדוח אינו קובע שמספר מסומן כספאם. לשם כך נדרש נתון חיצוני מאומת.",
    },
  };
}
