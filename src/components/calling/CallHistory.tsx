"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { X } from "lucide-react";
import { api, qs } from "@/lib/client/api";
import { Badge, Button, EmptyState, Input, Phone, Select, Spinner, cx } from "@/components/ui";
import { CALL_STATUS_LABEL, MODE_LABEL, TELEPHONY_RESULT_LABEL, formatDateTime, formatDuration, formatPhone } from "@/lib/client/format";
import { OUTCOMES } from "@/lib/outcomes";
import { useT } from "@/components/i18n/LangProvider";
import { useMe } from "@/lib/client/use-me";
import { CallDocView, DocStatus, type CallDoc } from "@/components/leads/LeadDrawer";

interface Row { id: string; createdAt: string; answeredAt: string | null; talkSeconds: number | null; status: string; direction: string; telephonyResult: string | null; outcome: string | null; outcomeNote: string | null; recordingStatus: string; mode: string; toE164: string; fromE164: string; hangupCause: string | null; user: { id: string; fullName: string }; contact: { id: string; fullName: string } | null; list: { id: string; name: string } | null; coachSession: { documentationStatus: string | null } | null }
interface Detail { id: string; createdAt: string; ringingAt: string | null; answeredAt: string | null; endedAt: string | null; talkSeconds: number | null; status: string; direction: string; mode: string; telephonyResult: string | null; hangupCause: string | null; outcome: string | null; outcomeNote: string | null; callbackAt: string | null; toE164: string; fromE164: string; recordingStatus: string; canPlayRecording: boolean; user: { id: string; fullName: string }; contact: { id: string; fullName: string; phoneE164: string } | null; list: { id: string; name: string } | null; coachSession: { documentation: CallDoc | null; documentationStatus: string | null; documentationError: string | null } | null }

const PAGE = 50;
/** Filters live in the URL (חייגן → היסטוריית שיחות?…): refresh, shared links and back / forward keep the same view. */
const KEYS = ["q", "userId", "outcome", "telephonyResult", "listId", "from", "to", "contactId", "metric"] as const;
type Filters = Record<(typeof KEYS)[number], string>;
const METRIC_LABEL: Record<string, [string, string]> = { outbound: ["שיחות יוצאות (כפי שנספרות בדוחות)", "Outbound calls (as counted in reports)"], answered: ["שיחות יוצאות שנענו (כפי שנספרות בדוחות)", "Answered outbound calls (as counted in reports)"] };

/**
 * Call history – the same /api/calls source the reports used, now the "היסטוריית שיחות" tab of the dialer area.
 * The server limits rows to the user's data scope (agent: own calls) and business; recordings stream only through
 * /api/recordings with the recordings permission. A row opens a side drawer (?call=…) over the table, so closing it
 * (or "back") returns to the same scroll position, filters and loaded rows.
 */
export function CallHistory() {
  const t = useT();
  const me = useMe();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const urlFilters = useMemo(() => Object.fromEntries(KEYS.map((k) => [k, params.get(k) ?? ""])) as Filters, [params]);
  const [f, setF] = useState<Filters>(urlFilters);
  const [rows, setRows] = useState<Row[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [users, setUsers] = useState<Array<{ id: string; fullName: string }>>([]);
  const [lists, setLists] = useState<Array<{ id: string; name: string }>>([]);
  const gen = useRef(0);
  const ownUrl = useRef<string | null>(null); // the filters WE last wrote to the URL (not a back / forward)
  const skipPages = useRef<number | null>(null); // "load more" already has the rows of this page
  const pushedDrawer = useRef(false);
  const openCall = params.get("call");
  const pages = Math.max(1, Math.min(10, Number(params.get("pages")) || 1));
  const canRecordings = me?.access?.modules.telephony?.actions.includes("recordings") ?? false;

  // Back / forward (or a link) changed the URL → follow it.
  useEffect(() => { if (JSON.stringify(urlFilters) !== ownUrl.current) setF(urlFilters); }, [urlFilters]);

  const setUrl = useCallback((next: Partial<Filters> & { pages?: number; call?: string | null }, push = false) => {
    const sp = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(next)) { if (v === null || v === undefined || v === "" || (k === "pages" && v === 1)) sp.delete(k); else sp.set(k, String(v)); }
    ownUrl.current = JSON.stringify(Object.fromEntries(KEYS.map((k) => [k, sp.get(k) ?? ""])));
    const href = `${pathname}${sp.size ? `?${sp.toString()}` : ""}`;
    if (push) router.push(href, { scroll: false }); else router.replace(href, { scroll: false });
  }, [params, pathname, router]);

  // Typing / picking a filter: update the URL (replace – one history entry per view, not per keystroke) and reset paging.
  function change(k: keyof Filters, v: string) { const next = { ...f, [k]: v }; setF(next); }
  useEffect(() => {
    if (KEYS.every((k) => f[k] === urlFilters[k])) return;
    const tm = setTimeout(() => setUrl({ ...f, pages: 1 }), 300);
    return () => clearTimeout(tm);
  }, [f, urlFilters, setUrl]);

  const query = useCallback((after: string | null) => `/api/calls${qs({ q: urlFilters.q, userId: urlFilters.userId, outcome: urlFilters.outcome, telephonyResult: urlFilters.telephonyResult, listId: urlFilters.listId, contactId: urlFilters.contactId, metric: urlFilters.metric, fromDate: urlFilters.from, toDate: urlFilters.to, cursor: after ?? "", limit: PAGE })}`, [urlFilters]);

  // Load the pages the URL asks for (so returning to the view restores the rows that were loaded).
  useEffect(() => {
    if (skipPages.current === pages) { skipPages.current = null; return; }
    const token = ++gen.current;
    setLoading(true);
    (async () => {
      let acc: Row[] = []; let next: string | null = null;
      for (let i = 0; i < pages; i++) {
        const r: { items: Row[]; nextCursor: string | null } = await api.get(query(next));
        acc = acc.concat(r.items); next = r.nextCursor;
        if (!next) break;
      }
      if (gen.current === token) { setRows(acc); setCursor(next); }
    })().catch((e) => { if (gen.current === token) { toast.error((e as Error).message); setRows([]); } }).finally(() => { if (gen.current === token) setLoading(false); });
  }, [query, pages]);

  async function loadMore() {
    if (!cursor) return;
    setLoading(true);
    try {
      const r = await api.get<{ items: Row[]; nextCursor: string | null }>(query(cursor));
      setRows((prev) => [...(prev ?? []), ...r.items]); setCursor(r.nextCursor);
      if (pages < 10) { skipPages.current = pages + 1; setUrl({ pages: pages + 1 }); }
    } catch (e) { toast.error((e as Error).message); } finally { setLoading(false); }
  }

  useEffect(() => {
    api.get<{ items: Array<{ id: string; fullName: string }> }>("/api/users").then((u) => setUsers(u.items)).catch(() => undefined);
    api.get<Array<{ id: string; name: string }>>("/api/lists").then((l) => setLists(l.map((x) => ({ id: x.id, name: x.name })))).catch(() => undefined);
  }, []);

  // Opening details adds a history entry (browser "back" closes them); a shared link with ?call= closes in place.
  function openDrawer(id: string) { pushedDrawer.current = true; setUrl({ call: id }, true); }
  function closeDrawer() { if (pushedDrawer.current) { pushedDrawer.current = false; router.back(); } else setUrl({ call: null }); }

  const contactName = rows?.find((r) => r.contact?.id === urlFilters.contactId)?.contact?.fullName;
  const anyFilter = KEYS.some((k) => urlFilters[k]);

  return (
    <div className="p-4 md:p-5 space-y-4" data-testid="call-history">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-lg font-semibold">{t("היסטוריית שיחות", "Call history")}</h1>
        {me?.user.role === "agent" && <span className="text-xs text-muted">{t("מוצגות השיחות שלך", "Showing your calls")}</span>}
        {anyFilter && <button type="button" className="ms-auto text-xs underline text-muted hover:text-text" onClick={() => { setF(Object.fromEntries(KEYS.map((k) => [k, ""])) as Filters); setUrl({ ...Object.fromEntries(KEYS.map((k) => [k, ""])), pages: 1 }); }} data-testid="history-clear">{t("נקה סינון", "Clear filters")}</button>}
      </div>
      {(urlFilters.contactId || urlFilters.metric) && (
        <div className="flex flex-wrap gap-2 text-xs" data-testid="history-chips">
          {urlFilters.contactId && <span className="inline-flex items-center gap-1 rounded-full bg-accent/10 text-accent px-2.5 py-1">{t("לקוח:", "Customer:")} {contactName ?? t("איש קשר נבחר", "Selected contact")}<Link href={`/contacts/${urlFilters.contactId}`} className="underline ms-1">{t("לכרטיס", "Card")}</Link><button type="button" aria-label={t("הסר סינון לקוח", "Remove customer filter")} onClick={() => setUrl({ contactId: "", pages: 1 })}><X size={13} /></button></span>}
          {urlFilters.metric && METRIC_LABEL[urlFilters.metric] && <span className="inline-flex items-center gap-1 rounded-full bg-accent/10 text-accent px-2.5 py-1" data-testid="history-metric-chip">{t(...METRIC_LABEL[urlFilters.metric])}<button type="button" aria-label={t("הסר סינון מדד", "Remove metric filter")} onClick={() => setUrl({ metric: "", pages: 1 })}><X size={13} /></button></span>}
        </div>
      )}
      <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-8 gap-2">
        <Input className="col-span-2" placeholder={t("שם / טלפון", "Name / phone")} aria-label={t("חיפוש לפי שם או טלפון", "Search by name or phone")} value={f.q} onChange={(e) => change("q", e.target.value)} data-testid="history-q" />
        {users.length > 1 && <Select aria-label={t("נציג", "Agent")} value={f.userId} onChange={(e) => change("userId", e.target.value)} data-testid="history-agent"><option value="">{t("כל הנציגים", "All agents")}</option>{users.map((u) => <option key={u.id} value={u.id}>{u.fullName}</option>)}</Select>}
        <Select aria-label={t("תוצאה", "Outcome")} value={f.outcome} onChange={(e) => change("outcome", e.target.value)} data-testid="history-outcome"><option value="">{t("כל התוצאות", "All outcomes")}</option>{OUTCOMES.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}</Select>
        <Select aria-label={t("מצב טלפוניה", "Telephony result")} value={f.telephonyResult} onChange={(e) => change("telephonyResult", e.target.value)} data-testid="history-telephony"><option value="">{t("טלפוניה: הכל", "Telephony: all")}</option>{Object.entries(TELEPHONY_RESULT_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</Select>
        <Select aria-label={t("רשימת חיוג", "Dial list")} value={f.listId} onChange={(e) => change("listId", e.target.value)} data-testid="history-list"><option value="">{t("כל הרשימות", "All lists")}</option>{lists.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}{f.listId && !lists.some((l) => l.id === f.listId) && <option value={f.listId}>{t("רשימה נבחרת", "Selected list")}</option>}</Select>
        <Input type="date" aria-label={t("מתאריך", "From date")} value={f.from} max={f.to || undefined} onChange={(e) => change("from", e.target.value)} ltr data-testid="history-from" />
        <Input type="date" aria-label={t("עד תאריך", "To date")} value={f.to} min={f.from || undefined} onChange={(e) => change("to", e.target.value)} ltr data-testid="history-to" />
      </div>
      <div className="bg-panel border border-line rounded-xl overflow-hidden">
        {rows === null ? <div className="flex justify-center p-10"><Spinner /></div> : rows.length === 0 && !loading ? <EmptyState title={anyFilter ? t("אין שיחות שתואמות לסינון", "No calls match the filters") : t("עדיין אין שיחות", "No calls yet")} /> : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs min-w-[860px]">
              <thead className="text-muted bg-white/3"><tr><th className="text-start px-3 h-9 font-medium">{t("מועד", "Time")}</th><th className="text-start px-3 font-medium">{t("נציג", "Agent")}</th><th className="text-start px-3 font-medium">{t("לקוח", "Customer")}</th><th className="text-start px-3 font-medium">{t("מצב", "Mode")}</th><th className="text-start px-3 font-medium">{t("טלפוניה", "Telephony")}</th><th className="text-start px-3 font-medium">{t("משך", "Duration")}</th><th className="text-start px-3 font-medium">{t("תוצאה", "Outcome")}</th><th className="text-start px-3 font-medium">{t("רשימה", "List")}</th><th className="text-start px-3 font-medium">{t("הקלטה", "Recording")}</th></tr></thead>
              <tbody className="divide-y divide-line">
                {rows.map((r) => (
                  <tr key={r.id} className={cx("hover:bg-white/3 cursor-pointer", openCall === r.id && "bg-accent/5")} onClick={(e) => { if ((e.target as HTMLElement).closest("a,button,audio")) return; openDrawer(r.id); }} data-testid={`history-row-${r.id}`}>
                    <td className="px-3 h-10 tabular"><button type="button" className="hover:underline text-start" onClick={() => openDrawer(r.id)} aria-label={t("פרטי שיחה", "Call details")}>{formatDateTime(r.createdAt)}</button></td>
                    <td className="px-3">{r.user.fullName}</td>
                    <td className="px-3">{r.contact ? <Link href={`/contacts/${r.contact.id}`} className="hover:underline">{r.contact.fullName}</Link> : "—"} <Phone value={formatPhone(r.toE164)} className="text-muted" /></td>
                    <td className="px-3 text-muted">{r.direction === "inbound" ? t("נכנסת", "Inbound") : MODE_LABEL[r.mode]}</td>
                    <td className="px-3"><Badge tone={r.answeredAt ? "good" : "neutral"}>{r.telephonyResult ? TELEPHONY_RESULT_LABEL[r.telephonyResult] : r.status === "failed" ? t("נכשלה", "Failed") : "—"}</Badge>{r.hangupCause && <span className="text-muted ms-1 ltr">{r.hangupCause}</span>}</td>
                    <td className="px-3 tabular">{r.answeredAt ? formatDuration(r.talkSeconds) : "—"}</td>
                    <td className="px-3">{OUTCOMES.find((o) => o.key === r.outcome)?.label ?? "—"}{r.outcomeNote && <p className="text-muted truncate max-w-56" title={r.outcomeNote}>{r.outcomeNote}</p>}</td>
                    <td className="px-3 text-muted">{r.list?.name ?? "—"}</td>
                    <td className="px-3">{r.recordingStatus === "saved" && canRecordings ? <audio controls preload="none" src={`/api/recordings/${r.id}`} className="h-7 w-40" /> : r.recordingStatus === "saved" ? <span className="text-muted">{t("אין הרשאה", "No permission")}</span> : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="flex items-center justify-center p-2 border-t border-line">
          {loading ? <Spinner className="w-4 h-4" /> : cursor ? <Button size="sm" variant="secondary" onClick={loadMore} data-testid="history-more">{t("טען עוד", "Load more")}</Button> : <span className="text-xs text-muted" data-testid="history-count">{t(`${rows?.length ?? 0} שיחות`, `${rows?.length ?? 0} calls`)}</span>}
        </div>
      </div>
      {openCall && <CallDrawer id={openCall} canRecordings={canRecordings} onClose={closeDrawer} onCustomerCalls={(contactId) => setUrl({ contactId, call: null, pages: 1 }, true)} />}
    </div>
  );
}

/** Call details over the table (the table stays mounted: closing returns to the same place). */
function CallDrawer({ id, canRecordings, onClose, onCustomerCalls }: { id: string; canRecordings: boolean; onClose: () => void; onCustomerCalls: (contactId: string) => void }) {
  const t = useT();
  const [d, setD] = useState<Detail | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    let live = true; setD(null); setError("");
    api.get<Detail>(`/api/calls/${id}`).then((x) => { if (live) setD(x); }).catch((e) => { if (live) setError((e as Error).message); });
    return () => { live = false; };
  }, [id]);
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); }; window.addEventListener("keydown", k); return () => window.removeEventListener("keydown", k); }, [onClose]);
  const row = (label: string, value: React.ReactNode) => <div className="flex justify-between gap-3 py-1.5 border-b border-line text-sm"><dt className="text-muted">{label}</dt><dd className="text-end">{value}</dd></div>;
  return (
    <>
      <div className="fixed inset-0 z-50 bg-black/20" onClick={onClose} aria-hidden />
      <aside className="lead-side-drawer" role="dialog" aria-modal="true" aria-label={t("פרטי שיחה", "Call details")} data-testid="call-drawer">
        <header><strong>{t("פרטי שיחה", "Call details")}</strong><button type="button" onClick={onClose} aria-label={t("סגור", "Close")} data-testid="call-drawer-close"><X size={20} /></button></header>
        <div>
          {error ? <p role="alert" className="text-sm text-bad">{error}</p> : !d ? <div className="flex justify-center p-8"><Spinner /></div> : (
            <div className="space-y-4">
              <div>
                <p className="text-base font-semibold">{d.contact?.fullName ?? t("לא מזוהה", "Unknown")} <Phone value={formatPhone(d.toE164)} className="text-muted text-sm" /></p>
                {d.contact && <div className="flex flex-wrap gap-3 mt-1 text-xs"><Link href={`/contacts/${d.contact.id}`} className="underline text-accent" data-testid="drawer-contact-card">{t("לכרטיס הלקוח", "Customer card")}</Link><button type="button" className="underline text-accent" onClick={() => onCustomerCalls(d.contact!.id)} data-testid="drawer-customer-calls">{t("כל השיחות של הלקוח", "All of the customer's calls")}</button></div>}
              </div>
              <dl>
                {row(t("מועד", "Time"), formatDateTime(d.createdAt))}
                {row(t("נציג", "Agent"), d.user.fullName)}
                {row(t("כיוון", "Direction"), d.direction === "inbound" ? t("נכנסת", "Inbound") : `${t("יוצאת", "Outbound")} · ${MODE_LABEL[d.mode] ?? d.mode}`)}
                {row(t("מצב שיחה", "Call status"), CALL_STATUS_LABEL[d.status] ?? d.status)}
                {row(t("טלפוניה", "Telephony"), <>{d.telephonyResult ? TELEPHONY_RESULT_LABEL[d.telephonyResult] : "—"}{d.hangupCause && <span className="text-muted ms-1 ltr">{d.hangupCause}</span>}</>)}
                {row(t("משך שיחה", "Talk time"), d.answeredAt ? formatDuration(d.talkSeconds) : "—")}
                {row(t("רשימת חיוג", "Dial list"), d.list ? <Link href={`/calling/lists/${d.list.id}`} className="underline">{d.list.name}</Link> : "—")}
                {row(t("תוצאה", "Outcome"), OUTCOMES.find((o) => o.key === d.outcome)?.label ?? "—")}
                {d.callbackAt && row(t("חזרה", "Callback"), formatDateTime(d.callbackAt))}
              </dl>
              {d.outcomeNote && <div><p className="text-xs text-muted mb-1">{t("סיכום הנציג", "Agent summary")}</p><p className="text-sm whitespace-pre-wrap">{d.outcomeNote}</p></div>}
              <div>
                <p className="text-xs text-muted mb-1">{t("הקלטה", "Recording")}</p>
                {d.recordingStatus !== "saved" ? <p className="text-sm text-muted">{t("אין הקלטה לשיחה זו", "No recording for this call")}</p> : d.canPlayRecording && canRecordings ? <audio controls preload="none" src={`/api/recordings/${d.id}`} className="w-full" data-testid="drawer-recording" onError={() => toast.error(t("ההקלטה אינה זמינה כרגע", "The recording is unavailable right now"))} /> : <p className="text-sm text-muted">{t("אין לך הרשאה להקלטות", "You don't have permission for recordings")}</p>}
              </div>
              {d.coachSession?.documentation ? <CallDocView doc={d.coachSession.documentation} /> : d.answeredAt && d.endedAt ? <DocStatus callId={d.id} status={d.coachSession?.documentationStatus ?? null} error={d.coachSession?.documentationError ?? null} /> : null}
            </div>
          )}
        </div>
      </aside>
    </>
  );
}
