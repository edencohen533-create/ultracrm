/** Application policy, not a claim about a provider's marketing limit. */
export const MARKETING_INTERVAL_MS = 24 * 60 * 60 * 1000;
export function isUnsubscribe(text: string) {
  const normalized = text.normalize("NFKC").trim().toLowerCase().replace(/[.!?]+$/u, "").trim();
  return ["הסר", "הסרה", "הסר אותי", "הסירו אותי", "הפסק", "stop", "unsubscribe", "stop all", "cancel", "remove me"].includes(normalized);
}
export function eligibilityError(contact: { consentStatus: string; isBlocked?: boolean }, marketing: boolean, serviceWindow: boolean) {
  if (contact.isBlocked) return "איש הקשר חסום לכל שליחה";
  if (marketing && contact.consentStatus !== "OPTED_IN") return "איש הקשר אינו מאשר קבלת דיוור";
  if (!serviceWindow && contact.consentStatus !== "OPTED_IN") return "נדרשת הסכמה לפתיחת שיחה יזומה";
  return null;
}
