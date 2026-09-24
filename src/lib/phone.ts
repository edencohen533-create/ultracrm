import { parsePhoneNumberFromString, type CountryCode } from "libphonenumber-js";

const DEFAULT_COUNTRY: CountryCode = "IL";

/**
 * Normalize any user-entered phone number to E.164 (e.g. "+972501234567").
 * Returns null when the number cannot be parsed or is not valid.
 */
export function normalizePhone(input: string, country: CountryCode = DEFAULT_COUNTRY): string | null {
  if (!input) return null;
  // Convert Arabic-Indic / Persian digits and strip everything except digits and a leading +
  const ascii = input
    .replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)))
    .replace(/[۰-۹]/g, (d) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d)))
    .trim();
  const cleaned = ascii.replace(/[^\d+]/g, "");
  if (!cleaned) return null;
  const parsed = parsePhoneNumberFromString(cleaned, country);
  if (!parsed || !parsed.isValid()) return null;
  return parsed.number; // E.164
}

/** Human-readable national format ("050-123-4567"), always safe to render with dir="ltr". */
export function formatPhoneDisplay(e164: string): string {
  const parsed = parsePhoneNumberFromString(e164);
  if (!parsed) return e164;
  if (parsed.country === DEFAULT_COUNTRY) return parsed.formatNational();
  return parsed.formatInternational();
}

/** Digits only, for "contains" searches. */
export function phoneDigits(input: string): string {
  return input.replace(/\D/g, "");
}
