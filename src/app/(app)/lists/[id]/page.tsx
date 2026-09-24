"use client";

import { use, useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { api, qs } from "@/lib/client/api";
import { Badge, Button, Input, Modal, Phone, Select, Spinner, Stat } from "@/components/ui";
import { LEAD_STATUS_LABEL, formatDateTime, formatPhone } from "@/lib/client/format";
import { OUTCOMES } from "@/lib/outcomes";

interface ListFull { id: string; name: string; description: string | null; isActive: boolean; isPaused: boolean; isDynamic: boolean; archivedAt: string | null; lastRefreshedAt: string | null; priority: number; maxAttempts: number | null; retryIntervalMinutes: number | null; dialWindowJson: { start: string; end: string; days: number[] } | null; agents: Array<{ user: { id: string; fullName: string } }>; stats: { byStatus: Record<string, number>; dueNow: number; total: number; unavailable: { notDueYet: number; inProgress: number; exhausted: number; completed: number; dnc: number; removed: number; outsideDialWindow: boolean; listPaused: boolean; listInactive: boolean } } }
interface LeadRow { id: string; status: string; attempts: number; priority: number; lastAttemptAt: string | null; nextAttemptAt: string | null; lastOutcome: string | null; lastSkipReason: string | null; contact: { id: string; fullName: string; phoneE164: string; source: string | null }; lockedBy: { fullName: string } | null }

export default function ListPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [list, setList] = useState<ListFull | null>(null);
  const [rows, setRows] = useState<LeadRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState("");
  const [q, setQ] = useState("");
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [me, setMe] = useState<{ role: string } | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [addFilter, setAddFilter] = useState({ source: "", city: "", neverCalled: false });
  const [users, setUsers] = useState<Array<{ id: string; fullName: string; role: string }>>([]);
  const [agentsOpen, setAgentsOpen] = useState(false);
  const [agentIds, setAgentIds] = useState<string[]>([]);

  const load = useCallback(async () => {
    try {
      const [l, r] = await Promise.all([api.get<ListFull>(`/api/lists/${id}`), api.get<{ items: LeadRow[]; total: number }>(`/api/lists/${id}/leads${qs({ status, q, page, limit: 50 })}`)]);
      setList(l);
      setRows(r.items);
      setTotal(r.total);
      setAgentIds(l.agents.map((a) => a.user.id));
    } catch (e) {
      toast.error((e as Error).message);
    }
  }, [id, status, q, page]);
  useEffect(() => { const t = setTimeout(load, 200); return () => clearTimeout(t); }, [load]);
  useEffect(() => {
    api.get<{ user: { role: string } }>("/api/auth/me").then((m) => setMe(m.user)).catch(() => undefined);
    api.get<{ items: typeof users }>("/api/users").then((u) => setUsers(u.items)).catch(() => undefined);
  }, []);

  const isManager = me?.role !== "agent";
  async function bulk(action: "remove" | "requeue") {
    if (sel.size === 0) return;
    try {
      await api.patch(`/api/lists/${id}/leads`, { leadIds: [...sel], action });
      setSel(new Set());
      load();
    } catch (e) { toast.error((e as Error).message); }
  }
  async function toggleActive() {
    if (!list) return;
    try { await api.patch(`/api/lists/${id}`, { isActive: !list.isActive }); load(); } catch (e) { toast.error((e as Error).message); }
  }
  async function addFromFilter() {
    try {
      const r = await api.post<{ added: number }>(`/api/lists/${id}/leads`, { filter: { source: addFilter.source || undefined, city: addFilter.city || undefined, neverCalled: addFilter.neverCalled ? "true" : undefined, notInListId: id } });
      toast.success(`נוספו ${r.added} לידים`);
      setAddOpen(false);
      load();
    } catch (e) { toast.error((e as Error).message); }
  }
  async function patchList(body: object, msg: string) { try { await api.patch(`/api/lists/${id}`, body); toast.success(msg); load(); } catch (e) { toast.error((e as Error).message); } }
  async function duplicate() { try { const r = await api.post<{ id: string; copied: number }>(`/api/lists/${id}/duplicate`, { withLeads: true }); toast.success(`שוכפל עם ${r.copied} לידים`); window.location.href = `/lists/${r.id}`; } catch (e) { toast.error((e as Error).message); } }
  async function refresh() { try { const r = await api.post<{ added: number }>(`/api/lists/${id}/refresh`); toast.success(`רוענן: נוספו ${r.added}`); load(); } catch (e) { toast.error((e as Error).message); } }
  async function transfer(leadId: string) {
    const toUserId = window.prompt("מזהה/שם נציג יעד (ריק = חזרה למאגר):\n" + users.filter((u) => u.role !== "admin").map((u) => `${u.fullName} = ${u.id}`).join("\n"));
    if (toUserId === null) return;
    const match = users.find((u) => u.id === toUserId.trim() || u.fullName === toUserId.trim());
    try { await api.post(`/api/leads/${leadId}/transfer`, { toUserId: toUserId.trim() ? match?.id ?? toUserId.trim() : null }); toast.success("הליד הועבר"); load(); } catch (e) { toast.error((e as Error).message); }
  }
  async function saveAgents() {
    try { await api.put(`/api/lists/${id}/agents`, { agentIds }); setAgentsOpen(false); load(); } catch (e) { toast.error((e as Error).message); }
  }

  if (!list) return <div className="flex justify-center p-10"><Spinner /></div>;
  const s = list.stats;

  return (
    <div className="p-5 space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-semibold">{list.name}</h1>
        <Badge tone={list.isActive ? "good" : "neutral"}>{list.isActive ? "פעילה" : "לא פעילה"}</Badge>
        {list.dialWindowJson && <span className="text-xs text-muted ltr">{list.dialWindowJson.start}–{list.dialWindowJson.end}</span>}
        {list.isPaused && <Badge tone="bad">מושהית</Badge>}
        {list.archivedAt && <Badge tone="neutral">בארכיון</Badge>}
        <Badge tone="neutral">{list.isDynamic ? "דינמית" : "מוקפאת"}</Badge>
        {isManager && (
          <div className="ms-auto flex flex-wrap gap-2">
            {list.isDynamic && <Button size="sm" variant="secondary" onClick={refresh}>רענן מהסינון</Button>}
            <Button size="sm" variant="secondary" onClick={duplicate}>שכפל</Button>
            <Button size="sm" variant="secondary" onClick={() => patchList({ isPaused: !list.isPaused }, list.isPaused ? "החיוג ברשימה חודש" : "החיוג ברשימה הושהה")}>{list.isPaused ? "חדש חיוג" : "השהה חיוג"}</Button>
            <Button size="sm" variant="secondary" onClick={() => patchList({ archived: !list.archivedAt }, list.archivedAt ? "הוצא מארכיון" : "הועבר לארכיון")}>{list.archivedAt ? "הוצא מארכיון" : "ארכב"}</Button>
            <Button size="sm" variant="secondary" onClick={() => setAgentsOpen(true)}>שיוך נציגים ({list.agents.length || "כולם"})</Button>
            <Button size="sm" variant="secondary" onClick={() => setAddOpen(true)}>+ הוסף לידים מסינון</Button>
            <Button size="sm" variant={list.isActive ? "danger" : "good"} onClick={toggleActive}>{list.isActive ? "השבת רשימה" : "הפעל רשימה"}</Button>
          </div>
        )}
      </div>
      <p className="text-xs text-muted">
        לא זמינים עכשיו: ממתינים לניסיון חוזר/חלון <b className="text-text tabular">{s.unavailable.notDueYet}</b> · בטיפול <b className="text-text tabular">{s.unavailable.inProgress}</b> · מוצו <b className="text-text tabular">{s.unavailable.exhausted}</b> · הושלמו <b className="text-text tabular">{s.unavailable.completed}</b> · DNC <b className="text-text tabular">{s.unavailable.dnc}</b> · הוסרו <b className="text-text tabular">{s.unavailable.removed}</b>
        {s.unavailable.outsideDialWindow && <Badge tone="warn" className="ms-2">מחוץ לחלון החיוג</Badge>}
        {s.unavailable.listPaused && <Badge tone="bad" className="ms-2">הרשימה מושהית</Badge>}
      </p>
      <div className="grid grid-cols-3 md:grid-cols-6 gap-2">
        <Stat label="בתור עכשיו" value={s.dueNow} tone="good" />
        <Stat label="ממתינים" value={s.byStatus.pending ?? 0} />
        <Stat label="חזרות" value={s.byStatus.callback ?? 0} tone="warn" />
        <Stat label="הושלמו" value={s.byStatus.completed ?? 0} />
        <Stat label="מוצו" value={s.byStatus.exhausted ?? 0} />
        <Stat label="DNC / הוסרו" value={(s.byStatus.dnc ?? 0) + (s.byStatus.removed ?? 0)} tone="bad" />
      </div>

      <div className="flex flex-wrap gap-2 items-center">
        <Input placeholder="חיפוש" value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} className="w-56" />
        <Select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }} className="w-44">
          <option value="">כל הסטטוסים</option>
          {Object.entries(LEAD_STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </Select>
        {isManager && sel.size > 0 && (
          <div className="flex gap-2 ms-auto">
            <span className="text-xs text-muted self-center">{sel.size} נבחרו</span>
            <Button size="sm" variant="secondary" onClick={() => bulk("requeue")}>החזר לתור</Button>
            <Button size="sm" variant="danger" onClick={() => bulk("remove")}>הסר</Button>
          </div>
        )}
      </div>

      <div className="bg-panel border border-line rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead className="text-xs text-muted bg-white/3">
            <tr>
              {isManager && <th className="px-3 w-8"><input type="checkbox" checked={sel.size === rows.length && rows.length > 0} onChange={(e) => setSel(e.target.checked ? new Set(rows.map((r) => r.id)) : new Set())} /></th>}
              <th className="text-start px-3 h-9 font-medium">שם</th><th className="text-start px-3 font-medium">טלפון</th><th className="text-start px-3 font-medium">מקור</th><th className="text-start px-3 font-medium">סטטוס</th><th className="text-start px-3 font-medium">ניסיונות</th><th className="text-start px-3 font-medium">תוצאה אחרונה</th><th className="text-start px-3 font-medium">ניסיון אחרון</th><th className="text-start px-3 font-medium">ניסיון הבא</th>{isManager && <th></th>}
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {rows.map((r) => (
              <tr key={r.id} className="hover:bg-white/3">
                {isManager && <td className="px-3"><input type="checkbox" checked={sel.has(r.id)} onChange={(e) => { const n = new Set(sel); if (e.target.checked) n.add(r.id); else n.delete(r.id); setSel(n); }} /></td>}
                <td className="px-3 h-10"><a href={`/contacts/${r.contact.id}`} className="hover:underline">{r.contact.fullName}</a></td>
                <td className="px-3"><Phone value={formatPhone(r.contact.phoneE164)} /></td>
                <td className="px-3 text-muted">{r.contact.source ?? "—"}</td>
                <td className="px-3"><Badge tone={r.status === "in_call" ? "good" : r.status === "dnc" || r.status === "exhausted" ? "bad" : r.status === "callback" ? "warn" : "neutral"}>{LEAD_STATUS_LABEL[r.status]}</Badge>{r.lockedBy && <span className="text-[11px] text-muted ms-1">{r.lockedBy.fullName}</span>}</td>
                <td className="px-3 tabular">{r.attempts}</td>
                <td className="px-3 text-muted">{OUTCOMES.find((o) => o.key === r.lastOutcome)?.label ?? (r.lastSkipReason ? `דילוג: ${r.lastSkipReason}` : "—")}</td>
                <td className="px-3 text-muted text-xs tabular">{formatDateTime(r.lastAttemptAt)}</td>
                <td className="px-3 text-muted text-xs tabular">{formatDateTime(r.nextAttemptAt)}</td>
                {isManager && <td className="px-3 text-end">{r.status !== "in_call" && <button onClick={() => transfer(r.id)} className="text-xs text-[#aab3ff] hover:underline">העבר</button>}</td>}
              </tr>
            ))}
          </tbody>
        </table>
        <div className="flex items-center justify-between px-3 h-10 border-t border-line text-xs text-muted">
          <span className="tabular">{total} לידים</span>
          <div className="flex gap-2"><button disabled={page <= 1} onClick={() => setPage((p) => p - 1)} className="disabled:opacity-30">‹ הקודם</button><button disabled={page * 50 >= total} onClick={() => setPage((p) => p + 1)} className="disabled:opacity-30">הבא ›</button></div>
        </div>
      </div>

      <Modal open={addOpen} onClose={() => setAddOpen(false)} title="הוספת לידים מסינון CRM" footer={<><Button variant="ghost" onClick={() => setAddOpen(false)}>ביטול</Button><Button onClick={addFromFilter}>הוסף</Button></>}>
        <div className="space-y-2">
          <Input label="מקור" value={addFilter.source} onChange={(e) => setAddFilter({ ...addFilter, source: e.target.value })} />
          <Input label="עיר" value={addFilter.city} onChange={(e) => setAddFilter({ ...addFilter, city: e.target.value })} />
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={addFilter.neverCalled} onChange={(e) => setAddFilter({ ...addFilter, neverCalled: e.target.checked })} /> רק אנשי קשר שטרם חויגו</label>
          <p className="text-xs text-muted">אנשי קשר שכבר ברשימה, ומספרים חסומים, לא יתווספו.</p>
        </div>
      </Modal>
      <Modal open={agentsOpen} onClose={() => setAgentsOpen(false)} title="שיוך נציגים לרשימה" footer={<><Button variant="ghost" onClick={() => setAgentsOpen(false)}>ביטול</Button><Button onClick={saveAgents}>שמור</Button></>}>
        <div className="flex flex-wrap gap-1.5">
          {users.filter((u) => u.role !== "admin").map((u) => (
            <button key={u.id} type="button" onClick={() => setAgentIds(agentIds.includes(u.id) ? agentIds.filter((x) => x !== u.id) : [...agentIds, u.id])} className={`h-8 px-3 rounded-md text-xs ${agentIds.includes(u.id) ? "bg-accent text-white" : "bg-white/6 text-muted"}`}>{u.fullName}</button>
          ))}
        </div>
        <p className="text-xs text-muted mt-2">ללא שיוך – כל הנציגים יכולים לעבוד על הרשימה.</p>
      </Modal>
    </div>
  );
}
