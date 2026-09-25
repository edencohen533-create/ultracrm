"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { api, qs } from "@/lib/client/api";
import { useDialer } from "@/components/telephony/DialerProvider";
import { useMe } from "@/lib/client/use-me";
import { Badge, Button, EmptyState, Input, Modal, Phone, Select, Spinner, Stat } from "@/components/ui";
import { formatPhone, relativeTime } from "@/lib/client/format";
import { LEAD_STATUSES, LEAD_STATUS_LABEL } from "@/lib/crm/labels";
import { DialerWorkspace } from "@/components/dialer/DialerWorkspace";
import { StartSessionForm } from "@/components/dialer/SessionControls";
import { WorkStrip } from "@/components/leads/WorkStrip";

interface Lead { id: string; title: string | null; status: string; source: string | null; priority: number; createdAt: string; contact: { id: string; fullName: string; phoneE164: string; company: string | null }; owner: { id: string; fullName: string } | null }
interface ContactHit { id: string; fullName: string; phoneE164: string }

/**
 * The agent's main workspace: the lead list with the auto dialer started from here ("הפעל חייגן").
 * While a dialing session, a live call or a call awaiting its outcome exists, the dialer workspace
 * (queue · lead card · call panel · outcome) replaces the list – nothing to look for on other screens.
 */
export default function LeadsPage() {
  return <Suspense fallback={<div className="flex justify-center p-10"><Spinner /></div>}><LeadsWorkspace /></Suspense>;
}

function LeadsWorkspace() {
  const me = useMe();
  const router = useRouter();
  const params = useSearchParams();
  const { dial, state, sessionSummary } = useDialer();
  const session = state?.session;
  // Keep the workspace mounted while the end-of-session summary is open – otherwise the modal would reappear
  // over the next call and block it.
  const dialerLive = Boolean((session && session.status !== "ended") || state?.activeCall || state?.wrapUpCall || sessionSummary);
  const [data, setData] = useState<{ items: Lead[]; total: number; byStatus: Record<string, number> } | null>(null);
  const [filter, setFilter] = useState({ status: params.get("status") ?? "", q: params.get("q") ?? "", ownerUserId: params.get("mine") === "1" ? "me" : (params.get("ownerUserId") ?? "") });
  const [page, setPage] = useState(1);
  const [users, setUsers] = useState<Array<{ id: string; fullName: string }>>([]);
  const [open, setOpen] = useState(false);
  const [preflight, setPreflight] = useState(false);
  const [search, setSearch] = useState("");
  const [hits, setHits] = useState<ContactHit[]>([]);
  const [form, setForm] = useState({ contactId: "", contactName: "", title: "", source: "", ownerUserId: "" });
  const [convert, setConvert] = useState<Lead | null>(null);
  const [dealForm, setDealForm] = useState({ title: "", amount: "" });
  const [refreshKey, setRefreshKey] = useState(0);

  const ownerParam = filter.ownerUserId === "me" ? (me?.user.id ?? "") : filter.ownerUserId;
  const load = useCallback(() => api.get<typeof data>(`/api/leads${qs({ status: filter.status, q: filter.q, ownerUserId: ownerParam, page, limit: 30 })}`).then(setData).catch((e) => toast.error(e.message)), [filter.status, filter.q, ownerParam, page]);
  useEffect(() => { if (dialerLive) return; const t = setTimeout(load, 200); return () => clearTimeout(t); }, [load, dialerLive]);
  useEffect(() => { api.get<{ items: Array<{ id: string; fullName: string }> }>("/api/users").then((r) => setUsers(r.items)).catch(() => undefined); }, []);
  useEffect(() => {
    if (!open || search.trim().length < 2) { setHits([]); return; }
    const t = setTimeout(() => api.get<{ items: ContactHit[] }>(`/api/contacts${qs({ q: search, limit: 8 })}`).then((r) => setHits(r.items)).catch(() => undefined), 250);
    return () => clearTimeout(t);
  }, [search, open]);
  // Coming back from the dialer (session ended / outcome saved): refresh the list and the work strip.
  useEffect(() => { if (!dialerLive) setRefreshKey((k) => k + 1); }, [dialerLive]);

  async function setStatus(id: string, status: string) { try { await api.patch(`/api/leads/${id}`, { status }); load(); } catch (e) { toast.error((e as Error).message); } }
  async function create() { try { await api.post("/api/leads", { contactId: form.contactId, title: form.title || undefined, source: form.source || undefined, ownerUserId: form.ownerUserId || undefined }); setOpen(false); setForm({ contactId: "", contactName: "", title: "", source: "", ownerUserId: "" }); toast.success("הליד נוצר"); load(); } catch (e) { toast.error((e as Error).message); } }
  async function doConvert() { if (!convert) return; try { await api.post(`/api/leads/${convert.id}/convert`, { title: dealForm.title || undefined, amount: dealForm.amount ? Number(dealForm.amount) : undefined }); setConvert(null); toast.success("הליד הומר לעסקה"); load(); } catch (e) { toast.error((e as Error).message); } }

  const isManager = me?.user.role !== "agent";
  const telephony = Boolean(me?.modules.telephony);
  const canDial = telephony && Boolean(state) && !state?.activeCall && !state?.wrapUpCall;

  if (telephony && dialerLive) {
    return (
      <div className="h-screen min-h-0" data-testid="dialer-embedded">
        <DialerWorkspace embedded />
      </div>
    );
  }

  return (
    <div className="p-5 space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-semibold">לידים</h1>
        <span className="text-xs text-muted tabular">{data?.total ?? 0} רשומות</span>
        <div className="ms-auto flex flex-wrap items-center gap-2">
          {isManager && <Link href="/contacts" className="text-xs text-muted hover:text-text">כל אנשי הקשר / ייבוא</Link>}
          <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>+ ליד</Button>
          {telephony && (
            <Button size="md" variant="good" onClick={() => setPreflight(true)} disabled={!state} data-testid="open-dialer" title={!state ? "מתחבר לטלפוניה…" : undefined}>
              ▶ הפעל חייגן
            </Button>
          )}
        </div>
      </div>
      <WorkStrip refreshKey={refreshKey} />
      {data && <div className="grid grid-cols-3 md:grid-cols-6 gap-2">{LEAD_STATUSES.map((s) => <button key={s} onClick={() => { setPage(1); setFilter({ ...filter, status: filter.status === s ? "" : s }); }} className={filter.status === s ? "ring-2 ring-accent rounded-lg text-start" : "text-start"}><Stat label={LEAD_STATUS_LABEL[s]} value={data.byStatus[s] ?? 0} /></button>)}</div>}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        <Input placeholder="חיפוש שם / טלפון / כותרת" value={filter.q} onChange={(e) => { setPage(1); setFilter({ ...filter, q: e.target.value }); }} className="md:col-span-2" />
        <Select value={filter.ownerUserId} onChange={(e) => { setPage(1); setFilter({ ...filter, ownerUserId: e.target.value }); }}>
          <option value="">{isManager ? "כל הנציגים" : "כל הלידים שלי והפנויים"}</option>
          <option value="me">הלידים שלי</option>
          {isManager && users.map((u) => <option key={u.id} value={u.id}>{u.fullName}</option>)}
        </Select>
      </div>
      {!data ? <div className="flex justify-center p-10"><Spinner /></div> : data.items.length === 0 ? <EmptyState title="אין לידים" hint="צור ליד מאיש קשר; שיוך לנציג ומשימת פנייה ראשונית נוצרים אוטומטית" /> : (
        <div className="bg-panel border border-line rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead className="text-xs text-muted bg-white/3"><tr><th className="text-start px-3 h-9 font-medium">ליד</th><th className="text-start px-3 font-medium hidden md:table-cell">כותרת</th><th className="text-start px-3 font-medium hidden lg:table-cell">מקור</th><th className="text-start px-3 font-medium hidden md:table-cell">נציג</th><th className="text-start px-3 font-medium">סטטוס</th><th className="text-start px-3 font-medium hidden lg:table-cell">נוצר</th><th className="px-3"></th></tr></thead>
            <tbody className="divide-y divide-line">
              {data.items.map((l) => (
                <tr key={l.id} className="hover:bg-white/3">
                  <td className="px-3 h-11"><Link href={`/contacts/${l.contact.id}?lead=${l.id}`} className="font-medium hover:underline">{l.contact.fullName}</Link><span className="block text-[11px]"><Phone value={formatPhone(l.contact.phoneE164)} className="text-muted" /></span></td>
                  <td className="px-3 hidden md:table-cell"><Link href={`/contacts/${l.contact.id}?lead=${l.id}`} className="hover:underline">{l.title ?? "—"}</Link></td>
                  <td className="px-3 text-muted hidden lg:table-cell">{l.source ?? "—"}</td>
                  <td className="px-3 text-muted hidden md:table-cell">{l.owner?.fullName ?? "ללא"}</td>
                  <td className="px-3"><Select value={l.status} onChange={(e) => setStatus(l.id, e.target.value)} className="h-8 text-xs w-32">{LEAD_STATUSES.map((s) => <option key={s} value={s}>{LEAD_STATUS_LABEL[s]}</option>)}</Select></td>
                  <td className="px-3 text-xs text-muted tabular hidden lg:table-cell">{relativeTime(l.createdAt)}</td>
                  <td className="px-3 text-end whitespace-nowrap">
                    {telephony && <Button size="sm" variant="good" disabled={!canDial} onClick={() => dial({ mode: "manual", contactId: l.contact.id })} title="חיוג ידני לליד זה">חייג</Button>}
                    {!["converted", "lost"].includes(l.status) && <Button size="sm" variant="ghost" onClick={() => { setConvert(l); setDealForm({ title: l.title ?? `עסקה – ${l.contact.fullName}`, amount: "" }); }}>המר לעסקה</Button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="flex items-center justify-between px-3 h-10 border-t border-line text-xs text-muted"><span>עמוד {page}</span><div className="flex gap-1"><Button size="sm" variant="ghost" disabled={page <= 1} onClick={() => setPage(page - 1)}>הקודם</Button><Button size="sm" variant="ghost" disabled={page * 30 >= data.total} onClick={() => setPage(page + 1)}>הבא</Button></div></div>
        </div>
      )}

      <Modal open={preflight} onClose={() => setPreflight(false)} title="הפעלת החייגן האוטומטי">
        <StartSessionForm compact onStarted={() => { setPreflight(false); router.replace("/leads"); }} />
      </Modal>
      <Modal open={open} onClose={() => setOpen(false)} title="ליד חדש" footer={<><Button variant="ghost" onClick={() => setOpen(false)}>ביטול</Button><Button onClick={create} disabled={!form.contactId}>צור</Button></>}>
        <div className="space-y-2">
          {form.contactId ? <div className="flex items-center gap-2 text-sm"><Badge tone="accent">{form.contactName}</Badge><Button size="sm" variant="ghost" onClick={() => setForm({ ...form, contactId: "", contactName: "" })}>שנה</Button></div> : (
            <div>
              <Input label="חיפוש איש קשר (שם / טלפון)" value={search} onChange={(e) => setSearch(e.target.value)} />
              <ul className="mt-1 divide-y divide-line border border-line rounded-lg max-h-48 overflow-auto">{hits.map((h) => <li key={h.id}><button className="w-full text-start px-3 py-2 text-sm hover:bg-white/5" onClick={() => setForm({ ...form, contactId: h.id, contactName: h.fullName })}>{h.fullName} <span className="text-muted ltr">{formatPhone(h.phoneE164)}</span></button></li>)}{search.length >= 2 && hits.length === 0 && <li className="px-3 py-2 text-xs text-muted">לא נמצא – <Link href="/contacts" className="underline">צור איש קשר חדש</Link></li>}</ul>
            </div>
          )}
          <Input label="כותרת" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
          <Input label="מקור" value={form.source} onChange={(e) => setForm({ ...form, source: e.target.value })} />
          {isManager && <Select label="נציג" value={form.ownerUserId} onChange={(e) => setForm({ ...form, ownerUserId: e.target.value })}><option value="">שיוך אוטומטי</option>{users.map((u) => <option key={u.id} value={u.id}>{u.fullName}</option>)}</Select>}
        </div>
      </Modal>
      <Modal open={Boolean(convert)} onClose={() => setConvert(null)} title="המרת ליד לעסקה" footer={<><Button variant="ghost" onClick={() => setConvert(null)}>ביטול</Button><Button onClick={doConvert}>המר</Button></>}>
        <div className="space-y-2"><Input label="כותרת העסקה" value={dealForm.title} onChange={(e) => setDealForm({ ...dealForm, title: e.target.value })} /><Input label="סכום (₪)" type="number" value={dealForm.amount} onChange={(e) => setDealForm({ ...dealForm, amount: e.target.value })} ltr /></div>
      </Modal>
    </div>
  );
}
