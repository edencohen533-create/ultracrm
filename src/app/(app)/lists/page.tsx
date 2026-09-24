"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/client/api";
import { Badge, Button, EmptyState, Input, Modal, Select, Spinner, Textarea } from "@/components/ui";

interface ListRow {
  id: string; name: string; description: string | null; isActive: boolean; priority: number; maxAttempts: number | null; retryIntervalMinutes: number | null;
  agents: Array<{ user: { id: string; fullName: string } }>;
  script: { id: string; title: string } | null;
  stats: { byStatus: Record<string, number>; dueNow: number; total: number };
}

export default function ListsPage() {
  const [lists, setLists] = useState<ListRow[] | null>(null);
  const [open, setOpen] = useState(false);
  const [users, setUsers] = useState<Array<{ id: string; fullName: string; role: string }>>([]);
  const [scripts, setScripts] = useState<Array<{ id: string; title: string }>>([]);
  const [me, setMe] = useState<{ role: string } | null>(null);
  const [form, setForm] = useState({ name: "", description: "", priority: 0, maxAttempts: "", retryIntervalMinutes: "", scriptId: "", phoneNumberId: "", isDynamic: false, agentIds: [] as string[], start: "09:00", end: "20:00", days: [0, 1, 2, 3, 4], filterSource: "", filterNeverCalled: false });
  const [numbers, setNumbers] = useState<Array<{ id: string; e164: string; label: string | null }>>([]);

  const load = useCallback(async () => {
    try {
      setLists(await api.get<ListRow[]>("/api/lists"));
    } catch (e) {
      toast.error((e as Error).message);
    }
  }, []);
  useEffect(() => {
    load();
    api.get<{ user: { role: string } }>("/api/auth/me").then((m) => setMe(m.user)).catch(() => undefined);
    api.get<{ items: Array<{ id: string; fullName: string; role: string }> }>("/api/users").then((u) => setUsers(u.items)).catch(() => undefined);
    api.get<Array<{ id: string; title: string }>>("/api/scripts").then(setScripts).catch(() => undefined);
    api.get<typeof numbers>("/api/phone-numbers").then(setNumbers).catch(() => undefined);
  }, [load]);

  async function create() {
    try {
      const r = await api.post<{ added: number }>("/api/lists", {
        name: form.name, description: form.description || undefined, priority: form.priority,
        maxAttempts: form.maxAttempts ? Number(form.maxAttempts) : null, retryIntervalMinutes: form.retryIntervalMinutes ? Number(form.retryIntervalMinutes) : null,
        dialWindow: { start: form.start, end: form.end, days: form.days }, scriptId: form.scriptId || null, phoneNumberId: form.phoneNumberId || null, isDynamic: form.isDynamic, agentIds: form.agentIds,
        filter: form.filterSource || form.filterNeverCalled ? { source: form.filterSource || undefined, neverCalled: form.filterNeverCalled ? "true" : undefined } : undefined,
      });
      toast.success(`הרשימה נוצרה${r.added ? ` עם ${r.added} לידים` : ""}`);
      setOpen(false);
      load();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  const isManager = me?.role !== "agent";
  const dayNames = ["א", "ב", "ג", "ד", "ה", "ו", "ש"];

  return (
    <div className="p-5 space-y-4">
      <div className="flex items-center gap-3">
        <h1 className="text-lg font-semibold">רשימות חיוג</h1>
        {isManager && <Button size="sm" className="ms-auto" onClick={() => setOpen(true)}>+ רשימה חדשה</Button>}
      </div>
      {!lists ? <div className="flex justify-center p-10"><Spinner /></div> : lists.length === 0 ? <EmptyState title="אין רשימות" hint="צור רשימה מסינון אנשי קשר או ידנית" /> : (
        <div className="grid md:grid-cols-2 xl:grid-cols-3 gap-3">
          {lists.map((l) => (
            <Link key={l.id} href={`/lists/${l.id}`} className="bg-panel border border-line rounded-xl p-4 hover:border-accent/50 transition-colors block">
              <div className="flex items-center justify-between gap-2">
                <h2 className="font-semibold truncate">{l.name}</h2>
                <Badge tone={l.isActive ? "good" : "neutral"}>{l.isActive ? "פעילה" : "לא פעילה"}</Badge>
              </div>
              {l.description && <p className="text-xs text-muted mt-1 line-clamp-2">{l.description}</p>}
              <div className="grid grid-cols-4 gap-2 mt-3 text-center">
                {[["בתור", l.stats.dueNow], ["ממתינים", l.stats.byStatus.pending ?? 0], ["הושלמו", l.stats.byStatus.completed ?? 0], ["סה״כ", l.stats.total]].map(([k, v]) => (
                  <div key={k as string} className="bg-white/4 rounded-md py-1.5"><p className="text-base font-semibold tabular">{v as number}</p><p className="text-[10px] text-muted">{k as string}</p></div>
                ))}
              </div>
              <p className="text-[11px] text-muted mt-3 truncate">נציגים: {l.agents.length ? l.agents.map((a) => a.user.fullName).join(", ") : "כולם"} · עדיפות {l.priority}</p>
            </Link>
          ))}
        </div>
      )}

      <Modal open={open} onClose={() => setOpen(false)} title="רשימת חיוג חדשה" width="max-w-2xl" footer={<><Button variant="ghost" onClick={() => setOpen(false)}>ביטול</Button><Button onClick={create} disabled={!form.name.trim()}>צור</Button></>}>
        <div className="grid grid-cols-2 gap-3">
          <Input label="שם" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="col-span-2" />
          <Textarea label="תיאור" rows={2} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} className="col-span-2" />
          <Input label="עדיפות (0–100)" type="number" value={form.priority} onChange={(e) => setForm({ ...form, priority: Number(e.target.value) })} />
          <Select label="תסריט" value={form.scriptId} onChange={(e) => setForm({ ...form, scriptId: e.target.value })}>
            <option value="">ברירת מחדל של העסק</option>
            {scripts.map((s) => <option key={s.id} value={s.id}>{s.title}</option>)}
          </Select>
          <Select label="מספר יוצא לרשימה" value={form.phoneNumberId} onChange={(e) => setForm({ ...form, phoneNumberId: e.target.value })}>
            <option value="">ברירת מחדל של העסק</option>
            {numbers.map((n) => <option key={n.id} value={n.id}>{n.e164} {n.label ? `· ${n.label}` : ""}</option>)}
          </Select>
          <Input label="מקס׳ ניסיונות (ריק = הגדרת עסק)" type="number" value={form.maxAttempts} onChange={(e) => setForm({ ...form, maxAttempts: e.target.value })} />
          <Input label="מרווח בין ניסיונות (דקות)" type="number" value={form.retryIntervalMinutes} onChange={(e) => setForm({ ...form, retryIntervalMinutes: e.target.value })} />
          <div className="col-span-2">
            <span className="block text-xs text-muted mb-1">חלון חיוג (שעון ישראל)</span>
            <div className="flex flex-wrap items-center gap-2">
              <input type="time" value={form.start} onChange={(e) => setForm({ ...form, start: e.target.value })} className="h-9 px-2 rounded-md bg-bg border border-line ltr" />
              <span className="text-muted">עד</span>
              <input type="time" value={form.end} onChange={(e) => setForm({ ...form, end: e.target.value })} className="h-9 px-2 rounded-md bg-bg border border-line ltr" />
              <div className="flex gap-1 ms-2">
                {dayNames.map((d, i) => (
                  <button key={i} type="button" onClick={() => setForm({ ...form, days: form.days.includes(i) ? form.days.filter((x) => x !== i) : [...form.days, i] })} className={`w-8 h-8 rounded-md text-xs ${form.days.includes(i) ? "bg-accent text-white" : "bg-white/6 text-muted"}`}>{d}</button>
                ))}
              </div>
            </div>
          </div>
          <div className="col-span-2">
            <span className="block text-xs text-muted mb-1">שיוך נציגים (ריק = כולם)</span>
            <div className="flex flex-wrap gap-1.5">
              {users.filter((u) => u.role === "agent" || u.role === "manager").map((u) => (
                <button key={u.id} type="button" onClick={() => setForm({ ...form, agentIds: form.agentIds.includes(u.id) ? form.agentIds.filter((x) => x !== u.id) : [...form.agentIds, u.id] })} className={`h-8 px-3 rounded-md text-xs ${form.agentIds.includes(u.id) ? "bg-accent text-white" : "bg-white/6 text-muted"}`}>{u.fullName}</button>
              ))}
            </div>
          </div>
          <div className="col-span-2 border-t border-line pt-3">
            <span className="block text-xs text-muted mb-1">מילוי ראשוני מ-CRM (אופציונלי)</span>
            <div className="flex gap-2 items-center">
              <Input placeholder="מקור (למשל facebook)" value={form.filterSource} onChange={(e) => setForm({ ...form, filterSource: e.target.value })} />
              <label className="flex items-center gap-2 text-xs whitespace-nowrap"><input type="checkbox" checked={form.filterNeverCalled} onChange={(e) => setForm({ ...form, filterNeverCalled: e.target.checked })} /> רק שטרם חויגו</label>
            </div>
            <label className="flex items-center gap-2 text-xs mt-2"><input type="checkbox" checked={form.isDynamic} onChange={(e) => setForm({ ...form, isDynamic: e.target.checked })} /> רשימה דינמית – ניתן לרענן ולהוסיף אנשי קשר חדשים שעונים לסינון (מוקפאת = חברות קבועה)</label>
          </div>
        </div>
      </Modal>
    </div>
  );
}
