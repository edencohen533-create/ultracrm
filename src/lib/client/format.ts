import { parsePhoneNumberFromString } from "libphonenumber-js";

export function formatDuration(totalSeconds: number | null | undefined) {
  const s = Math.max(0, Math.floor(totalSeconds ?? 0));
  const m = Math.floor(s / 60);
  const sec = s % 60;
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}:${String(m % 60).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  return `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

export function formatPhone(e164: string | null | undefined) {
  if (!e164) return "";
  const p = parsePhoneNumberFromString(e164);
  if (!p) return e164;
  return p.country === "IL" ? p.formatNational() : p.formatInternational();
}

const dt = new Intl.DateTimeFormat("he-IL", { dateStyle: "short", timeStyle: "short", timeZone: "Asia/Jerusalem" });
const t = new Intl.DateTimeFormat("he-IL", { timeStyle: "short", timeZone: "Asia/Jerusalem" });
const d = new Intl.DateTimeFormat("he-IL", { dateStyle: "medium", timeZone: "Asia/Jerusalem" });

export function formatDateTime(v: string | Date | null | undefined) {
  if (!v) return "—";
  return dt.format(new Date(v));
}
export function formatTime(v: string | Date | null | undefined) {
  if (!v) return "—";
  return t.format(new Date(v));
}
export function formatDate(v: string | Date | null | undefined) {
  if (!v) return "—";
  return d.format(new Date(v));
}

export function relativeTime(v: string | Date | null | undefined, now = Date.now()) {
  if (!v) return "—";
  const diff = Math.round((now - new Date(v).getTime()) / 1000);
  if (diff < 45) return "עכשיו";
  if (diff < 3600) return `לפני ${Math.round(diff / 60)} דק׳`;
  if (diff < 86400) return `לפני ${Math.round(diff / 3600)} שע׳`;
  return `לפני ${Math.round(diff / 86400)} ימים`;
}

/** Convert a Date to the value expected by <input type="datetime-local"> (local time). */
export function toLocalInputValue(date: Date) {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export const CALL_STATUS_LABEL: Record<string, string> = {
  created: "מכין שיחה",
  dialing_agent: "מחבר את הנציג",
  agent_connected: "הנציג מחובר",
  dialing_lead: "מחייג ללקוח",
  ringing: "מצלצל",
  answered: "בשיחה",
  ended: "הסתיימה",
  failed: "נכשלה",
};

export const TELEPHONY_RESULT_LABEL: Record<string, string> = {
  answered: "נענתה",
  no_answer: "אין מענה",
  busy: "תפוס",
  failed: "נכשלה",
  cancelled: "בוטלה",
  rejected: "נדחתה",
};

export const LEAD_STATUS_LABEL: Record<string, string> = {
  pending: "ממתין",
  locked: "בטיפול",
  in_call: "בשיחה",
  callback: "חזרה מתוכננת",
  completed: "הושלם",
  exhausted: "מוצו הניסיונות",
  removed: "הוסר",
  dnc: "לא ליצור קשר",
};

export const PRESENCE_LABEL: Record<string, string> = {
  offline: "מנותק",
  available: "זמין",
  in_call: "בשיחה",
  wrap_up: "בתיעוד",
  paused: "מושהה",
};

export const MODE_LABEL: Record<string, string> = { manual: "חיוג ידני", preview: "Preview", power: "תותח שיחות" };
