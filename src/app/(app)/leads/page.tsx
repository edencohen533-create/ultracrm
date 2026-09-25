"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Fragment, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { ArrowDownUp, CalendarDays, Check, ChevronLeft, ChevronRight, Coins, Download, Filter, Maximize2, Megaphone, MessageCircle, Minimize2, Phone as PhoneIcon, PiggyBank, RefreshCw, Search, ShoppingBag, Target, TrendingUp, Users, X, Percent } from "lucide-react";
import { api, qs } from "@/lib/client/api";
import { useDialer } from "@/components/telephony/DialerProvider";
import { useMe } from "@/lib/client/use-me";
import { Button, EmptyState, Input, Modal, Select, Spinner } from "@/components/ui";
import { formatPhone } from "@/lib/client/format";
import { LEAD_STATUSES, LEAD_STATUS_LABEL } from "@/lib/crm/labels";
import { LeadDrawer } from "@/components/leads/LeadDrawer";
import { DialerWorkspace } from "@/components/dialer/DialerWorkspace";
import { StartSessionForm } from "@/components/dialer/SessionControls";

interface Lead { id: string; title: string | null; status: string; source: string | null; createdAt: string; contact: { id: string; fullName: string; phoneE164: string; email: string | null; customFields: Record<string, unknown> | null }; owner: { id: string; fullName: string } | null }
interface LeadData { items: Lead[]; total: number; byOwner: { id: string | null; name: string; count: number }[]; sources: string[]; metrics: { leads: number; deals: number; revenue: number; conversion: number } }
interface ContactHit { id: string; fullName: string; phoneE164: string }
const number = (v: number) => v.toLocaleString("he-IL", { maximumFractionDigits: 1 });
const money = (v: number) => `₪ ${number(v)}`;
const metadata = (lead: Lead, key: string) => { const v = lead.contact.customFields?.[key]; return typeof v === "string" || typeof v === "number" ? String(v) : "—"; };
const periods: Record<string, string> = { month: "החודש", today: "היום", week: "7 ימים אחרונים", lastMonth: "החודש הקודם", all: "כל התקופות", custom: "טווח מותאם" };

export default function LeadsPage() { return <Suspense fallback={<div className="p-10"><Spinner /></div>}><LeadsWorkspace /></Suspense>; }

function LeadsWorkspace() {
  const me = useMe();
  const params = useSearchParams();
  const { dial, state, sessionSummary } = useDialer();
  const live = Boolean((state?.session && state.session.status !== "ended") || state?.activeCall || state?.wrapUpCall || sessionSummary);
  const [detail, setDetail] = useState<{ id: string; tab: "details" | "chat" } | null>(null);
  const [dock, setDock] = useState(false);
  const [side, setSide] = useState<"left" | "right">("left");
  const [minimized, setMinimized] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [data, setData] = useState<LeadData | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState({ status: params.get("status") ?? "", q: params.get("q") ?? "", ownerUserId: params.get("mine") === "1" ? "me" : params.get("ownerUserId") ?? "", source: "", product: "", campaign: "", ad: "", period: "month", from: "", to: "" });
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState({ key: "createdAt", direction: "desc" });
  const [group, setGroup] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [users, setUsers] = useState<{ id: string; fullName: string }[]>([]);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [hits, setHits] = useState<ContactHit[]>([]);
  const [form, setForm] = useState({ contactId: "", contactName: "", phone: "", title: "", source: "", ownerUserId: "" });
  const [newContact, setNewContact] = useState(false);
  const [saving, setSaving] = useState(false);
  const [convert, setConvert] = useState<Lead | null>(null);
  const [dealForm, setDealForm] = useState({ title: "", amount: "" });
  const [sourceInfo, setSourceInfo] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);
  const requestId = useRef(0);
  const manager = Boolean(me && me.user.role !== "agent");
  const telephony = Boolean(me?.modules.telephony);
  const canDial = telephony && Boolean(state) && !state?.activeCall && !state?.wrapUpCall;
  const owner = filter.ownerUserId === "me" ? me?.user.id ?? "" : filter.ownerUserId;
  const dates = useMemo(() => {
    const now = new Date(); let start: Date | undefined; let end: Date | undefined;
    if (filter.period === "month") start = new Date(now.getFullYear(), now.getMonth(), 1);
    if (filter.period === "lastMonth") { start = new Date(now.getFullYear(), now.getMonth() - 1, 1); end = new Date(now.getFullYear(), now.getMonth(), 1); }
    if (filter.period === "today") start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    if (filter.period === "week") start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6);
    if (filter.period === "custom") { if (filter.from) start = new Date(`${filter.from}T00:00:00`); if (filter.to) { end = new Date(`${filter.to}T00:00:00`); end.setDate(end.getDate() + 1); } }
    return { createdFrom: start?.toISOString(), createdTo: end?.toISOString() };
  }, [filter.period, filter.from, filter.to]);
  const load = useCallback(async () => {
    if (filter.ownerUserId === "me" && !me) return;
    const id = ++requestId.current; setLoading(true); setError("");
    try { const result = await api.get<LeadData>(`/api/leads${qs({ ...filter, ownerUserId: owner, ...dates, sort: sort.key, direction: sort.direction, page, limit: 30 })}`); if (id === requestId.current) setData(result); }
    catch (e) { if (id === requestId.current) setError((e as Error).message); }
    finally { if (id === requestId.current) setLoading(false); }
  }, [filter, owner, dates, sort, page, me]);
  useEffect(() => { const t = setTimeout(load, 220); return () => { clearTimeout(t); requestId.current++; }; }, [load, state?.wrapUpCall?.id]);
  useEffect(() => { api.get<{ items: { id: string; fullName: string; isActive: boolean }[] }>("/api/users").then(r => setUsers(r.items.filter(u => u.isActive))).catch(() => undefined); }, []);
  useEffect(() => { try { const v = localStorage.getItem("leads.dialer.side"); if (v === "left" || v === "right") setSide(v); } catch {} }, []);
  useEffect(() => { if (live) { setDock(true); setMinimized(false); } }, [live]);
  useEffect(() => { let alive = true; if (!open || search.trim().length < 2) { setHits([]); return; } const t = setTimeout(() => api.get<{ items: ContactHit[] }>(`/api/contacts${qs({ q: search, limit: 8 })}`).then(r => { if (alive) setHits(r.items); }).catch(() => undefined), 250); return () => { alive = false; clearTimeout(t); }; }, [open, search]);
  function change(key: keyof typeof filter, value: string) { setFilter(f => ({ ...f, [key]: value })); setPage(1); setSelected([]); }
  function moveDock(value: "left" | "right") { setSide(value); try { localStorage.setItem("leads.dialer.side", value); } catch {} }
  function sorting(key: string) { setSort(s => ({ key, direction: s.key === key && s.direction === "desc" ? "asc" : "desc" })); setPage(1); }
  async function patch(id: string, body: Record<string, unknown>) { try { await api.patch(`/api/leads/${id}`, body); await load(); } catch (e) { toast.error((e as Error).message); } }
  async function bulk(body: Record<string, unknown>) { setBulkBusy(true); const results = await Promise.allSettled(selected.map(id => api.patch(`/api/leads/${id}`, body))); const failed = results.filter(r => r.status === "rejected").length; setSelected(selected.filter((_, i) => results[i].status === "rejected")); if (failed) toast.error(`${failed} עדכונים נכשלו; הבחירה נשמרה עבורם`); else toast.success("הלידים עודכנו"); await load(); setBulkBusy(false); }
  async function create() {
    setSaving(true);
    try {
      let contactId = form.contactId;
      if (newContact && !contactId) { const c = await api.post<{ id: string }>("/api/contacts", { fullName: form.contactName, phone: form.phone }); contactId = c.id; setForm(f => ({ ...f, contactId })); }
      await api.post("/api/leads", { contactId, title: form.title || undefined, source: form.source || undefined, ownerUserId: form.ownerUserId || undefined });
      setOpen(false); setForm({ contactId: "", contactName: "", phone: "", title: "", source: "", ownerUserId: "" }); setSearch(""); setNewContact(false); toast.success("הליד נוצר"); await load();
    } catch (e) { toast.error((e as Error).message); } finally { setSaving(false); }
  }
  async function doConvert() { if (!convert) return; setSaving(true); try { await api.post(`/api/leads/${convert.id}/convert`, { title: dealForm.title || undefined, amount: dealForm.amount ? Number(dealForm.amount) : undefined }); setConvert(null); toast.success("העסקה נוצרה"); await load(); } catch (e) { toast.error((e as Error).message); } finally { setSaving(false); } }
  function exportSelected() { const rows = data?.items.filter(l => selected.includes(l.id)) ?? []; const csv = [["שם", "טלפון", "מקור", "סטטוס", "נציג"], ...rows.map(l => [l.contact.fullName, l.contact.phoneE164, l.source ?? "", LEAD_STATUS_LABEL[l.status as keyof typeof LEAD_STATUS_LABEL], l.owner?.fullName ?? ""])].map(row => row.map(value => { const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value; return `"${safe.replaceAll('"', '""')}"`; }).join(",")).join("\r\n"); const url = URL.createObjectURL(new Blob(["\ufeff", csv], { type: "text/csv;charset=utf-8" })); const a = document.createElement("a"); a.href = url; a.download = "leads.csv"; a.click(); URL.revokeObjectURL(url); }
  const groups = useMemo(() => {
    const map = new Map<string, Lead[]>();
    for (const lead of data?.items ?? []) { const key = group === "owner" ? lead.owner?.fullName ?? "ללא שיוך" : group === "status" ? LEAD_STATUS_LABEL[lead.status as keyof typeof LEAD_STATUS_LABEL] : group === "source" ? lead.source ?? "ללא מקור" : ""; map.set(key, [...map.get(key) ?? [], lead]); }
    return [...map];
  }, [data, group]);
  const cards = [
    { label: "תקציב פרסום", value: "—", Icon: Megaphone, tone: "orange", hint: "טרם חובר מקור לנתוני הוצאות פרסום" },
    { label: "כמות לידים", value: number(data?.metrics.leads ?? 0), Icon: Users, tone: "blue" },
    { label: "עסקאות שנסגרו", value: number(data?.metrics.deals ?? 0), Icon: ShoppingBag, tone: "indigo", hint: "עסקאות בשקלים שנסגרו בהצלחה ומקושרות ללידים בטווח" },
    { label: "עלות לליד", value: "—", Icon: Coins, tone: "amber", hint: "נדרש תקציב פרסום לחישוב" },
    { label: "אחוז סגירה", value: `${number(data?.metrics.conversion ?? 0)}%`, Icon: Percent, tone: "purple" },
    { label: "CAC", value: "—", Icon: Target, tone: "pink", hint: "נדרשות הוצאות רכישת לקוחות לחישוב" },
    { label: "הכנסות", value: money(data?.metrics.revenue ?? 0), Icon: TrendingUp, tone: "green", hint: "סכום עסקאות שנסגרו בהצלחה בשקלים" },
    { label: "רווח", value: "—", Icon: PiggyBank, tone: "teal", hint: "נדרשים נתוני עלויות לחישוב רווח" },
  ];
  return <div className="leads-page" data-testid="leads-redesign">
    <header className="leads-header"><h1>לידים</h1><div className="leads-header-actions"><span className="leads-count">{number(data?.total ?? 0)} לידים</span>
      <button className="lead-button" onClick={() => setSourceInfo(true)}><RefreshCw size={15} />סנכרן שדות מהמקור</button>
      <button className="lead-button" onClick={() => { void load(); toast.info("נתוני הסגירות מחושבים מהעסקאות במערכת"); }} disabled={loading}><RefreshCw size={15} className={loading ? "animate-spin" : ""} />רענן סגירות מעסקאות</button>
      <button className="lead-button primary" onClick={() => setOpen(true)}>ליד חדש</button></div></header>
    <section className="lead-filters" aria-label="סינון לידים">
      <div className="lead-search"><Search size={18} /><input aria-label="חיפוש לידים" placeholder="חיפוש לפי שם, טלפון או אימייל..." value={filter.q} onChange={e => change("q", e.target.value)} /></div>
      <div className="lead-period"><CalendarDays size={15}/><select aria-label="תקופה" value={filter.period} onChange={e => change("period", e.target.value)}>{Object.entries(periods).map(([key,label]) => <option key={key} value={key}>{label}</option>)}</select></div>
      <select aria-label="סטטוס" value={filter.status} onChange={e => change("status", e.target.value)}><option value="">כל הסטטוסים</option>{LEAD_STATUSES.map(s => <option key={s} value={s}>{LEAD_STATUS_LABEL[s]}</option>)}</select>
      <select aria-label="מקור" value={filter.source} onChange={e => change("source", e.target.value)}><option value="">כל המקורות</option>{data?.sources.map(s => <option key={s}>{s}</option>)}</select>
      <input aria-label="מוצר" placeholder="כל המוצרים" value={filter.product} onChange={e => change("product", e.target.value)} />
      <input aria-label="קמפיין" placeholder="חיפוש לפי קמפיין..." value={filter.campaign} onChange={e => change("campaign", e.target.value)} />
      <input aria-label="מודעה" placeholder="חיפוש לפי מודעה..." value={filter.ad} onChange={e => change("ad", e.target.value)} />
      <select aria-label="נציג" value={filter.ownerUserId} onChange={e => change("ownerUserId", e.target.value)}><option value="">כל הנציגים</option><option value="me">הלידים שלי</option><option value="unassigned">ללא שיוך</option>{manager && users.map(u => <option key={u.id} value={u.id}>{u.fullName}</option>)}</select>
      <div className="lead-period"><Filter size={15}/><select aria-label="קיבוץ" value={group} onChange={e => setGroup(e.target.value)}><option value="">קבץ: ללא</option><option value="owner">לפי נציג</option><option value="status">לפי סטטוס</option><option value="source">לפי מקור</option></select></div>
    </section>
    {filter.period === "custom" && <div className="lead-date-range"><label>מתאריך <input type="date" aria-label="מתאריך" value={filter.from} max={filter.to || undefined} onChange={e => change("from", e.target.value)} /></label><label>עד תאריך <input type="date" aria-label="עד תאריך" value={filter.to} min={filter.from || undefined} onChange={e => change("to", e.target.value)} /></label></div>}
    <div className="leads-tools"><span>טווח: {periods[filter.period]}</span><div>{telephony && <><button className="lead-button dialer-launch" data-testid="open-dialer" disabled={!state} onClick={() => { setDock(true); setMinimized(false); }}><PhoneIcon size={15}/>הפעל חייגן</button><select aria-label="מיקום החייגן" value={side} onChange={e => moveDock(e.target.value as "left" | "right")}><option value="left">שמאל למעלה</option><option value="right">ימין למעלה</option></select></>}</div></div>
    <section className="lead-stats" aria-label="נתוני לידים">{cards.map(({ label, value, Icon, tone, hint }) => <article className="lead-stat" key={label} title={hint}><span className={`stat-icon ${tone}`}><Icon size={21} strokeWidth={1.8}/></span><strong dir="ltr">{data ? value : "…"}</strong><span>{label}</span></article>)}</section>
    <section className="lead-distribution"><h2>לידים לפי נציג</h2>{data?.byOwner.length ? data.byOwner.map(o => <button key={o.id ?? "none"} title={`סנן לפי ${o.name}`} onClick={() => change("ownerUserId", o.id ?? "unassigned")} className="lead-bar-row"><span className="lead-bar-name">{o.name}</span><span className="lead-bar-track"><span style={{ width: `${data.total ? o.count / data.total * 100 : 0}%` }}/></span><strong>{number(o.count)}</strong><span className="lead-bar-percent">{number(data.total ? o.count / data.total * 100 : 0)}%</span></button>) : <p className="text-sm text-muted py-4">אין לידים בטווח שנבחר</p>}</section>
    {error && <div role="alert" className="lead-error">{error}<button onClick={load}>נסה שוב</button></div>}
    {selected.length > 0 && <div className="lead-bulk"><span><Check size={16}/> {selected.length} לידים נבחרו</span><select aria-label="שינוי סטטוס לנבחרים" value="" disabled={bulkBusy} onChange={e => e.target.value && bulk({ status: e.target.value })}><option value="">שנה סטטוס</option>{LEAD_STATUSES.map(s => <option key={s} value={s}>{LEAD_STATUS_LABEL[s]}</option>)}</select>{manager && <select aria-label="שיוך נבחרים" value="" disabled={bulkBusy} onChange={e => e.target.value && bulk({ ownerUserId: e.target.value === "none" ? null : e.target.value })}><option value="">שייך לנציג</option><option value="none">ללא שיוך</option>{users.map(u => <option value={u.id} key={u.id}>{u.fullName}</option>)}</select>}<button className="lead-button" onClick={exportSelected}><Download size={15}/>ייצוא נבחרים</button><button aria-label="בטל בחירה" onClick={() => setSelected([])}><X size={16}/></button></div>}
    <section className="lead-table-card" aria-busy={loading}>
      {!data ? <div className="p-12 flex justify-center"><Spinner/></div> : <><div className="lead-table-scroll"><table className="leads-table"><thead><tr><th><input type="checkbox" aria-label="בחר את כל הלידים בעמוד" checked={data.items.length > 0 && data.items.every(l => selected.includes(l.id))} onChange={e => setSelected(e.target.checked ? data.items.map(l => l.id) : [])}/></th><th><button onClick={() => sorting("name")}>שם <ArrowDownUp size={13}/></button></th><th>טלפון</th><th><button onClick={() => sorting("source")}>מקור <ArrowDownUp size={13}/></button></th><th>מוצר</th><th>קמפיין</th><th>מודעה</th><th><button onClick={() => sorting("status")}>סטטוס <ArrowDownUp size={13}/></button></th><th><button onClick={() => sorting("owner")}>נציג <ArrowDownUp size={13}/></button></th><th><button onClick={() => sorting("createdAt")}>נוצר <ArrowDownUp size={13}/></button></th><th>פעולות</th></tr></thead><tbody>{groups.map(([name, rows]) => <Fragment key={name}>{group && <tr className="lead-group"><td colSpan={11}>{name} · {rows.length} בעמוד זה</td></tr>}{rows.map(l => <tr key={l.id} data-testid={`lead-row-${l.id}`} className={selected.includes(l.id) ? "selected" : ""}>
        <td><input type="checkbox" aria-label={`בחר ${l.contact.fullName}`} checked={selected.includes(l.id)} onChange={e => setSelected(s => e.target.checked ? [...s, l.id] : s.filter(id => id !== l.id))}/></td>
        <td><button className="lead-name" onClick={() => setDetail({ id: l.id, tab: "details" })}>{l.contact.fullName}</button>{l.status !== "converted" && <button className="lead-new-deal" onClick={() => { setConvert(l); setDealForm({ title: l.title ?? `עסקה – ${l.contact.fullName}`, amount: "" }); }}>+ עסקה חדשה</button>}</td>
        <td className="lead-phone" dir="ltr">{formatPhone(l.contact.phoneE164)}</td><td>{l.source ?? "—"}</td><td>{metadata(l, "product")}</td><td className="lead-campaign">{metadata(l, "campaign")}</td><td className="lead-campaign">{metadata(l, "ad")}</td>
        <td><select aria-label={`סטטוס ${l.contact.fullName}`} className={`lead-status status-${l.status}`} value={l.status} onChange={e => patch(l.id, { status: e.target.value })}>{LEAD_STATUSES.map(s => <option key={s} value={s}>{LEAD_STATUS_LABEL[s]}</option>)}</select></td>
        <td>{manager ? <select className="lead-owner" aria-label={`נציג ${l.contact.fullName}`} value={l.owner?.id ?? ""} onChange={e => patch(l.id, { ownerUserId: e.target.value || null })}><option value="">ללא שיוך</option>{l.owner && !users.some(u => u.id === l.owner?.id) && <option value={l.owner.id}>{l.owner.fullName}</option>}{users.map(u => <option key={u.id} value={u.id}>{u.fullName}</option>)}</select> : l.owner?.fullName ?? "ללא שיוך"}</td>
        <td className="lead-created" dir="ltr">{new Date(l.createdAt).toLocaleDateString("he-IL")}<span>{new Date(l.createdAt).toLocaleTimeString("he-IL", { hour: "2-digit", minute: "2-digit" })}</span></td>
        <td><div className="lead-row-actions">{me?.modules.messaging && <button className="lead-whatsapp" onClick={() => setDetail({ id: l.id, tab: "chat" })} aria-label={`WhatsApp ${l.contact.fullName}`} title="פתיחת שיחת WhatsApp"><MessageCircle size={17}/><span>WhatsApp</span></button>}{telephony && <button className="lead-call" disabled={!canDial} title="חיוג לליד" aria-label={`חייג ${l.contact.fullName}`} onClick={() => { setDock(true); setMinimized(false); void dial({ mode: "manual", contactId: l.contact.id }); }}><PhoneIcon size={15}/><span>חייג</span></button>}</div></td>
      </tr>)}</Fragment>)}</tbody></table></div>{!data.items.length && <EmptyState title="אין לידים התואמים לסינון" hint="שנה את הטווח או המסננים, או צור ליד חדש"/>}<footer className="lead-pagination"><span>{number(data.total)} לידים · עמוד {page} מתוך {Math.max(1, Math.ceil(data.total / 30))}</span><div><button aria-label="עמוד קודם" disabled={page <= 1 || loading} onClick={() => { setPage(p => p - 1); setSelected([]); }}><ChevronRight size={17}/></button><button aria-label="עמוד הבא" disabled={page * 30 >= data.total || loading} onClick={() => { setPage(p => p + 1); setSelected([]); }}><ChevronLeft size={17}/></button></div></footer></>}
    </section>
    {telephony && dock && <section className={`lead-dialer-dock dock-${side} ${minimized ? "minimized" : ""} ${expanded ? "expanded" : ""}`} aria-label="חייגן" data-testid="dialer-embedded"><header><strong><PhoneIcon size={17}/> {live ? "חייגן פעיל" : "הפעלת חייגן"}</strong><div><button title="העבר לצד השני" aria-label="העבר חייגן לצד השני" onClick={() => moveDock(side === "left" ? "right" : "left")}><ArrowDownUp className="rotate-90" size={16}/></button><button title="הרחב" aria-label="הרחב חייגן" onClick={() => { setExpanded(v => !v); setMinimized(false); }}><Maximize2 size={16}/></button><button title={live ? "מזער (השיחה תמשיך)" : "סגור"} aria-label={live ? "מזער חייגן" : "סגור חייגן"} onClick={() => live ? setMinimized(v => !v) : setDock(false)}>{live ? <Minimize2 size={16}/> : <X size={17}/>}</button></div></header><div className="lead-dialer-body" hidden={minimized}>{live ? <DialerWorkspace embedded compact={!expanded}/> : <div className="p-4"><StartSessionForm compact onStarted={() => { setDock(true); void load(); }}/></div>}</div></section>}
    {detail && <LeadDrawer key={detail.id} leadId={detail.id} initialTab={detail.tab} users={users} manager={manager} messaging={Boolean(me?.modules.messaging)} canDial={canDial} onDial={contactId => { setDock(true); setMinimized(false); void dial({ mode: "manual", contactId }); }} onClose={() => setDetail(null)} onUpdated={() => { void load(); }}/>}
    <Modal open={open} onClose={() => !saving && setOpen(false)} title="ליד חדש" footer={<><Button variant="ghost" onClick={() => setOpen(false)} disabled={saving}>ביטול</Button><Button onClick={create} loading={saving} disabled={newContact ? !form.contactName || !form.phone : !form.contactId}>צור ליד</Button></>}><div className="space-y-3"><div className="flex gap-3"><button className={!newContact ? "text-accent font-medium" : "text-muted"} onClick={() => { setNewContact(false); setForm(f => ({ ...f, contactId: "" })); }}>איש קשר קיים</button><button className={newContact ? "text-accent font-medium" : "text-muted"} onClick={() => { setNewContact(true); setForm(f => ({ ...f, contactId: "", contactName: "" })); }}>איש קשר חדש</button></div>{newContact ? <><Input label="שם מלא" value={form.contactName} onChange={e => setForm({ ...form, contactName: e.target.value })}/><Input label="טלפון" value={form.phone} onChange={e => setForm({ ...form, phone: e.target.value })} ltr/></> : form.contactId ? <div>{form.contactName}<button className="ms-3 text-accent" onClick={() => setForm({ ...form, contactId: "" })}>שנה</button></div> : <><Input label="חיפוש איש קשר" value={search} onChange={e => setSearch(e.target.value)}/><ul className="max-h-44 overflow-auto">{hits.map(h => <li key={h.id}><button className="w-full text-start p-2 hover:bg-panel-2" onClick={() => setForm({ ...form, contactId: h.id, contactName: h.fullName })}>{h.fullName} · {formatPhone(h.phoneE164)}</button></li>)}</ul></>}<Input label="כותרת" value={form.title} onChange={e => setForm({ ...form, title: e.target.value })}/><Input label="מקור" value={form.source} onChange={e => setForm({ ...form, source: e.target.value })}/>{manager && <Select label="נציג" value={form.ownerUserId} onChange={e => setForm({ ...form, ownerUserId: e.target.value })}><option value="">ללא שיוך</option>{users.map(u => <option key={u.id} value={u.id}>{u.fullName}</option>)}</Select>}</div></Modal>
    <Modal open={Boolean(convert)} onClose={() => !saving && setConvert(null)} title="עסקה חדשה מהליד" footer={<Button onClick={doConvert} loading={saving}>צור עסקה</Button>}><div className="space-y-3"><Input label="כותרת העסקה" value={dealForm.title} onChange={e => setDealForm({ ...dealForm, title: e.target.value })}/><Input label="סכום (₪)" type="number" min="0" value={dealForm.amount} onChange={e => setDealForm({ ...dealForm, amount: e.target.value })} ltr/></div></Modal>
    <Modal open={sourceInfo} onClose={() => setSourceInfo(false)} title="נתוני המקור"><div className="space-y-3 text-sm"><p>המוצר, הקמפיין והמודעה מוצגים מתוך שדות איש הקשר במערכת. רענון טוען את העדכונים האחרונים שנשמרו.</p><p className="text-muted">טרם הוגדר חיבור חיצוני לפרסום או להזמנות. לאחר חיבור מקור נתונים ניתן יהיה לסנכרן גם תקציב, עלויות ורווח.</p><Button onClick={() => { void load(); setSourceInfo(false); }}>רענן נתונים מהמערכת</Button><Link href="/contacts" className="block text-accent">לאנשי קשר וייבוא נתונים ←</Link></div></Modal>
  </div>;
}
