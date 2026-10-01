"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/client/api";
import { Badge, Button, Panel, Spinner } from "@/components/ui";
import { useT } from "@/components/i18n/LangProvider";
import { ModulesDialog, UpgradeRequestDialog } from "./ModulesDialog";
import { ACCESS_STATUS_LABEL, MODULE_LABEL, MODULES, QUOTA_LABEL, SOURCE_LABEL, type ModuleKey, type QuotaMetric } from "@/lib/access/catalog";

interface Ent { planName: string | null; planVersion: number | null; accessStatus: string; accessUntil: string | null; billingStatus: string; suspended: boolean; modules: Record<ModuleKey, { included: boolean; seats: number | null; sources: Array<{ type: string; expiresAt: string | null }> }> }
interface Data { entitlement: Ent; seats: Record<ModuleKey, { included: boolean; seats: number | null; used: number; free: number | null }>; usage: Record<string, { used: number; limit: number | null; label: string }> }

/** Business side: read-only package overview (the package is changed by the platform admin only) + upgrade request. */
export function PlanOverview() {
  const t = useT();
  const loc = t.lang === "en" ? "en-GB" : "he-IL";
  const [d, setD] = useState<Data | null>(null);
  const load = useCallback(() => api.get<Data>("/api/settings/plan").then(setD).catch((e) => toast.error((e as Error).message)), []);
  useEffect(() => { void load(); }, [load]);
  // Platform admin: manage the modules; anyone else with this screen: a structured upgrade request (no free text box).
  const [me, setMe] = useState<{ business?: { id: string } | null; platformAdmin?: boolean } | null>(null);
  useEffect(() => { api.get<{ business?: { id: string } | null; platformAdmin?: boolean }>("/api/auth/me").then(setMe).catch(() => setMe({})); }, []);
  const [dialog, setDialog] = useState<null | "manage" | "request">(null);
  const [requested, setRequested] = useState<ModuleKey | null>(null);
  const request = (module?: ModuleKey) => { setRequested(module ?? null); setDialog("request"); };
  if (!d) return <Spinner />;
  const e = d.entitlement;
  return (
    <div className="space-y-4" data-testid="plan-overview">
      {dialog === "manage" && me?.business?.id && <ModulesDialog businessId={me.business.id} onClose={() => setDialog(null)} onSaved={() => { void load(); }} />}
      {dialog === "request" && <UpgradeRequestDialog initial={requested} included={Object.fromEntries(MODULES.map((m) => [m, d.entitlement.modules[m].included])) as Record<ModuleKey, boolean>} onClose={() => setDialog(null)} />}
      <Panel title={t("החבילה של העסק", "Business plan")} actions={me?.platformAdmin && me.business?.id ? <Button size="sm" onClick={() => setDialog("manage")} data-testid="modules-manage">{t("ניהול מודולים", "Manage modules")}</Button> : <Button size="sm" variant="secondary" onClick={() => request()} data-testid="upgrade-request">{t("בקשת שדרוג", "Request upgrade")}</Button>}>
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <span>{t("חבילה:", "Plan:")}</span><Badge tone="accent">{e.planName ? `${e.planName}${e.planVersion ? t(` · גרסה ${e.planVersion}`, ` · Version ${e.planVersion}`) : ""}` : t("ללא חבילה מוגדרת (ברירת מחדל קודמת)", "No plan defined (legacy default)")}</Badge>
          <span>{t("סטטוס גישה:", "Access status:")}</span><Badge tone={e.suspended ? "bad" : e.accessStatus === "active" ? "good" : "warn"}>{ACCESS_STATUS_LABEL[e.accessStatus] ?? e.accessStatus}{e.accessUntil ? t(` עד ${new Date(e.accessUntil).toLocaleDateString(loc)}`, ` until ${new Date(e.accessUntil).toLocaleDateString(loc)}`) : ""}</Badge>
          <span>{t("תשלום:", "Billing:")}</span><Badge>{e.billingStatus === "manual" ? t("שיוך ידני – ללא סליקה", "Manual assignment – no billing") : e.billingStatus}</Badge>
        </div>
        <p className="text-xs text-muted mt-2">{t("החבילה משתנה רק על ידי מנהל הפלטפורמה (״ניהול מודולים״ מוצג רק לו). סטטוס התשלום אינו מאומת אוטומטית – אין בשלב זה חיבור לסליקת מנויים.", "The plan can only be changed by the platform admin. Billing status is not verified automatically – there is no subscription billing integration yet.")}</p>
      </Panel>
      <Panel title={t("מודולים ומושבים", "Modules and seats")} bodyClassName="p-0">
        <table className="w-full text-sm"><thead className="text-xs text-muted"><tr><th className="text-start p-2">{t("מודול", "Module")}</th><th className="text-start">{t("מצב", "Status")}</th><th className="text-start">{t("מקור", "Source")}</th><th className="text-start">{t("מושבים", "Seats")}</th><th /></tr></thead>
          <tbody className="divide-y divide-line">{MODULES.map((m) => { const x = e.modules[m]; const s = d.seats[m]; return (
            <tr key={m} data-testid={`plan-module-${m}`}>
              <td className="p-2 font-medium">{MODULE_LABEL[m]}</td>
              <td>{x.included ? <Badge tone="good">{t("כלול", "Included")}</Badge> : <Badge>{t("לא כלול", "Not included")}</Badge>}</td>
              <td className="text-xs text-muted">{x.sources.map((src) => `${SOURCE_LABEL[src.type] ?? src.type}${src.expiresAt ? t(` (עד ${new Date(src.expiresAt).toLocaleDateString(loc)})`, ` (until ${new Date(src.expiresAt).toLocaleDateString(loc)})`) : ""}`).join(" + ") || "—"}</td>
              <td className="tabular">{x.included ? (s.seats === null ? t(`${s.used} בשימוש · ללא הגבלה`, `${s.used} in use · Unlimited`) : t(`${s.used}/${s.seats} · ${s.free} פנויים`, `${s.used}/${s.seats} · ${s.free} free`)) : "—"}</td>
              <td className="p-2">{!x.included && !me?.platformAdmin && <Button size="sm" variant="ghost" onClick={() => request(m)}>{t("בקש מודול", "Request module")}</Button>}</td>
            </tr>); })}</tbody></table>
      </Panel>
      <Panel title={t("שימוש ומכסות (החודש)", "Usage and quotas (this month)")}>
        <ul className="text-sm space-y-2">{Object.entries(d.usage).map(([k, u]) => { const pct = u.limit ? Math.min(100, Math.round((u.used / u.limit) * 100)) : null; return (
          <li key={k}><div className="flex justify-between"><span>{QUOTA_LABEL[k as QuotaMetric] ?? u.label}</span><span className="tabular text-muted">{u.used}{u.limit !== null ? ` / ${u.limit}` : t(" (ללא הגבלה)", " (unlimited)")}</span></div>{pct !== null && <div className="h-1.5 bg-panel-2 rounded mt-1"><div className={pct > 90 ? "h-full bg-bad rounded" : "h-full bg-accent rounded"} style={{ width: `${pct}%` }} /></div>}</li>); })}</ul>
      </Panel>
    </div>
  );
}
