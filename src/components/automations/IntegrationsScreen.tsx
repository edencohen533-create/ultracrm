"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Copy, KeyRound, Send, Trash2, Webhook } from "lucide-react";
import { api } from "@/lib/client/api";
import { Badge, Button, Input, Modal, Panel, Spinner } from "@/components/ui";

interface Key { id: string; name: string; prefix: string; lastUsedAt: string | null; revokedAt: string | null; createdAt: string }
interface Endpoint { id: string; url: string; description: string | null; events: string[]; isActive: boolean; failureCount: number; lastSuccessAt: string | null; lastFailureAt: string | null; secret: string | null }
interface Delivery { id: string; event: string; status: string; attempts: number; responseCode: number | null; error: string | null; createdAt: string; deliveredAt: string | null; nextAttemptAt: string }
const copy = async (t: string) => { try { await navigator.clipboard.writeText(t); toast.success("הועתק"); } catch { toast.error("לא ניתן להעתיק"); } };
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString("he-IL", { dateStyle: "short", timeStyle: "short" }) : "—");
function Code({ value, testid }: { value: string; testid?: string }) { return <div className="carts-code"><code dir="ltr" data-testid={testid}>{value}</code><button onClick={() => copy(value)} aria-label="העתקה"><Copy size={14} /></button></div>; }

/** "Webhooks ו-API": public API keys + outgoing webhooks, so Make / Zapier / n8n can connect in both directions. */
export function IntegrationsScreen() {
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
  async function revoke(k: Key) { if (!window.confirm(`לבטל את המפתח "${k.name}"? חיבורים שמשתמשים בו יפסיקו לעבוד מיד.`)) return; try { await api.delete(`/api/integrations/keys/${k.id}`); toast.success("המפתח בוטל"); await load(); } catch (e) { toast.error((e as Error).message); } }
  async function toggle(e: Endpoint) { try { await api.patch(`/api/integrations/webhooks/${e.id}`, { isActive: !e.isActive }); await load(); } catch (err) { toast.error((err as Error).message); } }
  async function remove(e: Endpoint) { if (!window.confirm("למחוק את ה-Webhook?")) return; try { await api.delete(`/api/integrations/webhooks/${e.id}`); await load(); } catch (err) { toast.error((err as Error).message); } }
  async function test(e: Endpoint) {
    try { const r = await api.post<{ ok: boolean; code: number | null; error: string | null }>(`/api/integrations/webhooks/${e.id}/test`, {}); if (r.ok) toast.success(`נשלח בהצלחה (HTTP ${r.code})`); else toast.error(`השליחה נכשלה: ${r.error ?? r.code}`); }
    catch (err) { toast.error((err as Error).message); }
  }

  if (!keys || !endpoints) return <div className="py-10 flex justify-center"><Spinner /></div>;
  return (
    <div className="space-y-4" data-testid="integrations-screen">
      <Panel title={<span className="flex items-center gap-2"><Webhook size={16} />Webhooks – שליחת אירועים ל-Make / Zapier</span>} actions={<Button size="sm" onClick={() => setAdding(true)} data-testid="webhook-add">הוסף Webhook</Button>}>
        <p className="text-sm text-muted mb-3">בכל פעם שקורה אירוע שבחרת (ליד חדש, עסקה נסגרה, שיחה תועדה…) נשלחת בקשת POST עם JSON לכתובת. ב-Make: מודול <b>Webhooks → Custom webhook</b>; ב-Zapier: <b>Webhooks by Zapier → Catch Hook</b> – העתק את הכתובת שהם נותנים לכאן.</p>
        {endpoints.length ? <table className="w-full text-sm" data-testid="webhook-list"><thead className="text-xs text-muted"><tr><th className="text-start h-8">כתובת</th><th className="text-start">אירועים</th><th className="text-start">מצב</th><th /></tr></thead><tbody className="divide-y divide-line">
          {endpoints.map((e) => <tr key={e.id} data-testid={`webhook-${e.id}`}><td className="py-2"><div dir="ltr" className="text-start truncate max-w-[340px]">{e.url}</div>{e.description && <div className="text-xs text-muted">{e.description}</div>}</td>
            <td className="text-xs">{e.events.map((x) => events[x] ?? x).join(" · ")}</td>
            <td className="text-xs"><Badge tone={!e.isActive ? "neutral" : e.failureCount ? "warn" : "good"} dot>{!e.isActive ? "כבוי" : e.failureCount ? `${e.failureCount} כשלונות` : "פעיל"}</Badge><div className="text-muted mt-1">הצלחה אחרונה: {when(e.lastSuccessAt)}</div></td>
            <td className="text-end whitespace-nowrap"><Button size="sm" variant="ghost" onClick={() => test(e)} data-testid="webhook-test"><Send size={13} />שלח בדיקה</Button><Button size="sm" variant="ghost" onClick={() => setLog(e)}>יומן</Button><Button size="sm" variant="ghost" onClick={() => toggle(e)}>{e.isActive ? "השבת" : "הפעל"}</Button><Button size="sm" variant="ghost" onClick={() => remove(e)} aria-label="מחק"><Trash2 size={13} /></Button></td></tr>)}
        </tbody></table> : <p className="text-sm text-muted">עוד לא הוגדרו Webhooks.</p>}
      </Panel>

      <Panel title={<span className="flex items-center gap-2"><KeyRound size={16} />API – קבלת לידים מ-Make / Zapier / טפסים</span>}>
        <p className="text-sm text-muted mb-2">צור מפתח API והשתמש בו בבקשת HTTP כדי ליצור לידים במערכת (Make: מודול <b>HTTP → Make a request</b>; Zapier: <b>Webhooks by Zapier → POST</b>).</p>
        <div className="flex flex-wrap items-end gap-2 mb-3"><Input label="שם המפתח" value={keyName} onChange={(e) => setKeyName(e.target.value)} className="w-56" data-testid="api-key-name" /><Button onClick={createKey} disabled={!keyName.trim()} data-testid="api-key-create">צור מפתח API</Button></div>
        {newKey && <div className="rounded-lg border border-accent p-3 mb-3" data-testid="api-key-created"><div className="text-sm mb-1">המפתח <b>{newKey.name}</b> נוצר. העתק אותו עכשיו – הוא לא יוצג שוב:</div><Code value={newKey.key} testid="api-key-value" /></div>}
        <table className="w-full text-sm mb-4" data-testid="api-key-list"><thead className="text-xs text-muted"><tr><th className="text-start h-8">שם</th><th className="text-start">מפתח</th><th className="text-start">שימוש אחרון</th><th className="text-start">מצב</th><th /></tr></thead><tbody className="divide-y divide-line">
          {keys.length ? keys.map((k) => <tr key={k.id}><td className="py-2">{k.name}</td><td dir="ltr" className="text-start">{k.prefix}…</td><td className="text-xs">{when(k.lastUsedAt)}</td><td>{k.revokedAt ? <Badge>בוטל</Badge> : <Badge tone="good" dot>פעיל</Badge>}</td><td className="text-end">{!k.revokedAt && <Button size="sm" variant="ghost" onClick={() => revoke(k)} data-testid="api-key-revoke">בטל</Button>}</td></tr>) : <tr><td colSpan={5} className="py-2 text-muted">אין מפתחות.</td></tr>}
        </tbody></table>
        <div className="space-y-2 text-sm">
          <div className="font-medium">יצירת ליד</div>
          <Code value={`POST ${base}/api/v1/leads`} />
          <div className="text-xs text-muted">Headers: <code dir="ltr">Authorization: Bearer uk_live_…</code> · <code dir="ltr">Content-Type: application/json</code></div>
          <Code value={'{"fullName": "ישראל ישראלי", "phone": "0501234567", "email": "a@b.com", "source": "facebook", "ownerEmail": "agent@company.com", "notes": "…", "customFields": {"campaign": "summer"}}'} />
          <p className="text-xs text-muted">רק fullName ו-phone חובה. בלי ownerEmail הליד מחולק לפי הגדרות חלוקת הלידים. אם לאיש הקשר כבר יש ליד פתוח – מוחזר הליד הקיים (בלי כפילות).</p>
          <div className="font-medium pt-1">בדיקת חיבור · לידים אחרונים</div>
          <Code value={`GET ${base}/api/v1/me`} /><Code value={`GET ${base}/api/v1/leads?since=2026-01-01T00:00:00Z`} />
          <p className="text-xs text-muted">אימות Webhooks: כל שליחה חתומה בכותרת <code dir="ltr">X-UltraCRM-Signature: sha256=HMAC(secret, body)</code>. שליחות שנכשלו נשלחות שוב (עד 6 ניסיונות).</p>
        </div>
      </Panel>

      {adding && <AddEndpoint events={events} onClose={() => setAdding(false)} onCreated={(e) => { setAdding(false); setCreated(e); void load(); }} />}
      {created && <Modal open onClose={() => setCreated(null)} title="ה-Webhook נוצר"><div className="space-y-2 text-sm" data-testid="webhook-created"><p>מפתח החתימה (לאימות בצד שלך – אופציונלי ב-Make/Zapier). מוצג פעם אחת:</p><Code value={created.secret ?? ""} /><p className="text-xs text-muted">לחץ &quot;שלח בדיקה&quot; כדי ש-Make/Zapier יזהו את מבנה הנתונים.</p></div></Modal>}
      {log && <DeliveryLog endpoint={log} onClose={() => setLog(null)} />}
    </div>
  );
}

function AddEndpoint({ events, onClose, onCreated }: { events: Record<string, string>; onClose: () => void; onCreated: (e: Endpoint) => void }) {
  const [url, setUrl] = useState(""); const [description, setDescription] = useState("");
  const [picked, setPicked] = useState<string[]>(["lead.created"]);
  const [busy, setBusy] = useState(false);
  async function save() { setBusy(true); try { onCreated(await api.post<Endpoint>("/api/integrations/webhooks", { url, description: description || undefined, events: picked })); } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); } }
  return (
    <Modal open onClose={() => !busy && onClose()} title="Webhook חדש" footer={<><Button variant="ghost" onClick={onClose}>ביטול</Button><Button onClick={save} loading={busy} disabled={!url.trim() || !picked.length} data-testid="webhook-save">שמור</Button></>}>
      <div className="space-y-3" data-testid="webhook-form">
        <Input label="כתובת (https)" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://hook.eu1.make.com/…" ltr data-testid="webhook-url" />
        <Input label="תיאור (לא חובה)" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="למשל: לידים לגוגל שיטס" />
        <div><div className="text-sm font-medium mb-1">אירועים</div><div className="grid sm:grid-cols-2 gap-1">{Object.entries(events).map(([k, label]) => <label key={k} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={picked.includes(k)} onChange={(e) => setPicked((p) => (e.target.checked ? [...p, k] : p.filter((x) => x !== k)))} data-testid={`webhook-event-${k}`} />{label} <span className="text-[11px] text-muted" dir="ltr">{k}</span></label>)}</div></div>
      </div>
    </Modal>
  );
}

function DeliveryLog({ endpoint, onClose }: { endpoint: Endpoint; onClose: () => void }) {
  const [items, setItems] = useState<Delivery[] | null>(null);
  useEffect(() => { api.get<{ items: Delivery[] }>(`/api/integrations/webhooks/${endpoint.id}/deliveries`).then((r) => setItems(r.items)).catch((e) => { toast.error((e as Error).message); setItems([]); }); }, [endpoint.id]);
  const S: Record<string, string> = { delivered: "נשלח", pending: "ממתין / ינסה שוב", failed: "נכשל" };
  return (
    <Modal open onClose={onClose} title="יומן שליחות" width="max-w-2xl">
      {!items ? <div className="py-6 flex justify-center"><Spinner /></div> : !items.length ? <p className="text-sm text-muted">עוד לא נשלחו אירועים.</p> :
        <table className="w-full text-sm"><thead className="text-xs text-muted"><tr><th className="text-start h-8">זמן</th><th className="text-start">אירוע</th><th className="text-start">מצב</th><th className="text-start">ניסיונות</th><th className="text-start">תשובה</th></tr></thead><tbody className="divide-y divide-line">
          {items.map((d) => <tr key={d.id}><td className="py-1.5 text-xs">{when(d.createdAt)}</td><td dir="ltr" className="text-start text-xs">{d.event}</td><td><Badge tone={d.status === "delivered" ? "good" : d.status === "failed" ? "bad" : "warn"}>{S[d.status] ?? d.status}</Badge></td><td>{d.attempts}</td><td className="text-xs">{d.responseCode ?? ""} {d.error ?? ""}</td></tr>)}
        </tbody></table>}
    </Modal>
  );
}
