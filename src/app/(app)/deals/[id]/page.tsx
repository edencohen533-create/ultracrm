"use client";

import Link from "next/link";
import { use, useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/client/api";
import { Badge, Button, Input, Panel, Phone, Select, Spinner, Textarea } from "@/components/ui";
import { formatDateTime, formatPhone } from "@/lib/client/format";
import { DEAL_STAGES, DEAL_STAGE_LABEL } from "@/lib/crm/labels";
import { useMe } from "@/lib/client/use-me";

interface Deal { id: string; title: string; stage: string; status: string; amount: string; currency: string; expectedCloseAt: string | null; closedAt: string | null; notes: string | null; createdAt: string; contact: { id: string; fullName: string; phoneE164: string; company: string | null }; owner: { id: string; fullName: string } | null; lead: { id: string; status: string; title: string | null } | null; tasks: Array<{ id: string; title: string | null; dueAt: string; user: { fullName: string } }> }

export default function DealPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const me = useMe();
  const [d, setD] = useState<Deal | null>(null);
  const [form, setForm] = useState({ title: "", amount: "", stage: "new", ownerUserId: "", expectedCloseAt: "", notes: "" });
  const [users, setUsers] = useState<Array<{ id: string; fullName: string }>>([]);
  const load = useCallback(() => api.get<Deal>(`/api/deals/${id}`).then((r) => { setD(r); setForm({ title: r.title, amount: String(r.amount), stage: r.stage, ownerUserId: r.owner?.id ?? "", expectedCloseAt: r.expectedCloseAt ? r.expectedCloseAt.slice(0, 10) : "", notes: r.notes ?? "" }); }).catch((e) => toast.error(e.message)), [id]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { api.get<{ items: Array<{ id: string; fullName: string }> }>("/api/users").then((r) => setUsers(r.items)).catch(() => undefined); }, []);
  async function save() { try { await api.patch(`/api/deals/${id}`, { title: form.title, amount: Number(form.amount || 0), stage: form.stage, ownerUserId: form.ownerUserId || null, expectedCloseAt: form.expectedCloseAt ? new Date(form.expectedCloseAt).toISOString() : null, notes: form.notes }); toast.success("נשמר"); load(); } catch (e) { toast.error((e as Error).message); } }
  if (!d) return <div className="flex justify-center p-10"><Spinner /></div>;
  return (
    <div className="p-5 space-y-4 max-w-4xl">
      <div className="flex flex-wrap items-center gap-3"><h1 className="text-xl font-semibold">{d.title}</h1><Badge tone={d.stage === "won" ? "good" : d.stage === "lost" ? "bad" : "neutral"}>{DEAL_STAGE_LABEL[d.stage as keyof typeof DEAL_STAGE_LABEL]}</Badge><Link href="/deals" className="text-xs text-muted hover:text-text ms-auto">כל העסקאות</Link></div>
      <div className="grid md:grid-cols-2 gap-4">
        <Panel title="איש קשר">
          <p className="font-medium"><Link href={`/contacts/${d.contact.id}`} className="hover:underline">{d.contact.fullName}</Link></p>
          <Phone value={formatPhone(d.contact.phoneE164)} className="text-muted" />
          {d.contact.company && <p className="text-muted text-xs">{d.contact.company}</p>}
          {d.lead && <p className="text-xs mt-2">מקור: <Link href={`/leads/${d.lead.id}`} className="hover:underline">ליד {d.lead.title ?? ""}</Link></p>}
          <p className="text-xs text-muted mt-2">נוצרה {formatDateTime(d.createdAt)}{d.closedAt ? ` · נסגרה ${formatDateTime(d.closedAt)}` : ""}</p>
          {d.tasks.length > 0 && <div className="mt-3 border-t border-line pt-2 text-xs"><p className="text-muted mb-1">משימות פתוחות</p>{d.tasks.map((t) => <p key={t.id}>{t.title ?? "משימה"} · {formatDateTime(t.dueAt)} · {t.user.fullName}</p>)}</div>}
        </Panel>
        <Panel title="פרטי העסקה" actions={<Button size="sm" onClick={save}>שמור</Button>}>
          <div className="space-y-2">
            <Input label="כותרת" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
            <Input label={`סכום (${d.currency})`} type="number" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} ltr />
            <Select label="שלב" value={form.stage} onChange={(e) => setForm({ ...form, stage: e.target.value })}>{DEAL_STAGES.map((s) => <option key={s} value={s}>{DEAL_STAGE_LABEL[s]}</option>)}</Select>
            {me?.user.role !== "agent" && <Select label="נציג" value={form.ownerUserId} onChange={(e) => setForm({ ...form, ownerUserId: e.target.value })}><option value="">ללא</option>{users.map((u) => <option key={u.id} value={u.id}>{u.fullName}</option>)}</Select>}
            <Input label="סגירה צפויה" type="date" value={form.expectedCloseAt} onChange={(e) => setForm({ ...form, expectedCloseAt: e.target.value })} ltr />
            <Textarea label="הערות" rows={4} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
          </div>
        </Panel>
      </div>
    </div>
  );
}
