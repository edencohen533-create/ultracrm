"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { api } from "@/lib/client/api";
import { Badge, Button, Input, Modal, Panel, Select, Spinner, cx } from "@/components/ui";
import { useT } from "@/components/i18n/LangProvider";

type Availability = "tested" | "needs_setup" | "unavailable";
interface Connector { key: string; name: string; description: string; availability: Availability; internal: boolean; authFields: Array<{ key: string; label: string; secret: boolean; required: boolean; placeholder?: string; help?: string }>; capabilities: Array<{ key: string; label: string }> }
interface Settings {
  records: { contacts: boolean; leads: boolean }; userMap: Record<string, string>; statusMap: Record<string, string>; statusOutMap: Record<string, string>;
  directions: { status: string; followUp: string }; selection: { statuses: string[]; lists: string[]; owners: string[]; teams: string[] }; queue: { enabled: boolean; listId: string | null };
  writeback: { calls: boolean; aiSummary: boolean; detailsLink: boolean; followUpTasks: boolean; status: boolean; whatsappSummary: boolean; blocks: boolean };
  ownerAuthority: "external" | "local"; freshnessMinutes: number; pollMinutes: number; deletionPolicy: "stop_activity" | "close_lead";
}
interface Conn { id: string; connectorKey: string; connectorName: string; name: string; status: string; verifiedAt: string | null; lastTestAt: string | null; lastTestResult: { ok: boolean; message: string } | null; lastSyncAt: string | null; lastSyncStatus: string | null; lastError: string | null; syncState: { phase?: string; processed?: number; startedAt?: string; finishedAt?: string }; disconnectedAt: string | null; settings: Settings; capabilities: string[]; authSet: Record<string, boolean>; authPublic: Record<string, string | null>; webhookUrl: string | null }
interface Status { connection: Conn; fresh: boolean; links: Record<string, number>; outbox: Record<string, number>; events7d: Record<string, number>; reviews: Array<{ id: string; kind: string; recordType: string; externalId: string; localId: string | null; details: Record<string, unknown>; createdAt: string }>; failedEvents: Array<{ id: string; recordType: string; externalId: string; error: string | null; createdAt: string }>; failedOutbox: Array<{ id: string; action: string; lastError: string | null; attempts: number; status: string }> }
interface Discovery { users: Array<{ externalId: string; name: string }> | { error: string } | null; statuses: string[] | { error: string } | null; lists: string[] | { error: string } | null; seen: { owners: string[]; statuses: string[]; lists: string[]; teams: string[] }; localUsers: Array<{ id: string; fullName: string; role: string }> }

const AVAIL: Record<Availability, [string, string, "good" | "warn" | "neutral"]> = { tested: ["נתמך ונבדק", "Supported & tested", "good"], needs_setup: ["דורש הגדרה", "Needs setup", "warn"], unavailable: ["לא זמין", "Unavailable", "neutral"] };
const STATUS: Record<string, [string, string, "good" | "warn" | "bad" | "neutral"]> = { setup: ["בהגדרה – טרם נבדק", "Setting up – not tested", "warn"], active: ["מחובר ונבדק", "Connected & tested", "good"], error: ["תקלה", "Error", "bad"], disconnected: ["מנותק (הנתונים נשמרו)", "Disconnected (data kept)", "neutral"], paused: ["מושהה", "Paused", "neutral"] };
const LOCAL_STATUSES: Array<[string, string]> = [["new", "חדש"], ["contacted", "נוצר קשר"], ["follow_up", "פולואפ"], ["qualified", "מתעניין"], ["unqualified", "לא רלוונטי"], ["converted", "נסגר"], ["lost", "אבוד"]];
const REVIEW: Record<string, string> = { fuzzy_match: "התאמה עמומה לכרטיס קיים", unmapped_owner: "נציג חיצוני לא ממופה", conflict: "התנגשות", deleted_external: "נמחק במערכת החיצונית", unmapped_status: "סטטוס לא ממופה" };
const STEPS = ["auth", "test", "mapping", "selection", "preview", "sync", "status"] as const;
type Step = (typeof STEPS)[number];
const arr = <T,>(v: T[] | { error: string } | null) => (Array.isArray(v) ? v : []);

/** הגדרות ← חיבורים ← CRM חיצוני – setup wizard and status screen (real states only). */
export function CrmConnectionsScreen() {
  const t = useT(); const loc = t.lang === "en" ? "en-GB" : "he-IL";
  const router = useRouter(); const pathname = usePathname(); const params = useSearchParams();
  const [connectors, setConnectors] = useState<Connector[]>([]); const [conns, setConns] = useState<Conn[] | null>(null);
  const [creating, setCreating] = useState<Connector | null>(null); const [form, setForm] = useState<Record<string, string>>({ name: "" }); const [busy, setBusy] = useState("");
  const [secretsOnce, setSecretsOnce] = useState<Record<string, string> | null>(null);
  const selectedId = params.get("c"); const step = (params.get("step") as Step | null) ?? "status";
  const go = (next: Record<string, string | null>) => { const sp = new URLSearchParams(params.toString()); for (const [k, v] of Object.entries(next)) { if (v) sp.set(k, v); else sp.delete(k); } router.push(`${pathname}?${sp}`, { scroll: false }); };
  const load = useCallback(() => api.get<{ connectors: Connector[]; connections: Conn[] }>("/api/integrations/crm").then((r) => { setConnectors(r.connectors); setConns(r.connections); }).catch((e) => toast.error((e as Error).message)), []);
  useEffect(() => { void load(); }, [load]);
  const selected = conns?.find((c) => c.id === selectedId) ?? null;
  const dt = (s: string | null) => (s ? new Date(s).toLocaleString(loc, { dateStyle: "short", timeStyle: "short" }) : "—");

  async function create() {
    if (!creating) return; setBusy("create");
    try {
      const r = await api.post<{ connection: Conn; secretsOnce: Record<string, string> }>("/api/integrations/crm", { connectorKey: creating.key, name: form.name || creating.name, auth: Object.fromEntries(creating.authFields.map((f) => [f.key, form[f.key] ?? ""])) });
      setCreating(null); setForm({ name: "" }); if (Object.keys(r.secretsOnce).length) setSecretsOnce(r.secretsOnce);
      await load(); go({ c: r.connection.id, step: "test" });
    } catch (e) { toast.error((e as Error).message); } finally { setBusy(""); }
  }

  if (!conns) return <div className="p-10 flex justify-center"><Spinner /></div>;
  return (
    <div className="p-4 md:p-5 space-y-4 max-w-5xl" data-testid="crm-screen">
      <div className="flex flex-wrap items-center gap-2"><Link href="/settings?tab=connections" className="text-xs text-muted hover:text-text">{t("→ חיבורים", "← Connections")}</Link><h1 className="text-lg font-semibold">{t("CRM חיצוני", "External CRM")}</h1></div>
      <p className="text-sm text-muted">{t("העסק נשאר עם ה-CRM שלו ועובד אצלנו בחייגן, בוואטסאפ וב-AI. אנשי קשר ופניות מסונכרנים לפי מזהה חיצוני, ותוצאות העבודה נכתבות חזרה לפי יכולות המחבר. סנכרון לבדו לא מחייג ולא שולח הודעות לאף אחד.", "The business keeps its CRM and works here in the dialer, WhatsApp and AI. Contacts and opportunities sync by external id, and results are written back per the connector's capabilities. Syncing alone never dials or messages anyone.")}</p>

      {!selected && (
        <>
          <Panel title={t("חיבורים", "Connections")}>
            {conns.length === 0 ? <p className="text-sm text-muted" data-testid="crm-empty">{t("אין עדיין חיבור CRM חיצוני.", "No external CRM connection yet.")}</p> : (
              <ul className="divide-y divide-line text-sm" data-testid="crm-connections">
                {conns.map((c) => { const s = STATUS[c.status] ?? [c.status, c.status, "neutral" as const]; return (
                  <li key={c.id} className="py-2 flex flex-wrap items-center gap-2"><b>{c.name}</b><span className="text-muted text-xs">{c.connectorName}</span><Badge tone={s[2]}>{t(s[0], s[1])}</Badge><span className="text-xs text-muted">{t("סנכרון אחרון", "Last sync")} {dt(c.lastSyncAt)}</span><Button size="sm" variant="secondary" className="ms-auto" onClick={() => go({ c: c.id, step: c.status === "active" ? "status" : "test" })} data-testid={`crm-open-${c.id}`}>{t("פתח", "Open")}</Button></li>
                ); })}
              </ul>
            )}
          </Panel>
          <Panel title={t("א. בחירת מחבר", "A. Choose a connector")}>
            <div className="grid gap-3 md:grid-cols-2" data-testid="crm-connectors">
              {connectors.map((c) => { const a = AVAIL[c.availability]; return (
                <div key={c.key} className="rounded-lg border border-line p-3 space-y-2">
                  <div className="flex items-center gap-2"><b>{c.name}</b><Badge tone={a[2]}>{t(a[0], a[1])}</Badge>{c.internal && <Badge tone="neutral">{t("בדיקות בלבד", "Tests only")}</Badge>}</div>
                  <p className="text-xs text-muted">{c.description}</p>
                  <details className="text-xs"><summary className="cursor-pointer">{t("יכולות", "Capabilities")} ({c.capabilities.length})</summary><ul className="list-disc ps-5 mt-1">{c.capabilities.map((x) => <li key={x.key}>{x.label}</li>)}</ul></details>
                  <Button size="sm" disabled={c.availability === "unavailable"} onClick={() => { setCreating(c); setForm({ name: c.name }); }} data-testid={`crm-add-${c.key}`}>{t("הוספה", "Add")}</Button>
                </div>
              ); })}
              <div className="rounded-lg border border-dashed border-line p-3 text-xs text-muted">{t("אין עדיין מחבר מוכן לספק CRM מסוים. מחבר לספק ייתווסף רק אחרי שייבנה וייבדק מול ה-API המתועד שלו. עד אז – \"אינטגרציה כללית\" מאפשרת לחבר כל מערכת שיכולה לשלוח ולקבל בקשות HTTP (בעצמה או דרך Make / Zapier / n8n).", "There is no ready connector for a specific CRM vendor yet. A vendor connector is added only after it is built and tested against the vendor's documented API. Until then, the general integration connects any system that can send and receive HTTP requests (itself or via Make / Zapier / n8n).")}</div>
            </div>
          </Panel>
        </>
      )}

      {selected && <ConnectionWizard key={selected.id} conn={selected} step={step} go={go} onChanged={load} dt={dt} />}

      <Modal open={Boolean(creating)} onClose={() => setCreating(null)} title={t(`ב. הזדהות – ${creating?.name ?? ""}`, `B. Authentication – ${creating?.name ?? ""}`)} footer={<><Button variant="ghost" onClick={() => setCreating(null)}>{t("ביטול", "Cancel")}</Button><Button onClick={create} loading={busy === "create"} data-testid="crm-create">{t("שמור והמשך לבדיקה", "Save & continue to test")}</Button></>}>
        <div className="space-y-3 text-sm">
          <Input label={t("שם החיבור", "Connection name")} value={form.name ?? ""} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          {creating?.authFields.map((f) => <div key={f.key}><Input label={`${f.label}${f.required ? " *" : ""}`} type={f.secret ? "password" : "text"} autoComplete="off" placeholder={f.placeholder} value={form[f.key] ?? ""} onChange={(e) => setForm({ ...form, [f.key]: e.target.value })} ltr />{f.help && <p className="text-[11px] text-muted mt-1">{f.help}</p>}</div>)}
          <p className="text-xs text-muted">{t("פרטי הגישה נשמרים מוצפנים בשרת ואינם מוצגים שוב. השמירה אינה \"חיבור\" – החיבור יסומן כמחובר רק אחרי בדיקה אמיתית.", "Credentials are stored encrypted on the server and never shown again. Saving is not \"connected\" – it is marked connected only after a real test.")}</p>
        </div>
      </Modal>
      <Modal open={Boolean(secretsOnce)} onClose={() => setSecretsOnce(null)} title={t("סודות חתימה – מוצגים פעם אחת", "Signing secrets – shown once")} footer={<Button onClick={() => setSecretsOnce(null)}>{t("שמרתי", "I saved them")}</Button>}>
        <div className="space-y-2 text-sm" data-testid="crm-secrets-once">
          {secretsOnce && Object.entries(secretsOnce).map(([k, v]) => <div key={k}><p className="text-xs text-muted">{k === "callbackSecret" ? t("סוד לאימות הבקשות שנשלח לכתובת החזרה שלכם (X-UltraCRM-Signature)", "Secret to verify the requests we send to your callback URL (X-UltraCRM-Signature)") : t("סוד לחתימת ה-Webhooks שהמערכת החיצונית שולחת אלינו", "Secret for signing the webhooks the external system sends us")}</p><code className="block ltr text-start bg-panel-2 rounded p-2 text-xs break-all">{v}</code></div>)}
        </div>
      </Modal>
    </div>
  );
}

function ConnectionWizard({ conn, step, go, onChanged, dt }: { conn: Conn; step: Step; go: (n: Record<string, string | null>) => void; onChanged: () => Promise<unknown>; dt: (s: string | null) => string }) {
  const t = useT();
  const [busy, setBusy] = useState(""); const [st, setSt] = useState<Status | null>(null); const [disc, setDisc] = useState<Discovery | null>(null);
  const [settings, setSettings] = useState<Settings>(conn.settings); const [pv, setPv] = useState<Record<string, unknown> | null>(null);
  const [lists, setLists] = useState<Array<{ id: string; name: string }>>([]); const [auth, setAuth] = useState<Record<string, string>>({});
  const refresh = useCallback(() => api.get<Status>(`/api/integrations/crm/${conn.id}`).then(setSt).catch((e) => toast.error((e as Error).message)), [conn.id]);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => { if (step === "mapping" || step === "selection") api.get<Discovery>(`/api/integrations/crm/${conn.id}/discovery`).then(setDisc).catch((e) => toast.error((e as Error).message)); if (step === "selection") api.get<Array<{ id: string; name: string }>>("/api/lists").then((l) => setLists(l.map((x) => ({ id: x.id, name: x.name })))).catch(() => undefined); }, [step, conn.id]);
  useEffect(() => { if (step !== "sync" && step !== "status") return; const i = setInterval(() => void refresh(), 4000); return () => clearInterval(i); }, [step, refresh]);
  const s = STATUS[conn.status] ?? [conn.status, conn.status, "neutral" as const];
  const can = (k: string) => conn.capabilities.includes(k);
  const act = async (key: string, fn: () => Promise<unknown>, ok?: string) => { setBusy(key); try { await fn(); if (ok) toast.success(ok); await onChanged(); await refresh(); } catch (e) { toast.error((e as Error).message); } finally { setBusy(""); } };
  const save = () => act("save", () => api.put(`/api/integrations/crm/${conn.id}/settings`, settings), t("נשמר", "Saved"));
  const owners = useMemo(() => [...new Set([...arr(disc?.users ?? null).map((u) => u.externalId), ...(disc?.seen.owners ?? []), ...Object.keys(settings.userMap)])], [disc, settings.userMap]);
  const extStatuses = useMemo(() => [...new Set([...arr(disc?.statuses ?? null), ...(disc?.seen.statuses ?? []), ...Object.keys(settings.statusMap)])], [disc, settings.statusMap]);
  const extName = (id: string) => arr(disc?.users ?? null).find((u) => u.externalId === id)?.name;
  const label: Record<Step, [string, string]> = { auth: ["ב. הזדהות", "B. Auth"], test: ["ג. בדיקה", "C. Test"], mapping: ["ד. מיפוי", "D. Mapping"], selection: ["ה. מה מסונכרן ונכנס לעבודה", "E. What syncs / enters work"], preview: ["ו. תצוגה מקדימה", "F. Preview"], sync: ["ז. סנכרון", "G. Sync"], status: ["מצב", "Status"] };
  const outbox = st?.outbox ?? {};

  return (
    <div className="space-y-3" data-testid="crm-wizard">
      <div className="flex flex-wrap items-center gap-2"><button type="button" className="text-xs text-muted hover:text-text" onClick={() => go({ c: null, step: null })}>{t("→ כל החיבורים", "← All connections")}</button><b>{conn.name}</b><span className="text-xs text-muted">{conn.connectorName}</span><Badge tone={s[2]} dot>{t(s[0], s[1])}</Badge>{st && conn.status === "active" && <Badge tone={st.fresh ? "good" : "warn"}>{st.fresh ? t("נתונים עדכניים", "Data fresh") : t("נתונים לא עדכניים – חיוג אוטומטי מושהה לרשומות שלו", "Data not fresh – auto-dialing paused for its records")}</Badge>}</div>
      <nav className="flex flex-wrap gap-1 text-xs" aria-label={t("שלבים", "Steps")} data-testid="crm-steps">{STEPS.map((k) => <button key={k} type="button" onClick={() => go({ step: k })} className={cx("h-8 px-3 rounded-full border", step === k ? "bg-accent text-white border-accent" : "border-line")} aria-current={step === k ? "step" : undefined}>{t(...label[k])}</button>)}</nav>

      {step === "auth" && (
        <Panel title={t(...label.auth)}>
          <div className="space-y-2 text-sm">
            {Object.entries(conn.authSet).map(([k, set]) => <div key={k} className="flex items-center gap-2"><span className="min-w-40">{k}</span><Badge tone={set ? "good" : "neutral"}>{set ? t("מוגדר", "Set") : t("לא מוגדר", "Not set")}</Badge>{conn.authPublic[k] && <span className="ltr text-xs text-muted">{conn.authPublic[k]}</span>}</div>)}
            <p className="text-xs text-muted">{t("עדכון פרטי גישה מחזיר את החיבור למצב \"בהגדרה\" עד בדיקה חוזרת.", "Updating credentials returns the connection to \"setting up\" until tested again.")}</p>
            <div className="grid md:grid-cols-2 gap-2">{Object.keys(conn.authSet).map((k) => <Input key={k} label={k} autoComplete="off" value={auth[k] ?? ""} onChange={(e) => setAuth({ ...auth, [k]: e.target.value })} ltr />)}</div>
            <Button size="sm" onClick={() => act("auth", () => api.patch(`/api/integrations/crm/${conn.id}/auth`, { auth: Object.fromEntries(Object.entries(auth).filter(([, v]) => v)) }), t("עודכן – יש לבדוק שוב", "Updated – test again"))} loading={busy === "auth"}>{t("עדכון", "Update")}</Button>
          </div>
        </Panel>
      )}

      {step === "test" && (
        <Panel title={t(...label.test)}>
          <div className="space-y-2 text-sm" data-testid="crm-test">
            <p className="text-muted text-xs">{t("בקשה אמיתית למערכת החיצונית. רק בדיקה שעוברת מסמנת את החיבור כמחובר.", "A real request to the external system. Only a passing test marks the connection as connected.")}</p>
            {conn.lastTestResult && <p className={conn.lastTestResult.ok ? "text-good" : "text-bad"} data-testid="crm-test-result">{conn.lastTestResult.ok ? "✓" : "✗"} {conn.lastTestResult.message} <span className="text-muted text-xs">({dt(conn.lastTestAt)})</span></p>}
            <Button onClick={() => act("test", () => api.post(`/api/integrations/crm/${conn.id}/test`, {}))} loading={busy === "test"} data-testid="crm-run-test">{t("בדיקת חיבור", "Test connection")}</Button>
            {conn.connectorKey === "generic_api" && <GenericSetup conn={conn} />}
          </div>
        </Panel>
      )}

      {step === "mapping" && (
        <Panel title={t(...label.mapping)} actions={<Button size="sm" onClick={save} loading={busy === "save"} data-testid="crm-save-mapping">{t("שמור", "Save")}</Button>}>
          {!disc ? <Spinner /> : (
            <div className="space-y-4 text-sm">
              <section><h3 className="font-semibold mb-1">{t("נציגים", "Agents")}</h3><p className="text-xs text-muted mb-2">{t("נציג חיצוני שאינו ממופה למשתמש פעיל – הרשומה ממתינה בתור בירור ולא עוברת לנציג אקראי.", "An external agent not mapped to an active user – the record waits in the review queue, never a random agent.")}</p>
                {owners.length === 0 && <p className="text-xs text-muted">{t("עוד לא התקבלו נציגים מהמערכת החיצונית. אפשר להוסיף מזהה ידנית:", "No agents received yet. Add an id manually:")}</p>}
                <div className="space-y-1">{owners.map((o) => <div key={o} className="flex flex-wrap items-center gap-2"><span className="ltr text-xs min-w-32">{o}{extName(o) ? ` · ${extName(o)}` : ""}</span><Select aria-label={o} value={settings.userMap[o] ?? ""} onChange={(e) => { const m = { ...settings.userMap }; if (e.target.value) m[o] = e.target.value; else delete m[o]; setSettings({ ...settings, userMap: m }); }} className="h-8 w-56"><option value="">{t("לא ממופה – לבירור", "Unmapped – review")}</option>{disc.localUsers.map((u) => <option key={u.id} value={u.id}>{u.fullName}</option>)}</Select></div>)}</div>
                <AddKey onAdd={(k) => setSettings({ ...settings, userMap: { ...settings.userMap, [k]: "" } })} placeholder={t("מזהה נציג חיצוני", "External agent id")} />
              </section>
              <section><h3 className="font-semibold mb-1">{t("סטטוסים", "Statuses")}</h3>
                <div className="flex flex-wrap gap-3 mb-2"><Select label={t("כיוון סנכרון סטטוס", "Status sync direction")} value={settings.directions.status} onChange={(e) => setSettings({ ...settings, directions: { ...settings.directions, status: e.target.value } })} className="w-60"><option value="in">{t("מהמערכת החיצונית אלינו", "From external to us")}</option><option value="out">{t("מאיתנו החוצה", "From us out")}</option><option value="both">{t("שני הכיוונים (התנגשות → בירור)", "Both (conflict → review)")}</option><option value="none">{t("ללא", "None")}</option></Select>
                  <Select label={t("כיוון פולואפ", "Follow-up direction")} value={settings.directions.followUp} onChange={(e) => setSettings({ ...settings, directions: { ...settings.directions, followUp: e.target.value } })} className="w-60"><option value="in">{t("מהמערכת החיצונית אלינו", "From external to us")}</option><option value="none">{t("ללא", "None")}</option></Select></div>
                <div className="space-y-1">{extStatuses.map((x) => <div key={x} className="flex flex-wrap items-center gap-2"><span className="ltr text-xs min-w-32">{x}</span><span>→</span><Select aria-label={x} value={settings.statusMap[x] ?? ""} onChange={(e) => { const m = { ...settings.statusMap }; if (e.target.value) m[x] = e.target.value; else delete m[x]; setSettings({ ...settings, statusMap: m }); }} className="h-8 w-48"><option value="">{t("לא ממופה", "Unmapped")}</option>{LOCAL_STATUSES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</Select></div>)}</div>
                <AddKey onAdd={(k) => setSettings({ ...settings, statusMap: { ...settings.statusMap, [k]: "new" } })} placeholder={t("סטטוס חיצוני", "External status")} />
                {(settings.directions.status === "out" || settings.directions.status === "both") && <div className="mt-2 space-y-1"><p className="text-xs text-muted">{t("סטטוס שלנו → ערך במערכת החיצונית (רק מה שממופה נשלח):", "Our status → external value (only mapped ones are sent):")}</p>{LOCAL_STATUSES.map(([k, l]) => <div key={k} className="flex items-center gap-2"><span className="min-w-24 text-xs">{l}</span><Input aria-label={l} value={settings.statusOutMap[k] ?? ""} onChange={(e) => { const m = { ...settings.statusOutMap }; if (e.target.value) m[k] = e.target.value; else delete m[k]; setSettings({ ...settings, statusOutMap: m }); }} className="h-8 w-48" ltr /></div>)}</div>}
              </section>
              <section><h3 className="font-semibold mb-1">{t("מקור אמת", "Source of truth")}</h3>
                <ul className="text-xs text-muted list-disc ps-5 space-y-0.5"><li>{t("פרטי קשר ונציג מטפל: ה-CRM החיצוני.", "Contact details & handling agent: the external CRM.")}</li><li>{t("שיחות, הודעות ותוצאותיהן: UltraCRM.", "Calls, messages and their results: UltraCRM.")}</li><li>{t("סטטוסים ופולואפים: לפי המיפוי והכיוון שלמעלה.", "Statuses & follow-ups: per the mapping and direction above.")}</li><li>{t("חסימה: נאכפת כאן מיד ונשלחת החוצה; עדכון חיצוני רגיל לא מסיר אותה.", "Blocks: enforced here at once and sent out; an ordinary external update never lifts one.")}</li></ul>
                <div className="flex flex-wrap gap-3 mt-2"><Select label={t("מי קובע שיוך", "Who decides assignment")} value={settings.ownerAuthority} onChange={(e) => setSettings({ ...settings, ownerAuthority: e.target.value as Settings["ownerAuthority"] })} className="w-56"><option value="external">{t("ה-CRM החיצוני", "The external CRM")}</option><option value="local">{t("UltraCRM", "UltraCRM")}</option></Select>
                  <Select label={t("רעננות נדרשת לחיוג אוטומטי", "Freshness required for auto-dialing")} value={String(settings.freshnessMinutes)} onChange={(e) => setSettings({ ...settings, freshnessMinutes: Number(e.target.value) })} className="w-56">{[15, 60, 240, 1440].map((m) => <option key={m} value={m}>{m < 60 ? t(`${m} דקות`, `${m} min`) : t(`${m / 60} שעות`, `${m / 60} h`)}</option>)}</Select>
                  <Select label={t("מחיקה במערכת החיצונית", "Deleted externally")} value={settings.deletionPolicy} onChange={(e) => setSettings({ ...settings, deletionPolicy: e.target.value as Settings["deletionPolicy"] })} className="w-64"><option value="stop_activity">{t("לבטל פעילות עתידית (ההיסטוריה נשמרת)", "Stop future activity (history kept)")}</option><option value="close_lead">{t("גם לסגור את הליד כאבוד", "Also close the lead as lost")}</option></Select></div>
              </section>
            </div>
          )}
        </Panel>
      )}

      {step === "selection" && (
        <Panel title={t(...label.selection)} actions={<Button size="sm" onClick={save} loading={busy === "save"} data-testid="crm-save-selection">{t("שמור", "Save")}</Button>}>
          <div className="space-y-4 text-sm">
            <div className="flex flex-wrap gap-4"><label className="flex items-center gap-1"><input type="checkbox" checked={settings.records.contacts} onChange={(e) => setSettings({ ...settings, records: { ...settings.records, contacts: e.target.checked } })} /> {t("אנשי קשר", "Contacts")}</label><label className="flex items-center gap-1"><input type="checkbox" checked={settings.records.leads} onChange={(e) => setSettings({ ...settings, records: { ...settings.records, leads: e.target.checked } })} /> {t("פניות / הזדמנויות", "Opportunities")}</label></div>
            <section><h3 className="font-semibold">{t("אילו פניות נכנסות לעבודה אצלנו", "Which opportunities enter work here")}</h3><p className="text-xs text-muted mb-2">{t("לדוגמה: רק סטטוס חדש או פולואפ של צוות המכירות. בלי בחירה – שום פנייה לא נכנסת לעבודה.", "E.g. only status new or follow-up of the sales team. Nothing selected – nothing enters work.")}</p>
              <Chips label={t("סטטוסים", "Statuses")} options={extStatuses} value={settings.selection.statuses} onChange={(v) => setSettings({ ...settings, selection: { ...settings.selection, statuses: v } })} />
              <Chips label={t("רשימות", "Lists")} options={[...new Set([...arr(disc?.lists ?? null), ...(disc?.seen.lists ?? [])])]} value={settings.selection.lists} onChange={(v) => setSettings({ ...settings, selection: { ...settings.selection, lists: v } })} />
              <Chips label={t("נציגים", "Agents")} options={owners} value={settings.selection.owners} onChange={(v) => setSettings({ ...settings, selection: { ...settings.selection, owners: v } })} />
              <Chips label={t("צוותים", "Teams")} options={disc?.seen.teams ?? []} value={settings.selection.teams} onChange={(v) => setSettings({ ...settings, selection: { ...settings.selection, teams: v } })} />
            </section>
            <section className="rounded-lg border border-line p-3"><h3 className="font-semibold">{t("הכנסה לתור חיוג – פעולה נפרדת ומפורשת", "Put into a dial queue – a separate, explicit step")}</h3>
              <label className="flex items-center gap-2 mt-1"><input type="checkbox" checked={settings.queue.enabled} onChange={(e) => setSettings({ ...settings, queue: { ...settings.queue, enabled: e.target.checked } })} data-testid="crm-queue-enabled" /> {t("להכניס פניות שנבחרו לרשימת חיוג:", "Put selected opportunities into dial list:")}</label>
              <Select aria-label={t("רשימת חיוג", "Dial list")} value={settings.queue.listId ?? ""} onChange={(e) => setSettings({ ...settings, queue: { ...settings.queue, listId: e.target.value || null } })} className="w-64 mt-1"><option value="">{t("בחירת רשימה", "Choose a list")}</option>{lists.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</Select>
              <p className="text-xs text-muted mt-1">{t("פנייה שיוצאת מהתנאים יוצאת מהתור; העברה לנציג אחר מעבירה אותה. חסימות, הרשאות ורעננות המידע נבדקות שוב לפני כל חיוג.", "An opportunity that no longer matches leaves the queue; an agent change moves it. Blocks, permissions and data freshness are checked again before every dial.")}</p></section>
            <section><h3 className="font-semibold">{t("כתיבה חזרה", "Write-back")}</h3>
              <div className="grid md:grid-cols-2 gap-1 mt-1">
                {([["calls", "פעילות שיחה (מועד, כיוון, משך, תוצאה)", "write_call"], ["aiSummary", "סיכום AI (מתעדכן בפעילות הקיימת)", "update_call"], ["detailsLink", "קישור לפרטי השיחה (דורש התחברות והרשאה)", "write_call"], ["followUpTasks", "משימת פולואפ", "upsert_task"], ["status", "שינוי סטטוס (לפי מיפוי יוצא)", "update_status"], ["blocks", "בקשת הסרה / חסימה", "request_block"], ["whatsappSummary", "סיכום WhatsApp – עדיין לא זמין", "__none"]] as const).map(([k, l, cap]) => <label key={k} className={cx("flex items-center gap-2 text-xs", !can(cap) && "opacity-50")}><input type="checkbox" disabled={!can(cap)} checked={settings.writeback[k] && can(cap)} onChange={(e) => setSettings({ ...settings, writeback: { ...settings.writeback, [k]: e.target.checked } })} /> {l}{!can(cap) && cap !== "__none" ? ` – ${t("המחבר אינו תומך", "not supported by the connector")}` : ""}</label>)}
              </div></section>
          </div>
        </Panel>
      )}

      {step === "preview" && (
        <Panel title={t(...label.preview)}>
          <div className="space-y-2 text-sm" data-testid="crm-preview">
            <Button size="sm" onClick={() => act("pv", async () => setPv(await api.get(`/api/integrations/crm/${conn.id}/preview`)))} loading={busy === "pv"} disabled={conn.status !== "active"}>{t("הצג תצוגה מקדימה", "Show preview")}</Button>
            {conn.status !== "active" && <p className="text-xs text-warn">{t("יש לעבור בדיקת חיבור קודם.", "Pass the connection test first.")}</p>}
            {pv && (pv.supported === false ? <p className="text-muted">{String(pv.message)}</p> : (
              <ul className="text-sm space-y-1"><li>{t("אנשי קשר", "Contacts")}: <b>{String(pv.contacts)}</b></li><li>{t("פניות", "Opportunities")}: <b>{String(pv.leads)}</b> · {t("ייכנסו לעבודה לפי הבחירה", "enter work per selection")}: <b>{String(pv.selectedLeads)}</b></li><li>{t("טלפונים כפולים בתוך המקור", "Duplicate phones in the source")}: <b>{String(pv.duplicatePhonesInSource)}</b></li><li>{t("התאמה לכרטיסים קיימים (ייבדקו – ללא איחוד עיוור)", "Match existing cards (checked – never merged blindly)")}: <b>{String(pv.matchingExistingCards)}</b></li><li>{t("נציגים לא ממופים", "Unmapped agents")}: <span className="ltr">{(pv.unmappedOwners as string[]).join(", ") || "—"}</span></li><li>{t("סטטוסים לא ממופים", "Unmapped statuses")}: <span className="ltr">{(pv.unmappedStatuses as string[]).join(", ") || "—"}</span></li><li className="text-xs text-muted">{String(pv.note)}</li></ul>
            ))}
          </div>
        </Panel>
      )}

      {step === "sync" && (
        <Panel title={t(...label.sync)}>
          <div className="space-y-2 text-sm" data-testid="crm-sync">
            {can("pull_contacts") || can("pull_leads") ? <>
              <Button onClick={() => act("sync", () => api.post(`/api/integrations/crm/${conn.id}/sync`, {}), t("הסנכרון הראשוני התחיל", "Initial sync started"))} loading={busy === "sync"} disabled={conn.status !== "active"} data-testid="crm-start-sync">{t("אישור והתחלת סנכרון ראשוני", "Confirm & start initial sync")}</Button>
              <p>{t("שלב", "Phase")}: <b>{conn.syncState.phase ?? "—"}</b> · {t("רשומות שעובדו", "Records processed")}: <b>{conn.syncState.processed ?? 0}</b> · {t("התחיל", "Started")} {dt(conn.syncState.startedAt ?? null)} · {t("הסתיים", "Finished")} {dt(conn.syncState.finishedAt ?? null)}</p>
              <p className="text-xs text-muted">{t("הייבוא ממשיך ברקע עם עימוד והגבלת קצב, וממשיך מנקודת העצירה אחרי תקלה. אחריו: בדיקת עדכונים כל", "Import continues in the background with paging and rate limits, and resumes after a failure. Then: checking for updates every")} {conn.settings.pollMinutes} {t("דקות והשלמה מלאה כל 6 שעות.", "minutes and a full reconcile every 6 hours.")}</p>
            </> : <p className="text-muted">{t("במחבר הזה המערכת החיצונית שולחת את הרשומות ל-API שלנו (ראו מפתח ותיעוד בשלב הבדיקה). אין שלב ייבוא יזום.", "With this connector the external system sends records to our API (see key & docs in the test step). There is no import to start.")}</p>}
          </div>
        </Panel>
      )}

      {step === "status" && st && (
        <div className="space-y-3" data-testid="crm-status">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-sm">
            {[[t("סנכרון אחרון", "Last sync"), dt(conn.lastSyncAt)], [t("אנשי קשר מקושרים", "Linked contacts"), st.links.contact ?? 0], [t("פניות מקושרות", "Linked opportunities"), st.links.lead ?? 0], [t("פעילויות שנכתבו", "Activities written"), st.links.activity ?? 0], [t("ממתין לכתיבה חזרה", "Waiting to write back"), (outbox.pending ?? 0) + (outbox.failed ?? 0)], [t("נכשל סופית", "Failed permanently"), outbox.dead ?? 0], [t("בירור פתוח", "Open review"), st.reviews.length], [t("אירועים נכשלו (7 ימים)", "Failed events (7d)"), st.events7d.failed ?? 0]].map(([l, v]) => <div key={String(l)} className="rounded-lg border border-line bg-panel p-2"><p className="text-xs text-muted">{l}</p><p className="font-semibold">{String(v)}</p></div>)}
          </div>
          {conn.lastError && <p className="text-sm text-bad">{conn.lastError}</p>}
          <p className="text-xs text-muted">{t("\"בוצע אצלנו\" ו\"סונכרן ל-CRM\" נפרדים: שיחה, תוצאה וחסימה נשמרות כאן מיד; הכתיבה החוצה ממתינה בתור וחוזרת על עצמה עד שהיא מצליחה, בלי כפילויות.", "\"Done here\" and \"synced to the CRM\" are separate: a call, its result and a block are saved here at once; writing out waits in a queue and retries until it succeeds, without duplicates.")}</p>
          <Panel title={t(`תור בירור (${st.reviews.length})`, `Review queue (${st.reviews.length})`)}>
            {st.reviews.length === 0 ? <p className="text-sm text-muted">{t("אין פריטים לבירור.", "Nothing to review.")}</p> : <ul className="divide-y divide-line text-sm" data-testid="crm-reviews">{st.reviews.map((r) => <ReviewRow key={r.id} r={r} connId={conn.id} onDone={refresh} />)}</ul>}
          </Panel>
          {(st.failedOutbox.length > 0 || st.failedEvents.length > 0) && <Panel title={t("כשלים", "Failures")} actions={<div className="flex gap-2"><Button size="sm" variant="secondary" onClick={() => act("rp1", () => api.post(`/api/integrations/crm/${conn.id}/reprocess`, { kind: "outbox" }), t("הוחזר לתור", "Re-queued"))}>{t("שלח שוב כתיבות", "Retry write-backs")}</Button><Button size="sm" variant="secondary" onClick={() => act("rp2", () => api.post(`/api/integrations/crm/${conn.id}/reprocess`, { kind: "events" }), t("עובד מחדש", "Reprocessed"))}>{t("עבד מחדש אירועים", "Reprocess events")}</Button></div>}>
            <ul className="text-xs space-y-1">{st.failedOutbox.map((o) => <li key={o.id}>{o.action} · {o.status} · {o.lastError}</li>)}{st.failedEvents.map((e) => <li key={e.id}>{e.recordType} <span className="ltr">{e.externalId}</span> · {e.error}</li>)}</ul>
          </Panel>}
          <div className="flex flex-wrap gap-2">
            {conn.status === "disconnected" ? <Button onClick={() => act("reconnect", () => api.post(`/api/integrations/crm/${conn.id}/reconnect`, {}), t("חובר מחדש – משלים פערים", "Reconnected – filling the gap"))} loading={busy === "reconnect"}>{t("חיבור מחדש (בדיקה + השלמת פערים)", "Reconnect (test + gap fill)")}</Button>
              : <Button variant="danger" onClick={() => { if (confirm(t("לנתק? הסנכרון והכתיבה חזרה ייעצרו וחיוג אוטומטי לרשומות שלו יושהה. שום נתון לא יימחק.", "Disconnect? Sync and write-back stop and auto-dialing of its records pauses. Nothing is deleted."))) void act("disc", () => api.post(`/api/integrations/crm/${conn.id}/disconnect`, {})); }}>{t("ניתוק", "Disconnect")}</Button>}
          </div>
        </div>
      )}
    </div>
  );
}

function ReviewRow({ r, connId, onDone }: { r: Status["reviews"][number]; connId: string; onDone: () => Promise<unknown> }) {
  const t = useT(); const [busy, setBusy] = useState(false);
  const cands = (r.details.candidates as Array<{ id: string; name: string }> | undefined) ?? [];
  const act = async (body: Record<string, unknown>) => { setBusy(true); try { await api.post(`/api/integrations/crm/${connId}/reviews/${r.id}`, body); await onDone(); } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); } };
  return (
    <li className="py-2 flex flex-wrap items-center gap-2">
      <Badge tone="warn">{REVIEW[r.kind] ?? r.kind}</Badge><span className="text-xs">{r.recordType} <span className="ltr">{r.externalId}</span></span>
      <span className="text-xs text-muted">{JSON.stringify(r.details).slice(0, 140)}</span>
      <div className="ms-auto flex flex-wrap gap-1">
        {(r.kind === "fuzzy_match" || r.kind === "conflict") && cands.map((c) => <Button key={c.id} size="sm" variant="secondary" disabled={busy} onClick={() => act({ action: "link", contactId: c.id })}>{t(`קשר ל"${c.name}"`, `Link to "${c.name}"`)}</Button>)}
        {r.kind === "fuzzy_match" && <Button size="sm" variant="secondary" disabled={busy} onClick={() => act({ action: "create_new" })}>{t("כרטיס נפרד", "Separate card")}</Button>}
        {(r.kind === "unmapped_owner" || r.kind === "unmapped_status") && <Button size="sm" variant="secondary" disabled={busy} onClick={() => act({ action: "retry" })}>{t("עבד שוב (אחרי מיפוי)", "Retry (after mapping)")}</Button>}
        <Button size="sm" variant="ghost" disabled={busy} onClick={() => act({ action: "dismiss" })}>{t("סגור", "Dismiss")}</Button>
      </div>
    </li>
  );
}

function Chips({ label, options, value, onChange }: { label: string; options: string[]; value: string[]; onChange: (v: string[]) => void }) {
  const t = useT(); const [extra, setExtra] = useState("");
  const all = [...new Set([...options, ...value])];
  return (
    <div className="mb-2"><p className="text-xs text-muted mb-1">{label}</p><div className="flex flex-wrap gap-1">{all.map((o) => <button key={o} type="button" onClick={() => onChange(value.includes(o) ? value.filter((x) => x !== o) : [...value, o])} className={cx("h-7 px-2.5 rounded-full text-xs border ltr", value.includes(o) ? "bg-accent text-white border-accent" : "border-line")}>{o}</button>)}
      <input className="h-7 px-2 rounded-full border border-line text-xs bg-transparent w-32" placeholder={t("+ ערך", "+ value")} value={extra} onChange={(e) => setExtra(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && extra.trim()) { onChange([...value, extra.trim()]); setExtra(""); } }} /></div></div>
  );
}
function AddKey({ onAdd, placeholder }: { onAdd: (k: string) => void; placeholder: string }) {
  const t = useT(); const [v, setV] = useState("");
  return <div className="flex gap-2 mt-1"><Input value={v} onChange={(e) => setV(e.target.value)} placeholder={placeholder} className="h-8 w-48" ltr /><Button size="sm" variant="ghost" onClick={() => { if (v.trim()) { onAdd(v.trim()); setV(""); } }}>{t("הוסף", "Add")}</Button></div>;
}

/** General integration: integration keys (scoped, rotatable) and the API reference with examples. */
function GenericSetup({ conn }: { conn: Conn }) {
  const t = useT();
  const [keys, setKeys] = useState<Array<{ id: string; name: string; prefix: string; scopes: string[]; lastUsedAt: string | null; revokedAt: string | null; expiresAt: string | null }>>([]);
  const [shown, setShown] = useState<string | null>(null); const [scopes, setScopes] = useState<string[]>(["contacts:write", "leads:write", "blocks:write", "events:read"]);
  const load = useCallback(() => api.get<{ items: typeof keys }>(`/api/integrations/crm/${conn.id}/keys`).then((r) => setKeys(r.items)).catch(() => undefined), [conn.id]);
  useEffect(() => { void load(); }, [load]);
  const base = typeof window !== "undefined" ? window.location.origin : "";
  return (
    <div className="space-y-3 border-t border-line pt-3" data-testid="crm-generic">
      <p className="text-xs rounded-md bg-warn/10 border border-warn/30 p-2">{t("זו אינטגרציה כללית ולא מחבר מוכן ל-CRM מסוים: צריך להגדיר במערכת החיצונית (או ב-Make / Zapier / n8n) שליחת אנשי קשר ופניות ל-API למטה, ואם רוצים – כתובת חזרה לקבלת התוצאות.", "This is a general integration, not a ready connector for a specific CRM: configure the external system (or Make / Zapier / n8n) to send contacts and opportunities to the API below and, optionally, a callback URL to receive results.")}</p>
      <div><h3 className="font-semibold text-sm">{t("מפתחות אינטגרציה", "Integration keys")}</h3>
        <div className="flex flex-wrap gap-3 text-xs my-1">{["contacts:write", "leads:write", "blocks:write", "events:read"].map((sc) => <label key={sc} className="flex items-center gap-1 ltr"><input type="checkbox" checked={scopes.includes(sc)} onChange={(e) => setScopes(e.target.checked ? [...scopes, sc] : scopes.filter((x) => x !== sc))} />{sc}</label>)}</div>
        <Button size="sm" onClick={async () => { try { const k = await api.post<{ key: string }>(`/api/integrations/crm/${conn.id}/keys`, { name: "מפתח אינטגרציה", scopes }); setShown(k.key); await load(); } catch (e) { toast.error((e as Error).message); } }} data-testid="crm-new-key">{t("יצירת מפתח", "Create key")}</Button>
        {shown && <div className="mt-2"><p className="text-xs text-warn">{t("המפתח מוצג פעם אחת בלבד:", "The key is shown once only:")}</p><code className="block ltr text-start bg-panel-2 rounded p-2 text-xs break-all" data-testid="crm-key-once">{shown}</code></div>}
        <ul className="text-xs mt-2 space-y-1">{keys.map((k) => <li key={k.id} className="flex flex-wrap items-center gap-2"><span className="ltr">{k.prefix}…</span><span className="ltr text-muted">{k.scopes.join(" ")}</span>{k.revokedAt ? <Badge tone="neutral">{t("בוטל", "Revoked")}</Badge> : k.expiresAt ? <Badge tone="warn">{t("פג ב-", "Expires ")}{new Date(k.expiresAt).toLocaleString()}</Badge> : <Badge tone="good">{t("פעיל", "Active")}</Badge>}{!k.revokedAt && !k.expiresAt && <><button type="button" className="underline" onClick={async () => { const r = await api.post<{ key: string }>(`/api/integrations/keys/${k.id}/rotate`, {}); setShown(r.key); await load(); }}>{t("החלפה", "Rotate")}</button><button type="button" className="underline text-bad" onClick={async () => { await api.delete(`/api/integrations/keys/${k.id}`); await load(); }}>{t("ביטול", "Revoke")}</button></>}</li>)}</ul>
      </div>
      <details className="text-xs" open><summary className="cursor-pointer font-semibold">{t("תיעוד API (גרסה 1)", "API reference (v1)")}</summary>
        <div className="space-y-2 mt-2 ltr text-start">
          <p>Auth: <code>Authorization: Bearer uk_live_…</code> · Rate limit: 120 requests / minute / key (<code>X-RateLimit-Remaining</code>) · Idempotency: <code>Idempotency-Key</code> or <code>X-Event-Id</code> header · Stale protection: <code>updatedAt</code> / numeric <code>version</code> in the body.</p>
          <pre className="bg-panel-2 rounded p-2 overflow-x-auto">{`PUT ${base}/api/v1/crm/contacts/{externalId}
{ "name": "Dana Levi", "phones": ["+972501234567"], "email": "dana@example.com",
  "ownerExternalId": "rep-17", "source": "website", "updatedAt": "2026-09-30T08:00:00Z" }

PUT ${base}/api/v1/crm/leads/{externalId}
{ "contactExternalId": "c-123", "status": "new", "ownerExternalId": "rep-17",
  "followUpAt": "2026-10-01T09:00:00+03:00", "timezone": "Asia/Jerusalem",
  "product": "Premium", "campaign": "Autumn", "list": "Sales", "updatedAt": "..." }
→ 200 { "success": true, "data": { "status": "applied" | "review" | "skipped_duplicate" | "skipped_stale", "localId": "...", "reviewIds": [] } }

DELETE ${base}/api/v1/crm/contacts/{externalId}   (future work stops; history kept)
POST   ${base}/api/v1/crm/blocks   { "contactExternalId": "c-123", "reason": "unsubscribe" }
GET    ${base}/api/v1/crm/events?after={lastEventId}&limit=50
       → { "items": [{ "id", "type": "call.outcome_saved" | "call.summary_ready" | ..., "contactExternalId", "data" }], "nextCursor" }
GET    ${base}/api/v1/crm/records/{contact|lead}/{externalId}`}</pre>
          <p>Callback (optional, write-back): we POST <code>{`{ action, correlationId, idempotencyKey, data }`}</code> to your HTTPS URL with <code>X-UltraCRM-Timestamp</code> and <code>{`X-UltraCRM-Signature: sha256=HMAC_SHA256(callbackSecret, timestamp + "." + body)`}</code>. Actions: <code>call.logged</code>, <code>call.updated</code> (late AI summary), <code>task.created</code> / <code>task.updated</code>, <code>lead.status</code>, <code>contact.block</code>, <code>ping</code>. Reply 2xx (optionally <code>{`{ "externalId": "..." }`}</code>); retries reuse the same <code>correlationId</code> – ignore repeats.</p>
          <p>Errors: 400 validation · 401 bad / expired key · 403 missing scope · 409 connection disconnected · 422 not applied (e.g. contact not synced yet) · 429 rate limited.</p>
        </div>
      </details>
    </div>
  );
}
