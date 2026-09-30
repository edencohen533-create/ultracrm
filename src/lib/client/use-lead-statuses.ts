"use client";

import { useEffect, useMemo, useState } from "react";
import { api } from "@/lib/client/api";
import { DEFAULT_LEAD_STATUSES, type LeadStatusItem } from "@/lib/lead-statuses";
import { uiLang } from "@/lib/i18n-labels";

type Payload = { items: LeadStatusItem[]; canEditStructure: boolean; timezone?: string };
let cached: Payload | null = null;
/** Forget the cached statuses (business switch – the next mount fetches the new tenant's list). */
export function resetLeadStatusesCache() { cached = null; }
const listeners = new Set<(v: Payload) => void>();
const FALLBACK: LeadStatusItem[] = DEFAULT_LEAD_STATUSES.map((s, i) => ({ id: `system:${s.key}`, kind: s.key, label: s.label, sortOrder: i, isSystem: true, active: true }));
const EN: Record<string, string> = { new: "New", contacted: "Contacted", follow_up: "Follow-up", qualified: "Qualified", unqualified: "Not relevant", converted: "Converted to deal", lost: "Lost" };

/**
 * The business's lead statuses (one source of truth for the CRM, the dialer wrap-up and automations): stable ids, the
 * meaning (`kind`) that drives behaviour, and the label. A lead shows its custom status (`statusDefId`) or the system
 * status of its meaning. Rename / add / delete anywhere → every screen using this hook updates.
 */
export function useLeadStatuses() {
  const [data, setData] = useState<Payload>(cached ?? { items: FALLBACK, canEditStructure: false });
  useEffect(() => {
    listeners.add(setData);
    if (!cached) api.get<Payload>("/api/lead-statuses").then((r) => { cached = { items: r.items, canEditStructure: Boolean(r.canEditStructure), timezone: r.timezone }; listeners.forEach((l) => l(cached!)); }).catch(() => undefined);
    return () => { listeners.delete(setData); };
  }, []);
  // English UI: untouched system labels are shown in English; labels the business wrote stay as written.
  const en = uiLang() === "en";
  // Stable references (screens sync their local copy from `items` in effects).
  const items = useMemo(() => data.items.map((s) => (en && s.isSystem && DEFAULT_LEAD_STATUSES.find((d) => d.key === s.kind)?.label === s.label ? { ...s, label: EN[s.kind] ?? s.label } : s)), [data.items, en]);
  const system = (kind: string) => items.find((s) => s.isSystem && s.kind === kind);
  /** The status a lead is in (custom by id, else the system status of its meaning). */
  const forLead = (lead: { status: string; statusDefId?: string | null }) => (lead.statusDefId ? items.find((s) => s.id === lead.statusDefId) : undefined) ?? system(lead.status);
  /** A label by status id or by meaning (older data / reports grouped by meaning). */
  const label = (ref: string) => (items.find((s) => s.id === ref) ?? system(ref))?.label ?? ref;
  const active = useMemo(() => items.filter((s) => s.active), [items]);
  return {
    items, active, forLead, label, system, canEditStructure: data.canEditStructure,
    /** The business's time zone (follow-up times are chosen and shown in it). */
    timezone: data.timezone ?? "Asia/Jerusalem",
    /** Options for a lead's status picker: the active statuses + the lead's current one even if it's inactive. */
    optionsFor: (lead: { status: string; statusDefId?: string | null }) => { const cur = forLead(lead); return cur && !cur.active ? [...active, cur] : active; },
    refresh: (next?: LeadStatusItem[]) => {
      if (next) { cached = { ...data, items: next }; listeners.forEach((l) => l(cached!)); return; }
      api.get<Payload>("/api/lead-statuses").then((r) => { cached = { items: r.items, canEditStructure: Boolean(r.canEditStructure), timezone: r.timezone }; listeners.forEach((l) => l(cached!)); }).catch(() => undefined);
    },
  };
}
