"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/client/api";
import { DEFAULT_LEAD_STATUSES, type LeadStatusConfig } from "@/lib/lead-statuses";
import { uiLang } from "@/lib/i18n-labels";

let cached: LeadStatusConfig[] | null = null;
/** Forget the cached statuses (business switch – the next mount fetches the new tenant's list). */
export function resetLeadStatusesCache() { cached = null; }
const listeners = new Set<(v: LeadStatusConfig[]) => void>();

/** Business-configurable lead statuses (labels, order, hidden). Falls back to the defaults until loaded. */
export function useLeadStatuses() {
  const [raw, setItems] = useState<LeadStatusConfig[]>(cached ?? DEFAULT_LEAD_STATUSES);
  let items = raw;
  useEffect(() => {
    listeners.add(setItems);
    if (!cached) api.get<{ items: LeadStatusConfig[] }>("/api/lead-statuses").then((r) => { cached = r.items; listeners.forEach((l) => l(r.items)); }).catch(() => undefined);
    return () => { listeners.delete(setItems); };
  }, []);
  // English UI: the default labels are shown in English; labels the business renamed stay as written.
  const en = uiLang() === "en";
  const EN: Record<string, string> = { new: "New", contacted: "Contacted", follow_up: "Follow-up", qualified: "Qualified", unqualified: "Not relevant", converted: "Converted to deal", lost: "Lost" };
  const tr = (s: LeadStatusConfig) => (en && DEFAULT_LEAD_STATUSES.find((d) => d.key === s.key)?.label === s.label ? { ...s, label: EN[s.key] ?? s.label } : s);
  items = items.map(tr);
  const label = (key: string) => items.find((s) => s.key === key)?.label ?? key;
  const visible = items.filter((s) => !s.hidden);
  return { items, visible, label, refresh: (next: LeadStatusConfig[]) => { cached = next; listeners.forEach((l) => l(next)); } };
}
