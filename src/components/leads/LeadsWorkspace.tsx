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
import { TasksPanel } from "@/components/tasks/TasksPanel";
import { CallsInbox } from "@/components/inbox/CallsInbox";
import dynamic from "next/dynamic";
// Dialogs load on first open (they carry the settings forms / validation) – not with the leads list.
const LeadsSettingsModal = dynamic(() => import("@/components/leads/LeadsSettingsModal").then((m) => m.LeadsSettingsModal), { ssr: false });
const LeadImportModal = dynamic(() => import("@/components/leads/LeadImportModal").then((m) => m.LeadImportModal), { ssr: false });
const DealCloseModal = dynamic(() => import("@/components/leads/DealCloseModal").then((m) => m.DealCloseModal), { ssr: false });
const MoveToCampaignModal = dynamic(() => import("@/components/leads/MoveToCampaignModal").then((m) => m.MoveToCampaignModal), { ssr: false });
import { AttemptsCell, AttemptsModal, FollowUpBadge, FollowUpModal, TransferModal, WaitingCard, type FollowUpInfo, type WaitingKey } from "@/components/leads/LeadActions";
import { useT } from "@/components/i18n/LangProvider";

interface Lead { existingCustomer?: boolean; reviewReason?: string | null; availableNow?: { signalId: string; at: string; text: string } | null; id: string; title: string | null; status: string; statusDefId?: string | null; attemptLimit?: number | null; closeReason?: string | null; source: string | null; createdAt: string; contact: { id: string; fullName: string; phoneE164: string; email: string | null; customFields: Record<string, unknown> | null }; owner: { id: string; fullName: string } | null; attempts: number; lastAttemptAt: string | null; followUp: FollowUpInfo | null; needsSchedule: boolean; pendingTransfer: { to: string | null; at: string } | null }
interface LeadData { items: Lead[]; total: number; timezone: string; permissions?: { canTransfer: boolean }; byOwner: { id: string | null; name: string; count: number }[]; sources: string[]; metrics: { leads: number; deals: number; revenue: number; conversion: number } }
interface ContactHit { id: string; fullName: string; phoneE164: string }
const fmtNum = (v: number, loc: string) => v.toLocaleString(loc, { maximumFractionDigits: 1 });
const metadata = (lead: Lead, key: string) => { const v = lead.contact.customFields?.[key]; return typeof v === "string" || typeof v === "number" ? String(v) : "—"; };
const periods: Record<string, [string, string]> = { month: ["החודש", "This month"], today: ["היום", "Today"], week: ["7 ימים אחרונים", "Last 7 days"], lastMonth: ["החודש הקודם", "Last month"], all: ["כל התקופות", "All time"], custom: ["טווח מותאם", "Custom range"] };

/**
 * The lead workspace: list + metrics + lead drawer + tasks drawer + dialer settings. The dialer itself is a separate screen (/dialer).
 * Used by /leads and, with `listId`, by a dial list's page (same screen, filtered to the list's leads).
 */
export function LeadsWorkspace({ listId, listName, listHeader }: { listId?: string; listName?: string; listHeader?: React.ReactNode } = {}) {
  const me = useMe();
  const t = useT();
  const loc = t.lang === "en" ? "en-GB" : "he-IL";
  const number = (v: number) => fmtNum(v, loc);
  const money = (v: number) => `₪ ${number(v)}`;
  const router = useRouter();
  const params = useSearchParams();
  const statuses = useLeadStatuses();
  const { dial, state, sessionSummary } = useDialer();
  const live = Boolean((state?.session && state.session.status !== "ended") || state?.activeCall || state?.wrapUpCall || sessionSummary);
  const [detail, setDetail] = useState<{ id: string; tab: "details" | "chat" } | null>(() => params.get("leadId") ? { id: params.get("leadId")!, tab: "details" } : null);
  const [settingsOpen, setSettingsOpen] = useState(params.get("settings") === "1");
  const [settingsTab, setSettingsTab] = useState<"settings" | "statuses" | "assignment">("settings");
  const [tasksOpen, setTasksOpen] = useState(params.get("tasks") === "1");
  const [drawerView, setDrawerView] = useState<"tasks" | "calls">(params.get("view") === "calls" ? "calls" : "tasks");
  const [data, setData] = useState<LeadData | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState({ status: params.get("status") ?? "", statusId: params.get("statusId") ?? "", q: params.get("q") ?? "", ownerUserId: params.get("mine") === "1" ? "me" : params.get("ownerUserId") ?? "", source: "", product: "", campaign: "", ad: "", period: listId ? "all" : "month", from: "", to: "", waiting: "" as WaitingKey | "" });
  const [followUpFor, setFollowUpFor] = useState<(Lead & { pickStatusId?: string }) | null>(null);
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
  /** A custom "sale" status chosen in the table – applied to the lead once the deal is saved. */
  const [convertStatusId, setConvertStatusId] = useState<string | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const requestId = useRef(0);
  const manager = Boolean(me && me.user.role !== "agent");
  /** Lead distribution and its rules are the business owner's (the server enforces it too). */
  const isOwner = me?.user.role === "owner";
  const telephony = Boolean(me?.modules.telephony);
  const canDial = telephony && Boolean(state) && !state?.activeCall;
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
    if (filter.ownerUserId === "me" && !owner) return;
    const id = ++requestId.current; setLoading(true); setError("");
    try { const result = await api.get<LeadData>(`/api/leads${qs({ ...filter, ownerUserId: owner, ...(filter.waiting ? {} : dates), listId, sort: sort.key, direction: sort.direction, page, limit: 30 })}`); if (id === requestId.current) setData(result); }
    catch (e) { if (id === requestId.current) setError((e as Error).message); }
    finally { if (id === requestId.current) setLoading(false); }
  }, [filter, owner, dates, sort, page, listId]);
  // The debounce is for typing/filter bursts; the first load goes out immediately.
  const loadedOnce = useRef(false);
  useEffect(() => { const t = setTimeout(() => { loadedOnce.current = true; void load(); }, loadedOnce.current ? 220 : 0); return () => { clearTimeout(t); requestId.current++; }; }, [load, state?.wrapUpCall?.id]);
  useEffect(() => { const t = setInterval(() => { if (document.visibilityState === "visible" && !bulkBusy) void load(); }, 30_000); return () => clearInterval(t); }, [load, bulkBusy]);
  useEffect(() => { api.get<{ items: { id: string; fullName: string; isActive: boolean }[] }>("/api/users").then(r => setUsers(r.items.filter(u => u.isActive))).catch(() => undefined); }, []);
  // Client-side navigation to /leads?tasks=1 or ?settings=1 while already mounted (e.g. the /tasks redirect) must open the drawer/modal too.
  useEffect(() => { if (params.get("tasks") === "1") { setTasksOpen(true); setDrawerView(params.get("view") === "calls" ? "calls" : "tasks"); } if (params.get("settings") === "1") setSettingsOpen(true); }, [params]);
  useEffect(() => { let alive = true; if (!open || search.trim().length < 2) { setHits([]); return; } const t = setTimeout(() => api.get<{ items: ContactHit[] }>(`/api/contacts${qs({ q: search, limit: 8 })}`).then(r => { if (alive) setHits(r.items); }).catch(() => undefined), 250); return () => { alive = false; clearTimeout(t); }; }, [open, search]);
  function change(key: keyof typeof filter, value: string) { setFilter(f => ({ ...f, [key]: value })); setPage(1); setSelected([]); }
  const tz = data?.timezone ?? "Asia/Jerusalem";
  const canTransfer = manager || Boolean(data?.permissions?.canTransfer);
  /** Status select: "פולואפ" never saves without a time – it opens the date/time picker first. */
  // By the status's meaning, never its name: follow-up needs a time, a sale opens the deal form, the rest save at once.
  function onStatus(l: Lead, statusId: string) {
    const def = statuses.items.find((s) => s.id === statusId); if (!def) return;
    if (def.kind === "follow_up") setFollowUpFor({ ...l, pickStatusId: def.id });
    else if (def.kind === "converted") { setConvert(l); setConvertStatusId(def.isSystem ? null : def.id); }
    else void patch(l.id, { statusId: def.id }).then((ok) => { if (ok && def.kind === "unqualified" && telephony) setMoveFor(l); });
  }
  function onOwner(l: Lead, value: string) { if (!value) void patch(l.id, { ownerUserId: null }); else void transferNow([l.id], value); }
  async function transferNow(ids: string[], to: string) {
    try {
      const r = await api.post<{ transferred: string[]; pending: string[]; to: { fullName: string } }>("/api/leads/transfer", { leadIds: ids, toUserId: to });
      if (r.transferred.length) toast.success(t(`${r.transferred.length === 1 ? "הליד הועבר" : `${r.transferred.length} לידים הועברו`} ל${r.to.fullName}`, `${r.transferred.length === 1 ? "Lead transferred" : `${r.transferred.length} leads transferred`} to ${r.to.fullName}`));
      if (r.pending.length) toast.message(t("הליד נמצא בשיחה פעילה – ההעברה תתבצע מיד בסיום השיחה, בלי לנתק אותה.", "The lead is on an active call – the transfer will happen as soon as the call ends, without disconnecting it."), { duration: 8000 });
      setSelected([]); await load();
    } catch (e) { toast.error((e as Error).message); }
  }
  const dialerHref = listId ? `/dialer?listId=${listId}` : "/dialer";
  /** Manual dial from a row/drawer: place the call, then open the full dialer screen where the call is handled. */
  function dialAndOpen(contactId: string) { void dial({ mode: "manual", contactId }).then(() => router.push("/dialer")).catch(() => undefined); }
  function sorting(key: string) { setSort(s => ({ key, direction: s.key === key && s.direction === "desc" ? "asc" : "desc" })); setPage(1); }
  function closeSettings() { setSettingsOpen(false); if (params.get("settings")) router.replace(listId ? `/calling/lists/${listId}` : "/leads"); }
  async function patch(id: string, body: Record<string, unknown>) { try { await api.patch(`/api/leads/${id}`, body); await load(); return true; } catch (e) { toast.error((e as Error).message); return false; } }
  async function bulk(body: Record<string, unknown>) { setBulkBusy(true); const results = await Promise.allSettled(selected.map(id => api.patch(`/api/leads/${id}`, body))); const failed = results.filter(r => r.status === "rejected").length; setSelected(selected.filter((_, i) => results[i].status === "rejected")); if (failed) toast.error(t(`${failed} עדכונים נכשלו; הבחירה נשמרה עבורם`, `${failed} updates failed; they remain selected`)); else toast.success(t("הלידים עודכנו", "Leads updated")); await load(); setBulkBusy(false); }
  async function create() {
    setSaving(true);
    try {
      let contactId = form.contactId;
      if (newContact && !contactId) { const c = await api.post<{ id: string }>("/api/contacts", { fullName: form.contactName, phone: form.phone }); contactId = c.id; setForm(f => ({ ...f, contactId })); }
      await api.post("/api/leads", { contactId, title: form.title || undefined, source: form.source || undefined, ownerUserId: form.ownerUserId || undefined });
      setOpen(false); setForm({ contactId: "", contactName: "", phone: "", title: "", source: "", ownerUserId: "" }); setSearch(""); setNewContact(false); toast.success(t("הליד נוצר", "Lead created")); await load();
    } catch (e) { toast.error((e as Error).message); } finally { setSaving(false); }
  }
  function exportSelected() { const rows = data?.items.filter(l => selected.includes(l.id)) ?? []; const csv = [[t("שם", "Name"), t("טלפון", "Phone"), t("מקור", "Source"), t("סטטוס", "Status"), t("נציג", "Agent")], ...rows.map(l => [l.contact.fullName, l.contact.phoneE164, l.source ?? "", statuses.forLead(l)?.label ?? l.status, l.owner?.fullName ?? ""])].map(row => row.map(value => { const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value; return `"${safe.replaceAll('"', '""')}"`; }).join(",")).join("\r\n"); const url = URL.createObjectURL(new Blob(["﻿", csv], { type: "text/csv;charset=utf-8" })); const a = document.createElement("a"); a.href = url; a.download = "leads.csv"; a.click(); URL.revokeObjectURL(url); }
  const groups = useMemo(() => [["", data?.items ?? []]] as Array<[string, Lead[]]>, [data]);
  const cards = [
    { label: t("סה״כ לידים", "Total leads"), value: number(data?.metrics.leads ?? 0), Icon: Users, tone: "blue", hint: t("לידים שנוצרו בטווח ובמסננים שנבחרו", "Leads created in the selected range and filters") },
    { label: t("עסקאות שנסגרו", "Deals closed"), value: number(data?.metrics.deals ?? 0), Icon: ShoppingBag, tone: "indigo", hint: t("עסקאות שנסגרו בהצלחה ומקושרות ללידים בטווח", "Deals closed successfully and linked to leads in the range") },
    { label: t("אחוז סגירה", "Close rate"), value: `${number(data?.metrics.conversion ?? 0)}%`, Icon: Percent, tone: "purple", hint: t("לידים שהומרו לעסקה מתוך כלל הלידים בטווח", "Leads converted to a deal out of all leads in the range") },
    { label: t("הכנסות", "Revenue"), value: money(data?.metrics.revenue ?? 0), Icon: TrendingUp, tone: "green", hint: t("סכום העסקאות שנסגרו בהצלחה", "Total of deals closed successfully") },
  ];
  const statusOptions = statuses.active;
  const filterValue = filter.statusId || (filter.status ? statuses.system(filter.status)?.id ?? "" : "");
  return <div className="leads-page" data-testid="leads-redesign">
    {listHeader}
    <header className="leads-header"><h1>{listName ? t(`רשימת חיוג: ${listName}`, `Dial list: ${listName}`) : "CRM"}</h1><div className="leads-header-actions"><span className="leads-count">{number(data?.total ?? 0)} {t("לידים", "leads")}</span>
      {!listId && manager && <button className="lead-button" onClick={() => setImportOpen(true)} data-testid="open-lead-import"><Download size={15} className="rotate-180" />{t("ייבוא לידים (Excel)", "Import leads (Excel)")}</button>}
      {!listId && manager && <Link href="/contacts" className="lead-button">{t("אנשי קשר", "Contacts")}</Link>}
      {!listId && manager && telephony && <Link href="/calling/lists" className="lead-button" data-testid="open-lists">{t("רשימות חיוג", "Dial lists")}</Link>}
      <button className="lead-button" onClick={() => setTasksOpen(true)} data-testid="open-tasks"><CheckSquare size={15} />{t("משימות וחזרות", "Tasks & callbacks")}</button>
      {manager && <button className="lead-button mobile-keep" onClick={() => { setSettingsTab("statuses"); setSettingsOpen(true); }} data-testid="open-statuses">{t("עריכת סטטוסים", "Edit statuses")}</button>}
      {isOwner && <button className="lead-button mobile-keep" onClick={() => { setSettingsTab("assignment"); setSettingsOpen(true); }} data-testid="open-assignment">{t("חלוקת לידים", "Lead distribution")}</button>}
      {telephony && <button className="lead-button mobile-keep" onClick={() => { setSettingsTab("settings"); setSettingsOpen(true); }} data-testid="open-leads-settings"><Settings size={15} />{t("הגדרות", "Settings")}</button>}
      <button className="lead-button" onClick={() => { void load(); }} disabled={loading}><RefreshCw size={15} className={loading ? "animate-spin" : ""} />{t("רענן", "Refresh")}</button>
      <button className="lead-button primary" onClick={() => setOpen(true)}>{t("ליד חדש", "New lead")}</button></div></header>
    <section className="lead-filters" aria-label={t("סינון לידים", "Lead filters")}>
      <div className="lead-search"><Search size={18} /><input aria-label={t("חיפוש לידים", "Search leads")} placeholder={t("חיפוש לפי שם, טלפון או אימייל...", "Search by name, phone or email...")} value={filter.q} onChange={e => change("q", e.target.value)} /></div>
      <div className="lead-period"><CalendarDays size={15}/><select aria-label={t("תקופה", "Period")} value={filter.period} onChange={e => change("period", e.target.value)}>{Object.entries(periods).map(([key,label]) => <option key={key} value={key}>{t(...label)}</option>)}</select></div>
      <select aria-label={t("סטטוס", "Status")} value={filterValue} onChange={e => setFilter(f => ({ ...f, status: "", statusId: e.target.value }))} data-testid="lead-filter-status"><option value="">{t("כל הסטטוסים", "All statuses")}</option>{statuses.items.map(s => <option key={s.id} value={s.id}>{s.label}{s.active ? "" : t(" (לא פעיל)", " (inactive)")}</option>)}</select>
      <select aria-label={t("מקור", "Source")} value={filter.source} onChange={e => change("source", e.target.value)}><option value="">{t("כל המקורות", "All sources")}</option>{data?.sources.map(s => <option key={s}>{s}</option>)}</select>
      <input aria-label={t("מוצר", "Product")} placeholder={t("כל המוצרים", "All products")} value={filter.product} onChange={e => change("product", e.target.value)} />
      <input aria-label={t("קמפיין", "Campaign")} placeholder={t("חיפוש לפי קמפיין...", "Search by campaign...")} value={filter.campaign} onChange={e => change("campaign", e.target.value)} />
      <input aria-label={t("מודעה", "Ad")} placeholder={t("חיפוש לפי מודעה...", "Search by ad...")} value={filter.ad} onChange={e => change("ad", e.target.value)} />
      <select aria-label={t("נציג", "Agent")} value={filter.ownerUserId} onChange={e => change("ownerUserId", e.target.value)}><option value="">{t("כל הנציגים", "All agents")}</option><option value="me">{t("הלידים שלי", "My leads")}</option><option value="unassigned">{t("ללא שיוך", "Unassigned")}</option>{manager && users.map(u => <option key={u.id} value={u.id}>{u.fullName}</option>)}</select>
    </section>
    {filter.period === "custom" && <div className="lead-date-range"><label>{t("מתאריך", "From")} <input type="date" aria-label={t("מתאריך", "From date")} value={filter.from} max={filter.to || undefined} onChange={e => change("from", e.target.value)} /></label><label>{t("עד תאריך", "To")} <input type="date" aria-label={t("עד תאריך", "To date")} value={filter.to} min={filter.from || undefined} onChange={e => change("to", e.target.value)} /></label></div>}
    <div className="leads-tools"><span>{t("טווח:", "Range:")} {periods[filter.period] ? t(...periods[filter.period]) : filter.period}</span><div>{telephony && <button className="lead-button dialer-launch" data-testid="open-dialer" disabled={!state} onClick={() => router.push(dialerHref)}><PhoneIcon size={18}/>{live ? t("לחייגן הפעיל", "To the active dialer") : t("הפעל חייגן", "Start dialer")}</button>}</div></div>
    {filter.waiting && <div className="lead-waiting-chip" data-testid="waiting-filter-chip">{t("מסונן:", "Filtered:")} {t(...({ total: ["ממתינים לשיחה היום", "Waiting for a call today"], new: ["לידים חדשים שטרם חויגו", "New leads not yet dialed"], today: ["פולואפים להיום", "Follow-ups for today"], overdue: ["פולואפים באיחור", "Overdue follow-ups"], schedule: ["פולואפ ללא מועד", "Follow-up without a time"] } as Record<WaitingKey, [string, string]>)[filter.waiting])} · {t("ללא הגבלת תאריך", "No date limit")}<button onClick={() => change("waiting", "")} aria-label={t("נקה סינון ממתינים", "Clear waiting filter")}><X size={14}/></button></div>}
    <section className="lead-stats" aria-label={t("נתוני לידים", "Lead stats")}>{manager && !listId && <WaitingCard agent={owner} users={users} active={filter.waiting} version={data} onPick={k => change("waiting", k)} onAgent={id => change("ownerUserId", id)} />}{cards.map(({ label, value, Icon, tone, hint }) => <article className="lead-stat" key={label} title={hint}><span className={`stat-icon ${tone}`}><Icon size={21} strokeWidth={1.8}/></span><strong dir="ltr">{data ? value : "…"}</strong><span>{label}</span></article>)}</section>
    <section className="lead-distribution"><h2>{t("לידים לפי נציג", "Leads by agent")}</h2>{data?.byOwner.length ? data.byOwner.map(o => <button key={o.id ?? "none"} title={t(`סנן לפי ${o.name}`, `Filter by ${o.name}`)} onClick={() => change("ownerUserId", o.id ?? "unassigned")} className="lead-bar-row"><span className="lead-bar-name">{o.name}</span><span className="lead-bar-track"><span style={{ width: `${data.total ? o.count / data.total * 100 : 0}%` }}/></span><strong>{number(o.count)}</strong><span className="lead-bar-percent">{number(data.total ? o.count / data.total * 100 : 0)}%</span></button>) : <p className="text-sm text-muted py-4">{t("אין לידים בטווח שנבחר", "No leads in the selected range")}</p>}</section>
    {error && <div role="alert" className="lead-error">{error}<button onClick={load}>{t("נסה שוב", "Try again")}</button></div>}
    {selected.length > 0 && <div className="lead-bulk"><span><Check size={16}/> {t(`${selected.length} לידים נבחרו`, `${selected.length} leads selected`)}</span><select aria-label={t("שינוי סטטוס לנבחרים", "Change status of selected")} value="" disabled={bulkBusy} onChange={e => e.target.value && bulk({ statusId: e.target.value })}><option value="">{t("שנה סטטוס", "Change status")}</option>{statusOptions.filter(s => s.kind !== "follow_up" && s.kind !== "converted").map(s => <option key={s.id} value={s.id}>{s.label}</option>)}</select>{canTransfer && <button className="lead-button" disabled={bulkBusy} onClick={() => setTransferIds({ ids: selected })} data-testid="bulk-transfer">{t("העבר לנציג", "Transfer to agent")}</button>}{manager && <button className="lead-button" disabled={bulkBusy} onClick={() => bulk({ ownerUserId: null })}>{t("בטל שיוך", "Unassign")}</button>}<button className="lead-button" onClick={exportSelected}><Download size={15}/>{t("ייצוא נבחרים", "Export selected")}</button><button aria-label={t("בטל בחירה", "Clear selection")} onClick={() => setSelected([])}><X size={16}/></button></div>}
    <section className="lead-table-card" aria-busy={loading}>
      {!data ? <div className="p-12 flex justify-center"><Spinner/></div> : <><div className="lead-table-scroll"><table className="leads-table"><thead><tr><th><input type="checkbox" aria-label={t("בחר את כל הלידים בעמוד", "Select all leads on page")} checked={data.items.length > 0 && data.items.every(l => selected.includes(l.id))} onChange={e => setSelected(e.target.checked ? data.items.map(l => l.id) : [])}/></th><th><button onClick={() => sorting("name")}>{t("שם", "Name")} <ArrowDownUp size={13}/></button></th><th>{t("טלפון", "Phone")}</th><th><button onClick={() => sorting("source")}>{t("מקור", "Source")} <ArrowDownUp size={13}/></button></th><th>{t("מוצר", "Product")}</th><th>{t("קמפיין", "Campaign")}</th><th>{t("מודעה", "Ad")}</th><th><button onClick={() => sorting("status")}>{t("סטטוס", "Status")} <ArrowDownUp size={13}/></button></th><th>{t("ניסיונות חיוג", "Dial attempts")}</th><th>{t("פולואפ", "Follow-up")}</th><th><button onClick={() => sorting("owner")}>{t("נציג", "Agent")} <ArrowDownUp size={13}/></button></th><th><button onClick={() => sorting("createdAt")}>{t("נוצר", "Created")} <ArrowDownUp size={13}/></button></th><th>{t("פעולות", "Actions")}</th></tr></thead><tbody>{groups.map(([name, rows]) => <Fragment key={name}>{rows.map(l => <tr key={l.id} data-testid={`lead-row-${l.id}`} className={selected.includes(l.id) ? "selected" : ""}>
        <td><input type="checkbox" aria-label={t(`בחר ${l.contact.fullName}`, `Select ${l.contact.fullName}`)} checked={selected.includes(l.id)} onChange={e => setSelected(s => e.target.checked ? [...s, l.id] : s.filter(id => id !== l.id))}/></td>
        <td><button className="lead-name" onClick={() => setDetail({ id: l.id, tab: "details" })}>{l.contact.fullName}</button>{l.existingCustomer && <span className="ms-1 rounded bg-[#ecf9f0] px-1.5 py-0.5 text-[11px] font-semibold text-[#14532d]" title={t("רכש בעבר – זו הזדמנות חדשה של לקוח קיים, לא ליד חדש", "Bought before – a new opportunity of an existing customer, not a new lead")} data-testid={`lead-existing-${l.id}`}>{t("לקוח קיים", "Existing customer")}</span>}{l.reviewReason && <span className="ms-1 rounded bg-[#fff4e5] px-1.5 py-0.5 text-[11px] font-semibold text-[#8a4b00]" title={t("אין נציג מטפל פעיל – יש לשייך ידנית", "No active handling agent – assign manually")} data-testid={`lead-review-${l.id}`}>{t("לבירור", "Review")}</span>}{l.availableNow && <AvailableNowTag compact at={l.availableNow.at} text={l.availableNow.text} />}{l.status !== "converted" && <button className="lead-new-deal" onClick={() => setConvert(l)}>{t("+ עסקה חדשה", "+ New deal")}</button>}</td>
        <td className="lead-phone" dir="ltr">{formatPhone(l.contact.phoneE164)}</td><td>{l.source ?? "—"}</td><td>{metadata(l, "product")}</td><td className="lead-campaign">{metadata(l, "campaign")}</td><td className="lead-campaign">{metadata(l, "ad")}</td>
        <td><select aria-label={t(`סטטוס ${l.contact.fullName}`, `Status ${l.contact.fullName}`)} className={`lead-status status-${l.status}`} value={statuses.forLead(l)?.id ?? ""} onChange={e => onStatus(l, e.target.value)} data-testid={`lead-status-${l.id}`}>{statuses.optionsFor(l).map(s => <option key={s.id} value={s.id}>{s.label}</option>)}</select>{l.pendingTransfer && <small className="lead-pending-transfer" title={t("ההעברה תתבצע בסיום השיחה", "The transfer will happen when the call ends")}>⇄ {t(`בהעברה ל${l.pendingTransfer.to ?? "נציג"}`, `Transferring to ${l.pendingTransfer.to ?? "agent"}`)}</small>}</td>
        <td><AttemptsCell count={l.attempts} limit={l.attemptLimit} lastAt={l.lastAttemptAt} tz={tz} onOpen={() => setAttemptsFor(l)} /></td>
        <td><FollowUpBadge followUp={l.followUp} needsSchedule={l.needsSchedule} tz={tz} onClick={() => setFollowUpFor(l)} /></td>
        <td>{manager ? <select className="lead-owner" aria-label={t(`נציג ${l.contact.fullName}`, `Agent ${l.contact.fullName}`)} value={l.owner?.id ?? ""} onChange={e => onOwner(l, e.target.value)} data-testid={`lead-owner-${l.id}`}><option value="">{t("ללא שיוך", "Unassigned")}</option>{l.owner && !users.some(u => u.id === l.owner?.id) && <option value={l.owner.id}>{l.owner.fullName}</option>}{users.map(u => <option key={u.id} value={u.id}>{u.fullName}</option>)}</select> : l.owner?.fullName ?? t("ללא שיוך", "Unassigned")}</td>
        <td className="lead-created" dir="ltr">{new Date(l.createdAt).toLocaleDateString(loc)}<span>{new Date(l.createdAt).toLocaleTimeString(loc, { hour: "2-digit", minute: "2-digit" })}</span></td>
        <td><div className="lead-row-actions">{me?.modules.messaging && <button className="lead-whatsapp" onClick={() => setDetail({ id: l.id, tab: "chat" })} aria-label={`WhatsApp ${l.contact.fullName}`} title={t("פתיחת שיחת WhatsApp", "Open WhatsApp conversation")}><MessageCircle size={17}/><span>WhatsApp</span></button>}{canTransfer && <button className="lead-transfer" onClick={() => setTransferIds({ ids: [l.id], owner: l.owner?.id })} title={t("העבר לנציג", "Transfer to agent")} aria-label={t(`העבר את ${l.contact.fullName} לנציג`, `Transfer ${l.contact.fullName} to an agent`)} data-testid={`lead-transfer-${l.id}`}><Users size={15}/><span>{t("העבר", "Transfer")}</span></button>}{telephony && <button className="lead-call" disabled={!canDial} title={t("חיוג לליד", "Call the lead")} aria-label={t(`חייג ${l.contact.fullName}`, `Call ${l.contact.fullName}`)} onClick={() => dialAndOpen(l.contact.id)}><PhoneIcon size={15}/><span>{t("חייג", "Call")}</span></button>}</div></td>
      </tr>)}</Fragment>)}</tbody></table></div>{!data.items.length && <EmptyState title={t("אין לידים התואמים לסינון", "No leads match the filter")} hint={t("שנה את הטווח או המסננים, או צור ליד חדש", "Change the range or filters, or create a new lead")}/>}<footer className="lead-pagination"><span>{t(`${number(data.total)} לידים · עמוד ${page} מתוך ${Math.max(1, Math.ceil(data.total / 30))}`, `${number(data.total)} leads · Page ${page} of ${Math.max(1, Math.ceil(data.total / 30))}`)}</span><div><button aria-label={t("עמוד קודם", "Previous page")} disabled={page <= 1 || loading} onClick={() => { setPage(p => p - 1); setSelected([]); }}><ChevronRight size={17}/></button><button aria-label={t("עמוד הבא", "Next page")} disabled={page * 30 >= data.total || loading} onClick={() => { setPage(p => p + 1); setSelected([]); }}><ChevronLeft size={17}/></button></div></footer></>}
    </section>
    {telephony && live && <Link href="/dialer" className="dialer-live-pill" data-testid="dialer-reopen">{t("📞 החייגן פעיל – פתח", "📞 Dialer active – open")}</Link>}
    {detail && <LeadDrawer key={detail.id} leadId={detail.id} initialTab={detail.tab} users={users} manager={manager} canTransfer={canTransfer} messaging={Boolean(me?.modules.messaging)} canDial={canDial} onDial={contactId => dialAndOpen(contactId)} onClose={() => { setDetail(null); if (params.get("leadId")) { const next = new URLSearchParams(params.toString()); next.delete("leadId"); router.replace((listId ? `/lists/${listId}` : "/leads") + (next.size ? `?${next}` : "")); } }} onUpdated={() => { void load(); }}/>}
    {tasksOpen && <aside className="lead-side-drawer" aria-label={t("משימות וחזרות", "Tasks & callbacks")} data-testid="tasks-drawer"><header><strong>{t("משימות וחזרות", "Tasks & callbacks")}</strong>{telephony && <div className="drawer-tabs" role="tablist"><button role="tab" aria-selected={drawerView === "tasks"} onClick={() => setDrawerView("tasks")} data-testid="drawer-tab-tasks">{t("משימות", "Tasks")}</button><button role="tab" aria-selected={drawerView === "calls"} onClick={() => setDrawerView("calls")} data-testid="drawer-tab-calls">{t("שיחות שלא נענו", "Missed calls")}</button></div>}<button aria-label={t("סגור משימות", "Close tasks")} onClick={() => { setTasksOpen(false); if (params.get("tasks")) router.replace(listId ? `/calling/lists/${listId}` : "/leads"); }}><X size={17}/></button></header><div>{drawerView === "calls" && telephony ? <CallsInbox /> : <TasksPanel embedded />}</div></aside>}
    {moveFor && <MoveToCampaignModal leadId={moveFor.id} name={moveFor.contact.fullName} onClose={() => setMoveFor(null)} onDone={() => { void load(); }} />}
    {importOpen && <LeadImportModal users={users} onClose={() => setImportOpen(false)} onDone={() => { void load(); }} />}
    {followUpFor && <FollowUpModal leadId={followUpFor.id} name={followUpFor.contact.fullName} tz={tz} current={followUpFor.followUp} statusId={followUpFor.pickStatusId} onClose={() => setFollowUpFor(null)} onSaved={() => { void load(); }} />}
    {attemptsFor && <AttemptsModal leadId={attemptsFor.id} name={attemptsFor.contact.fullName} tz={tz} onClose={() => setAttemptsFor(null)} />}
    {transferIds && <TransferModal leadIds={transferIds.ids} currentOwnerId={transferIds.owner} users={users} onClose={() => setTransferIds(null)} onDone={() => { setSelected([]); void load(); }} />}
    {settingsOpen && <LeadsSettingsModal open={settingsOpen} onClose={closeSettings} manager={manager} mode={settingsTab} />}
    <Modal open={open} onClose={() => !saving && setOpen(false)} title={t("ליד חדש", "New lead")} footer={<><Button variant="ghost" onClick={() => setOpen(false)} disabled={saving}>{t("ביטול", "Cancel")}</Button><Button onClick={create} loading={saving} disabled={newContact ? !form.contactName || !form.phone : !form.contactId}>{t("צור ליד", "Create lead")}</Button></>}><div className="space-y-3"><div className="flex gap-3"><button className={!newContact ? "text-accent font-medium" : "text-muted"} onClick={() => { setNewContact(false); setForm(f => ({ ...f, contactId: "" })); }}>{t("איש קשר קיים", "Existing contact")}</button><button className={newContact ? "text-accent font-medium" : "text-muted"} onClick={() => { setNewContact(true); setForm(f => ({ ...f, contactId: "", contactName: "" })); }}>{t("איש קשר חדש", "New contact")}</button></div>{newContact ? <><Input label={t("שם מלא", "Full name")} value={form.contactName} onChange={e => setForm({ ...form, contactName: e.target.value })}/><Input label={t("טלפון", "Phone")} value={form.phone} onChange={e => setForm({ ...form, phone: e.target.value })} ltr/></> : form.contactId ? <div>{form.contactName}<button className="ms-3 text-accent" onClick={() => setForm({ ...form, contactId: "" })}>{t("שנה", "Change")}</button></div> : <><Input label={t("חיפוש איש קשר", "Search contact")} value={search} onChange={e => setSearch(e.target.value)}/><ul className="max-h-44 overflow-auto">{hits.map(h => <li key={h.id}><button className="w-full text-start p-2 hover:bg-panel-2" onClick={() => setForm({ ...form, contactId: h.id, contactName: h.fullName })}>{h.fullName} · {formatPhone(h.phoneE164)}</button></li>)}</ul></>}<Input label={t("כותרת", "Title")} value={form.title} onChange={e => setForm({ ...form, title: e.target.value })}/><Input label={t("מקור", "Source")} value={form.source} onChange={e => setForm({ ...form, source: e.target.value })}/>{manager && <Select label={t("נציג", "Agent")} value={form.ownerUserId} onChange={e => setForm({ ...form, ownerUserId: e.target.value })}><option value="">{t("ללא שיוך (לפי חלוקת הלידים)", "Unassigned (per lead distribution)")}</option>{users.map(u => <option key={u.id} value={u.id}>{u.fullName}</option>)}</Select>}</div></Modal>
    {convert && <DealCloseModal contactId={convert.contact.id} leadId={convert.id} name={convert.contact.fullName} onClose={() => { setConvert(null); setConvertStatusId(null); }} onDone={() => { const id = convert.id, custom = convertStatusId; setConvertStatusId(null); void (custom ? patch(id, { statusId: custom }) : Promise.resolve(true)).then(() => load()); }} />}
  </div>;
}
