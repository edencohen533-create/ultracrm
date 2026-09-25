"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/client/api";
import { DEFAULT_LEAD_STATUSES, type LeadStatusConfig } from "@/lib/lead-statuses";

let cached: LeadStatusConfig[] | null = null;
const listeners = new Set<(v: LeadStatusConfig[]) => void>();

/** Business-configurable lead statuses (labels, order, hidden). Falls back to the defaults until loaded. */
export function useLeadStatuses() {
  const [items, setItems] = useState<LeadStatusConfig[]>(cached ?? DEFAULT_LEAD_STATUSES);
  useEffect(() => {
    listeners.add(setItems);
    if (!cached) api.get<{ items: LeadStatusConfig[] }>("/api/lead-statuses").then((r) => { cached = r.items; listeners.forEach((l) => l(r.items)); }).catch(() => undefined);
    return () => { listeners.delete(setItems); };
  }, []);
  const label = (key: string) => items.find((s) => s.key === key)?.label ?? key;
  const visible = items.filter((s) => !s.hidden);
  return { items, visible, label, refresh: (next: LeadStatusConfig[]) => { cached = next; listeners.forEach((l) => l(next)); } };
}
