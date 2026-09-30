"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/client/api";
import { Badge, Button, Input, Panel, Spinner, Textarea } from "@/components/ui";
import { useT } from "@/components/i18n/LangProvider";

interface Ops { alerts: Array<{ id: string; severity: string; category: string; title: string; businessName: string | null; count: number; lastSeenAt: string; status: string; details: Record<string, unknown> }>; tickets: Array<{ id: string; code: string; message: string; status: string; createdAt: string; businessName: string | null; context: Record<string, unknown> }>; drills: Array<{ id: string; kind: string; environment: string; result: string; finishedAt: string; details: { problems?: string[]; tables?: Record<string, unknown>; safety?: Record<string, number>; notCovered?: string[] } }>; reconciliation: Array<{ id: string; provider: string; periodStart: string; periodEnd: string; currency: string; summary: Record<string, number | string>; createdAt: string }>; counters: Record<string, number> }
interface Versions { versions: Array<{ id: string; version: number; status: string; currency: string; licenseItems: Array<{ code: string; name: string; unitPriceMinor: number; kind: string }>; usageRates: Array<{ service: string; unitPriceMinor: number | null }>; taxRateBps: number; publishedAt: string | null; note: string | null }>; services: Array<{ service: string; unit: string; label: string }> }
const dt = (s: string) => new Date(s).toLocaleString("he-IL", { dateStyle: "short", timeStyle: "short" });
const tone = (s: string) => (s === "critical" ? "bad" : s === "warning" ? "warn" : "neutral") as "bad" | "warn" | "neutral";

/** Platform operations: unified alerts, support tickets, restore drills, provider reconciliation, price book. */
export function PlatformOps() {
  const t = useT();
  const [o, setO] = useState<Ops | null>(null); const [v, setV] = useState<Versions | null>(null);
  const [rec, setRec] = useState({ provider: "telnyx", periodStart: "", periodEnd: "", currency: "USD", csv: "providerRef,quantity,costMinor,businessRef\n" });
  const load = useCallback(async () => { try { setO(await api.get<Ops>("/api/platform/ops")); setV(await api.get<Versions>("/api/platform/pricebook")); } catch (e) { toast.error((e as Error).message); } }, []);
  useEffect(() => { void load(); }, [load]);
  if (!o || !v) return <div className="p-10 flex justify-center"><Spinner /></div>;
  const lastDrill = o.drills[0];
  return (
    <div className="p-4 md:p-5 space-y-4 max-w-6xl" data-testid="platform-ops">
      <div className="flex items-center gap-2"><a href="/platform" className="text-xs text-muted">{t("→ ניהול הפלטפורמה", "← Platform")}</a><h1 className="text-lg font-semibold">{t("תפעול הפלטפורמה", "Platform operations")}</h1></div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-sm">
        <div className="rounded-lg border border-line p-2"><p className="text-xs text-muted">{t("התראות פתוחות", "Open alerts")}</p><p className="font-semibold">{o.alerts.filter((a) => a.status === "open").length}</p></div>
        <div className="rounded-lg border border-line p-2"><p className="text-xs text-muted">{t("אירועים תקועים", "Stuck events")}</p><p className="font-semibold">{o.counters.stuckEvents}</p></div>
        <div className="rounded-lg border border-line p-2"><p className="text-xs text-muted">{t("שימוש ללא תעריף (24ש׳)", "Unrated usage (24h)")}</p><p className="font-semibold">{o.counters.unratedUsage24h}</p></div>
        <div className="rounded-lg border border-line p-2" data-testid="ops-last-drill"><p className="text-xs text-muted">{t("בדיקת שחזור אחרונה", "Last restore test")}</p>{lastDrill ? <p className="font-semibold">{lastDrill.result === "ok" ? "✓" : "✗"} {dt(lastDrill.finishedAt)}</p> : <p className="font-semibold text-bad">{t("לא בוצעה", "Never run")}</p>}</div>
      </div>

      <Panel title={t("התראות (מאוחדות – אותה תקלה נספרת בשורה אחת)", "Alerts (one row per problem)")}>
        {o.alerts.length === 0 ? <p className="text-sm text-muted">{t("אין התראות.", "No alerts.")}</p> : <ul className="divide-y divide-line text-sm" data-testid="ops-alerts">{o.alerts.map((a) => <li key={a.id} className="py-1.5 flex flex-wrap items-center gap-2"><Badge tone={tone(a.severity)}>{a.severity}</Badge><span className={a.status === "resolved" ? "text-muted line-through" : ""}>{a.title}</span>{a.businessName && <span className="text-xs text-muted">{a.businessName}</span>}<span className="text-xs text-muted">×{a.count} · {dt(a.lastSeenAt)}</span><span className="text-xs text-muted ltr">{JSON.stringify(a.details).slice(0, 80)}</span>{a.status === "open" && <div className="ms-auto flex gap-1"><Button size="sm" variant="ghost" onClick={async () => { await api.patch(`/api/platform/ops/alerts/${a.id}`, { status: "acknowledged" }); await load(); }}>{t("טופל", "Ack")}</Button><Button size="sm" variant="ghost" onClick={async () => { await api.patch(`/api/platform/ops/alerts/${a.id}`, { status: "resolved" }); await load(); }}>{t("סגור", "Resolve")}</Button></div>}</li>)}</ul>}
      </Panel>

      <Panel title={t("פניות מתוך המערכת", "In-app support tickets")}>
        {o.tickets.length === 0 ? <p className="text-sm text-muted">{t("אין פניות.", "No tickets.")}</p> : <ul className="divide-y divide-line text-sm" data-testid="ops-tickets">{o.tickets.map((x) => <li key={x.id} className="py-1.5"><b className="ltr">{x.code}</b> · {x.businessName} · {dt(x.createdAt)} · <Badge tone="neutral">{x.status}</Badge><p className="text-xs">{x.message}</p><p className="text-[11px] text-muted ltr text-start">{JSON.stringify(x.context).slice(0, 300)}</p></li>)}</ul>}
      </Panel>

      <Panel title={t("גיבוי ושחזור", "Backup & restore")}>
        <p className="text-xs text-muted mb-2">{t("\"תקין\" מוצג רק לפי בדיקת שחזור שבוצעה בפועל (scripts/restore-drill.mjs), לא לפי הגדרת גיבוי.", "\"OK\" is shown only from a restore test that actually ran (scripts/restore-drill.mjs), never from a backup setting.")}</p>
        {o.drills.length === 0 ? <p className="text-sm text-bad">{t("לא בוצעה בדיקת שחזור.", "No restore test yet.")}</p> : <ul className="text-sm space-y-2" data-testid="ops-drills">{o.drills.map((d) => <li key={d.id}><Badge tone={d.result === "ok" ? "good" : "bad"}>{d.result}</Badge> {dt(d.finishedAt)} · {d.environment} · {t("טבלאות", "tables")} {Object.keys(d.details.tables ?? {}).length}{d.details.problems?.length ? <span className="text-bad"> · {d.details.problems.slice(0, 3).join("; ")}</span> : null}{d.details.notCovered && <p className="text-xs text-muted">{t("לא מכוסה בגיבוי בסיס הנתונים:", "Not covered by the database backup:")} {d.details.notCovered.join(" · ")}</p>}</li>)}</ul>}
      </Panel>

      <Panel title={t("התאמה לדוחות ספקים", "Provider reconciliation")}>
        <div className="grid md:grid-cols-4 gap-2 text-sm">
          <Input label={t("ספק", "Provider")} value={rec.provider} onChange={(e) => setRec({ ...rec, provider: e.target.value })} ltr />
          <Input label={t("מתאריך", "From")} type="date" value={rec.periodStart} onChange={(e) => setRec({ ...rec, periodStart: e.target.value })} ltr />
          <Input label={t("עד (לא כולל)", "To (exclusive)")} type="date" value={rec.periodEnd} onChange={(e) => setRec({ ...rec, periodEnd: e.target.value })} ltr />
          <Input label={t("מטבע הדוח", "Report currency")} value={rec.currency} onChange={(e) => setRec({ ...rec, currency: e.target.value.toUpperCase() })} ltr />
        </div>
        <Textarea rows={4} className="mt-2 ltr" value={rec.csv} onChange={(e) => setRec({ ...rec, csv: e.target.value })} aria-label="CSV" />
        <Button size="sm" className="mt-2" onClick={async () => { try { const r = await api.post<{ summary: Record<string, number> }>("/api/platform/reconciliation", rec); toast.success(JSON.stringify(r.summary).slice(0, 120)); await load(); } catch (e) { toast.error((e as Error).message); } }} disabled={!rec.periodStart || !rec.periodEnd}>{t("השוואה", "Compare")}</Button>
        <ul className="text-xs mt-2 space-y-1" data-testid="ops-recon">{o.reconciliation.map((r) => <li key={r.id}>{r.provider} · {r.periodStart.slice(0, 10)}–{r.periodEnd.slice(0, 10)} · {r.currency} · <span className="ltr">{JSON.stringify(r.summary)}</span></li>)}</ul>
        <p className="text-[11px] text-muted mt-1">{t("ממצאים בלבד – תיקון נעשה ברישום התאמה מפורש; מסמכים שהופקו לא משתנים. מטבעות שונים לא נסכמים.", "Findings only – a correction is an explicit adjustment; issued documents never change. Currencies are never summed together.")}</p>
      </Panel>

      <Panel title={t("מחירון (גרסאות)", "Price book (versions)")}>
        <p className="text-xs text-warn mb-2">{t("פרסום גרסה קובע את מחירי הרכישות החדשות בלבד. אין לפרסם ללקוחות אמיתיים בלי החלטה עסקית; מנויים קיימים ומסמכים שהופקו לא משתנים.", "Publishing sets prices for NEW purchases only. Don't publish to real customers without a business decision; existing subscriptions and issued documents never change.")}</p>
        <ul className="space-y-2 text-sm" data-testid="ops-pricebook">{v.versions.map((x) => <li key={x.id} className="rounded-lg border border-line p-2"><b>v{x.version}</b> <Badge tone={x.status === "published" ? "good" : "neutral"}>{x.status}</Badge> {x.note && <span className="text-xs text-muted">{x.note}</span>}<p className="text-xs">{x.licenseItems.map((i) => `${i.name} ₪${(i.unitPriceMinor / 100).toFixed(0)}`).join(" · ")} · {t("מע״מ", "VAT")} {x.taxRateBps / 100}%</p><p className="text-xs text-muted">{t("תעריפי שימוש:", "Usage rates:")} {v.services.map((s) => { const r = x.usageRates.find((u) => u.service === s.service); return `${s.label}: ${r?.unitPriceMinor !== undefined && r?.unitPriceMinor !== null ? `${r.unitPriceMinor / 100}₪/${s.unit}` : t("ללא תעריף (חסום מסחרית)", "no rate (blocked)")}`; }).join(" · ")}</p>{x.status === "draft" && <Button size="sm" variant="secondary" onClick={async () => { if (!window.confirm(t(`לפרסם את v${x.version}? היא תחול על רכישות חדשות בלבד.`, `Publish v${x.version}? New purchases only.`))) return; try { await api.post(`/api/platform/pricebook/${x.id}/publish`, {}); await load(); } catch (e) { toast.error((e as Error).message); } }}>{t("פרסום", "Publish")}</Button>}</li>)}</ul>
      </Panel>
    </div>
  );
}
