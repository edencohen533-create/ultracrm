"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { api, qs } from "@/lib/client/api";
import { useDialer } from "@/components/telephony/DialerProvider";
import { Badge, Button, EmptyState, Phone, Select, Spinner, cx } from "@/components/ui";
import { formatDateTime, formatPhone } from "@/lib/client/format";

interface Task { id: string; dueAt: string; note: string | null; status: string; contact: { id: string; fullName: string; phoneE164: string }; user: { id: string; fullName: string }; lead: { id: string; listId: string; status: string } | null }

export default function TasksPage() {
  const { dial, state } = useDialer();
  const [items, setItems] = useState<Task[] | null>(null);
  const [status, setStatus] = useState("open");
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async () => {
    try {
      const r = await api.get<{ items: Task[]; now: string }>(`/api/tasks${qs({ status })}`);
      setItems(r.items);
      setNow(new Date(r.now).getTime());
    } catch (e) { toast.error((e as Error).message); }
  }, [status]);
  useEffect(() => { load(); }, [load, state?.wrapUpCall?.id]);

  async function setTask(id: string, s: "done" | "cancelled") {
    try { await api.patch(`/api/tasks/${id}`, { status: s }); load(); } catch (e) { toast.error((e as Error).message); }
  }
  const canDial = !state?.activeCall && !state?.wrapUpCall;

  return (
    <div className="p-5 space-y-4 max-w-5xl">
      <div className="flex items-center gap-3">
        <h1 className="text-lg font-semibold">משימות חזרה</h1>
        <Select value={status} onChange={(e) => setStatus(e.target.value)} className="w-36 ms-auto"><option value="open">פתוחות</option><option value="done">בוצעו</option><option value="cancelled">בוטלו</option></Select>
      </div>
      {!items ? <div className="flex justify-center p-10"><Spinner /></div> : items.length === 0 ? <EmptyState title="אין משימות" hint="משימות נוצרות אוטומטית כשבוחרים 'לחזור בהמשך' בסיום שיחה" /> : (
        <ul className="space-y-2">
          {items.map((t) => {
            const overdue = t.status === "open" && new Date(t.dueAt).getTime() < now;
            const soon = t.status === "open" && !overdue && new Date(t.dueAt).getTime() - now < 3600_000;
            return (
              <li key={t.id} className={cx("bg-panel border rounded-xl p-3 flex flex-wrap items-center gap-3", overdue ? "border-bad/40" : soon ? "border-warn/40" : "border-line")}>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <Link href={`/contacts/${t.contact.id}`} className="font-medium hover:underline">{t.contact.fullName}</Link>
                    <Phone value={formatPhone(t.contact.phoneE164)} className="text-muted text-xs" />
                    {overdue && <Badge tone="bad">באיחור</Badge>}
                    {soon && <Badge tone="warn">בקרוב</Badge>}
                  </div>
                  <p className="text-xs text-muted mt-0.5 tabular">{formatDateTime(t.dueAt)} · {t.user.fullName}{t.note ? ` · ${t.note}` : ""}</p>
                </div>
                {t.status === "open" && (
                  <div className="flex gap-2">
                    <Button size="sm" variant="good" disabled={!canDial} onClick={() => dial({ mode: "manual", contactId: t.contact.id })}>חייג</Button>
                    <Button size="sm" variant="secondary" onClick={() => setTask(t.id, "done")}>בוצע</Button>
                    <Button size="sm" variant="ghost" onClick={() => setTask(t.id, "cancelled")}>בטל</Button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
