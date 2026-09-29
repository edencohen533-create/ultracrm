import type { OutcomeKey } from "@/generated/prisma/enums";
import { withLabel } from "@/lib/i18n-labels";

export interface OutcomeDef {
  key: OutcomeKey;
  label: string;
  /** Lead is removed from the queue (no further attempts in this list). */
  closesLead: boolean;
  /** Counts as a "retry later" – schedules next attempt per retry policy. */
  retry: boolean;
  requiresCallbackTime: boolean;
  isSale: boolean;
  addsToDnc: boolean;
  /** Keyboard shortcut (digit) shown in the outcome panel. */
  hotkey: string;
  tone: "good" | "neutral" | "bad" | "danger";
}

const OUTCOME_EN: Record<string, string> = {"answered_interested": "Answered – interested", "answered_not_interested": "Answered – not interested", "callback": "Call back later", "no_answer": "No answer", "busy": "Busy", "wrong_number": "Wrong number", "sale": "Sale made", "dnc": "Do not contact"};
export const OUTCOMES: OutcomeDef[] = ([
  { key: "answered_interested", label: "ענה – מעוניין", closesLead: true, retry: false, requiresCallbackTime: false, isSale: false, addsToDnc: false, hotkey: "1", tone: "good" },
  { key: "answered_not_interested", label: "ענה – לא מעוניין", closesLead: true, retry: false, requiresCallbackTime: false, isSale: false, addsToDnc: false, hotkey: "2", tone: "neutral" },
  { key: "callback", label: "לחזור בהמשך", closesLead: false, retry: false, requiresCallbackTime: true, isSale: false, addsToDnc: false, hotkey: "3", tone: "neutral" },
  { key: "no_answer", label: "אין מענה", closesLead: false, retry: true, requiresCallbackTime: false, isSale: false, addsToDnc: false, hotkey: "4", tone: "bad" },
  { key: "busy", label: "תפוס", closesLead: false, retry: true, requiresCallbackTime: false, isSale: false, addsToDnc: false, hotkey: "5", tone: "bad" },
  { key: "wrong_number", label: "מספר שגוי", closesLead: true, retry: false, requiresCallbackTime: false, isSale: false, addsToDnc: false, hotkey: "6", tone: "bad" },
  { key: "sale", label: "בוצעה מכירה", closesLead: true, retry: false, requiresCallbackTime: false, isSale: true, addsToDnc: false, hotkey: "7", tone: "good" },
  { key: "dnc", label: "לא ליצור קשר", closesLead: true, retry: false, requiresCallbackTime: false, isSale: false, addsToDnc: true, hotkey: "8", tone: "danger" },
] as OutcomeDef[]).map((o) => withLabel(o, OUTCOME_EN[o.key] ?? o.label));

/**
 * Set by the system, never picked by the agent: an answered call the agent left without choosing a result (the AI
 * documentation holds what was said). The queue row is completed; the CRM lead stays open (new → contacted).
 */
export const AUTO_OUTCOMES: OutcomeDef[] = ([
  { key: "answered", label: "ענה – תועד אוטומטית", closesLead: true, retry: false, requiresCallbackTime: false, isSale: false, addsToDnc: false, hotkey: "", tone: "neutral" },
] as OutcomeDef[]).map((o) => withLabel(o, "Answered – documented automatically"));
/** Every outcome a call can have (manual + automatic) – for labels, reports and filters. */
export const ALL_OUTCOMES: OutcomeDef[] = [...OUTCOMES, ...AUTO_OUTCOMES];

export const OUTCOME_BY_KEY: Record<OutcomeKey, OutcomeDef> = Object.fromEntries(
  ALL_OUTCOMES.map((o) => [o.key, o]),
) as Record<OutcomeKey, OutcomeDef>;

export function outcomeLabel(key: OutcomeKey | null | undefined) {
  return key ? OUTCOME_BY_KEY[key]?.label ?? key : "—";
}

/** Outcomes that make sense when the provider says the lead never answered. */
export const UNANSWERED_OUTCOMES: OutcomeKey[] = ["no_answer", "busy", "wrong_number", "callback", "dnc"];
