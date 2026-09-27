/** Client-safe CRM labels (no server imports). */
export const LEAD_STATUSES = ["new", "contacted", "follow_up", "qualified", "unqualified", "converted", "lost"] as const;
/** Statuses of a lead that is still being worked (everything else is closed). */
export const OPEN_LEAD_STATUSES = ["new", "contacted", "follow_up", "qualified"] as const;
export const LEAD_STATUS_LABEL: Record<(typeof LEAD_STATUSES)[number], string> = { new: "חדש", contacted: "נוצר קשר", follow_up: "פולואפ", qualified: "מתאים", unqualified: "לא מתאים", converted: "הומר לעסקה", lost: "אבוד" };
export const DEAL_STAGES = ["new", "proposal", "negotiation", "won", "lost"] as const;
export const DEAL_STAGE_LABEL: Record<(typeof DEAL_STAGES)[number], string> = { new: "חדשה", proposal: "הצעה", negotiation: "משא ומתן", won: "נסגרה", lost: "אבודה" };
export const TASK_TYPE_LABEL: Record<string, string> = { callback: "חזרה טלפונית", follow_up: "מעקב", todo: "משימה" };
