/**
 * Client-safe catalog of modules, their actions, data scopes and role templates. Only actions that EXIST in the
 * product are listed (e.g. there is no lead/contact delete, so CRM has no "delete" action). Anything not listed is
 * denied by the engine (src/lib/access/engine.ts).
 */
export type ModuleKey = "crm" | "telephony" | "whatsapp" | "sms" | "email";
export const MODULES: ModuleKey[] = ["crm", "telephony", "whatsapp", "sms", "email"];
export const MODULE_LABEL: Record<ModuleKey, string> = { crm: "CRM", telephony: "חייגן", whatsapp: "וואטסאפ", sms: "SMS מרקטינג", email: "אימייל מרקטינג" };

export const ACTIONS = {
  crm: { view: "צפייה", create: "יצירה", edit: "עריכה", export: "ייצוא", transfer: "העברת לידים" },
  telephony: { use: "שימוש בחייגן", personal_settings: "שינוי הגדרות אישיות", team_settings: "ניהול הגדרות צוות וקמפיינים", recordings: "גישה להקלטות" },
  whatsapp: { view: "צפייה בשיחות", reply: "מענה", assign: "הקצאת שיחות", automations: "ניהול אוטומציות", campaign_draft: "הכנת הודעות תפוצה", campaign_send: "אישור ושליחת הודעות תפוצה" },
  sms: { view: "צפייה", draft: "יצירה ועריכת טיוטות", send: "אישור ושליחת קמפיינים" },
  email: { view: "צפייה", draft: "יצירה ועריכת טיוטות", send: "אישור ושליחת קמפיינים" },
} as const satisfies Record<ModuleKey, Record<string, string>>;
export type ActionOf<M extends ModuleKey> = keyof (typeof ACTIONS)[M] & string;
export type Permission = { [M in ModuleKey]: `${M}.${ActionOf<M>}` }[ModuleKey];
/** Actions that send to customers or spend money – kept apart from preparing drafts. */
export const SENDING_ACTIONS: Permission[] = ["sms.send", "email.send", "whatsapp.campaign_send", "whatsapp.reply"];

export type DataScope = "own" | "team" | "business";
export const SCOPE_LABEL: Record<DataScope, string> = { own: "נתונים אישיים / שהוקצו לו", team: "נתוני הצוות", business: "כל נתוני העסק" };

export interface ModuleGrant { enabled: boolean; actions: string[] }
export interface UserPermissions { template: TemplateKey | "custom"; scope: DataScope; modules: Partial<Record<ModuleKey, ModuleGrant>> }

export type TemplateKey = "business_manager" | "team_manager" | "agent";
const all = (m: ModuleKey) => Object.keys(ACTIONS[m]);
export const TEMPLATES: Record<TemplateKey, { label: string; scope: DataScope; actions: Record<ModuleKey, string[]> }> = {
  business_manager: { label: "מנהל עסק", scope: "business", actions: { crm: all("crm"), telephony: all("telephony"), whatsapp: all("whatsapp"), sms: all("sms"), email: all("email") } },
  team_manager: { label: "מנהל צוות", scope: "team", actions: { crm: all("crm"), telephony: all("telephony"), whatsapp: ["view", "reply", "assign", "automations", "campaign_draft"], sms: ["view", "draft"], email: ["view", "draft"] } },
  agent: { label: "נציג", scope: "own", actions: { crm: ["view", "create", "edit"], telephony: ["use", "personal_settings"], whatsapp: ["view", "reply"], sms: ["view"], email: ["view"] } },
};

/** Real product dependencies between modules (shown when configuring packages and permissions). */
export const DEPENDENCIES: Array<{ module: ModuleKey; note: string }> = [
  { module: "telephony", note: "החייגן עובד על אנשי הקשר והלידים של העסק; בלי CRM הנציג מחייג מרשימות החיוג ומכרטיס הליד בחייגן בלבד – מסכי ה-CRM אינם נפתחים." },
  { module: "sms", note: "קמפיינים משתמשים באנשי הקשר ובקהלים המשותפים – גם בלי מודול CRM." },
  { module: "email", note: "קמפיינים משתמשים באנשי הקשר ובקהלים המשותפים – גם בלי מודול CRM." },
];

export const QUOTA_METRICS = ["users", "contacts", "messages_sent", "calls_started", "campaigns_started"] as const;
export type QuotaMetric = (typeof QUOTA_METRICS)[number];
export const QUOTA_LABEL: Record<QuotaMetric, string> = { users: "משתמשים פעילים", contacts: "אנשי קשר", messages_sent: "הודעות יוצאות בחודש", calls_started: "שיחות יוצאות בחודש", campaigns_started: "קמפיינים בחודש" };

export const ACCESS_STATUS_LABEL: Record<string, string> = { active: "פעיל", trial: "ניסיון", grace: "תקופת חסד", suspended: "מושעה" };
export const SOURCE_LABEL: Record<string, string> = { plan: "חבילה", addon: "תוספת", trial: "ניסיון", temporary: "הרשאה זמנית", legacy: "ללא חבילה (ברירת מחדל קודמת)", override: "התאמה ידנית קודמת" };

export function isPermission(p: string): p is Permission {
  const [m, a] = p.split(".");
  return m in ACTIONS && Boolean(a) && a in ACTIONS[m as ModuleKey];
}
