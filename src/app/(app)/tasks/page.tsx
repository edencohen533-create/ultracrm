"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { api, qs } from "@/lib/client/api";
import { useDialer } from "@/components/telephony/DialerProvider";
import { useMe } from "@/lib/client/use-me";
import { Badge, Button, EmptyState, Phone, Select, Spinner, cx } from "@/components/ui";
import { formatDateTime, formatPhone } from "@/lib/client/format";

interface Task { id: string; title: string | null; type: string; dueAt: string; note: string | null; status: string; contact: { id: string; fullName: string; phoneE164: string }; user: { id: string; fullName: string }; listLead: { id: string; listId: string; status: string } | null; lead: { id: string; title: string | null } | null; deal: { id: string; title: string } | null }
const TYPE_LABEL: Record<string, string> = { callback: "חזרה טלפונית", follow_up: "מעקב", todo: "משימה" };

export default function TasksPage() {
  const { dial, state } = useDialer();
  const me = useMe();
  const [items, setItems] = useState<Task[] | null>(null);
  const [assignees, setAssignees] = useState<Array<{ id: string; fullName: string }>>([]);
  const [status, setStatus] = useState("open");
  const [type, setType] = useState("");
  const [userId, setUserId] = useState("");
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async () => {
    try {
      const r = await api.get<{ items: Task[]; now: string; assignees: Array<{ id: string; fullName: string }> }>(`/api/tasks${qs({ status, type, userId, limit: 200 })}`);
      setItems(r.items);
      setAssignees(r.assignees);
      setNow(new Date(r.now).getTime());
    } catch (e) { toast.error((e as Error).message); }
  }, [status, type, userId]);
  useEffect(() => { load(); }, [load, state?.wrapUpCall?.id]);

  async function setTask(id: string, s: "done" | "cancelled" | "open") {
    try { await api.patch(`/api/tasks/${id}`, { status: s }); load(); } catch (e) { toast.error((e as Error).message); }
  }
  const canDial = Boolean(me?.modules.telephony) && Boolean(state) && !state?.activeCall && !state?.wrapUpCall;

  return (
    <div className="p-5 space-y-4 max-w-5xl">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-semibold">משימות</h1>
        <div className="ms-auto flex gap-2">
          {me?.user.role !== "agent" && <Select value={userId} onChange={(e) => setUserId(e.target.value)} className="w-40"><option value="">כל הנציגים</option>{assignees.map((a) => <option key={a.id} value={a.id}>{a.fullName}</option>)}</Select>}
          <Select value={type} onChange={(e) => setType(e.target.value)} className="w-36"><option value="">כל הסוגים</option><option value="callback">חזרות טלפוניות</option><option value="follow_up">מעקבים</option><option value="todo">משימות</option></Select>
          <Select value={status} onChange={(e) => setStatus(e.target.value)} className="w-32"><option value="open">פתוחות</option><option value="done">בוצעו</option><option value="cancelled">בוטלו</option></Select>
        </div>
      </div>
      {!items ? <div className="flex justify-center p-10"><Spinner /></div> : items.length === 0 ? <EmptyState title="אין משימות" hint="משימות נוצרות מכרטיס לקוח, מתוצאות שיחה, מלידים חדשים ומהתיבה" /> : (
        <ul className="space-y-2">
          {items.map((t) => {
            const overdue = t.status === "open" && new Date(t.dueAt).getTime() < now;
            const soon = t.status === "open" && !overdue && new Date(t.dueAt).getTime() - now < 3600_000;
            return (
              <li key={t.id} className={cx("bg-panel border rounded-xl p-3 flex flex-wrap items-center gap-3", overdue ? "border-bad/40" : soon ? "border-warn/40" : "border-line")}>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <Link href={`/contacts/${t.contact.id}`} className="font-medium hover:underline">{t.contact.fullName}</Link>
                    <Phone value={formatPhone(t.contact.phoneE164)} className="text-muted text-xs" />
                    <Badge tone="neutral">{TYPE_LABEL[t.type] ?? t.type}</Badge>
                    {overdue && <Badge tone="bad">באיחור</Badge>}
                    {soon && <Badge tone="warn">בקרוב</Badge>}
                  </div>
                  <p className="text-sm mt-0.5">{t.title ?? ""}{t.note ? <span className="text-muted"> · {t.note}</span> : null}</p>
                  <p className="text-xs text-muted mt-0.5 tabular">{formatDateTime(t.dueAt)} · {t.user.fullName}{t.lead ? ` · ליד ${t.lead.title ?? ""}` : ""}{t.deal ? ` · עסקה ${t.deal.title}` : ""}</p>
                </div>
                {t.status === "open" ? (
                  <div className="flex gap-2">
                    {me?.modules.telephony && <Button size="sm" variant="good" disabled={!canDial} onClick={() => dial({ mode: "manual", contactId: t.contact.id })}>חייג</Button>}
                    <Button size="sm" variant="secondary" onClick={() => setTask(t.id, "done")}>בוצע</Button>
                    <Button size="sm" variant="ghost" onClick={() => setTask(t.id, "cancelled")}>בטל</Button>
                  </div>
                ) : <Button size="sm" variant="ghost" onClick={() => setTask(t.id, "open")}>פתח מחדש</Button>}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
