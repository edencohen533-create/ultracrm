"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/client/api";
import { Badge, Button, Modal, Spinner, Textarea, cx } from "@/components/ui";
import { useT } from "@/components/i18n/LangProvider";
import { DEPENDENCIES, MODULE_DESC, MODULE_LABEL, MODULES, SOURCE_LABEL, type ModuleKey } from "@/lib/access/catalog";

type Source = { type: string; expiresAt: string | null };
interface Ent { planName: string | null; planVersion: number | null; subscription?: { status: string } | null; modules: Record<ModuleKey, { included: boolean; seats: number | null; sources: Source[] }> }
interface Impact { modulesRemoved: ModuleKey[]; usersLosing: Record<string, Array<{ id: string; fullName: string }>>; seatOverflow: Record<string, { seats: number; holders: unknown[] }>; campaigns: Array<{ id: string; name: string; channel: string; status: string }>; journeys: Array<{ id: string; name: string }>; inboxAutomations: number; serviceAgent: boolean; dialerSessions: number; dialLists: number }
interface Preview { changes: Array<{ module: ModuleKey; to: boolean }>; blocked: Array<{ module: ModuleKey; reason: string }>; impact: Impact | null }

function Switch({ on, disabled, onChange, label }: { on: boolean; disabled?: boolean; onChange: () => void; label: string }) {
  return <button type="button" role="switch" aria-checked={on} aria-label={label} disabled={disabled} onClick={onChange} className={cx("relative inline-flex h-6 w-11 shrink-0 items-center rounded-full p-0.5 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-50", on ? "justify-end bg-good" : "justify-start bg-line")}><span className="h-5 w-5 rounded-full bg-white shadow" aria-hidden /></button>;
}

/**
 * Settings → package → "ניהול מודולים" (platform admin). Opens with the saved state (fresh from the server); each
 * switch says where the module comes from. A module that IS the package version / a paid subscription can't be
 * switched off here (that is a package / billing change). Save = preview (who and what is affected) → confirm.
 */
export function ModulesDialog({ businessId, onClose, onSaved }: { businessId: string; onClose: () => void; onSaved: () => void }) {
  const t = useT();
  const [ent, setEnt] = useState<Ent | null>(null); const [err, setErr] = useState("");
  const [want, setWant] = useState<Partial<Record<ModuleKey, boolean>>>({});
  const [preview, setPreview] = useState<Preview | null>(null); const [busy, setBusy] = useState(false);
  useEffect(() => { api.get<{ entitlement: Ent }>("/api/settings/plan").then((r) => { setEnt(r.entitlement); setWant(Object.fromEntries(MODULES.map((m) => [m, r.entitlement.modules[m].included]))); }).catch((e) => setErr((e as Error).message)); }, []);
  const lockedOff = (m: ModuleKey) => Boolean(ent && (ent.subscription || (ent.modules[m].included && ent.modules[m].sources.some((s) => s.type === "plan"))));
  const lockedOn = () => Boolean(ent?.subscription);
  const dirty = ent ? MODULES.filter((m) => want[m] !== ent.modules[m].included) : [];
  async function check() {
    setBusy(true);
    try { setPreview(await api.post<Preview>(`/api/platform/businesses/${businessId}/modules`, { modules: Object.fromEntries(dirty.map((m) => [m, want[m]])) })); }
    catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  }
  async function confirm() {
    setBusy(true);
    try {
      await api.post(`/api/platform/businesses/${businessId}/modules`, { modules: Object.fromEntries(dirty.map((m) => [m, want[m]])), confirm: true });
      toast.success(t("המודולים עודכנו – הגישה משתנה מיד. לא נוצר חיוב או זיכוי.", "Modules updated – access changes right away. No charge or credit was created."));
      onSaved(); onClose();
    } catch (e) { toast.error((e as Error).message); setPreview(null); } finally { setBusy(false); }
  }
  const imp = preview?.impact;
  const hasImpact = Boolean(imp && (imp.modulesRemoved.length || Object.keys(imp.seatOverflow).length));
  return (
    <Modal open onClose={() => !busy && onClose()} width="max-w-2xl" title={t("ניהול מודולים בחבילת העסק", "Manage the business's modules")}
      footer={preview ? <><Button variant="ghost" onClick={() => setPreview(null)} disabled={busy}>{t("חזרה", "Back")}</Button><Button onClick={confirm} loading={busy} disabled={busy || preview.blocked.length > 0 || !preview.changes.length || Boolean(imp && Object.keys(imp.seatOverflow).length)} data-testid="modules-confirm">{t("אישור ושמירה", "Confirm & save")}</Button></>
        : <><Button variant="ghost" onClick={onClose} disabled={busy}>{t("ביטול", "Cancel")}</Button><Button onClick={check} loading={busy} disabled={busy || !dirty.length} data-testid="modules-save">{t("שמירה", "Save")}</Button></>}>
      {err ? <p role="alert" className="text-sm text-bad">{err}</p> : !ent ? <div className="flex justify-center p-8"><Spinner /></div> : preview ? (
        <div className="space-y-3 text-sm" data-testid="modules-preview">
          <p className="font-medium">{t("מה ישתנה:", "What will change:")}</p>
          <ul className="list-disc ps-5">{preview.changes.map((c) => <li key={c.module}>{MODULE_LABEL[c.module]} – {c.to ? t("יתווסף לחבילה", "added to the package") : t("יוסר מהחבילה", "removed from the package")}</li>)}</ul>
          {preview.blocked.length > 0 && <div role="alert" className="rounded-md border border-bad/40 bg-bad/10 p-2 text-xs">{preview.blocked.map((b) => <p key={b.module}><b>{MODULE_LABEL[b.module]}:</b> {b.reason}</p>)}</div>}
          {hasImpact && imp && <div className="rounded-md border border-warn/40 bg-warn/10 p-2 text-xs space-y-1" data-testid="modules-impact">
            {imp.modulesRemoved.map((m) => <p key={m}><b>{MODULE_LABEL[m]}</b>: {imp.usersLosing[m]?.length ? t(`${imp.usersLosing[m].length} משתמשים יאבדו גישה (${imp.usersLosing[m].map((u) => u.fullName).join(", ")})`, `${imp.usersLosing[m].length} users lose access (${imp.usersLosing[m].map((u) => u.fullName).join(", ")})`) : t("אין משתמשים עם גישה פעילה", "No users with active access")}</p>)}
            {imp.campaigns.length > 0 && <p>{t(`${imp.campaigns.length} קמפיינים מתוזמנים / רצים ייעצרו לפני השליחה הבאה: `, `${imp.campaigns.length} scheduled / running campaigns stop before their next send: `)}{imp.campaigns.map((c) => c.name).join(", ")}</p>}
            {imp.journeys.length > 0 && <p>{t(`${imp.journeys.length} מסעות לקוח פעילים לא ישלחו בערוץ שהוסר: `, `${imp.journeys.length} active journeys won't send on the removed channel: `)}{imp.journeys.map((j) => j.name).join(", ")}</p>}
            {imp.inboxAutomations > 0 && <p>{t(`${imp.inboxAutomations} אוטומציות של תיבת השיחות יפסיקו לפעול.`, `${imp.inboxAutomations} inbox automations stop.`)}</p>}
            {imp.serviceAgent && <p>{t("סוכן השירות (AI) בוואטסאפ ייעצר.", "The WhatsApp AI service agent stops.")}</p>}
            {(imp.dialerSessions > 0 || imp.dialLists > 0) && <p>{t(`חייגן: ${imp.dialerSessions} סשנים פתוחים ו-${imp.dialLists} רשימות חיוג פעילות לא יוכלו להמשיך לחייג. שיחה פעילה לא מנותקת.`, `Dialer: ${imp.dialerSessions} open sessions and ${imp.dialLists} active dial lists can't keep dialing. A live call isn't cut.`)}</p>}
            {Object.keys(imp.seatOverflow).length > 0 && <p className="text-bad">{t("חריגה ממכסת מושבים – יש לבחור מי נשאר עם גישה במסך ניהול הפלטפורמה.", "Seat overflow – choose who keeps access in the platform administration screen.")}</p>}
          </div>}
          <p className="text-xs text-muted">{t("הנתונים הקיימים (אנשי קשר, שיחות, קמפיינים, הקלטות) לא נמחקים, ומודול שיוחזר יציג אותם שוב. הרשאות המשתמשים במודול שהוסר נסגרות – החזרת המודול לא פותחת אותן מעצמה. השינוי מעדכן גישה בלבד – לא נוצר חיוב או זיכוי.", "Existing data (contacts, calls, campaigns, recordings) is not deleted, and a module that comes back shows it again. Users' permissions in a removed module are closed – bringing the module back doesn't reopen them by itself. This changes access only – no charge or credit is created.")}</p>
        </div>
      ) : (
        <div className="space-y-2" data-testid="modules-dialog">
          <p className="text-xs text-muted">{t(`חבילה: ${ent.planName ?? "ללא חבילה מוגדרת"}${ent.planVersion ? ` · גרסה ${ent.planVersion}` : ""}. מודול שמגיע מגרסת החבילה עצמה לא מוסר כאן – זה שינוי חבילה.`, `Package: ${ent.planName ?? "none"}${ent.planVersion ? ` · version ${ent.planVersion}` : ""}. A module that comes from the package version itself isn't removed here – that's a package change.`)}</p>
          {ent.subscription && <p role="status" className="rounded-md border border-warn/40 bg-warn/10 p-2 text-xs">{t("לעסק יש מנוי משולם – המודולים נקבעים לפי המנוי (חיוב ושימוש) ולא ניתן לשנות אותם כאן.", "The business has a paid subscription – modules follow it (Billing & usage) and can't be changed here.")}</p>}
          <ul className="divide-y divide-line rounded-lg border border-line">
            {MODULES.map((m) => { const x = ent.modules[m]; const on = Boolean(want[m]); const dep = DEPENDENCIES.find((d) => d.module === m); const lock = on ? lockedOff(m) : lockedOn(); return (
              <li key={m} className="flex items-start gap-3 p-3" data-testid={`module-row-${m}`}>
                <Switch on={on} disabled={lock || busy} onChange={() => setWant((w) => ({ ...w, [m]: !w[m] }))} label={MODULE_LABEL[m]} />
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2 text-sm font-medium">{MODULE_LABEL[m]}{x.included ? <Badge tone="good">{t("כלול כעת", "Included now")}</Badge> : <Badge>{t("לא כלול כעת", "Not included now")}</Badge>}{on !== x.included && <Badge tone="warn">{on ? t("יתווסף", "Will be added") : t("יוסר", "Will be removed")}</Badge>}</p>
                  <p className="text-xs text-muted">{MODULE_DESC[m]}</p>
                  {x.sources.length > 0 && <p className="text-[11px] text-muted">{t("מקור:", "Source:")} {x.sources.map((s) => SOURCE_LABEL[s.type] ?? s.type).join(" + ")}</p>}
                  {lock && on && <p className="text-[11px] text-warn">{ent.subscription ? t("נקבע לפי המנוי המשולם.", "Set by the paid subscription.") : t("חלק מגרסת החבילה – להסרה יש להחליף גרסת חבילה (ניהול הפלטפורמה).", "Part of the package version – switch the package version to remove it (platform administration).")}</p>}
                  {dep && <p className="text-[11px] text-muted">{dep.note}</p>}
                </div>
              </li>); })}
          </ul>
        </div>
      )}
    </Modal>
  );
}

/** Business owner / manager without platform rights: ask for modules (recorded for the platform admin – the package doesn't change). */
export function UpgradeRequestDialog({ included, onClose }: { included: Record<ModuleKey, boolean>; onClose: () => void }) {
  const t = useT();
  const [pick, setPick] = useState<ModuleKey[]>([]); const [note, setNote] = useState(""); const [busy, setBusy] = useState(false);
  const missing = MODULES.filter((m) => !included[m]);
  async function send() {
    setBusy(true);
    try { await api.post("/api/access/upgrade-request", { modules: pick, note: note.trim() || undefined }); toast.success(t("הבקשה נשלחה למנהל הפלטפורמה. החבילה לא שונתה עד שהוא יאשר.", "Request sent to the platform admin. The package doesn't change until they approve it.")); onClose(); }
    catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  }
  return (
    <Modal open onClose={() => !busy && onClose()} title={t("בקשת שדרוג חבילה", "Request a package upgrade")}
      footer={<><Button variant="ghost" onClick={onClose} disabled={busy}>{t("ביטול", "Cancel")}</Button><Button onClick={send} loading={busy} disabled={busy || (!pick.length && !note.trim())} data-testid="upgrade-send">{t("שליחת בקשה", "Send request")}</Button></>}>
      <div className="space-y-3 text-sm" data-testid="upgrade-dialog">
        <p className="text-xs text-muted">{t("החבילה משתנה רק על ידי מנהל הפלטפורמה. הבקשה נרשמת אצלו – שום דבר לא משתנה עד שהוא מאשר.", "Only the platform admin changes the package. The request is recorded for them – nothing changes until they approve.")}</p>
        {missing.length ? <ul className="space-y-2">{missing.map((m) => <li key={m}><label className="flex items-start gap-2"><input type="checkbox" className="mt-1" checked={pick.includes(m)} onChange={(e) => setPick((p) => e.target.checked ? [...p, m] : p.filter((x) => x !== m))} data-testid={`upgrade-pick-${m}`} /><span><b>{MODULE_LABEL[m]}</b><span className="block text-xs text-muted">{MODULE_DESC[m]}</span></span></label></li>)}</ul> : <p className="text-xs">{t("כל המודולים כבר כלולים בחבילה.", "All modules are already included.")}</p>}
        <Textarea label={t("הערה (אופציונלי) – למשל מספר משתמשים או מועד", "Note (optional) – e.g. number of users or timing")} rows={3} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
      </div>
    </Modal>
  );
}
