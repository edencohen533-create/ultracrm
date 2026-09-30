"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/client/api";
import { Badge, Button, Input, Panel, Spinner } from "@/components/ui";
import { useT } from "@/components/i18n/LangProvider";

interface O { business: { name: string; deletionScheduledFor: string | null; accessStatus: string }; subscription: { status: string; currentPeriodEnd: string | null; cancelAtPeriodEnd: boolean } | null; connections: Array<{ key: string; label: string; active: number; href: string }>; futureActions: Record<string, number>; options: Array<{ key: string; title: string; what: string; deleted: string; kept: string }>; retentionPolicy: Record<string, string | number> }

/** ייצוא וסיום התקשרות – export, disconnect, stop future actions; cancel ≠ delete user ≠ delete business. */
export function OffboardingScreen() {
  const t = useT(); const [o, setO] = useState<O | null>(null); const [name, setName] = useState(""); const [busy, setBusy] = useState(false);
  const load = () => api.get<O>("/api/business/offboarding").then(setO).catch((e) => toast.error((e as Error).message));
  useEffect(() => { void load(); }, []);
  if (!o) return <div className="p-10 flex justify-center"><Spinner /></div>;
  const FA: Record<string, string> = { scheduledCampaigns: "קמפיינים מתוזמנים / פעילים", activeDialLists: "רשימות חיוג פעילות", activeAutomations: "אוטומציות פעילות", runningSequences: "רצפים פעילים" };
  return (
    <div className="p-4 md:p-5 space-y-3 max-w-3xl" data-testid="offboarding">
      <h1 className="text-lg font-semibold">{t("ייצוא וסיום התקשרות", "Export & offboarding")}</h1>
      <Panel title={t("1. ייצוא נתוני העסק", "1. Export the business's data")}><p className="text-sm text-muted mb-2">{t("קובץ ZIP עם טבלאות CSV (אנשי קשר, לידים, עסקאות, שיחות, הודעות, משימות, שימוש, מסמכי חיוב). הקלטות וקבצים – קישורים מאובטחים שדורשים התחברות.", "A ZIP of CSV tables. Recordings and files – secure links that require signing in.")}</p><a className="inline-flex items-center h-9 px-4 rounded-lg bg-accent text-white text-sm" href="/api/business/export" data-testid="export-download">{t("הורדת ייצוא", "Download export")}</a></Panel>
      <Panel title={t("2. ניתוק חיבורים", "2. Disconnect connections")}><ul className="text-sm space-y-1">{o.connections.map((c) => <li key={c.key} className="flex items-center gap-2">{c.label} <Badge tone={c.active ? "warn" : "neutral"}>{c.active ? t(`${c.active} פעילים`, `${c.active} active`) : t("לא מחובר", "Not connected")}</Badge>{c.active > 0 && <Link className="text-xs underline" href={c.href}>{t("לניתוק", "Disconnect")}</Link>}</li>)}</ul></Panel>
      <Panel title={t("3. עצירת פעולות עתידיות", "3. Stop future actions")}>
        <ul className="text-sm mb-2">{Object.entries(o.futureActions).map(([k, v]) => <li key={k}>{FA[k] ?? k}: <b>{v}</b></li>)}</ul>
        <div className="flex flex-wrap items-end gap-2"><Input label={t(`להקלדת שם העסק לאישור: ${o.business.name}`, `Type the business name to confirm: ${o.business.name}`)} value={name} onChange={(e) => setName(e.target.value)} className="w-72" /><Button variant="danger" disabled={busy || name.trim() !== o.business.name.trim()} onClick={async () => { setBusy(true); try { const r = await api.post<Record<string, number>>("/api/business/offboarding/stop", { confirmName: name }); toast.success(t(`נעצר: ${Object.values(r).reduce((a, b) => a + b, 0)} פריטים`, "Stopped")); setName(""); await load(); } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); } }} data-testid="offboarding-stop">{t("עצירת כל הפעולות העתידיות", "Stop all future actions")}</Button></div>
      </Panel>
      <Panel title={t("4. מה בדיוק אפשר לסיים", "4. What can be ended")}>
        <div className="space-y-3 text-sm" data-testid="offboarding-options">{o.options.map((x) => <div key={x.key} className="rounded-lg border border-line p-3"><p className="font-semibold">{x.title}</p><p>{x.what}</p><p className="text-xs"><b>{t("נמחק:", "Deleted:")}</b> {x.deleted}</p><p className="text-xs"><b>{t("נשמר:", "Kept:")}</b> {x.kept}</p>{x.key === "cancel_subscription" && <Link className="text-xs underline" href="/settings/billing">{t("לחיוב ושימוש", "Billing & usage")}</Link>}{x.key === "delete_business" && <Link className="text-xs underline" href="/settings?tab=account">{t("למחיקת העסק (דורש הקלדת שם)", "Delete business (type the name)")}</Link>}</div>)}</div>
      </Panel>
      <Panel title={t("מדיניות שמירה", "Retention")}><ul className="text-xs space-y-1">{Object.entries(o.retentionPolicy).map(([k, v]) => <li key={k}><b>{k}</b>: {String(v)}</li>)}</ul><p className="text-[11px] text-muted mt-1">{t("תקופות שלא הוגדרו מסומנות \"דורש החלטת בעל המערכת\" – לא נקבעו כאן תקופות משפטיות.", "Undefined periods are marked as requiring the platform owner's decision – no legal periods are set here.")}</p></Panel>
    </div>
  );
}
