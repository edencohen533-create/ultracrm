"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Copy, KeyRound, Send, Trash2, Webhook } from "lucide-react";
import { api } from "@/lib/client/api";
import { Badge, Button, Input, Modal, Panel, Spinner } from "@/components/ui";
import { useT } from "@/components/i18n/LangProvider";

type T = (he: string, en: string) => string;

interface Key { id: string; name: string; prefix: string; lastUsedAt: string | null; revokedAt: string | null; createdAt: string }
interface Endpoint { id: string; url: string; description: string | null; events: string[]; isActive: boolean; failureCount: number; lastSuccessAt: string | null; lastFailureAt: string | null; secret: string | null }
interface Delivery { id: string; event: string; status: string; attempts: number; responseCode: number | null; error: string | null; createdAt: string; deliveredAt: string | null; nextAttemptAt: string }
const copy = async (text: string, t: T) => { try { await navigator.clipboard.writeText(text); toast.success(t("הועתק", "Copied")); } catch { toast.error(t("לא ניתן להעתיק", "Could not copy")); } };
const when = (iso: string | null, lang: string) => (iso ? new Date(iso).toLocaleString(lang === "en" ? "en-GB" : "he-IL", { dateStyle: "short", timeStyle: "short" }) : "—");
function Code({ value, testid }: { value: string; testid?: string }) { const t = useT(); return <div className="carts-code"><code dir="ltr" data-testid={testid}>{value}</code><button onClick={() => copy(value, t)} aria-label={t("העתקה", "Copy")}><Copy size={14} /></button></div>; }

/** "Webhooks ו-API": public API keys + outgoing webhooks, so Make / Zapier / n8n can connect in both directions. */
export function IntegrationsScreen() {
  const t = useT();
  const [keys, setKeys] = useState<Key[] | null>(null);
  const [endpoints, setEndpoints] = useState<Endpoint[] | null>(null);
  const [events, setEvents] = useState<Record<string, string>>({});
  const [newKey, setNewKey] = useState<{ name: string; key: string } | null>(null);
  const [keyName, setKeyName] = useState("Make");
  const [adding, setAdding] = useState(false);
  const [created, setCreated] = useState<Endpoint | null>(null);
  const [log, setLog] = useState<Endpoint | null>(null);
  const base = typeof window !== "undefined" ? window.location.origin : "";
  const load = useCallback(async () => {
    try {
      const [k, w] = await Promise.all([api.get<{ items: Key[] }>("/api/integrations/keys"), api.get<{ items: Endpoint[]; events: Record<string, string> }>("/api/integrations/webhooks")]);
      setKeys(k.items); setEndpoints(w.items); setEvents(w.events);
    } catch (e) { toast.error((e as Error).message); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function createKey() {
    try { const r = await api.post<{ name: string; key: string }>("/api/integrations/keys", { name: keyName }); setNewKey(r); await load(); } catch (e) { toast.error((e as Error).message); }
  }
  async function revoke(k: Key) { if (!window.confirm(t(`לבטל את המפתח "${k.name}"? חיבורים שמשתמשים בו יפסיקו לעבוד מיד.`, `Revoke the key "${k.name}"? Connections using it will stop working immediately.`))) return; try { await api.delete(`/api/integrations/keys/${k.id}`); toast.success(t("המפתח בוטל", "Key revoked")); await load(); } catch (e) { toast.error((e as Error).message); } }
  async function toggle(e: Endpoint) { try { await api.patch(`/api/integrations/webhooks/${e.id}`, { isActive: !e.isActive }); await load(); } catch (err) { toast.error((err as Error).message); } }
  async function remove(e: Endpoint) { if (!window.confirm(t("למחוק את ה-Webhook?", "Delete this webhook?"))) return; try { await api.delete(`/api/integrations/webhooks/${e.id}`); await load(); } catch (err) { toast.error((err as Error).message); } }
  async function test(e: Endpoint) {
    try { const r = await api.post<{ ok: boolean; code: number | null; error: string | null }>(`/api/integrations/webhooks/${e.id}/test`, {}); if (r.ok) toast.success(t(`נשלח בהצלחה (HTTP ${r.code})`, `Sent successfully (HTTP ${r.code})`)); else toast.error(t(`השליחה נכשלה: ${r.error ?? r.code}`, `Send failed: ${r.error ?? r.code}`)); }
    catch (err) { toast.error((err as Error).message); }
  }

  if (!keys || !endpoints) return <div className="py-10 flex justify-center"><Spinner /></div>;
  return (
    <div className="space-y-4" data-testid="integrations-screen">
      <Panel title={<span className="flex items-center gap-2"><Webhook size={16} />{t("Webhooks – שליחת אירועים ל-Make / Zapier", "Webhooks – send events to Make / Zapier")}</span>} actions={<Button size="sm" onClick={() => setAdding(true)} data-testid="webhook-add">{t("הוסף Webhook", "Add webhook")}</Button>}>
        <p className="text-sm text-muted mb-3">{t("בכל פעם שקורה אירוע שבחרת (ליד חדש, עסקה נסגרה, שיחה תועדה…) נשלחת בקשת POST עם JSON לכתובת. ב-Make: מודול", "Whenever an event you selected happens (new lead, deal closed, call logged…), a POST request with JSON is sent to the URL. In Make: the module")} <b>Webhooks → Custom webhook</b>{t("; ב-Zapier:", "; in Zapier:")} <b>Webhooks by Zapier → Catch Hook</b> {t("– העתק את הכתובת שהם נותנים לכאן.", "– copy the URL they give you here.")}</p>
        {endpoints.length ? <table className="w-full text-sm" data-testid="webhook-list"><thead className="text-xs text-muted"><tr><th className="text-start h-8">{t("כתובת", "URL")}</th><th className="text-start">{t("אירועים", "Events")}</th><th className="text-start">{t("מצב", "Status")}</th><th /></tr></thead><tbody className="divide-y divide-line">
          {endpoints.map((e) => <tr key={e.id} data-testid={`webhook-${e.id}`}><td className="py-2"><div dir="ltr" className="text-start truncate max-w-[340px]">{e.url}</div>{e.description && <div className="text-xs text-muted">{e.description}</div>}</td>
            <td className="text-xs">{e.events.map((x) => events[x] ?? x).join(" · ")}</td>
            <td className="text-xs"><Badge tone={!e.isActive ? "neutral" : e.failureCount ? "warn" : "good"} dot>{!e.isActive ? t("כבוי", "Off") : e.failureCount ? t(`${e.failureCount} כשלונות`, `${e.failureCount} failures`) : t("פעיל", "Active")}</Badge><div className="text-muted mt-1">{t("הצלחה אחרונה:", "Last success:")} {when(e.lastSuccessAt, t.lang)}</div></td>
            <td className="text-end whitespace-nowrap"><Button size="sm" variant="ghost" onClick={() => test(e)} data-testid="webhook-test"><Send size={13} />{t("שלח בדיקה", "Send test")}</Button><Button size="sm" variant="ghost" onClick={() => setLog(e)}>{t("יומן", "Log")}</Button><Button size="sm" variant="ghost" onClick={() => toggle(e)}>{e.isActive ? t("השבת", "Disable") : t("הפעל", "Enable")}</Button><Button size="sm" variant="ghost" onClick={() => remove(e)} aria-label={t("מחק", "Delete")}><Trash2 size={13} /></Button></td></tr>)}
        </tbody></table> : <p className="text-sm text-muted">{t("עוד לא הוגדרו Webhooks.", "No webhooks configured yet.")}</p>}
      </Panel>

      <Panel title={<span className="flex items-center gap-2"><KeyRound size={16} />{t("API – קבלת לידים מ-Make / Zapier / טפסים", "API – receive leads from Make / Zapier / forms")}</span>}>
        <p className="text-sm text-muted mb-2">{t("צור מפתח API והשתמש בו בבקשת HTTP כדי ליצור לידים במערכת (Make: מודול", "Create an API key and use it in an HTTP request to create leads in the system (Make: the module")} <b>HTTP → Make a request</b>; Zapier: <b>Webhooks by Zapier → POST</b>).</p>
        <div className="flex flex-wrap items-end gap-2 mb-3"><Input label={t("שם המפתח", "Key name")} value={keyName} onChange={(e) => setKeyName(e.target.value)} className="w-56" data-testid="api-key-name" /><Button onClick={createKey} disabled={!keyName.trim()} data-testid="api-key-create">{t("צור מפתח API", "Create API key")}</Button></div>
        {newKey && <div className="rounded-lg border border-accent p-3 mb-3" data-testid="api-key-created"><div className="text-sm mb-1">{t("המפתח", "The key")} <b>{newKey.name}</b> {t("נוצר. העתק אותו עכשיו – הוא לא יוצג שוב:", "was created. Copy it now – it will not be shown again:")}</div><Code value={newKey.key} testid="api-key-value" /></div>}
        <table className="w-full text-sm mb-4" data-testid="api-key-list"><thead className="text-xs text-muted"><tr><th className="text-start h-8">{t("שם", "Name")}</th><th className="text-start">{t("מפתח", "Key")}</th><th className="text-start">{t("שימוש אחרון", "Last used")}</th><th className="text-start">{t("מצב", "Status")}</th><th /></tr></thead><tbody className="divide-y divide-line">
          {keys.length ? keys.map((k) => <tr key={k.id}><td className="py-2">{k.name}</td><td dir="ltr" className="text-start">{k.prefix}…</td><td className="text-xs">{when(k.lastUsedAt, t.lang)}</td><td>{k.revokedAt ? <Badge>{t("בוטל", "Revoked")}</Badge> : <Badge tone="good" dot>{t("פעיל", "Active")}</Badge>}</td><td className="text-end">{!k.revokedAt && <Button size="sm" variant="ghost" onClick={() => revoke(k)} data-testid="api-key-revoke">{t("בטל", "Revoke")}</Button>}</td></tr>) : <tr><td colSpan={5} className="py-2 text-muted">{t("אין מפתחות.", "No keys.")}</td></tr>}
        </tbody></table>
        <div className="space-y-2 text-sm">
          <div className="font-medium">{t("יצירת ליד", "Create a lead")}</div>
          <Code value={`POST ${base}/api/v1/leads`} />
          <div className="text-xs text-muted">Headers: <code dir="ltr">Authorization: Bearer uk_live_…</code> · <code dir="ltr">Content-Type: application/json</code></div>
          <Code value={`{"fullName": "${t("ישראל ישראלי", "John Doe")}", "phone": "0501234567", "email": "a@b.com", "source": "facebook", "ownerEmail": "agent@company.com", "notes": "…", "customFields": {"campaign": "summer"}}`} />
          <p className="text-xs text-muted">{t("רק fullName ו-phone חובה. בלי ownerEmail הליד מחולק לפי הגדרות חלוקת הלידים. אם לאיש הקשר כבר יש ליד פתוח – מוחזר הליד הקיים (בלי כפילות).", "Only fullName and phone are required. Without ownerEmail the lead is assigned according to the lead distribution settings. If the contact already has an open lead, the existing lead is returned (no duplicate).")}</p>
          <div className="font-medium pt-1">{t("בדיקת חיבור · לידים אחרונים", "Connection test · recent leads")}</div>
          <Code value={`GET ${base}/api/v1/me`} /><Code value={`GET ${base}/api/v1/leads?since=2026-01-01T00:00:00Z`} />
          <p className="text-xs text-muted">{t("אימות Webhooks: כל שליחה חתומה בכותרת", "Webhook verification: every delivery is signed in the header")} <code dir="ltr">X-UltraCRM-Signature: sha256=HMAC(secret, body)</code>{t(". שליחות שנכשלו נשלחות שוב (עד 6 ניסיונות).", ". Failed deliveries are retried (up to 6 attempts).")}</p>
        </div>
      </Panel>

      {adding && <AddEndpoint events={events} onClose={() => setAdding(false)} onCreated={(e) => { setAdding(false); setCreated(e); void load(); }} />}
      {created && <Modal open onClose={() => setCreated(null)} title={t("ה-Webhook נוצר", "Webhook created")}><div className="space-y-2 text-sm" data-testid="webhook-created"><p>{t("מפתח החתימה (לאימות בצד שלך – אופציונלי ב-Make/Zapier). מוצג פעם אחת:", "Signing secret (for verification on your side – optional in Make/Zapier). Shown once:")}</p><Code value={created.secret ?? ""} /><p className="text-xs text-muted">{t("לחץ \"שלח בדיקה\" כדי ש-Make/Zapier יזהו את מבנה הנתונים.", "Click \"Send test\" so Make/Zapier can detect the data structure.")}</p></div></Modal>}
      {log && <DeliveryLog endpoint={log} onClose={() => setLog(null)} />}
    </div>
  );
}

function AddEndpoint({ events, onClose, onCreated }: { events: Record<string, string>; onClose: () => void; onCreated: (e: Endpoint) => void }) {
  const [url, setUrl] = useState(""); const [description, setDescription] = useState("");
  const [picked, setPicked] = useState<string[]>(["lead.created"]);
  const [busy, setBusy] = useState(false);
  const t = useT();
  async function save() { setBusy(true); try { onCreated(await api.post<Endpoint>("/api/integrations/webhooks", { url, description: description || undefined, events: picked })); } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); } }
  return (
    <Modal open onClose={() => !busy && onClose()} title={t("Webhook חדש", "New webhook")} footer={<><Button variant="ghost" onClick={onClose}>{t("ביטול", "Cancel")}</Button><Button onClick={save} loading={busy} disabled={!url.trim() || !picked.length} data-testid="webhook-save">{t("שמור", "Save")}</Button></>}>
      <div className="space-y-3" data-testid="webhook-form">
        <Input label={t("כתובת (https)", "URL (https)")} value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://hook.eu1.make.com/…" ltr data-testid="webhook-url" />
        <Input label={t("תיאור (לא חובה)", "Description (optional)")} value={description} onChange={(e) => setDescription(e.target.value)} placeholder={t("למשל: לידים לגוגל שיטס", "e.g. Leads to Google Sheets")} />
        <div><div className="text-sm font-medium mb-1">{t("אירועים", "Events")}</div><div className="grid sm:grid-cols-2 gap-1">{Object.entries(events).map(([k, label]) => <label key={k} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={picked.includes(k)} onChange={(e) => setPicked((p) => (e.target.checked ? [...p, k] : p.filter((x) => x !== k)))} data-testid={`webhook-event-${k}`} />{label} <span className="text-[11px] text-muted" dir="ltr">{k}</span></label>)}</div></div>
      </div>
    </Modal>
  );
}

function DeliveryLog({ endpoint, onClose }: { endpoint: Endpoint; onClose: () => void }) {
  const [items, setItems] = useState<Delivery[] | null>(null);
  const t = useT();
  useEffect(() => { api.get<{ items: Delivery[] }>(`/api/integrations/webhooks/${endpoint.id}/deliveries`).then((r) => setItems(r.items)).catch((e) => { toast.error((e as Error).message); setItems([]); }); }, [endpoint.id]);
  const S: Record<string, string> = { delivered: t("נשלח", "Delivered"), pending: t("ממתין / ינסה שוב", "Pending / will retry"), failed: t("נכשל", "Failed") };
  return (
    <Modal open onClose={onClose} title={t("יומן שליחות", "Delivery log")} width="max-w-2xl">
      {!items ? <div className="py-6 flex justify-center"><Spinner /></div> : !items.length ? <p className="text-sm text-muted">{t("עוד לא נשלחו אירועים.", "No events sent yet.")}</p> :
        <table className="w-full text-sm"><thead className="text-xs text-muted"><tr><th className="text-start h-8">{t("זמן", "Time")}</th><th className="text-start">{t("אירוע", "Event")}</th><th className="text-start">{t("מצב", "Status")}</th><th className="text-start">{t("ניסיונות", "Attempts")}</th><th className="text-start">{t("תשובה", "Response")}</th></tr></thead><tbody className="divide-y divide-line">
          {items.map((d) => <tr key={d.id}><td className="py-1.5 text-xs">{when(d.createdAt, t.lang)}</td><td dir="ltr" className="text-start text-xs">{d.event}</td><td><Badge tone={d.status === "delivered" ? "good" : d.status === "failed" ? "bad" : "warn"}>{S[d.status] ?? d.status}</Badge></td><td>{d.attempts}</td><td className="text-xs">{d.responseCode ?? ""} {d.error ?? ""}</td></tr>)}
        </tbody></table>}
    </Modal>
  );
}
