/** Only quick replies produce inbound button callbacks; URL/phone buttons are not selectable. */
export function quickReplyButtons(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap(b => b && typeof b === 'object' && b.type === 'QUICK_REPLY' && typeof b.text === 'string' ? [b.text] : []);
}
export interface WhatsAppButtonCondition { sourceStep: number; buttonText: string; timeoutMinutes: number }
