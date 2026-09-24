/**
 * Transparent lead scoring. The SQL expression and the JS explanation are kept
 * side by side so what the queue does and what the agent is told never drift.
 */
import { Prisma } from "@/generated/prisma/client";
import { dbSchema } from "@/lib/db";
import type { PrioritizationWeights } from "@/lib/settings";

/** ORDER BY expression for the claim query. `l` = list_leads, `c` = contacts. */
export function scoreSql(w: PrioritizationWeights, userId: string) {
  const S = dbSchema();
  const E = Prisma.raw(`"${S}"."LeadStatus"`);
  const O = Prisma.raw(`"${S}"."OutcomeKey"`);
  const sourceCase =
    Object.keys(w.sourceWeights).length === 0
      ? Prisma.sql`0`
      : Prisma.sql`(CASE ${Prisma.join(
          Object.entries(w.sourceWeights).map(([src, wt]) => Prisma.sql`WHEN c.source = ${src} THEN ${Number(wt)}::float`),
          " ",
        )} ELSE 0 END)`;
  return Prisma.sql`(
      (CASE WHEN l.status = 'callback'::${E} THEN ${w.callbackDue}::float ELSE 0 END)
    + l.priority * ${w.priority}::float
    + (CASE WHEN l.attempts = 0 THEN LEAST(EXTRACT(EPOCH FROM (timezone('UTC', now()) - l.created_at)) / 3600.0, ${w.newLeadMaxHours}::float) * ${w.newLeadPerHour}::float ELSE 0 END)
    + LEAST(EXTRACT(EPOCH FROM (timezone('UTC', now()) - COALESCE(l.last_attempt_at, l.created_at))) / 3600.0, ${w.agingMaxHours}::float) * ${w.agingPerHour}::float
    - l.attempts * ${w.attemptPenalty}::float
    + (CASE WHEN c.owner_user_id = ${userId} THEN ${w.ownerMatch}::float ELSE 0 END)
    + (CASE WHEN l.last_outcome = 'answered_interested'::${O} THEN ${w.interestedBefore}::float ELSE 0 END)
    + ${sourceCase}
  )`;
}

export interface ScoredLeadInput {
  status: string;
  priority: number;
  attempts: number;
  createdAt: Date;
  lastAttemptAt: Date | null;
  lastOutcome: string | null;
  nextAttemptAt: Date | null;
  contact: { source: string | null; ownerUserId: string | null };
}

/** Same formula in JS, returning the score and the reasons that contributed. */
export function explainScore(w: PrioritizationWeights, lead: ScoredLeadInput, userId: string, now = new Date()) {
  const reasons: string[] = [];
  let score = 0;
  const hours = (d: Date) => (now.getTime() - d.getTime()) / 3600_000;
  const wasCallback = lead.status === "callback" || (lead.lastOutcome === "callback" && lead.nextAttemptAt !== null);
  if (wasCallback) {
    score += w.callbackDue;
    const overdueMin = lead.nextAttemptAt ? Math.round((now.getTime() - lead.nextAttemptAt.getTime()) / 60000) : 0;
    reasons.push(overdueMin > 60 ? `חזרה שנקבעה – באיחור של ${Math.round(overdueMin / 60)} שע׳` : "חזרה שנקבעה להיום");
  }
  if (lead.priority > 0) {
    score += lead.priority * w.priority;
    reasons.push(`עדיפות ${lead.priority}`);
  }
  if (lead.attempts === 0) {
    const h = Math.min(hours(lead.createdAt), w.newLeadMaxHours);
    score += h * w.newLeadPerHour;
    reasons.push(h < 1 ? "ליד חדש (פחות משעה)" : h < 24 ? `ליד חדש (לפני ${Math.round(h)} שע׳)` : `ליד חדש (לפני ${Math.round(h / 24)} ימים)`);
  } else {
    const h = Math.min(hours(lead.lastAttemptAt ?? lead.createdAt), w.agingMaxHours);
    score += h * w.agingPerHour;
    if (h >= 24) reasons.push(`ממתין ${Math.round(h / 24)} ימים מהניסיון האחרון`);
    score -= lead.attempts * w.attemptPenalty;
    reasons.push(`ניסיון ${lead.attempts + 1}`);
  }
  if (lead.contact.ownerUserId === userId) {
    score += w.ownerMatch;
    reasons.push("הליד שלך");
  }
  if (lead.lastOutcome === "answered_interested") {
    score += w.interestedBefore;
    reasons.push("הביע עניין בשיחה קודמת");
  }
  const src = lead.contact.source ? w.sourceWeights[lead.contact.source] : undefined;
  if (src) {
    score += src;
    reasons.push(`מקור ${lead.contact.source} (+${src})`);
  }
  return { score: Math.round(score * 100) / 100, reason: reasons.slice(0, 3).join(" · ") || "לפי סדר הכניסה" };
}
