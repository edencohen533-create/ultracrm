/**
 * Meta Cloud API error classification (developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes).
 * Only transient conditions are retryable; everything about the recipient, the template or the
 * account is permanent for this message. Auth/permission codes additionally block the credential.
 */
export const META_AUTH_BLOCK_CODES = new Set([10, 190, 200, 131005, 131031]);
const RETRYABLE = new Set([1, 2, 4, 80007, 130429, 131000, 131016, 131048, 131056, 133004]);
const LABEL: Record<number, string> = {
  130429: "מגבלת קצב של Meta – יישלח שוב מאוחר יותר",
  131048: "מגבלת ספאם זמנית של Meta",
  131056: "יותר מדי הודעות לאותו נמען בזמן קצר",
  80007: "מגבלת throughput של Meta",
  131016: "שירות Meta אינו זמין זמנית",
  131026: "לא ניתן למסור למספר זה (לא רשום ב-WhatsApp / חסם את העסק)",
  131047: "חלף חלון 24 השעות – נדרשת תבנית מאושרת",
  131049: "Meta בחרה לא למסור הודעה שיווקית זו (מגבלת נמען)",
  131050: "הנמען ביטל קבלת הודעות שיווקיות מהעסק",
  131051: "סוג הודעה לא נתמך",
  132000: "מספר הפרמטרים אינו תואם לתבנית",
  132001: "התבנית אינה קיימת בשפה זו",
  132012: "פורמט פרמטר לא תואם לתבנית",
  132015: "התבנית מושהית",
  132016: "התבנית מושבתת",
  131031: "החשבון נחסם על ידי Meta",
  190: "ה-token פג או בוטל",
  10: "אין הרשאה לפעולה זו",
  200: "אין הרשאה לפעולה זו",
  100: "פרמטר לא תקין בבקשה",
};

export function classifyMetaError(code: number | null | undefined, httpStatus: number | null | undefined, message?: string | null) {
  const c = typeof code === "number" ? code : null;
  const retryable = (c !== null && RETRYABLE.has(c)) || httpStatus === 429 || (typeof httpStatus === "number" && httpStatus >= 500);
  const blocksCredential = c !== null && META_AUTH_BLOCK_CODES.has(c);
  const label = c !== null && LABEL[c] ? LABEL[c] : message ?? `Meta error ${c ?? httpStatus ?? "?"}`;
  return { code: c !== null ? String(c) : httpStatus ? `http_${httpStatus}` : null, retryable, blocksCredential, label };
}

/** Backoff schedule for automatic retries (attempt 1 → 60s, 2 → 5m, 3 → 15m). */
export const MAX_AUTO_ATTEMPTS = 3;
export function retryDelayMs(attempt: number) {
  return [60_000, 5 * 60_000, 15 * 60_000][Math.min(attempt, 2)] ?? 15 * 60_000;
}
