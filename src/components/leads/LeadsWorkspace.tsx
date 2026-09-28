"use client";

import { AvailableNowTag } from "@/components/telephony/AvailableNowTag";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { ArrowDownUp, CalendarDays, Check, CheckSquare, ChevronLeft, ChevronRight, Download, MessageCircle, Percent, Phone as PhoneIcon, RefreshCw, Search, Settings, ShoppingBag, TrendingUp, Users, X } from "lucide-react";
import { api, qs } from "@/lib/client/api";
import { useDialer } from "@/components/telephony/DialerProvider";
import { useMe } from "@/lib/client/use-me";
import { Button, EmptyState, Input, Modal, Select, Spinner } from "@/components/ui";
import { formatPhone } from "@/lib/client/format";
import { useLeadStatuses } from "@/lib/client/use-lead-statuses";
import { LeadDrawer } from "@/components/leads/LeadDrawer";
import { LeadsSettingsModal } from "@/components/leads/LeadsSettingsModal";
import { TasksPanel } from "@/components/tasks/TasksPanel";
import { CallsInbox } from "@/components/inbox/CallsInbox";
import { LeadImportModal } from "@/components/leads/LeadImportModal";
import { DealCloseModal } from "@/components/leads/DealCloseModal";
import { MoveToCampaignModal } from "@/components/leads/MoveToCampaignModal";
import { AttemptsCell, AttemptsModal, FollowUpBadge, FollowUpModal, TransferModal, WaitingCard, type FollowUpInfo, type WaitingKey } from "@/components/leads/LeadActions";

interface Lead { availableNow?: { signalId: string; at: string; text: string } | null; id: string; title: string | null; status: string; attemptLimit?: number | null; closeReason?: string | null; source: string | null; createdAt: string; contact: { id: string; fullName: string; phoneE164: string; email: string | null; customFields: Record<string, unknown> | null }; owner: { id: string; fullName: string } | null; attempts: number; lastAttemptAt: string | null; followUp: FollowUpInfo | null; needsSchedule: boolean; pendingTransfer: { to: string | null; at: string } | null }
interface LeadData { items: Lead[]; total: number; timezone: string; permissions?: { canTransfer: boolean }; byOwner: { id: string | null; name: string; count: number }[]; sources: string[]; metrics: { leads: number; deals: number; revenue: number; conversion: number } }
interface ContactHit { id: string; fullName: string; phoneE164: string }
const number = (v: number) => v.toLocaleString("he-IL", { maximumFractionDigits: 1 });
const money = (v: number) => `₪ ${number(v)}`;
const metadata = (lead: Lead, key: string) => { const v = lead.contact.customFields?.[key]; return typeof v === "string" || typeof v === "number" ? String(v) : "—"; };
const periods: Record<string, string> = { month: "החודש", today: "היום", week: "7 ימים אחרונים", lastMonth: "החודש הקודם", all: "כל התקופות", custom: "טווח מותאם" };

/**
 * The lead workspace: list + metrics + lead drawer + tasks drawer + dialer settings. The dialer itself is a separate screen (/dialer).
 * Used by /leads and, with `listId`, by a dial list's page (same screen, filtered to the list's leads).
 */
export function LeadsWorkspace({ listId, listName, listHeader }: { listId?: string; listName?: string; listHeader?: React.ReactNode } = {}) {
  const me = useMe();
  const router = useRouter();
  const params = useSearchParams();
  const statuses = useLeadStatuses();
  const { dial, state, sessionSummary } = useDialer();
  const live = Boolean((state?.session && state.session.status !== "ended") || state?.activeCall || state?.wrapUpCall || sessionSummary);
  const [detail, setDetail] = useState<{ id: string; tab: "details" | "chat" } | null>(() => params.get("leadId") ? { id: params.get("leadId")!, tab: "details" } : null);
  const [settingsOpen, setSettingsOpen] = useState(params.get("settings") === "1");
  const [settingsTab, setSettingsTab] = useState<"dialer" | "statuses" | "assignment">("dialer");
  const [tasksOpen, setTasksOpen] = useState(params.get("tasks") === "1");
  const [drawerView, setDrawerView] = useState<"tasks" | "calls">(params.get("view") === "calls" ? "calls" : "tasks");
  const [data, setData] = useState<LeadData | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState({ status: params.get("status") ?? "", q: params.get("q") ?? "", ownerUserId: params.get("mine") === "1" ? "me" : params.get("ownerUserId") ?? "", source: "", product: "", campaign: "", ad: "", period: listId ? "all" : "month", from: "", to: "", waiting: "" as WaitingKey | "" });
  const [followUpFor, setFollowUpFor] = useState<Lead | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [moveFor, setMoveFor] = useState<Lead | null>(null);
  const [attemptsFor, setAttemptsFor] = useState<Lead | null>(null);
  const [transferIds, setTransferIds] = useState<{ ids: string[]; owner?: string | null } | null>(null);
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState({ key: "createdAt", direction: "desc" });
  const [selected, setSelected] = useState<string[]>([]);
  const [users, setUsers] = useState<{ id: string; fullName: string }[]>([]);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [hits, setHits] = useState<ContactHit[]>([]);
  const [form, setForm] = useState({ contactId: "", contactName: "", phone: "", title: "", source: "", ownerUserId: "" });
  const [newContact, setNewContact] = useState(false);
  const [saving, setSaving] = useState(false);
  const [convert, setConvert] = useState<Lead | null>(null);
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
    try { const result = await api.get<LeadData>(`/api/leads${qs({ ...filter, ownerUserId: owner, ...(filter.waiting ? {} : dates), listId, sort: sort.key, direction: sort.direction, page, limit: 30 })}`); if (id === requestId.current) setData(result); }
    catch (e) { if (id === requestId.current) setError((e as Error).message); }
    finally { if (id === requestId.current) setLoading(false); }
  }, [filter, owner, dates, sort, page, me, listId]);
  useEffect(() => { const t = setTimeout(load, 220); return () => { clearTimeout(t); requestId.current++; }; }, [load, state?.wrapUpCall?.id]);
  useEffect(() => { const t = setInterval(() => { if (document.visibilityState === "visible" && !bulkBusy) void load(); }, 30_000); return () => clearInterval(t); }, [load, bulkBusy]);
  useEffect(() => { api.get<{ items: { id: string; fullName: string; isActive: boolean }[] }>("/api/users").then(r => setUsers(r.items.filter(u => u.isActive))).catch(() => undefined); }, []);
  // Client-side navigation to /leads?tasks=1 or ?settings=1 while already mounted (e.g. the /tasks redirect) must open the drawer/modal too.
  useEffect(() => { if (params.get("tasks") === "1") { setTasksOpen(true); setDrawerView(params.get("view") === "calls" ? "calls" : "tasks"); } if (params.get("settings") === "1") setSettingsOpen(true); }, [params]);
  useEffect(() => { let alive = true; if (!open || search.trim().length < 2) { setHits([]); return; } const t = setTimeout(() => api.get<{ items: ContactHit[] }>(`/api/contacts${qs({ q: search, limit: 8 })}`).then(r => { if (alive) setHits(r.items); }).catch(() => undefined), 250); return () => { alive = false; clearTimeout(t); }; }, [open, search]);
  function change(key: keyof typeof filter, value: string) { setFilter(f => ({ ...f, [key]: value })); setPage(1); setSelected([]); }
  const tz = data?.timezone ?? "Asia/Jerusalem";
  const canTransfer = manager || Boolean(data?.permissions?.canTransfer);
  /** Status select: "פולואפ" never saves without a time – it opens the date/time picker first. */
  function onStatus(l: Lead, value: string) { if (value === "follow_up") setFollowUpFor(l); else if (value === "converted") setConvert(l); else void patch(l.id, { status: value }).then((ok) => { if (ok && value === "unqualified" && telephony) setMoveFor(l); }); }
  function onOwner(l: Lead, value: string) { if (!value) void patch(l.id, { ownerUserId: null }); else void transferNow([l.id], value); }
  async function transferNow(ids: string[], to: string) {
    try {
      const r = await api.post<{ transferred: string[]; pending: string[]; to: { fullName: string } }>("/api/leads/transfer", { leadIds: ids, toUserId: to });
      if (r.transferred.length) toast.success(`${r.transferred.length === 1 ? "הליד הועבר" : `${r.transferred.length} לידים הועברו`} ל${r.to.fullName}`);
      if (r.pending.length) toast.message("הליד נמצא בשיחה פעילה – ההעברה תתבצע מיד בסיום השיחה, בלי לנתק אותה.", { duration: 8000 });
      setSelected([]); await load();
    } catch (e) { toast.error((e as Error).message); }
  }
  const dialerHref = listId ? `/dialer?listId=${listId}` : "/dialer";
  /** Manual dial from a row/drawer: place the call, then open the full dialer screen where the call is handled. */
  function dialAndOpen(contactId: string) { void dial({ mode: "manual", contactId }).then(() => router.push("/dialer")).catch(() => undefined); }
  function sorting(key: string) { setSort(s => ({ key, direction: s.key === key && s.direction === "desc" ? "asc" : "desc" })); setPage(1); }
  function closeSettings() { setSettingsOpen(false); if (params.get("settings")) router.replace(listId ? `/lists/${listId}` : "/leads"); }
  async function patch(id: string, body: Record<string, unknown>) { try { await api.patch(`/api/leads/${id}`, body); await load(); return true; } catch (e) { toast.error((e as Error).message); return false; } }
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
  function exportSelected() { const rows = data?.items.filter(l => selected.includes(l.id)) ?? []; const csv = [["שם", "טלפון", "מקור", "סטטוס", "נציג"], ...rows.map(l => [l.contact.fullName, l.contact.phoneE164, l.source ?? "", statuses.label(l.status), l.owner?.fullName ?? ""])].map(row => row.map(value => { const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value; return `"${safe.replaceAll('"', '""')}"`; }).join(",")).join("\r\n"); const url = URL.createObjectURL(new Blob(["﻿", csv], { type: "text/csv;charset=utf-8" })); const a = document.createElement("a"); a.href = url; a.download = "leads.csv"; a.click(); URL.revokeObjectURL(url); }
  const groups = useMemo(() => [["", data?.items ?? []]] as Array<[string, Lead[]]>, [data]);
  const cards = [
    { label: "סה״כ לידים", value: number(data?.metrics.leads ?? 0), Icon: Users, tone: "blue", hint: "לידים שנוצרו בטווח ובמסננים שנבחרו" },
    { label: "עסקאות שנסגרו", value: number(data?.metrics.deals ?? 0), Icon: ShoppingBag, tone: "indigo", hint: "עסקאות שנסגרו בהצלחה ומקושרות ללידים בטווח" },
    { label: "אחוז סגירה", value: `${number(data?.metrics.conversion ?? 0)}%`, Icon: Percent, tone: "purple", hint: "לידים שהומרו לעסקה מתוך כלל הלידים בטווח" },
    { label: "הכנסות", value: money(data?.metrics.revenue ?? 0), Icon: TrendingUp, tone: "green", hint: "סכום העסקאות שנסגרו בהצלחה" },
  ];
  const statusOptions = statuses.visible;
  return <div className="leads-page" data-testid="leads-redesign">
    {listHeader}
    <header className="leads-header"><h1>{listName ? `רשימת חיוג: ${listName}` : "CRM"}</h1><div className="leads-header-actions"><span className="leads-count">{number(data?.total ?? 0)} לידים</span>
      {!listId && manager && <button className="lead-button" onClick={() => setImportOpen(true)} data-testid="open-lead-import"><Download size={15} className="rotate-180" />ייבוא לידים (Excel)</button>}
      {!listId && manager && <Link href="/contacts" className="lead-button">אנשי קשר</Link>}
      {!listId && manager && telephony && <Link href="/lists" className="lead-button" data-testid="open-lists">קמפיינים</Link>}
      <button className="lead-button" onClick={() => setTasksOpen(true)} data-testid="open-tasks"><CheckSquare size={15} />משימות וחזרות</button>
      {manager && <button className="lead-button" onClick={() => { setSettingsTab("statuses"); setSettingsOpen(true); }} data-testid="open-statuses">עריכת סטטוסים</button>}
      {manager && <button className="lead-button" onClick={() => { setSettingsTab("assignment"); setSettingsOpen(true); }} data-testid="open-assignment">חלוקת לידים</button>}
      {telephony && <button className="lead-button" onClick={() => { setSettingsTab("dialer"); setSettingsOpen(true); }} data-testid="open-leads-settings"><Settings size={15} />הגדרות חייגן</button>}
      <button className="lead-button" onClick={() => { void load(); }} disabled={loading}><RefreshCw size={15} className={loading ? "animate-spin" : ""} />רענן</button>
      <button className="lead-button primary" onClick={() => setOpen(true)}>ליד חדש</button></div></header>
    <section className="lead-filters" aria-label="סינון לידים">
      <div className="lead-search"><Search size={18} /><input aria-label="חיפוש לידים" placeholder="חיפוש לפי שם, טלפון או אימייל..." value={filter.q} onChange={e => change("q", e.target.value)} /></div>
      <div className="lead-period"><CalendarDays size={15}/><select aria-label="תקופה" value={filter.period} onChange={e => change("period", e.target.value)}>{Object.entries(periods).map(([key,label]) => <option key={key} value={key}>{label}</option>)}</select></div>
      <select aria-label="סטטוס" value={filter.status} onChange={e => change("status", e.target.value)}><option value="">כל הסטטוסים</option>{statuses.items.map(s => <option key={s.key} value={s.key}>{s.label}{s.hidden ? " (מוסתר)" : ""}</option>)}</select>
      <select aria-label="מקור" value={filter.source} onChange={e => change("source", e.target.value)}><option value="">כל המקורות</option>{data?.sources.map(s => <option key={s}>{s}</option>)}</select>
      <input aria-label="מוצר" placeholder="כל המוצרים" value={filter.product} onChange={e => change("product", e.target.value)} />
      <input aria-label="קמפיין" placeholder="חיפוש לפי קמפיין..." value={filter.campaign} onChange={e => change("campaign", e.target.value)} />
      <input aria-label="מודעה" placeholder="חיפוש לפי מודעה..." value={filter.ad} onChange={e => change("ad", e.target.value)} />
      <select aria-label="נציג" value={filter.ownerUserId} onChange={e => change("ownerUserId", e.target.value)}><option value="">כל הנציגים</option><option value="me">הלידים שלי</option><option value="unassigned">ללא שיוך</option>{manager && users.map(u => <option key={u.id} value={u.id}>{u.fullName}</option>)}</select>
    </section>
    {filter.period === "custom" && <div className="lead-date-range"><label>מתאריך <input type="date" aria-label="מתאריך" value={filter.from} max={filter.to || undefined} onChange={e => change("from", e.target.value)} /></label><label>עד תאריך <input type="date" aria-label="עד תאריך" value={filter.to} min={filter.from || undefined} onChange={e => change("to", e.target.value)} /></label></div>}
    <div className="leads-tools"><span>טווח: {periods[filter.period]}</span><div>{telephony && <button className="lead-button dialer-launch" data-testid="open-dialer" disabled={!state} onClick={() => router.push(dialerHref)}><PhoneIcon size={18}/>{live ? "לחייגן הפעיל" : "הפעל חייגן"}</button>}</div></div>
    {filter.waiting && <div className="lead-waiting-chip" data-testid="waiting-filter-chip">מסונן: {({ total: "ממתינים לשיחה היום", new: "לידים חדשים שטרם חויגו", today: "פולואפים להיום", overdue: "פולואפים באיחור", schedule: "פולואפ ללא מועד" } as const)[filter.waiting]} · ללא הגבלת תאריך<button onClick={() => change("waiting", "")} aria-label="נקה סינון ממתינים"><X size={14}/></button></div>}
    <section className="lead-stats" aria-label="נתוני לידים">{manager && !listId && <WaitingCard agent={owner} users={users} active={filter.waiting} version={data} onPick={k => change("waiting", k)} onAgent={id => change("ownerUserId", id)} />}{cards.map(({ label, value, Icon, tone, hint }) => <article className="lead-stat" key={label} title={hint}><span className={`stat-icon ${tone}`}><Icon size={21} strokeWidth={1.8}/></span><strong dir="ltr">{data ? value : "…"}</strong><span>{label}</span></article>)}</section>
    <section className="lead-distribution"><h2>לידים לפי נציג</h2>{data?.byOwner.length ? data.byOwner.map(o => <button key={o.id ?? "none"} title={`סנן לפי ${o.name}`} onClick={() => change("ownerUserId", o.id ?? "unassigned")} className="lead-bar-row"><span className="lead-bar-name">{o.name}</span><span className="lead-bar-track"><span style={{ width: `${data.total ? o.count / data.total * 100 : 0}%` }}/></span><strong>{number(o.count)}</strong><span className="lead-bar-percent">{number(data.total ? o.count / data.total * 100 : 0)}%</span></button>) : <p className="text-sm text-muted py-4">אין לידים בטווח שנבחר</p>}</section>
    {error && <div role="alert" className="lead-error">{error}<button onClick={load}>נסה שוב</button></div>}
    {selected.length > 0 && <div className="lead-bulk"><span><Check size={16}/> {selected.length} לידים נבחרו</span><select aria-label="שינוי סטטוס לנבחרים" value="" disabled={bulkBusy} onChange={e => e.target.value && bulk({ status: e.target.value })}><option value="">שנה סטטוס</option>{statusOptions.filter(s => s.key !== "follow_up" && s.key !== "converted").map(s => <option key={s.key} value={s.key}>{s.label}</option>)}</select>{canTransfer && <button className="lead-button" disabled={bulkBusy} onClick={() => setTransferIds({ ids: selected })} data-testid="bulk-transfer">העבר לנציג</button>}{manager && <button className="lead-button" disabled={bulkBusy} onClick={() => bulk({ ownerUserId: null })}>בטל שיוך</button>}<button className="lead-button" onClick={exportSelected}><Download size={15}/>ייצוא נבחרים</button><button aria-label="בטל בחירה" onClick={() => setSelected([])}><X size={16}/></button></div>}
    <section className="lead-table-card" aria-busy={loading}>
      {!data ? <div className="p-12 flex justify-center"><Spinner/></div> : <><div className="lead-table-scroll"><table className="leads-table"><thead><tr><th><input type="checkbox" aria-label="בחר את כל הלידים בעמוד" checked={data.items.length > 0 && data.items.every(l => selected.includes(l.id))} onChange={e => setSelected(e.target.checked ? data.items.map(l => l.id) : [])}/></th><th><button onClick={() => sorting("name")}>שם <ArrowDownUp size={13}/></button></th><th>טלפון</th><th><button onClick={() => sorting("source")}>מקור <ArrowDownUp size={13}/></button></th><th>מוצר</th><th>קמפיין</th><th>מודעה</th><th><button onClick={() => sorting("status")}>סטטוס <ArrowDownUp size={13}/></button></th><th>ניסיונות חיוג</th><th>פולואפ</th><th><button onClick={() => sorting("owner")}>נציג <ArrowDownUp size={13}/></button></th><th><button onClick={() => sorting("createdAt")}>נוצר <ArrowDownUp size={13}/></button></th><th>פעולות</th></tr></thead><tbody>{groups.map(([name, rows]) => <Fragment key={name}>{rows.map(l => <tr key={l.id} data-testid={`lead-row-${l.id}`} className={selected.includes(l.id) ? "selected" : ""}>
        <td><input type="checkbox" aria-label={`בחר ${l.contact.fullName}`} checked={selected.includes(l.id)} onChange={e => setSelected(s => e.target.checked ? [...s, l.id] : s.filter(id => id !== l.id))}/></td>
        <td><button className="lead-name" onClick={() => setDetail({ id: l.id, tab: "details" })}>{l.contact.fullName}</button>{l.availableNow && <AvailableNowTag compact at={l.availableNow.at} text={l.availableNow.text} />}{l.status !== "converted" && <button className="lead-new-deal" onClick={() => setConvert(l)}>+ עסקה חדשה</button>}</td>
        <td className="lead-phone" dir="ltr">{formatPhone(l.contact.phoneE164)}</td><td>{l.source ?? "—"}</td><td>{metadata(l, "product")}</td><td className="lead-campaign">{metadata(l, "campaign")}</td><td className="lead-campaign">{metadata(l, "ad")}</td>
        <td><select aria-label={`סטטוס ${l.contact.fullName}`} className={`lead-status status-${l.status}`} value={l.status} onChange={e => onStatus(l, e.target.value)}>{statuses.items.filter(s => !s.hidden || s.key === l.status).map(s => <option key={s.key} value={s.key}>{s.label}</option>)}</select>{l.pendingTransfer && <small className="lead-pending-transfer" title="ההעברה תתבצע בסיום השיחה">⇄ בהעברה ל{l.pendingTransfer.to ?? "נציג"}</small>}</td>
        <td><AttemptsCell count={l.attempts} limit={l.attemptLimit} lastAt={l.lastAttemptAt} tz={tz} onOpen={() => setAttemptsFor(l)} /></td>
        <td><FollowUpBadge followUp={l.followUp} needsSchedule={l.needsSchedule} tz={tz} onClick={() => setFollowUpFor(l)} /></td>
        <td>{manager ? <select className="lead-owner" aria-label={`נציג ${l.contact.fullName}`} value={l.owner?.id ?? ""} onChange={e => onOwner(l, e.target.value)} data-testid={`lead-owner-${l.id}`}><option value="">ללא שיוך</option>{l.owner && !users.some(u => u.id === l.owner?.id) && <option value={l.owner.id}>{l.owner.fullName}</option>}{users.map(u => <option key={u.id} value={u.id}>{u.fullName}</option>)}</select> : l.owner?.fullName ?? "ללא שיוך"}</td>
        <td className="lead-created" dir="ltr">{new Date(l.createdAt).toLocaleDateString("he-IL")}<span>{new Date(l.createdAt).toLocaleTimeString("he-IL", { hour: "2-digit", minute: "2-digit" })}</span></td>
        <td><div className="lead-row-actions">{me?.modules.messaging && <button className="lead-whatsapp" onClick={() => setDetail({ id: l.id, tab: "chat" })} aria-label={`WhatsApp ${l.contact.fullName}`} title="פתיחת שיחת WhatsApp"><MessageCircle size={17}/><span>WhatsApp</span></button>}{canTransfer && <button className="lead-transfer" onClick={() => setTransferIds({ ids: [l.id], owner: l.owner?.id })} title="העבר לנציג" aria-label={`העבר את ${l.contact.fullName} לנציג`} data-testid={`lead-transfer-${l.id}`}><Users size={15}/><span>העבר</span></button>}{telephony && <button className="lead-call" disabled={!canDial} title="חיוג לליד" aria-label={`חייג ${l.contact.fullName}`} onClick={() => dialAndOpen(l.contact.id)}><PhoneIcon size={15}/><span>חייג</span></button>}</div></td>
      </tr>)}</Fragment>)}</tbody></table></div>{!data.items.length && <EmptyState title="אין לידים התואמים לסינון" hint="שנה את הטווח או המסננים, או צור ליד חדש"/>}<footer className="lead-pagination"><span>{number(data.total)} לידים · עמוד {page} מתוך {Math.max(1, Math.ceil(data.total / 30))}</span><div><button aria-label="עמוד קודם" disabled={page <= 1 || loading} onClick={() => { setPage(p => p - 1); setSelected([]); }}><ChevronRight size={17}/></button><button aria-label="עמוד הבא" disabled={page * 30 >= data.total || loading} onClick={() => { setPage(p => p + 1); setSelected([]); }}><ChevronLeft size={17}/></button></div></footer></>}
    </section>
    {telephony && live && <Link href="/dialer" className="dialer-live-pill" data-testid="dialer-reopen">📞 החייגן פעיל – פתח</Link>}
    {detail && <LeadDrawer key={detail.id} leadId={detail.id} initialTab={detail.tab} users={users} manager={manager} canTransfer={canTransfer} messaging={Boolean(me?.modules.messaging)} canDial={canDial} onDial={contactId => dialAndOpen(contactId)} onClose={() => { setDetail(null); if (params.get("leadId")) { const next = new URLSearchParams(params.toString()); next.delete("leadId"); router.replace((listId ? `/lists/${listId}` : "/leads") + (next.size ? `?${next}` : "")); } }} onUpdated={() => { void load(); }}/>}
    {tasksOpen && <aside className="lead-side-drawer" aria-label="משימות וחזרות" data-testid="tasks-drawer"><header><strong>משימות וחזרות</strong>{telephony && <div className="drawer-tabs" role="tablist"><button role="tab" aria-selected={drawerView === "tasks"} onClick={() => setDrawerView("tasks")} data-testid="drawer-tab-tasks">משימות</button><button role="tab" aria-selected={drawerView === "calls"} onClick={() => setDrawerView("calls")} data-testid="drawer-tab-calls">שיחות שלא נענו</button></div>}<button aria-label="סגור משימות" onClick={() => { setTasksOpen(false); if (params.get("tasks")) router.replace(listId ? `/lists/${listId}` : "/leads"); }}><X size={17}/></button></header><div>{drawerView === "calls" && telephony ? <CallsInbox /> : <TasksPanel embedded />}</div></aside>}
    {moveFor && <MoveToCampaignModal leadId={moveFor.id} name={moveFor.contact.fullName} onClose={() => setMoveFor(null)} onDone={() => { void load(); }} />}
    {importOpen && <LeadImportModal users={users} onClose={() => setImportOpen(false)} onDone={() => { void load(); }} />}
    {followUpFor && <FollowUpModal leadId={followUpFor.id} name={followUpFor.contact.fullName} tz={tz} current={followUpFor.followUp} onClose={() => setFollowUpFor(null)} onSaved={() => { void load(); }} />}
    {attemptsFor && <AttemptsModal leadId={attemptsFor.id} name={attemptsFor.contact.fullName} tz={tz} onClose={() => setAttemptsFor(null)} />}
    {transferIds && <TransferModal leadIds={transferIds.ids} currentOwnerId={transferIds.owner} users={users} onClose={() => setTransferIds(null)} onDone={() => { setSelected([]); void load(); }} />}
    <LeadsSettingsModal open={settingsOpen} onClose={closeSettings} manager={manager} initialTab={settingsTab} />
    <Modal open={open} onClose={() => !saving && setOpen(false)} title="ליד חדש" footer={<><Button variant="ghost" onClick={() => setOpen(false)} disabled={saving}>ביטול</Button><Button onClick={create} loading={saving} disabled={newContact ? !form.contactName || !form.phone : !form.contactId}>צור ליד</Button></>}><div className="space-y-3"><div className="flex gap-3"><button className={!newContact ? "text-accent font-medium" : "text-muted"} onClick={() => { setNewContact(false); setForm(f => ({ ...f, contactId: "" })); }}>איש קשר קיים</button><button className={newContact ? "text-accent font-medium" : "text-muted"} onClick={() => { setNewContact(true); setForm(f => ({ ...f, contactId: "", contactName: "" })); }}>איש קשר חדש</button></div>{newContact ? <><Input label="שם מלא" value={form.contactName} onChange={e => setForm({ ...form, contactName: e.target.value })}/><Input label="טלפון" value={form.phone} onChange={e => setForm({ ...form, phone: e.target.value })} ltr/></> : form.contactId ? <div>{form.contactName}<button className="ms-3 text-accent" onClick={() => setForm({ ...form, contactId: "" })}>שנה</button></div> : <><Input label="חיפוש איש קשר" value={search} onChange={e => setSearch(e.target.value)}/><ul className="max-h-44 overflow-auto">{hits.map(h => <li key={h.id}><button className="w-full text-start p-2 hover:bg-panel-2" onClick={() => setForm({ ...form, contactId: h.id, contactName: h.fullName })}>{h.fullName} · {formatPhone(h.phoneE164)}</button></li>)}</ul></>}<Input label="כותרת" value={form.title} onChange={e => setForm({ ...form, title: e.target.value })}/><Input label="מקור" value={form.source} onChange={e => setForm({ ...form, source: e.target.value })}/>{manager && <Select label="נציג" value={form.ownerUserId} onChange={e => setForm({ ...form, ownerUserId: e.target.value })}><option value="">ללא שיוך (לפי חלוקת הלידים)</option>{users.map(u => <option key={u.id} value={u.id}>{u.fullName}</option>)}</Select>}</div></Modal>
    {convert && <DealCloseModal contactId={convert.contact.id} leadId={convert.id} name={convert.contact.fullName} onClose={() => setConvert(null)} onDone={() => { void load(); }} />}
  </div>;
}
