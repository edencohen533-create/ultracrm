/**
 * SMS length / segment counting (GSM 03.38 vs UCS-2).
 *
 *  • GSM-7: 160 chars single segment, 153 per segment when concatenated.
 *    Characters of the GSM extension table (€ [ ] { } ~ \ ^ |) cost 2 septets.
 *  • UCS-2 (any character outside GSM-7 – Hebrew, Arabic, most emoji…):
 *    70 UTF-16 code units single segment, 67 per segment when concatenated.
 *    Emoji outside the BMP are surrogate pairs and therefore count as 2.
 * These are the standard limits; the provider reports the actual `parts` after sending.
 */
const GSM_BASIC = "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";
const GSM_EXTENDED = "^{}\\[~]|€";
const GSM_SET = new Set([...GSM_BASIC]);
const GSM_EXT_SET = new Set([...GSM_EXTENDED]);

export type SmsEncoding = "GSM-7" | "UCS-2";

export interface SmsMetrics {
  encoding: SmsEncoding;
  /** Length in encoding units (septets for GSM-7, UTF-16 code units for UCS-2). */
  length: number;
  segments: number;
  perSegment: number;
  singleLimit: number;
  /** Units left before the next segment starts. */
  remaining: number;
}

export function smsEncodingOf(text: string): SmsEncoding {
  for (const ch of text) if (!GSM_SET.has(ch) && !GSM_EXT_SET.has(ch)) return "UCS-2";
  return "GSM-7";
}

export function smsMetrics(text: string): SmsMetrics {
  const encoding = smsEncodingOf(text);
  let length = 0;
  if (encoding === "GSM-7") for (const ch of text) length += GSM_EXT_SET.has(ch) ? 2 : 1;
  else length = text.length; // UTF-16 code units – surrogate pairs count 2
  const singleLimit = encoding === "GSM-7" ? 160 : 70;
  const multiLimit = encoding === "GSM-7" ? 153 : 67;
  if (length === 0) return { encoding, length, segments: 0, perSegment: singleLimit, singleLimit, remaining: singleLimit };
  const segments = length <= singleLimit ? 1 : Math.ceil(length / multiLimit);
  const perSegment = segments === 1 ? singleLimit : multiLimit;
  const remaining = perSegment * segments - length;
  return { encoding, length, segments, perSegment, singleLimit, remaining };
}

export const SMS_MAX_SEGMENTS = 6;
