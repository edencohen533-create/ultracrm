/**
 * Client-safe catalog of modules, their actions, data scopes and role templates. Only actions that EXIST in the
 * product are listed (e.g. there is no lead/contact delete, so CRM has no "delete" action). Anything not listed is
 * denied by the engine (src/lib/access/engine.ts).
 */
import { bi, withLabel } from "@/lib/i18n-labels";

export type ModuleKey = "crm" | "telephony" | "whatsapp" | "sms" | "email";
export const MODULES: ModuleKey[] = ["crm", "telephony", "whatsapp", "sms", "email"];
export const MODULE_LABEL: Record<ModuleKey, string> = bi({ crm: "CRM", telephony: "חייגן", whatsapp: "וואטסאפ", sms: "SMS מרקטינג", email: "אימייל מרקטינג" }, { crm: "CRM", telephony: "Dialer", whatsapp: "WhatsApp", sms: "SMS marketing", email: "Email marketing" });

export const ACTIONS = {
  crm: bi({ view: "צפייה", create: "יצירה", edit: "עריכה", export: "ייצוא", transfer: "העברת לידים", payments: "גבייה מלקוח (קישור / עמוד תשלום)", payment_amount: "שינוי סכום בגבייה" } as const, { view: "View", create: "Create", edit: "Edit", export: "Export", transfer: "Transfer leads", payments: "Take payments (link / payment page)", payment_amount: "Change the amount of a payment" }),
  telephony: bi({ use: "שימוש בחייגן", personal_settings: "שינוי הגדרות אישיות", team_settings: "ניהול הגדרות צוות וקמפיינים", recordings: "גישה להקלטות" } as const, { use: "Use the dialer", personal_settings: "Change personal settings", team_settings: "Manage team settings and campaigns", recordings: "Access recordings" }),
  whatsapp: bi({ view: "צפייה בשיחות", reply: "מענה", assign: "הקצאת שיחות", automations: "ניהול אוטומציות", campaign_draft: "הכנת הודעות תפוצה", campaign_send: "אישור ושליחת הודעות תפוצה", connect: "חיבור וניתוק חשבון WhatsApp" } as const, { view: "View conversations", reply: "Reply", assign: "Assign conversations", automations: "Manage automations", campaign_draft: "Prepare broadcasts", campaign_send: "Approve and send broadcasts", connect: "Connect & disconnect the WhatsApp account" }),
  sms: bi({ view: "צפייה", draft: "יצירה ועריכת טיוטות", send: "אישור ושליחת קמפיינים" } as const, { view: "View", draft: "Create and edit drafts", send: "Approve and send campaigns" }),
  email: bi({ view: "צפייה", draft: "יצירה ועריכת טיוטות", send: "אישור ושליחת קמפיינים" } as const, { view: "View", draft: "Create and edit drafts", send: "Approve and send campaigns" }),
} as const satisfies Record<ModuleKey, Record<string, string>>;
export type ActionOf<M extends ModuleKey> = keyof (typeof ACTIONS)[M] & string;
export type Permission = { [M in ModuleKey]: `${M}.${ActionOf<M>}` }[ModuleKey];
/** Actions that send to customers or spend money – kept apart from preparing drafts. */
export const SENDING_ACTIONS: Permission[] = ["sms.send", "email.send", "whatsapp.campaign_send", "whatsapp.reply"];

export type DataScope = "own" | "team" | "business";
export const SCOPE_LABEL: Record<DataScope, string> = bi({ own: "נתונים אישיים / שהוקצו לו", team: "נתוני הצוות", business: "כל נתוני העסק" }, { own: "Own / assigned data", team: "Team data", business: "All business data" });

export interface ModuleGrant { enabled: boolean; actions: string[] }
export interface UserPermissions { template: TemplateKey | "custom"; scope: DataScope; modules: Partial<Record<ModuleKey, ModuleGrant>> }

export type TemplateKey = "business_manager" | "team_manager" | "agent";
const all = (m: ModuleKey) => Object.keys(ACTIONS[m]);
const TEMPLATES_RAW: Record<TemplateKey, { label: string; en: string; scope: DataScope; actions: Record<ModuleKey, string[]> }> = {
  business_manager: { label: "מנהל עסק", en: "Business manager", scope: "business", actions: { crm: all("crm"), telephony: all("telephony"), whatsapp: all("whatsapp"), sms: all("sms"), email: all("email") } },
  team_manager: { label: "מנהל צוות", en: "Team manager", scope: "team", actions: { crm: all("crm"), telephony: all("telephony"), whatsapp: ["view", "reply", "assign", "automations", "campaign_draft"], sms: ["view", "draft"], email: ["view", "draft"] } },
  agent: { label: "נציג", en: "Agent", scope: "own", actions: { crm: ["view", "create", "edit", "payments"], telephony: ["use", "personal_settings"], whatsapp: ["view", "reply"], sms: ["view"], email: ["view"] } },
};
export const TEMPLATES = Object.fromEntries(Object.entries(TEMPLATES_RAW).map(([k, v]) => [k, withLabel(v, v.en)])) as typeof TEMPLATES_RAW;

/** Real product dependencies between modules (shown when configuring packages and permissions). */
const DEPENDENCY_EN: Record<string, string> = {"telephony": "The dialer works on the business's contacts and leads; without CRM the agent dials from dial lists and the lead card in the dialer only – CRM screens don't open.", "sms": "Campaigns use the shared contacts and audiences – even without the CRM module.", "email": "Campaigns use the shared contacts and audiences – even without the CRM module."};
export const DEPENDENCIES: Array<{ module: ModuleKey; note: string }> = ([
  { module: "telephony", note: "החייגן עובד על אנשי הקשר והלידים של העסק; בלי CRM הנציג מחייג מרשימות החיוג ומכרטיס הליד בחייגן בלבד – מסכי ה-CRM אינם נפתחים." },
  { module: "sms", note: "קמפיינים משתמשים באנשי הקשר ובקהלים המשותפים – גם בלי מודול CRM." },
  { module: "email", note: "קמפיינים משתמשים באנשי הקשר ובקהלים המשותפים – גם בלי מודול CRM." },
] as Array<{ module: ModuleKey; note: string; label: string }>).map((d) => { const x = withLabel({ ...d, label: d.note }, DEPENDENCY_EN[d.module] ?? d.note); return Object.defineProperty(x, "note", { get: () => x.label, enumerable: true }); });

export const QUOTA_METRICS = ["users", "contacts", "messages_sent", "calls_started", "campaigns_started"] as const;
export type QuotaMetric = (typeof QUOTA_METRICS)[number];
export const QUOTA_LABEL: Record<QuotaMetric, string> = bi({ users: "משתמשים פעילים", contacts: "אנשי קשר", messages_sent: "הודעות יוצאות בחודש", calls_started: "שיחות יוצאות בחודש", campaigns_started: "קמפיינים בחודש" }, { users: "Active users", contacts: "Contacts", messages_sent: "Outgoing messages per month", calls_started: "Outgoing calls per month", campaigns_started: "Campaigns per month" });

export const ACCESS_STATUS_LABEL: Record<string, string> = bi({ active: "פעיל", trial: "ניסיון", grace: "תקופת חסד", suspended: "מושעה" }, { active: "Active", trial: "Trial", grace: "Grace period", suspended: "Suspended" });
export const SOURCE_LABEL: Record<string, string> = bi({ plan: "חבילה", addon: "תוספת", trial: "ניסיון", temporary: "הרשאה זמנית", legacy: "ללא חבילה (ברירת מחדל קודמת)", override: "התאמה ידנית קודמת" }, { plan: "Plan", addon: "Add-on", trial: "Trial", temporary: "Temporary grant", legacy: "No plan (previous default)", override: "Previous manual override" });

export function isPermission(p: string): p is Permission {
  const [m, a] = p.split(".");
  return m in ACTIONS && Boolean(a) && a in ACTIONS[m as ModuleKey];
}
