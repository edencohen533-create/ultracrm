"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { ExternalLink, Plus, RefreshCw } from "lucide-react";
import { api } from "@/lib/client/api";
import { Badge, Button, EmptyState, Input, Modal, Panel, Select, Spinner, cx } from "@/components/ui";
import { formatDateTime } from "@/lib/client/format";
import { useT } from "@/components/i18n/LangProvider";

type Conn = { id: string; datasetId: string; datasetName: string | null; tokenHint: string | null; enabled: boolean; testEventCode: string | null; status: string; lastError: string | null; lastCheckedAt: string | null; leadEventSource: string; siteSendsPurchase: boolean };
type Rule = { id: string; name: string; trigger: string; triggerConfig: { statusId?: string; field?: string; fieldValue?: string }; conditions: { campaignId?: string; product?: string; source?: string }; eventKind: "standard" | "custom"; eventName: string; actionSource: string; valueSource: string; valueField: string | null; fixedValue: number | null; currency: string | null; valueIncludes: { vat?: boolean; shipping?: boolean; discounts?: boolean }; resend: "once" | "every"; enabled: boolean };
type Overview = { connection: Conn | null; rules: Rule[]; statuses: Array<{ id: string; label: string; kind: string; active: boolean }>; fields: string[]; adsConnection: { status: string; scopes: string[] } | null; counts: Record<string, number>; eventsManagerUrl: string;
  vocabulary: { triggers: Record<string, string>; actionSources: Record<string, string>; valueSources: Record<string, string>; standardEvents: string[]; templates: Array<{ key: string; name: string; trigger: string; eventKind: "standard" | "custom"; eventName: string; actionSource: string; valueSource: string; note: string }> } };
type Ev = { id: string; eventName: string; eventId: string; occurredAt: string; entityType: string; entityId: string; contactId: string | null; contactName: string | null; value: number | null; currency: string | null; status: string; statusReason: string | null; attempts: number; lastError: string | null; testCode: string | null; receivedAt: string | null; rule: { id: string; name: string } | null };
type T = ReturnType<typeof useT>;

const EV_STATUS: Record<string, [string, "neutral" | "info" | "warn" | "good" | "bad"]> = { pending_data: ["ממתין להשלמת נתונים", "warn"], queued: ["בתור", "info"], sending: ["בשליחה", "info"], received: ["התקבל ב-API", "good"], failed: ["נכשל", "bad"], expired: ["פג תוקף (מעל 7 ימים)", "neutral"], skipped: ["לא נשלח", "neutral"] };
const CONN_STATUS: Record<string, [string, "neutral" | "good" | "bad" | "warn"]> = { unverified: ["לא נבדק", "warn"], ok: ["החיבור תקין", "good"], revoked: ["אין הרשאה / הטוקן בוטל", "bad"], error: ["שגיאה", "bad"] };

/** "המרות למטא": Conversions API connection, no-code event rules, and the send log. */
export function MetaConversions({ canManage }: { canManage: boolean }) {
  const t = useT();
  const [o, setO] = useState<Overview | null>(null);
  const [tab, setTab] = useState<"connection" | "rules" | "log">("connection");
  const load = useCallback(async () => { try { setO(await api.get<Overview>("/api/marketing/capi")); } catch (e) { toast.error((e as Error).message); } }, []);
  useEffect(() => { void load(); }, [load]);
  if (!o) return <div className="flex justify-center p-10"><Spinner /></div>;
  return (
    <div className="space-y-4 p-4 md:p-5" data-testid="meta-conversions">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-semibold">{t("המרות למטא", "Conversions to Meta")}</h1>
        {o.connection ? <Badge tone={CONN_STATUS[o.connection.status]?.[1] ?? "neutral"}>{CONN_STATUS[o.connection.status]?.[0] ?? o.connection.status}</Badge> : <Badge tone="warn">{t("לא מחובר", "Not connected")}</Badge>}
        {o.connection && <Badge tone={o.connection.enabled ? "good" : "neutral"} data-testid="capi-sending-badge">{o.connection.enabled ? t("שליחה פעילה", "Sending on") : t("שליחה מושהית", "Sending paused")}</Badge>}
        {o.connection?.testEventCode && <Badge tone="info">{t("מצב בדיקה – כל האירועים נשלחים עם Test Event Code", "Test mode – every event is sent with the Test Event Code")}</Badge>}
        <a href={o.eventsManagerUrl} target="_blank" rel="noreferrer" className="ms-auto inline-flex items-center gap-1 text-sm text-accent underline">Events Manager <ExternalLink size={13} /></a>
      </div>
      <p className="text-sm text-muted">{t("שליחת שלבים ותוצאות מה-CRM ל-Meta Events Manager דרך Conversions API (שרת לשרת). כל אירוע נוצר מפעולה שנשמרה ב-CRM, נכנס לתור עמיד, נשלח פעם אחת עם מזהה קבוע, ונרשם ביומן.", "Sends CRM stages and outcomes to Meta Events Manager through the Conversions API (server to server). Every event comes from a saved CRM change, enters a durable queue, is sent once with a stable id, and is logged.")}</p>
      <div className="flex gap-1 rounded-lg border border-line bg-panel p-1 w-fit" role="tablist">
        {([["connection", "חיבור", "Connection"], ["rules", "אירועים", "Events"], ["log", "יומן שליחה", "Send log"]] as const).map(([k, he, en]) => <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)} className={cx("h-8 px-3 rounded-md text-sm", tab === k ? "bg-accent text-white" : "text-muted hover:text-text")} data-testid={`capi-tab-${k}`}>{t(he, en)}{k === "log" && (o.counts.failed || o.counts.pending_data) ? ` (${(o.counts.failed ?? 0) + (o.counts.pending_data ?? 0)})` : ""}</button>)}
      </div>
      {tab === "connection" && <ConnectionCard t={t} o={o} canManage={canManage} reload={load} />}
      {tab === "rules" && <Rules t={t} o={o} canManage={canManage} reload={load} />}
      {tab === "log" && <Log t={t} canManage={canManage} />}
    </div>
  );
}

function ConnectionCard({ t, o, canManage, reload }: { t: T; o: Overview; canManage: boolean; reload: () => void }) {
  const c = o.connection;
  const [f, setF] = useState({ datasetId: c?.datasetId ?? "", datasetName: c?.datasetName ?? "", token: "", testEventCode: c?.testEventCode ?? "", leadEventSource: c?.leadEventSource ?? "UltraCRM", siteSendsPurchase: c?.siteSendsPurchase ?? false });
  const [datasets, setDatasets] = useState<Array<{ id: string; name: string; account: string }> | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const act = async (key: string, fn: () => Promise<unknown>, okMsg: string) => { setBusy(key); try { await fn(); toast.success(okMsg); reload(); } catch (e) { toast.error((e as Error).message); } finally { setBusy(null); } };
  async function loadDatasets() { try { const r = await api.get<{ available: boolean; items: Array<{ id: string; name: string; account: string }> }>("/api/marketing/capi/datasets"); setDatasets(r.items); if (!r.available) toast.info(t("אין חיבור חשבון פרסום – הזינו את מזהה ה-Dataset ידנית", "No ad account connection – enter the dataset ID manually")); } catch (e) { toast.error((e as Error).message); } }
  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_22rem]">
      <Panel title={t("חיבור Conversions API", "Conversions API connection")}>
        <fieldset disabled={!canManage} className="space-y-3 text-sm">
          <div className="flex flex-wrap items-end gap-2">
            <Input label={t("מזהה Dataset / Pixel", "Dataset / Pixel ID")} value={f.datasetId} onChange={(e) => setF({ ...f, datasetId: e.target.value.trim() })} ltr className="w-56" data-testid="capi-dataset" />
            {o.adsConnection && <Button size="sm" variant="secondary" onClick={() => void loadDatasets()}>{t("בחירה מחשבון הפרסום המחובר", "Pick from the connected ad account")}</Button>}
          </div>
          {datasets && (datasets.length ? <Select label={t("Datasets בחשבון הפרסום", "Datasets in the ad account")} value={f.datasetId} onChange={(e) => { const d = datasets.find((x) => x.id === e.target.value); setF({ ...f, datasetId: e.target.value, datasetName: d?.name ?? "" }); }}><option value="">{t("בחרו…", "Choose…")}</option>{datasets.map((d) => <option key={d.id} value={d.id}>{d.name} · {d.id} ({d.account})</option>)}</Select> : <p className="text-xs text-muted">{t("לא נמצאו Datasets בחשבונות הפרסום המחוברים.", "No datasets found in the connected ad accounts.")}</p>)}
          <Input label={t(`טוקן Conversions API${c?.tokenHint ? ` (שמור: ${c.tokenHint})` : ""}`, `Conversions API token${c?.tokenHint ? ` (saved: ${c.tokenHint})` : ""}`)} type="password" autoComplete="off" value={f.token} onChange={(e) => setF({ ...f, token: e.target.value })} ltr placeholder={c ? t("השאירו ריק כדי לא לשנות", "Leave empty to keep") : ""} data-testid="capi-token" />
          <Input label={t("Test Event Code (לבדיקה בלבד)", "Test Event Code (testing only)")} value={f.testEventCode} onChange={(e) => setF({ ...f, testEventCode: e.target.value.trim() })} ltr data-testid="capi-test-code" />
          <Input label={t("שם מערכת ה-CRM (lead_event_source)", "CRM name (lead_event_source)")} value={f.leadEventSource} onChange={(e) => setF({ ...f, leadEventSource: e.target.value })} ltr />
          <label className="flex items-start gap-2"><input type="checkbox" className="mt-1" checked={f.siteSendsPurchase} onChange={(e) => setF({ ...f, siteSendsPurchase: e.target.checked })} data-testid="capi-site-purchase" /><span>{t("האתר / התוסף כבר שולחים Purchase למטא. רכישה ב-CRM שתואמת הזמנה מהחנות (אותו לקוח, אותו סכום, עד 48 שעות) לא תישלח שוב – מקור אחד מוסכם.", "The site / plugin already sends Purchase to Meta. A CRM purchase matching a store order (same customer, same total, within 48h) is not sent again – one agreed source.")}</span></label>
          <div className="flex flex-wrap gap-2 pt-1">
            <Button onClick={() => void act("save", () => api.put("/api/marketing/capi/connection", { datasetId: f.datasetId, datasetName: f.datasetName || undefined, token: f.token || undefined, testEventCode: f.testEventCode || null, leadEventSource: f.leadEventSource || undefined, siteSendsPurchase: f.siteSendsPurchase }).then(() => setF((x) => ({ ...x, token: "" }))), t("נשמר – בדקו את החיבור", "Saved – check the connection"))} loading={busy === "save"} data-testid="capi-save">{t("שמירה", "Save")}</Button>
            {c && <Button variant="secondary" onClick={() => void act("check", () => api.post("/api/marketing/capi/check"), t("נבדק", "Checked"))} loading={busy === "check"} data-testid="capi-check">{t("בדיקת חיבור", "Check connection")}</Button>}
            {c && <Button variant="secondary" onClick={() => void act("test", () => api.post("/api/marketing/capi/test"), t("אירוע בדיקה נשלח עם ה-Test Event Code – בדקו ב-Events Manager ← Test events", "Test event sent with the Test Event Code – check Events Manager → Test events"))} loading={busy === "test"} disabled={!c.testEventCode} data-testid="capi-test">{t("שליחת אירוע בדיקה", "Send a test event")}</Button>}
            {c && <Button variant={c.enabled ? "warn" : "good"} onClick={() => void act("sending", () => api.post("/api/marketing/capi/sending", { enabled: !c.enabled }), c.enabled ? t("השליחה הושהתה", "Sending paused") : t("השליחה הופעלה", "Sending on"))} loading={busy === "sending"} data-testid="capi-toggle">{c.enabled ? t("השהיית שליחה", "Pause sending") : t("הפעלת שליחה", "Turn sending on")}</Button>}
          </div>
          {c?.lastError && <p className="text-bad text-xs" data-testid="capi-error">{c.lastError}</p>}
          {c?.lastCheckedAt && <p className="text-xs text-muted">{t("נבדק לאחרונה:", "Last checked:")} {formatDateTime(c.lastCheckedAt)}{c.datasetName ? ` · ${c.datasetName}` : ""}</p>}
        </fieldset>
      </Panel>
      <Panel title={t("מה צריך ממטא", "What Meta needs")}>
        <ol className="list-decimal space-y-2 ps-5 text-xs leading-relaxed">
          <li>{t("ב-Events Manager בחרו את ה-Dataset ← הגדרות ← Conversions API ← ״יצירת אסימון גישה״ (Generate access token). זה הטוקן שמאפשר שליחת אירועים.", "In Events Manager pick the dataset → Settings → Conversions API → Generate access token. That token allows sending events.")}</li>
          <li>{t("חיבור חשבון הפרסום לדוחות (הרשאת קריאה ads_read) אינו מאפשר שליחת אירועים, וההפך – הם שני חיבורים נפרדים.", "The ad-account connection for reports (read permission ads_read) does not allow sending events, and vice versa – they are two separate connections.")}{o.adsConnection ? t(` חשבון פרסום מחובר: ${o.adsConnection.status}.`, ` Ad account connected: ${o.adsConnection.status}.`) : ""}</li>
          <li>{t("לבדיקה: Events Manager ← Test events ← העתיקו את ה-Test Event Code לכאן, ושלחו אירוע בדיקה. כל עוד הקוד מוגדר, כל האירועים נשלחים במצב בדיקה.", "To test: Events Manager → Test events → copy the Test Event Code here and send a test event. While the code is set, every event is sent in test mode.")}</li>
          <li>{t("לפני שליחה אמיתית: מחקו את ה-Test Event Code והפעילו שליחה.", "Before live sending: clear the Test Event Code and turn sending on.")}</li>
          <li>{t("״התקבל ב-API״ ביומן = מטא אישרה קבלה (events_received). זה עדיין לא אומר שהאירוע הופיע ב-Events Manager, ובוודאי לא שהמרה יוחסה לפרסום. הופעה זמינה לאופטימיזציה דורשת לרוב הגדרות נוספות במטא (Custom Conversion / אירוע בקמפיין) וזמן.", "\"Received by the API\" = Meta acknowledged it (events_received). It does not mean it appeared in Events Manager, and certainly not that a conversion was attributed to an ad. Availability for optimisation usually needs more setup in Meta (Custom Conversion / campaign event) and time.")}</li>
        </ol>
      </Panel>
    </div>
  );
}

const EMPTY: Omit<Rule, "id"> = { name: "", trigger: "lead_created", triggerConfig: {}, conditions: {}, eventKind: "standard", eventName: "Lead", actionSource: "system_generated", valueSource: "none", valueField: null, fixedValue: null, currency: null, valueIncludes: {}, resend: "once", enabled: false };

function Rules({ t, o, canManage, reload }: { t: T; o: Overview; canManage: boolean; reload: () => void }) {
  const [edit, setEdit] = useState<(Omit<Rule, "id"> & { id?: string }) | null>(null);
  const [adding, setAdding] = useState(false);
  const v = o.vocabulary;
  async function toggle(r: Rule) { try { await api.put(`/api/marketing/capi/rules/${r.id}`, { ...r, enabled: !r.enabled }); reload(); } catch (e) { toast.error((e as Error).message); } }
  async function remove(r: Rule) { if (!confirm(t(`למחוק את "${r.name}"? אירועים שכבר נשלחו נשארים ביומן; אירועים בתור לא יישלחו.`, `Delete "${r.name}"? Events already sent stay in the log; queued ones won't be sent.`))) return; try { await api.delete(`/api/marketing/capi/rules/${r.id}`); reload(); } catch (e) { toast.error((e as Error).message); } }
  return (
    <div className="space-y-3">
      {canManage && <Button icon={<Plus size={15} />} onClick={() => setAdding(true)} data-testid="capi-add">{t("הוסף אירוע", "Add event")}</Button>}
      {!o.rules.length ? <EmptyState title={t("עדיין אין אירועים", "No events yet")} hint={t("התחילו מתבנית: ליד חדש → Lead, פגישה נקבעה → Schedule, רכישה → Purchase", "Start from a template: new lead → Lead, meeting scheduled → Schedule, purchase → Purchase")} /> : (
        <Panel bodyClassName="p-0"><ul className="divide-y divide-line">{o.rules.map((r) => (
          <li key={r.id} className="flex flex-wrap items-center gap-2 p-3 text-sm" data-testid="capi-rule">
            <div className="min-w-0 flex-1"><div className="font-medium">{r.name}</div><div className="text-xs text-muted">{v.triggers[r.trigger]}{r.trigger === "lead_status" ? `: ${o.statuses.find((s) => s.id === r.triggerConfig.statusId)?.label ?? "?"}` : ""} → <span dir="ltr">{r.eventName}</span> {r.eventKind === "custom" ? t("(אירוע מותאם)", "(custom event)") : ""} · {v.actionSources[r.actionSource]} · {v.valueSources[r.valueSource]}</div></div>
            <label className="flex items-center gap-1 text-xs"><input type="checkbox" checked={r.enabled} disabled={!canManage} onChange={() => void toggle(r)} data-testid="capi-rule-enabled" /> {r.enabled ? t("פעיל", "On") : t("כבוי", "Off")}</label>
            {canManage && <Button size="sm" variant="ghost" onClick={() => setEdit(r)}>{t("עריכה", "Edit")}</Button>}
            {canManage && <Button size="sm" variant="ghost" onClick={() => void remove(r)}>{t("מחיקה", "Delete")}</Button>}
          </li>))}</ul></Panel>
      )}
      <Panel title={t("Custom Event מול Custom Conversion", "Custom Event vs Custom Conversion")}>
        <div className="space-y-2 text-xs leading-relaxed">
          <p><b>Custom Event</b> – {t("אירוע שהמערכת שולחת בשם שבחרתם (למשל AppointmentAttended). הוא מגיע ל-Dataset, אבל לא נספר אוטומטית כהמרה בקמפיין.", "An event the system sends under a name you chose (e.g. AppointmentAttended). It reaches the dataset but is not automatically counted as a conversion in a campaign.")}</p>
          <p><b>Custom Conversion</b> – {t("כלל שמוגדר במטא על בסיס אירוע ותנאים, ורק הוא נבחר כהמרה בקמפיין. יצירה דרך API דורשת הרשאת ads_management על חשבון הפרסום – החיבור הנוכחי הוא לקריאה בלבד, לכן אין כאן יצירה אוטומטית. הגדרה ידנית:", "A rule defined in Meta on top of an event and conditions; only that can be chosen as a campaign conversion. Creating it by API needs ads_management on the ad account – the current connection is read-only, so nothing is created automatically here. Manual setup:")}</p>
          <ol className="list-decimal ps-5 space-y-1"><li>Events Manager ← Custom conversions ← Create custom conversion</li><li>{t("מקור נתונים: ה-Dataset המחובר", "Data source: the connected dataset")}</li><li>{t("אירוע המרה: שם ה-Custom Event (כפי שמופיע כאן)", "Conversion event: the Custom Event name (as shown here)")}</li><li>{t("כללים / ערך המרה לפי הצורך ← שמירה", "Rules / conversion value as needed → Save")}</li></ol>
        </div>
      </Panel>
      {adding && <Modal open onClose={() => setAdding(false)} title={t("הוסף אירוע", "Add event")}><div className="space-y-2" data-testid="capi-templates">{v.templates.map((tp) => <button key={tp.key} className="w-full rounded-lg border border-line p-3 text-start text-sm hover:border-accent" onClick={() => { setAdding(false); setEdit({ ...EMPTY, name: tp.name, trigger: tp.trigger, eventKind: tp.eventKind, eventName: tp.eventName, actionSource: tp.actionSource, valueSource: tp.valueSource, currency: null }); }} data-testid={`capi-template-${tp.key}`}><b>{tp.name}</b> <span dir="ltr" className="text-muted">→ {tp.eventName}</span><p className="text-xs text-muted mt-1">{tp.note}</p></button>)}<button className="w-full rounded-lg border border-dashed border-line p-3 text-start text-sm" onClick={() => { setAdding(false); setEdit({ ...EMPTY }); }}>{t("כלל ריק", "Blank rule")}</button></div></Modal>}
      {edit && <RuleEditor t={t} o={o} rule={edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); reload(); }} />}
    </div>
  );
}

function RuleEditor({ t, o, rule, onClose, onSaved }: { t: T; o: Overview; rule: Omit<Rule, "id"> & { id?: string }; onClose: () => void; onSaved: () => void }) {
  const [r, setR] = useState(rule);
  const [preview, setPreview] = useState<Record<string, unknown> | null>(null);
  const [busy, setBusy] = useState(false);
  const v = o.vocabulary;
  const set = (p: Partial<typeof r>) => { setR((x) => ({ ...x, ...p })); setPreview(null); };
  const body = () => ({ ...r, valueField: r.valueField || null, fixedValue: r.fixedValue ?? null, currency: r.currency || null });
  async function save() {
    setBusy(true);
    try { if (r.id) await api.put(`/api/marketing/capi/rules/${r.id}`, body()); else await api.post("/api/marketing/capi/rules", body()); toast.success(t("נשמר", "Saved")); onSaved(); }
    catch (e) {
      // Show WHY (the server's per-field explanation), not only "invalid data".
      const fe = ((e as { details?: { fieldErrors?: Record<string, string[]> } }).details?.fieldErrors) ?? {};
      const why = Object.values(fe).flat();
      toast.error(why.length ? why.join(" · ") : (e as Error).message);
    } finally { setBusy(false); }
  }
  const customNameBad = r.eventKind === "custom" && r.eventName.length > 0 && (!/^[A-Za-z][A-Za-z0-9_]{1,39}$/.test(r.eventName) || v.standardEvents.includes(r.eventName));
  async function runPreview() { try { setPreview(await api.post("/api/marketing/capi/rules/preview", body())); } catch (e) { toast.error((e as Error).message); } }
  const isAppt = r.trigger.startsWith("appointment");
  return (
    <Modal open onClose={onClose} title={r.id ? t("עריכת אירוע", "Edit event") : t("אירוע חדש", "New event")} width="max-w-2xl" footer={<><Button variant="ghost" onClick={onClose}>{t("ביטול", "Cancel")}</Button><Button variant="secondary" onClick={() => void runPreview()} data-testid="capi-preview">{t("תצוגה מקדימה", "Preview")}</Button><Button onClick={() => void save()} loading={busy} data-testid="capi-rule-save">{t("שמירה", "Save")}</Button></>}>
      <div className="grid gap-3 sm:grid-cols-2 text-sm" data-testid="capi-editor">
        <Input label={t("שם פנימי", "Internal name")} value={r.name} onChange={(e) => set({ name: e.target.value })} data-testid="capi-rule-name" />
        <Select label={t("טריגר מה-CRM", "CRM trigger")} value={r.trigger} onChange={(e) => set({ trigger: e.target.value, triggerConfig: {}, valueSource: e.target.value === "payment_received" ? r.valueSource : r.valueSource === "payment_amount" ? "none" : r.valueSource })} data-testid="capi-rule-trigger">{Object.entries(v.triggers).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select>
        {r.trigger === "lead_status" && <Select label={t("סטטוס (מה-CRM של העסק)", "Status (from this business's CRM)")} value={r.triggerConfig.statusId ?? ""} onChange={(e) => set({ triggerConfig: { statusId: e.target.value } })} data-testid="capi-rule-status"><option value="">{t("בחרו…", "Choose…")}</option>{o.statuses.filter((s) => s.active || s.id === r.triggerConfig.statusId).map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}</Select>}
        {r.trigger === "field_changed" && <><Select label={t("שדה", "Field")} value={r.triggerConfig.field ?? ""} onChange={(e) => set({ triggerConfig: { ...r.triggerConfig, field: e.target.value } })}><option value="">{t("בחרו…", "Choose…")}</option>{o.fields.map((f) => <option key={f} value={f}>{f}</option>)}</Select><Input label={t("כשהערך הופך ל-", "When the value becomes")} value={r.triggerConfig.fieldValue ?? ""} onChange={(e) => set({ triggerConfig: { ...r.triggerConfig, fieldValue: e.target.value } })} /></>}
        <Input label={t("תנאי: מזהה קמפיין במטא (אופציונלי)", "Condition: Meta campaign ID (optional)")} value={r.conditions.campaignId ?? ""} onChange={(e) => set({ conditions: { ...r.conditions, campaignId: e.target.value || undefined } })} ltr />
        <Input label={t("תנאי: מוצר (אופציונלי)", "Condition: product (optional)")} value={r.conditions.product ?? ""} onChange={(e) => set({ conditions: { ...r.conditions, product: e.target.value || undefined } })} />
        <Input label={t("תנאי: מקור הליד (אופציונלי)", "Condition: lead source (optional)")} value={r.conditions.source ?? ""} onChange={(e) => set({ conditions: { ...r.conditions, source: e.target.value || undefined } })} />
        <Select label={t("סוג אירוע במטא", "Meta event type")} value={r.eventKind} onChange={(e) => set({ eventKind: e.target.value as "standard" | "custom", eventName: e.target.value === "standard" ? "Lead" : "" })} data-testid="capi-rule-kind"><option value="standard">{t("אירוע סטנדרטי", "Standard event")}</option><option value="custom">{t("אירוע מותאם (Custom Event)", "Custom Event")}</option></Select>
        {r.eventKind === "standard" ? <Select label={t("אירוע", "Event")} value={r.eventName} onChange={(e) => set({ eventName: e.target.value })} data-testid="capi-rule-event">{v.standardEvents.map((e) => <option key={e} value={e}>{e}</option>)}</Select>
          : <div><Input label={t("שם באנגלית (אותיות, ספרות, _)", "English name (letters, digits, _)")} value={r.eventName} onChange={(e) => set({ eventName: e.target.value })} ltr placeholder="AppointmentAttended" data-testid="capi-rule-event" aria-invalid={customNameBad} />{customNameBad && <p className="mt-1 text-xs text-bad" data-testid="capi-name-hint">{t("אותיות באנגלית, ספרות וקו תחתון, מתחיל באות, עד 40 תווים – ולא שם של אירוע סטנדרטי. התווית בעברית היא ״שם פנימי״.", "English letters, digits and underscore, starting with a letter, up to 40 characters – and not a standard event name. The Hebrew label is the internal name.")}</p>}</div>}
        <Select label={t("מקור האירוע (action_source)", "Event source (action_source)")} value={r.actionSource} onChange={(e) => set({ actionSource: e.target.value })} data-testid="capi-rule-source">{Object.entries(v.actionSources).map(([k, l]) => <option key={k} value={k}>{l} – {k}</option>)}</Select>
        <Select label={t("ערך", "Value")} value={r.valueSource} onChange={(e) => set({ valueSource: e.target.value })} data-testid="capi-rule-value">{Object.entries(v.valueSources).filter(([k]) => (k !== "payment_amount" || r.trigger === "payment_received") && (k !== "deal_amount" || ["deal_won", "payment_received"].includes(r.trigger))).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select>
        {r.valueSource === "custom_field" && <Select label={t("שדה כספי", "Money field")} value={r.valueField ?? ""} onChange={(e) => set({ valueField: e.target.value })}><option value="">{t("בחרו…", "Choose…")}</option>{o.fields.map((f) => <option key={f} value={f}>{f}</option>)}</Select>}
        {r.valueSource === "fixed" && <Input label={t("ערך קבוע", "Fixed value")} type="number" value={r.fixedValue ?? ""} onChange={(e) => set({ fixedValue: e.target.value === "" ? null : Number(e.target.value) })} ltr />}
        {(r.valueSource === "fixed" || r.valueSource === "custom_field") && <Input label={t("מטבע (ISO, למשל ILS)", "Currency (ISO, e.g. ILS)")} value={r.currency ?? ""} onChange={(e) => set({ currency: e.target.value.toUpperCase() })} ltr />}
        {r.valueSource !== "none" && <div className="sm:col-span-2 rounded-lg border border-line p-2 text-xs space-y-1">
          <p>{(r.valueSource === "deal_amount" || r.valueSource === "payment_amount") ? t("הערך והמטבע נלקחים מהרשומה ב-CRM בדיוק כפי שנשמרו בה (למשל עסקה של 1,800 ₪ → value 1800, currency ILS). סמנו מה הסכום הזה כולל אצלכם – לתיעוד בלבד; ההגדרה נפרדת ממסנני הדוחות.", "Value and currency come from the CRM record exactly as stored (e.g. a ₪1,800 deal → value 1800, currency ILS). Mark what that amount includes – documentation only; separate from report filters.") : isAppt ? t("ערך לפגישה הוא ערך משוער – הוא לא מוצג כהכנסה ממכירה.", "A meeting value is an estimate – it is not shown as sales revenue.") : ""}</p>
          <div className="flex flex-wrap gap-3">{([["vat", "כולל מע״מ", "Incl. VAT"], ["shipping", "כולל משלוח", "Incl. shipping"], ["discounts", "אחרי הנחות", "After discounts"]] as const).map(([k, he, en]) => <label key={k} className="flex items-center gap-1"><input type="checkbox" checked={Boolean(r.valueIncludes[k])} onChange={(e) => set({ valueIncludes: { ...r.valueIncludes, [k]: e.target.checked } })} /> {t(he, en)}</label>)}</div>
        </div>}
        <Select label={t("שליחה חוזרת", "Resend policy")} value={r.resend} onChange={(e) => set({ resend: e.target.value as "once" | "every" })}><option value="once">{t("פעם אחת לכל ליד / עסקה / פגישה", "Once per lead / deal / meeting")}</option><option value="every">{t("בכל התרחשות חדשה", "Every new occurrence")}</option></Select>
        <label className="flex items-center gap-2 self-end"><input type="checkbox" checked={r.enabled} onChange={(e) => set({ enabled: e.target.checked })} data-testid="capi-rule-on" /> {t("פעיל", "On")}</label>
        {r.eventName === "Purchase" && <p className="sm:col-span-2 text-xs text-muted">{t("אותה רכישה נשלחת פעם אחת בלבד (מזהה עסקה / תשלום קבוע) – גם אם קיים גם כלל של סגירת עסקה וגם של תשלום. שינוי שווי אחרי השליחה לא יוצר Purchase נוסף. מטא לא מאפשרת למחוק או לתקן אירוע שהתקבל; ביטולים והחזרים אינם מבוטלים אוטומטית שם.", "The same purchase is sent once (stable deal / payment id) – even if both a deal-closed and a payment rule exist. A value change after sending creates no new Purchase. Meta does not allow deleting or correcting a received event; cancellations and refunds are not reversed there automatically.")}</p>}
        {r.actionSource === "system_generated" && <p className="sm:col-span-2 text-xs text-muted">{t("מסלול CRM (Conversion Leads): נשלח עם event_source=crm ו-lead_id של מטא אם הליד הגיע מטופס לידים. מתאים לשלבי ליד; לשיחות מכירה טלפוניות או בצ׳אט בחרו phone_call / chat.", "CRM route (Conversion Leads): sent with event_source=crm and Meta's lead_id when the lead came from a lead form. For lead stages; for phone or chat sales choose phone_call / chat.")}</p>}
        {preview && <pre className="sm:col-span-2 max-h-64 overflow-auto rounded-lg bg-muted-bg p-2 text-xs" dir="ltr" data-testid="capi-preview-json">{JSON.stringify(preview, null, 2)}</pre>}
      </div>
    </Modal>
  );
}

function Log({ t, canManage }: { t: T; canManage: boolean }) {
  const [status, setStatus] = useState("");
  const [items, setItems] = useState<Ev[] | null>(null);
  const load = useCallback(async () => { try { setItems((await api.get<{ items: Ev[] }>(`/api/marketing/capi/events${status ? `?status=${status}` : ""}`)).items); } catch (e) { toast.error((e as Error).message); } }, [status]);
  useEffect(() => { void load(); }, [load]);
  async function retry(e: Ev) { try { await api.post(`/api/marketing/capi/events/${e.id}/retry`); toast.success(t("נשלח שוב לתור – אותו מזהה אירוע", "Re-queued – same event id")); void load(); } catch (err) { toast.error((err as Error).message); } }
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Select aria-label={t("סטטוס", "Status")} value={status} onChange={(e) => setStatus(e.target.value)} className="w-56"><option value="">{t("כל הסטטוסים", "All statuses")}</option>{Object.entries(EV_STATUS).map(([k, [l]]) => <option key={k} value={k}>{l}</option>)}</Select>
        <Button size="sm" variant="ghost" icon={<RefreshCw size={14} />} onClick={() => void load()}>{t("רענון", "Refresh")}</Button>
      </div>
      <p className="text-xs text-muted">{t("״התקבל ב-API״ = מטא אישרה קבלה. הופעה ב-Events Manager וייחוס לפרסום נבדקים במטא עצמה – המערכת לא מציגה אותם כי אין לה ראיה לכך.", "\"Received by the API\" = Meta acknowledged it. Appearing in Events Manager and attribution to ads are checked in Meta itself – the system doesn't show them because it has no evidence for them.")}</p>
      {!items ? <Spinner /> : !items.length ? <EmptyState title={t("אין אירועים ביומן", "No events in the log")} /> : (
        <div className="overflow-x-auto rounded-xl border border-line bg-panel"><table className="w-full min-w-[820px] text-sm" data-testid="capi-log">
          <thead className="text-xs text-muted"><tr><th className="p-2 text-start">{t("אירוע", "Event")}</th><th className="text-start">{t("כלל", "Rule")}</th><th className="text-start">{t("רשומה", "Record")}</th><th className="text-start">{t("זמן האירוע", "Event time")}</th><th className="text-start">{t("ערך", "Value")}</th><th className="text-start">{t("סטטוס", "Status")}</th><th className="text-start">{t("ניסיונות", "Attempts")}</th><th /></tr></thead>
          <tbody className="divide-y divide-line">{items.map((e) => (
            <tr key={e.id} data-testid="capi-log-row" data-status={e.status}>
              <td className="p-2" dir="ltr">{e.eventName}{e.testCode ? <span className="ms-1 text-[10px] text-info">TEST</span> : null}</td>
              <td>{e.rule?.name ?? "—"}</td>
              <td>{e.contactId ? <Link href={`/contacts/${e.contactId}`} className="text-accent underline">{e.contactName ?? t("איש קשר", "Contact")}</Link> : "—"} <span className="text-xs text-muted">({e.entityType})</span></td>
              <td className="tabular-nums">{formatDateTime(e.occurredAt)}</td>
              <td className="tabular-nums" dir="ltr">{e.value !== null ? `${e.value.toLocaleString()} ${e.currency ?? ""}` : "—"}</td>
              <td><Badge tone={EV_STATUS[e.status]?.[1] ?? "neutral"}>{t(EV_STATUS[e.status]?.[0] ?? e.status, e.status)}</Badge>{(e.statusReason || e.lastError) && <div className="max-w-64 text-xs text-muted">{e.lastError ?? e.statusReason}</div>}</td>
              <td className="tabular-nums">{e.attempts}</td>
              <td>{canManage && ["failed", "pending_data"].includes(e.status) && <Button size="sm" variant="secondary" onClick={() => void retry(e)} data-testid="capi-retry">{t("נסה שוב", "Retry")}</Button>}</td>
            </tr>))}</tbody>
        </table></div>
      )}
    </div>
  );
}
