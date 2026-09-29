"use client";

import Link from "next/link";
import { Suspense, useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { api, qs } from "@/lib/client/api";
import { useDialer } from "@/components/telephony/DialerProvider";
import { useMe } from "@/lib/client/use-me";
import { Badge, Button, EmptyState, Phone, Select, Spinner, cx } from "@/components/ui";
import { formatDateTime, formatPhone } from "@/lib/client/format";
import { useT } from "@/components/i18n/LangProvider";

interface Task { id: string; title: string | null; type: string; dueAt: string; note: string | null; status: string; contact: { id: string; fullName: string; phoneE164: string }; user: { id: string; fullName: string }; listLead: { id: string; listId: string; status: string } | null; lead: { id: string; title: string | null } | null; deal: { id: string; title: string } | null }
const TYPE_LABEL: Record<string, [string, string]> = { callback: ["חזרה טלפונית", "Callback"], follow_up: ["מעקב", "Follow-up"], todo: ["משימה", "Task"] };

/** Tasks & callbacks – lives inside the lead workspace (drawer) since the standalone page was removed. */
export function TasksPanel({ embedded = false }: { embedded?: boolean } = {}) {
  return <Suspense fallback={<div className="flex justify-center p-10"><Spinner /></div>}><TasksView embedded={embedded} /></Suspense>;
}

function TasksView({ embedded }: { embedded: boolean }) {
  const params = useSearchParams();
  const { dial, state } = useDialer();
  const me = useMe();
  const t = useT();
  const [items, setItems] = useState<Task[] | null>(null);
  const [assignees, setAssignees] = useState<Array<{ id: string; fullName: string }>>([]);
  const [status, setStatus] = useState("open");
  const [type, setType] = useState(params.get("type") ?? "");
  const [due, setDue] = useState<"" | "today" | "overdue">((params.get("due") as "today" | "overdue" | null) ?? "");
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
  const canDial = Boolean(me?.modules.telephony) && Boolean(state) && !state?.activeCall;

  return (
    <div className={embedded ? "space-y-3" : "p-5 space-y-4 max-w-5xl"}>
      <div className="flex flex-wrap items-center gap-3">
        {!embedded && <h1 className="text-lg font-semibold">{t("משימות", "Tasks")}</h1>}
        <div className="ms-auto flex gap-2">
          {me?.user.role !== "agent" && <Select value={userId} onChange={(e) => setUserId(e.target.value)} className="w-40"><option value="">{t("כל הנציגים", "All agents")}</option>{assignees.map((a) => <option key={a.id} value={a.id}>{a.fullName}</option>)}</Select>}
          <Select value={due} onChange={(e) => setDue(e.target.value as "" | "today" | "overdue")} className="w-32" aria-label={t("מועד", "Due")}><option value="">{t("כל המועדים", "Any time")}</option><option value="today">{t("עד סוף היום", "By end of day")}</option><option value="overdue">{t("באיחור", "Overdue")}</option></Select>
          <Select value={type} onChange={(e) => setType(e.target.value)} className="w-36"><option value="">{t("כל הסוגים", "All types")}</option><option value="callback">{t("חזרות טלפוניות", "Callbacks")}</option><option value="follow_up">{t("מעקבים", "Follow-ups")}</option><option value="todo">{t("משימות", "Tasks")}</option></Select>
          <Select value={status} onChange={(e) => setStatus(e.target.value)} className="w-32"><option value="open">{t("פתוחות", "Open")}</option><option value="done">{t("בוצעו", "Done")}</option><option value="cancelled">{t("בוטלו", "Cancelled")}</option></Select>
        </div>
      </div>
      {!items ? <div className="flex justify-center p-10"><Spinner /></div> : items.length === 0 ? <EmptyState title={t("אין משימות", "No tasks")} hint={t("משימות נוצרות מכרטיס לקוח, מתוצאות שיחה, מלידים חדשים ומהתיבה", "Tasks are created from customer cards, call outcomes, new leads and the inbox")} /> : (
        <ul className="space-y-2">
          {items.filter((task) => { if (!due) return true; const d = new Date(task.dueAt).getTime(); const end = new Date(now); end.setHours(23, 59, 59, 999); return due === "overdue" ? d < now && task.status === "open" : d <= end.getTime(); }).map((task) => {
            const overdue = task.status === "open" && new Date(task.dueAt).getTime() < now;
            const soon = task.status === "open" && !overdue && new Date(task.dueAt).getTime() - now < 3600_000;
            return (
              <li key={task.id} className={cx("bg-panel border rounded-xl p-3 flex flex-wrap items-center gap-3", overdue ? "border-bad/40" : soon ? "border-warn/40" : "border-line")}>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <Link href={`/contacts/${task.contact.id}`} className="font-medium hover:underline">{task.contact.fullName}</Link>
                    <Phone value={formatPhone(task.contact.phoneE164)} className="text-muted text-xs" />
                    <Badge tone="neutral">{TYPE_LABEL[task.type] ? t(...TYPE_LABEL[task.type]) : task.type}</Badge>
                    {overdue && <Badge tone="bad">{t("באיחור", "Overdue")}</Badge>}
                    {soon && <Badge tone="warn">{t("בקרוב", "Soon")}</Badge>}
                  </div>
                  <p className="text-sm mt-0.5">{task.title ?? ""}{task.note ? <span className="text-muted"> · {task.note}</span> : null}</p>
                  <p className="text-xs text-muted mt-0.5 tabular">{formatDateTime(task.dueAt)} · {task.user.fullName}{task.lead ? ` · ${t("ליד", "Lead")} ${task.lead.title ?? ""}` : ""}{task.deal ? ` · ${t("עסקה", "Deal")} ${task.deal.title}` : ""}</p>
                </div>
                {task.status === "open" ? (
                  <div className="flex gap-2">
                    {me?.modules.telephony && <Button size="sm" variant="good" disabled={!canDial} onClick={() => dial({ mode: "manual", contactId: task.contact.id })}>{t("חייג", "Call")}</Button>}
                    <Button size="sm" variant="secondary" onClick={() => setTask(task.id, "done")}>{t("בוצע", "Done")}</Button>
                    <Button size="sm" variant="ghost" onClick={() => setTask(task.id, "cancelled")}>{t("בטל", "Cancel")}</Button>
                  </div>
                ) : <Button size="sm" variant="ghost" onClick={() => setTask(task.id, "open")}>{t("פתח מחדש", "Reopen")}</Button>}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
