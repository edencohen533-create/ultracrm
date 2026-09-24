"use client";

import Link from "next/link";
import { use, useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/client/api";
import { Badge, Button, Input, Panel, Phone, Select, Spinner, Textarea } from "@/components/ui";
import { formatDateTime, formatPhone } from "@/lib/client/format";
import { LEAD_STATUSES, LEAD_STATUS_LABEL } from "@/lib/crm/labels";
import { useMe } from "@/lib/client/use-me";

interface Lead { id: string; title: string | null; status: string; source: string | null; priority: number; notes: string | null; createdAt: string; closedAt: string | null; dealId: string | null; contact: { id: string; fullName: string; phoneE164: string; email: string | null; company: string | null }; owner: { id: string; fullName: string } | null; tasks: Array<{ id: string; title: string | null; dueAt: string; user: { fullName: string } }>; deals: Array<{ id: string; title: string; stage: string; amount: string; currency: string }> }

export default function LeadPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const me = useMe();
  const [l, setL] = useState<Lead | null>(null);
  const [form, setForm] = useState({ title: "", source: "", notes: "", priority: 0, ownerUserId: "", status: "new" });
  const [users, setUsers] = useState<Array<{ id: string; fullName: string }>>([]);
  const load = useCallback(() => api.get<Lead>(`/api/leads/${id}`).then((r) => { setL(r); setForm({ title: r.title ?? "", source: r.source ?? "", notes: r.notes ?? "", priority: r.priority, ownerUserId: r.owner?.id ?? "", status: r.status }); }).catch((e) => toast.error(e.message)), [id]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { api.get<{ items: Array<{ id: string; fullName: string }> }>("/api/users").then((r) => setUsers(r.items)).catch(() => undefined); }, []);
  async function save() { try { await api.patch(`/api/leads/${id}`, { ...form, ownerUserId: form.ownerUserId || null }); toast.success("נשמר"); load(); } catch (e) { toast.error((e as Error).message); } }
  if (!l) return <div className="flex justify-center p-10"><Spinner /></div>;
  return (
    <div className="p-5 space-y-4 max-w-4xl">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold">{l.title ?? "ליד"}</h1>
        <Badge tone={l.status === "new" ? "info" : l.status === "qualified" ? "good" : "neutral"}>{LEAD_STATUS_LABEL[l.status as keyof typeof LEAD_STATUS_LABEL]}</Badge>
        <Link href="/leads" className="text-xs text-muted hover:text-text ms-auto">כל הלידים</Link>
      </div>
      <div className="grid md:grid-cols-2 gap-4">
        <Panel title="איש קשר">
          <p className="font-medium"><Link href={`/contacts/${l.contact.id}`} className="hover:underline">{l.contact.fullName}</Link></p>
          <Phone value={formatPhone(l.contact.phoneE164)} className="text-muted" />
          {l.contact.email && <p className="ltr text-muted text-xs">{l.contact.email}</p>}
          {l.contact.company && <p className="text-muted text-xs">{l.contact.company}</p>}
          <p className="text-xs text-muted mt-2">נוצר {formatDateTime(l.createdAt)}{l.closedAt ? ` · נסגר ${formatDateTime(l.closedAt)}` : ""}</p>
          {l.deals.length > 0 && <div className="mt-3 border-t border-line pt-2 text-sm">{l.deals.map((d) => <Link key={d.id} href={`/deals/${d.id}`} className="block hover:underline">עסקה: {d.title} · {Number(d.amount).toLocaleString("he-IL")} {d.currency}</Link>)}</div>}
          {l.tasks.length > 0 && <div className="mt-3 border-t border-line pt-2 text-xs"><p className="text-muted mb-1">משימות פתוחות</p>{l.tasks.map((t) => <p key={t.id}>{t.title ?? "משימה"} · {formatDateTime(t.dueAt)} · {t.user.fullName}</p>)}</div>}
        </Panel>
        <Panel title="פרטי הליד" actions={<Button size="sm" onClick={save}>שמור</Button>}>
          <div className="space-y-2">
            <Input label="כותרת" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
            <Select label="סטטוס" value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>{LEAD_STATUSES.map((s) => <option key={s} value={s}>{LEAD_STATUS_LABEL[s]}</option>)}</Select>
            <Input label="מקור" value={form.source} onChange={(e) => setForm({ ...form, source: e.target.value })} />
            <Input label="עדיפות (0–100)" type="number" value={String(form.priority)} onChange={(e) => setForm({ ...form, priority: Number(e.target.value) })} />
            {me?.user.role !== "agent" && <Select label="נציג אחראי" value={form.ownerUserId} onChange={(e) => setForm({ ...form, ownerUserId: e.target.value })}><option value="">ללא</option>{users.map((u) => <option key={u.id} value={u.id}>{u.fullName}</option>)}</Select>}
            <Textarea label="הערות" rows={4} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
          </div>
        </Panel>
      </div>
    </div>
  );
}
