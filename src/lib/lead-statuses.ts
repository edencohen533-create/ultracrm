/** Lead status keys/labels – client-safe (no DB import), shared by the settings merge and the browser hook. */
export type LeadStatusKey = "new" | "contacted" | "qualified" | "unqualified" | "converted" | "lost";
export interface LeadStatusConfig { key: LeadStatusKey; label: string; hidden: boolean }
export const DEFAULT_LEAD_STATUSES: LeadStatusConfig[] = [
  { key: "new", label: "חדש", hidden: false }, { key: "contacted", label: "נוצר קשר", hidden: false }, { key: "qualified", label: "מתאים", hidden: false },
  { key: "unqualified", label: "לא מתאים", hidden: false }, { key: "converted", label: "הומר לעסקה", hidden: false }, { key: "lost", label: "אבוד", hidden: false },
];
/** Every status key exists exactly once; saved order/labels/hidden flags win, missing keys are appended with defaults. */
export function mergeLeadStatuses(raw: unknown): LeadStatusConfig[] {
  const saved = Array.isArray(raw) ? (raw as Partial<LeadStatusConfig>[]) : [];
  const out: LeadStatusConfig[] = [];
  for (const s of saved) { const d = DEFAULT_LEAD_STATUSES.find((x) => x.key === s.key); if (d && !out.some((o) => o.key === d.key)) out.push({ key: d.key, label: (s.label ?? "").trim() || d.label, hidden: Boolean(s.hidden) }); }
  for (const d of DEFAULT_LEAD_STATUSES) if (!out.some((o) => o.key === d.key)) out.push({ ...d });
  return out;
}

/** How new leads without an owner are handed to agents. */
export interface LeadAssignmentSettings {
  mode: "least_loaded" | "round_robin";
  /** 0 = no cap. Agents at the cap are skipped; if everyone is capped the lead stays unassigned. */
  maxOpenLeadsPerAgent: number;
  /** Empty = every active agent/manager. */
  agentIds: string[];
  /** Round-robin pointer: the user who received the previous lead. */
  lastAssignedUserId: string | null;
}
