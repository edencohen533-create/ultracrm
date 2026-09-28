import { bi } from "@/lib/i18n-labels";
/** Client-safe CRM labels (no server imports). */
export const LEAD_STATUSES = ["new", "contacted", "follow_up", "qualified", "unqualified", "converted", "lost"] as const;
/** Statuses of a lead that is still being worked (everything else is closed). */
export const OPEN_LEAD_STATUSES = ["new", "contacted", "follow_up", "qualified"] as const;
export const LEAD_STATUS_LABEL: Record<(typeof LEAD_STATUSES)[number], string> = bi({ new: "חדש", contacted: "נוצר קשר", follow_up: "פולואפ", qualified: "מתאים", unqualified: "לא מתאים", converted: "הומר לעסקה", lost: "אבוד" }, { new: "New", contacted: "Contacted", follow_up: "Follow-up", qualified: "Qualified", unqualified: "Not relevant", converted: "Converted to deal", lost: "Lost" });
export const DEAL_STAGES = ["new", "proposal", "negotiation", "won", "lost"] as const;
export const DEAL_STAGE_LABEL: Record<(typeof DEAL_STAGES)[number], string> = bi({ new: "חדשה", proposal: "הצעה", negotiation: "משא ומתן", won: "נסגרה", lost: "אבודה" }, { new: "New", proposal: "Proposal", negotiation: "Negotiation", won: "Won", lost: "Lost" });
export const TASK_TYPE_LABEL: Record<string, string> = bi({ callback: "חזרה טלפונית", follow_up: "מעקב", todo: "משימה" }, { callback: "Callback", follow_up: "Follow-up", todo: "Task" });
