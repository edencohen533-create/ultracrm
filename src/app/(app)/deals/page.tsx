"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { api, qs } from "@/lib/client/api";
import { useMe } from "@/lib/client/use-me";
import { Badge, Button, EmptyState, Input, Modal, Select, Spinner, Stat } from "@/components/ui";
import { formatDateTime } from "@/lib/client/format";
import { DEAL_STAGES, DEAL_STAGE_LABEL } from "@/lib/crm/labels";

interface Deal { id: string; title: string; stage: string; status: string; amount: string; currency: string; expectedCloseAt: string | null; createdAt: string; contact: { id: string; fullName: string; company: string | null }; owner: { id: string; fullName: string } | null }
const money = (n: number, c = "ILS") => new Intl.NumberFormat("he-IL", { style: "currency", currency: c, maximumFractionDigits: 0 }).format(n);

export default function DealsPage() {
  const me = useMe();
  const [data, setData] = useState<{ items: Deal[]; total: number; byStage: Record<string, { count: number; amount: number }> } | null>(null);
  const [filter, setFilter] = useState({ status: "", stage: "", q: "", ownerUserId: "" });
  const [page, setPage] = useState(1);
  const [users, setUsers] = useState<Array<{ id: string; fullName: string }>>([]);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [hits, setHits] = useState<Array<{ id: string; fullName: string; phoneE164: string }>>([]);
  const [form, setForm] = useState({ contactId: "", contactName: "", title: "", amount: "", stage: "new", expectedCloseAt: "" });

  const load = useCallback(() => api.get<typeof data>(`/api/deals${qs({ ...filter, page, limit: 30 })}`).then(setData).catch((e) => toast.error(e.message)), [filter, page]);
  useEffect(() => { const t = setTimeout(load, 200); return () => clearTimeout(t); }, [load]);
  useEffect(() => { api.get<{ items: Array<{ id: string; fullName: string }> }>("/api/users").then((r) => setUsers(r.items)).catch(() => undefined); }, []);
  useEffect(() => {
    if (!open || search.trim().length < 2) { setHits([]); return; }
    const t = setTimeout(() => api.get<{ items: typeof hits }>(`/api/contacts${qs({ q: search, limit: 8 })}`).then((r) => setHits(r.items)).catch(() => undefined), 250);
    return () => clearTimeout(t);
  }, [search, open]);

  async function setStage(id: string, stage: string) { try { await api.patch(`/api/deals/${id}`, { stage }); load(); } catch (e) { toast.error((e as Error).message); } }
  async function create() { try { await api.post("/api/deals", { contactId: form.contactId, title: form.title, amount: Number(form.amount || 0), stage: form.stage, expectedCloseAt: form.expectedCloseAt ? new Date(form.expectedCloseAt).toISOString() : undefined }); setOpen(false); setForm({ contactId: "", contactName: "", title: "", amount: "", stage: "new", expectedCloseAt: "" }); toast.success("העסקה נוצרה"); load(); } catch (e) { toast.error((e as Error).message); } }
  const isManager = me?.user.role !== "agent";
  return (
    <div className="p-5 space-y-4">
      <div className="flex flex-wrap items-center gap-3"><h1 className="text-lg font-semibold">עסקאות</h1><span className="text-xs text-muted tabular">{data?.total ?? 0} רשומות</span><Button size="sm" className="ms-auto" onClick={() => setOpen(true)}>+ עסקה</Button></div>
      {data && <div className="grid grid-cols-3 md:grid-cols-5 gap-2">{DEAL_STAGES.map((s) => <button key={s} onClick={() => { setPage(1); setFilter({ ...filter, stage: filter.stage === s ? "" : s }); }} className={filter.stage === s ? "ring-2 ring-accent rounded-lg text-start" : "text-start"}><Stat label={DEAL_STAGE_LABEL[s]} value={data.byStage[s]?.count ?? 0} sub={money(data.byStage[s]?.amount ?? 0)} tone={s === "won" ? "good" : s === "lost" ? "bad" : undefined} /></button>)}</div>}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        <Input placeholder="חיפוש" value={filter.q} onChange={(e) => { setPage(1); setFilter({ ...filter, q: e.target.value }); }} className="md:col-span-2" />
        <Select value={filter.status} onChange={(e) => { setPage(1); setFilter({ ...filter, status: e.target.value }); }}><option value="">כל הסטטוסים</option><option value="open">פתוחות</option><option value="won">נסגרו</option><option value="lost">אבודות</option></Select>
        {isManager && <Select value={filter.ownerUserId} onChange={(e) => { setPage(1); setFilter({ ...filter, ownerUserId: e.target.value }); }}><option value="">כל הנציגים</option>{users.map((u) => <option key={u.id} value={u.id}>{u.fullName}</option>)}</Select>}
      </div>
      {!data ? <div className="flex justify-center p-10"><Spinner /></div> : data.items.length === 0 ? <EmptyState title="אין עסקאות" hint="צור עסקה מכרטיס לקוח, מליד או כאן" /> : (
        <div className="bg-panel border border-line rounded-xl overflow-hidden">
          <table className="w-full text-sm">
            <thead className="text-xs text-muted bg-white/3"><tr><th className="text-start px-3 h-9 font-medium">עסקה</th><th className="text-start px-3 font-medium">איש קשר</th><th className="text-start px-3 font-medium">סכום</th><th className="text-start px-3 font-medium">שלב</th><th className="text-start px-3 font-medium">נציג</th><th className="text-start px-3 font-medium">סגירה צפויה</th></tr></thead>
            <tbody className="divide-y divide-line">
              {data.items.map((d) => (
                <tr key={d.id} className="hover:bg-white/3">
                  <td className="px-3 h-11"><Link href={`/deals/${d.id}`} className="font-medium hover:underline">{d.title}</Link></td>
                  <td className="px-3"><Link href={`/contacts/${d.contact.id}`} className="hover:underline">{d.contact.fullName}</Link>{d.contact.company && <span className="text-muted text-xs"> · {d.contact.company}</span>}</td>
                  <td className="px-3 tabular">{money(Number(d.amount), d.currency)}</td>
                  <td className="px-3"><Select value={d.stage} onChange={(e) => setStage(d.id, e.target.value)} className="h-8 text-xs w-32">{DEAL_STAGES.map((s) => <option key={s} value={s}>{DEAL_STAGE_LABEL[s]}</option>)}</Select></td>
                  <td className="px-3 text-muted">{d.owner?.fullName ?? "—"}</td>
                  <td className="px-3 text-xs text-muted tabular">{d.expectedCloseAt ? formatDateTime(d.expectedCloseAt) : "—"}{d.status !== "open" && <Badge tone={d.status === "won" ? "good" : "bad"} className="ms-2">{d.status === "won" ? "נסגרה" : "אבודה"}</Badge>}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="flex items-center justify-between px-3 h-10 border-t border-line text-xs text-muted"><span>עמוד {page}</span><div className="flex gap-1"><Button size="sm" variant="ghost" disabled={page <= 1} onClick={() => setPage(page - 1)}>הקודם</Button><Button size="sm" variant="ghost" disabled={page * 30 >= data.total} onClick={() => setPage(page + 1)}>הבא</Button></div></div>
        </div>
      )}
      <Modal open={open} onClose={() => setOpen(false)} title="עסקה חדשה" footer={<><Button variant="ghost" onClick={() => setOpen(false)}>ביטול</Button><Button onClick={create} disabled={!form.contactId || !form.title}>צור</Button></>}>
        <div className="space-y-2">
          {form.contactId ? <div className="flex items-center gap-2 text-sm"><Badge tone="accent">{form.contactName}</Badge><Button size="sm" variant="ghost" onClick={() => setForm({ ...form, contactId: "", contactName: "" })}>שנה</Button></div> : (
            <div><Input label="חיפוש איש קשר" value={search} onChange={(e) => setSearch(e.target.value)} /><ul className="mt-1 divide-y divide-line border border-line rounded-lg max-h-48 overflow-auto">{hits.map((h) => <li key={h.id}><button className="w-full text-start px-3 py-2 text-sm hover:bg-white/5" onClick={() => setForm({ ...form, contactId: h.id, contactName: h.fullName, title: form.title || `עסקה – ${h.fullName}` })}>{h.fullName}</button></li>)}</ul></div>
          )}
          <Input label="כותרת" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
          <Input label="סכום (₪)" type="number" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} ltr />
          <Select label="שלב" value={form.stage} onChange={(e) => setForm({ ...form, stage: e.target.value })}>{DEAL_STAGES.map((s) => <option key={s} value={s}>{DEAL_STAGE_LABEL[s]}</option>)}</Select>
          <Input label="סגירה צפויה" type="date" value={form.expectedCloseAt} onChange={(e) => setForm({ ...form, expectedCloseAt: e.target.value })} ltr />
        </div>
      </Modal>
    </div>
  );
}
