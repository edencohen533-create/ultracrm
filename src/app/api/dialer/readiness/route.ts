import { withAuth } from "@/lib/api";
import { ok } from "@/lib/response";
import { prisma } from "@/lib/db";
import { effectiveAccess } from "@/lib/access/engine";
import { getBusinessSettings } from "@/lib/settings";
import { queueAvailability } from "@/lib/dialer/exhaustion";
import { telephonyStatus } from "@/lib/telephony";

export const dynamic = "force-dynamic";

/**
 * Shift readiness – server-side facts for the agent (the browser checks microphone / audio itself): license, business
 * state, outbound number, the dial lists this agent may work with available leads and due follow-ups, and every
 * blocker with the action that fixes it. Nothing here dials or messages anyone.
 */
export const GET = withAuth(async ({ user }) => {
  const [access, settings, numbers, lists, sub, tasks] = await Promise.all([
    effectiveAccess(user.businessId, user.id), getBusinessSettings(user.businessId),
    prisma.phoneNumber.findMany({ where: { businessId: user.businessId, isActive: true }, select: { e164: true, isDefault: true, verificationStatus: true, label: true } }),
    prisma.dialList.findMany({ where: { businessId: user.businessId, isActive: true, archivedAt: null }, select: { id: true, name: true }, take: 30 }),
    prisma.subscription.findUnique({ where: { businessId: user.businessId }, select: { status: true } }),
    prisma.task.count({ where: { businessId: user.businessId, userId: user.id, status: "open", type: "callback", dueAt: { lte: new Date() } } }),
  ]);
  const blockers: Array<{ code: string; text: string; fix: string }> = [];
  const tel = access.modules.telephony;
  if (access.suspended) blockers.push({ code: "business_suspended", text: "הגישה של העסק מושעית", fix: "פנו לבעל העסק (חיוב ושימוש)" });
  else if (tel.state === "not_in_package") blockers.push({ code: "not_in_package", text: "החייגן אינו כלול במנוי העסק", fix: "בעל העסק מוסיף את מודול החייגן בחיוב ושימוש" });
  else if (!tel.actions.includes("use")) blockers.push({ code: "no_license", text: "לא הוקצה לך רישיון חייגן", fix: "בעל העסק / מנהל החיוב מקצה לך רישיון" });
  if (settings.dialingPaused) blockers.push({ code: "dialing_paused", text: "החיוג מושהה ברמת העסק", fix: "מנהל מחדש חיוג במסך שיחות פעילות" });
  const usable = numbers.filter((n) => n.verificationStatus === "verified" || n.verificationStatus === "approved" || n.isDefault);
  if (!numbers.length) blockers.push({ code: "no_number", text: "אין לעסק מספר יוצא", fix: "מנהל מוסיף מספר בהגדרות ← מספרים" });
  if (sub && ["past_due", "grace"].includes(sub.status)) blockers.push({ code: "billing_issue", text: "יש בעיית תשלום במנוי העסק", fix: "בעל העסק מעדכן אמצעי תשלום" });
  const listStates = [];
  for (const l of lists) { const a = await queueAvailability(user, l.id).catch(() => null); if (a && a.state !== "blocked") listStates.push({ id: l.id, name: l.name, availableNow: a.availableNow, waiting: a.waiting, nextAt: a.nextAt, reason: a.reason }); else if (a) listStates.push({ id: l.id, name: l.name, availableNow: 0, waiting: 0, nextAt: null, reason: a.reason, blocked: true }); }
  const workable = listStates.filter((l) => !("blocked" in l));
  if (!workable.length) blockers.push({ code: "no_list", text: "אין רשימת חיוג שמותר לך לעבוד בה", fix: "מנהל משייך אותך לרשימת חיוג" });
  return ok({
    license: { telephony: tel.state === "active" && tel.actions.includes("use") }, telephony: telephonyStatus(),
    numbers: numbers.map((n) => ({ e164: n.e164, label: n.label, isDefault: n.isDefault, verified: n.verificationStatus === "verified" || n.verificationStatus === "approved" })), usableNumbers: usable.length,
    lists: listStates, followUpsDue: tasks, blockers, checkedAt: new Date().toISOString(),
  });
}, { module: "telephony" });
