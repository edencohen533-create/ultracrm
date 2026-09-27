"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/client/api";
import { Badge, Button, Panel, Spinner } from "@/components/ui";
import { ACCESS_STATUS_LABEL, MODULE_LABEL, MODULES, SOURCE_LABEL, type ModuleKey } from "@/lib/access/catalog";

interface Ent { planName: string | null; planVersion: number | null; accessStatus: string; accessUntil: string | null; billingStatus: string; suspended: boolean; modules: Record<ModuleKey, { included: boolean; seats: number | null; sources: Array<{ type: string; expiresAt: string | null }> }> }
interface Data { entitlement: Ent; seats: Record<ModuleKey, { included: boolean; seats: number | null; used: number; free: number | null }>; usage: Record<string, { used: number; limit: number | null; label: string }> }

/** Business side: read-only package overview (the package is changed by the platform admin only) + upgrade request. */
export function PlanOverview() {
  const [d, setD] = useState<Data | null>(null);
  const load = useCallback(() => api.get<Data>("/api/settings/plan").then(setD).catch((e) => toast.error((e as Error).message)), []);
  useEffect(() => { void load(); }, [load]);
  async function request(module?: ModuleKey) {
    const note = window.prompt(module ? `בקשת שדרוג: ${MODULE_LABEL[module]}. הערה (אופציונלי):` : "מה תרצו להוסיף לחבילה?") ?? null;
    if (note === null) return;
    try { await api.post("/api/access/upgrade-request", { module, note }); toast.success("הבקשה נשלחה למנהל הפלטפורמה"); } catch (e) { toast.error((e as Error).message); }
  }
  if (!d) return <Spinner />;
  const e = d.entitlement;
  return (
    <div className="space-y-4" data-testid="plan-overview">
      <Panel title="החבילה של העסק" actions={<Button size="sm" variant="secondary" onClick={() => request()} data-testid="upgrade-request">בקשת שדרוג</Button>}>
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <span>חבילה:</span><Badge tone="accent">{e.planName ? `${e.planName}${e.planVersion ? ` · גרסה ${e.planVersion}` : ""}` : "ללא חבילה מוגדרת (ברירת מחדל קודמת)"}</Badge>
          <span>סטטוס גישה:</span><Badge tone={e.suspended ? "bad" : e.accessStatus === "active" ? "good" : "warn"}>{ACCESS_STATUS_LABEL[e.accessStatus] ?? e.accessStatus}{e.accessUntil ? ` עד ${new Date(e.accessUntil).toLocaleDateString("he-IL")}` : ""}</Badge>
          <span>תשלום:</span><Badge>{e.billingStatus === "manual" ? "שיוך ידני – ללא סליקה" : e.billingStatus}</Badge>
        </div>
        <p className="text-xs text-muted mt-2">החבילה משתנה רק על ידי מנהל הפלטפורמה. סטטוס התשלום אינו מאומת אוטומטית – אין בשלב זה חיבור לסליקת מנויים.</p>
      </Panel>
      <Panel title="מודולים ומושבים" bodyClassName="p-0">
        <table className="w-full text-sm"><thead className="text-xs text-muted"><tr><th className="text-start p-2">מודול</th><th className="text-start">מצב</th><th className="text-start">מקור</th><th className="text-start">מושבים</th><th /></tr></thead>
          <tbody className="divide-y divide-line">{MODULES.map((m) => { const x = e.modules[m]; const s = d.seats[m]; return (
            <tr key={m} data-testid={`plan-module-${m}`}>
              <td className="p-2 font-medium">{MODULE_LABEL[m]}</td>
              <td>{x.included ? <Badge tone="good">כלול</Badge> : <Badge>לא כלול</Badge>}</td>
              <td className="text-xs text-muted">{x.sources.map((src) => `${SOURCE_LABEL[src.type] ?? src.type}${src.expiresAt ? ` (עד ${new Date(src.expiresAt).toLocaleDateString("he-IL")})` : ""}`).join(" + ") || "—"}</td>
              <td className="tabular">{x.included ? (s.seats === null ? `${s.used} בשימוש · ללא הגבלה` : `${s.used}/${s.seats} · ${s.free} פנויים`) : "—"}</td>
              <td className="p-2">{!x.included && <Button size="sm" variant="ghost" onClick={() => request(m)}>בקש מודול</Button>}</td>
            </tr>); })}</tbody></table>
      </Panel>
      <Panel title="שימוש ומכסות (החודש)">
        <ul className="text-sm space-y-2">{Object.entries(d.usage).map(([k, u]) => { const pct = u.limit ? Math.min(100, Math.round((u.used / u.limit) * 100)) : null; return (
          <li key={k}><div className="flex justify-between"><span>{u.label}</span><span className="tabular text-muted">{u.used}{u.limit !== null ? ` / ${u.limit}` : " (ללא הגבלה)"}</span></div>{pct !== null && <div className="h-1.5 bg-panel-2 rounded mt-1"><div className={pct > 90 ? "h-full bg-bad rounded" : "h-full bg-accent rounded"} style={{ width: `${pct}%` }} /></div>}</li>); })}</ul>
      </Panel>
    </div>
  );
}
