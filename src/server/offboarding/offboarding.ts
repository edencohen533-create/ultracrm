/**
 * Ending the relationship – three separate things, never mixed:
 *  • cancel the subscription (at the period end; data kept; business becomes "cancelled"),
 *  • delete a user (personal details erased; business records stay),
 *  • delete the business (scheduled, cancellable; everything of the business erased on the date).
 * Before that: disconnect connections and stop future actions. Retention periods beyond what the product does today
 * need the platform owner's decision (listed, not invented).
 */
import { db } from "@/lib/db";
import { ApiError } from "@/lib/response";
import { audit } from "@/lib/audit";
import type { SessionUser } from "@/lib/auth";
import { BUSINESS_DELETION_DAYS } from "@/server/services/account-deletion-service";

export async function offboardingOverview(user: SessionUser) {
  if (user.role !== "owner") throw new ApiError("לבעל העסק בלבד", 403, "forbidden");
  const b = user.businessId;
  const [biz, sub, wa, sms, numbers, stores, crm, meta, pay, campaigns, lists, automations, sequences] = await Promise.all([
    db.business.findUniqueOrThrow({ where: { id: b }, select: { name: true, deletionScheduledFor: true, accessStatus: true } }),
    db.subscription.findUnique({ where: { businessId: b }, select: { status: true, currentPeriodEnd: true, cancelAtPeriodEnd: true } }),
    db.providerCredential.count({ where: { businessId: b, channel: "whatsapp", isActive: true } }),
    db.providerCredential.count({ where: { businessId: b, channel: { in: ["sms", "email"] }, isActive: true } }),
    db.phoneNumber.count({ where: { businessId: b, isActive: true } }),
    db.storeConnection.count({ where: { businessId: b, isActive: true } }),
    db.crmConnection.count({ where: { businessId: b, status: { not: "disconnected" } } }),
    db.metaAdConnection.count({ where: { businessId: b } }),
    db.paymentProviderConnection.count({ where: { businessId: b, isActive: true } }),
    db.campaign.count({ where: { businessId: b, status: { in: ["SCHEDULED", "RUNNING"] } } }).catch(() => 0),
    db.dialList.count({ where: { businessId: b, isActive: true } }),
    db.automationRule.count({ where: { businessId: b, isActive: true } }).catch(() => 0),
    db.sequenceRun.count({ where: { businessId: b, status: { in: ["PENDING", "RUNNING"] } } }).catch(() => 0),
  ]);
  return {
    business: biz, subscription: sub,
    connections: [{ key: "whatsapp", label: "WhatsApp", active: wa, href: "/settings/whatsapp" }, { key: "sms_email", label: "SMS / אימייל", active: sms, href: "/settings?tab=connections" }, { key: "numbers", label: "מספרי טלפון", active: numbers, href: "/settings?tab=numbers" }, { key: "stores", label: "חנויות", active: stores, href: "/settings?tab=connections" }, { key: "crm", label: "CRM חיצוני", active: crm, href: "/settings/crm" }, { key: "meta_ads", label: "Meta Ads", active: meta, href: "/settings?tab=connections" }, { key: "payments", label: "סליקה ללקוחות", active: pay, href: "/settings?tab=connections" }],
    futureActions: { scheduledCampaigns: campaigns, activeDialLists: lists, activeAutomations: automations, runningSequences: sequences },
    options: [
      { key: "cancel_subscription", title: "ביטול מנוי", what: "המנוי מסתיים בסוף התקופה ששולמה. העסק עובר למצב \"מבוטל\": אין פעולות, הנתונים נשמרים.", deleted: "לא נמחק דבר.", kept: "כל הנתונים, עד מחיקת עסק מפורשת." },
      { key: "delete_user", title: "מחיקת משתמש", what: "פרטי המשתמש האישיים נמחקים (מהגדרות ← החשבון שלי / משתמשים).", deleted: "שם, אימייל, סיסמה (כשאין לו עסק פעיל אחר).", kept: "רשומות העסק שיצר – בלי זיהוי אישי." },
      { key: "delete_business", title: "מחיקת העסק", what: `מחיקה מתוזמנת בעוד ${BUSINESS_DELETION_DAYS} ימים, ניתנת לביטול עד אז. חיבורי WhatsApp / SMS / אימייל מנותקים והטוקנים נמחקים מיד.`, deleted: "כל נתוני העסק: אנשי קשר, לידים, שיחות, הודעות, משימות, הגדרות, משתמשים.", kept: "מסמכי חיוב ורישומי שימוש של Solina CRM – תקופת השמירה שלהם דורשת החלטת בעל המערכת (לא הוגדרה)." },
    ],
    retentionPolicy: { businessDeletionGraceDays: BUSINESS_DELETION_DAYS, billingRecords: "דורש החלטת בעל המערכת", auditLogs: "דורש החלטת בעל המערכת", recordingsAtProvider: "לפי ספק הטלפוניה – דורש החלטה ובדיקה מולו", backups: "לפי מדיניות הגיבוי של ספק מסד הנתונים – דורש אימות" },
  };
}

/** Stop everything that would still happen by itself (explicit, confirmed by the business name, audited). */
export async function stopFutureActions(user: SessionUser, confirmName: string) {
  if (user.role !== "owner") throw new ApiError("לבעל העסק בלבד", 403, "forbidden");
  const b = user.businessId;
  const biz = await db.business.findUniqueOrThrow({ where: { id: b }, select: { name: true } });
  if (confirmName.trim() !== biz.name.trim()) throw new ApiError("שם העסק שהוקלד אינו תואם", 400, "confirm_mismatch");
  const [campaigns, lists, automations, sequences, crm] = await Promise.all([
    db.campaign.updateMany({ where: { businessId: b, status: { in: ["SCHEDULED", "RUNNING"] } }, data: { status: "PAUSED" } }).catch(() => ({ count: 0 })),
    db.dialList.updateMany({ where: { businessId: b, isActive: true }, data: { isActive: false } }),
    db.automationRule.updateMany({ where: { businessId: b, isActive: true }, data: { isActive: false } }).catch(() => ({ count: 0 })),
    db.sequenceRun.updateMany({ where: { businessId: b, status: { in: ["PENDING", "RUNNING"] } }, data: { status: "STOPPED" } }).catch(() => ({ count: 0 })),
    db.crmConnection.updateMany({ where: { businessId: b, status: { not: "disconnected" } }, data: { status: "disconnected", disconnectedAt: new Date() } }),
  ]);
  const result = { campaignsPaused: campaigns.count, dialListsDeactivated: lists.count, automationsPaused: automations.count, sequencesCancelled: sequences.count, crmDisconnected: crm.count };
  await audit(b, user.id, "business", b, "business.future_actions_stopped", result);
  return result;
}
