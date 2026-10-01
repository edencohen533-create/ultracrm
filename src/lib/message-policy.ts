import { classifyContactRequest } from "@/lib/contact-requests";
/** Application policy, not a claim about a provider's marketing limit. */
export const MARKETING_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** Business setting (marketing.minHoursBetweenMarketing) → ms; the same value drives preflight and the send-time reservation. */
export function marketingIntervalMs(hours?: number) { return (hours && hours > 0 ? hours : 24) * 3600_000; }
export function isUnsubscribe(text: string) {
  const kind = classifyContactRequest(text).kind;
  return kind === "unsubscribe" || kind === "do_not_call" || kind === "wrong_person";
}
/** Uncertain requests pause outreach for review, without claiming a confirmed opt-out. */
export function isAmbiguousUnsubscribe(text: string) {
  return classifyContactRequest(text).kind === "unclear";
}
export function eligibilityError(contact: { consentStatus: string; isBlocked?: boolean }, marketing: boolean, serviceWindow: boolean) {
  if (contact.isBlocked) return "איש הקשר חסום לכל שליחה";
  if (marketing && contact.consentStatus !== "OPTED_IN") return "איש הקשר אינו מאשר קבלת דיוור";
  if (!serviceWindow && contact.consentStatus !== "OPTED_IN") return "נדרשת הסכמה לפתיחת שיחה יזומה";
  return null;
}
