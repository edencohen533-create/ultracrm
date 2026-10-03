export const EMAIL_EVENTS = {
  opened: ['דווחה פתיחת האימייל', 'Email open reported'],
  not_opened: ['לא דווחה פתיחה עד תום ההמתנה', 'No open reported by deadline'],
  clicked: ['דווחה לחיצה על קישור', 'Link click reported'],
  not_clicked: ['לא דווחה לחיצה עד תום ההמתנה', 'No click reported by deadline'],
  delivered: ['האימייל נמסר לשרת הנמען', 'Delivered to recipient server'],
  bounced: ['האימייל חזר (Bounce)', 'Email bounced'],
  failed: ['שליחת האימייל נכשלה', 'Email failed'],
} as const;
export interface EmailCondition { sourceStep: number; event: keyof typeof EMAIL_EVENTS; timeoutMinutes: number; link?: string }
