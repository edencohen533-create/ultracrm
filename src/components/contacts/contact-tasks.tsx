"use client";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useT } from "@/components/i18n/LangProvider";

/** Follow-up tasks inside a conversation – backed by the unified CRM task API. */
type Task = { id: string; title: string | null; dueAt: string; status: string; version: number; userId: string; user: { fullName: string } };
type Assignee = { id: string; fullName: string };
const labels: Record<string, [string, string]> = { open: ["פתוחה", "Open"], done: ["הושלמה", "Done"], cancelled: ["בוטלה", "Cancelled"] };
function localDate(value: string) { const date = new Date(value); return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16); }

function TaskEditor({ task, assignees, checkedAt, saved }: { task: Task; assignees: Assignee[]; checkedAt: number; saved: () => Promise<void> }) {
  const [title, setTitle] = useState(task.title ?? ""); const [dueAt, setDueAt] = useState(localDate(task.dueAt));
  const [userId, setUserId] = useState(task.userId); const [status, setStatus] = useState(task.status);
  const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const t = useT();
  async function submit(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    try {
      const response = await fetch(`/api/tasks/${task.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title, dueAt: new Date(dueAt).toISOString(), userId, status, version: task.version }) });
      const data = await response.json(); if (!response.ok) { setError(data.error || t("שמירת המשימה נכשלה", "Failed to save the task")); return; }
      await saved();
    } catch { setError(t("לא ניתן לאמת את העדכון. יש לרענן את הרשימה לפני ניסיון נוסף", "Couldn't confirm the update. Refresh the list before trying again")); }
    finally { setBusy(false); }
  }
  return <details className="rounded border p-2">
    <summary className="cursor-pointer break-words text-sm"><span dir="auto">{task.title ?? t("משימה", "Task")}</span> · {labels[task.status] ? t(...labels[task.status]) : undefined} · {new Date(task.dueAt).toLocaleString(t.lang === "en" ? "en-GB" : "he-IL")} · {task.user.fullName}{task.status === "open" && Date.parse(task.dueAt) < checkedAt ? t(" · באיחור", " · Overdue") : ""}</summary>
    <form className="mt-2 grid gap-2" onSubmit={submit}>
      <label className="text-sm">{t("תיאור משימה", "Task description")}<Input aria-label={t(`תיאור משימה ${task.id}`, `Task description ${task.id}`)} dir="auto" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} required /></label>
      <label className="text-sm">{t("מועד יעד", "Due date")}<Input aria-label={t(`מועד משימה ${task.id}`, `Task due date ${task.id}`)} type="datetime-local" dir="ltr" value={dueAt} onChange={(e) => setDueAt(e.target.value)} required /></label>
      <label className="text-sm">{t("נציג", "Agent")}<select className="block w-full rounded border p-2 bg-bg" aria-label={t(`נציג למשימה ${task.id}`, `Task agent ${task.id}`)} value={userId} onChange={(e) => setUserId(e.target.value)}>{!assignees.some((a) => a.id === task.userId) && <option value={task.userId}>{task.user.fullName} {t("(אינו זמין)", "(unavailable)")}</option>}{assignees.map((a) => <option key={a.id} value={a.id}>{a.fullName}</option>)}</select></label>
      <label className="text-sm">{t("סטטוס", "Status")}<select className="block w-full rounded border p-2 bg-bg" aria-label={t(`סטטוס משימה ${task.id}`, `Task status ${task.id}`)} value={status} onChange={(e) => setStatus(e.target.value)}>{Object.entries(labels).map(([id, label]) => <option key={id} value={id}>{t(...label)}</option>)}</select></label>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <Button type="submit" disabled={busy}>{busy ? t("שומר...", "Saving...") : t("שמור משימה", "Save task")}</Button>
    </form>
  </details>;
}

export function Tasks({ contactId, conversationId, userId }: { contactId: string; conversationId?: string; userId: string }) {
  const [loaded, setLoaded] = useState(false); const [loading, setLoading] = useState(false); const [error, setError] = useState("");
  const [tasks, setTasks] = useState<Task[]>([]); const [assignees, setAssignees] = useState<Assignee[]>([]);
  const [checkedAt, setCheckedAt] = useState(0);
  const t = useT();
  const [page, setPage] = useState(1); const [total, setTotal] = useState(0);
  const [title, setTitle] = useState(""); const [dueAt, setDueAt] = useState(""); const [assignee, setAssignee] = useState(userId);
  const [requestKey, setRequestKey] = useState(() => crypto.randomUUID()); const [saving, setSaving] = useState(false);
  async function load(targetPage = page) {
    setLoading(true); setError("");
    try {
      const params = new URLSearchParams({ contactId, page: String(targetPage), limit: "50", status: "all", ...(conversationId ? { conversationId } : {}) });
      const response = await fetch(`/api/tasks?${params}`); const data = await response.json();
      if (!response.ok) { setError(data.error || t("טעינת המשימות נכשלה", "Failed to load tasks")); return; }
      setCheckedAt(Date.now()); setTasks(data.data.items); setAssignees(data.data.assignees); setTotal(data.data.total); setPage(data.data.page); setLoaded(true);
    } catch { setError(t("טעינת המשימות נכשלה. אפשר לנסות שוב", "Failed to load tasks. You can try again")); }
    finally { setLoading(false); }
  }
  async function create(event: React.FormEvent) {
    event.preventDefault(); setSaving(true); setError("");
    try {
      const response = await fetch("/api/tasks", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ contactId, conversationId, title, dueAt: new Date(dueAt).toISOString(), userId: assignee, requestKey, type: "follow_up" }) });
      const data = await response.json(); if (!response.ok) { setError(data.error || t("יצירת המשימה נכשלה", "Failed to create the task")); return; }
      setTitle(""); setDueAt(""); setRequestKey(crypto.randomUUID()); await load(1);
    } catch { setError(t("לא ניתן לאמת את השמירה. אפשר לנסות שוב עם אותם פרטים; הבקשה מוגנת מכפילות", "Couldn't confirm the save. You can retry with the same details; the request is protected against duplicates")); }
    finally { setSaving(false); }
  }
  return <details className="border-b px-3 py-2" onToggle={(event) => { if (event.currentTarget.open && !loaded && !loading) void load(); }}>
    <summary className="cursor-pointer text-sm font-medium">{t("משימות מעקב", "Follow-up tasks")}{loaded ? ` (${total})` : ""}</summary>
    <div className="mt-2 max-h-[55dvh] space-y-3 overflow-y-auto p-1">
      <p className="text-xs text-muted-foreground">{t("משימות פנימיות בלבד; אינן שולחות הודעה ללקוח. מופיעות גם בכרטיס הלקוח ובמסך המשימות.", "Internal tasks only; they don't message the customer. They also appear on the customer card and in the Tasks screen.")}</p>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <Button variant="outline" disabled={loading || saving} onClick={() => load()}>{loading ? t("טוען...", "Loading...") : t("רענן משימות", "Refresh tasks")}</Button>
      {loaded && <>
        <form onSubmit={create} className="grid gap-2 rounded border p-3">
          <label className="text-sm">{t("משימה חדשה", "New task")}<Input aria-label={t("משימה חדשה", "New task")} dir="auto" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} required /></label>
          <label className="text-sm">{t("מועד יעד", "Due date")}<Input aria-label={t("מועד יעד למשימה חדשה", "Due date for new task")} type="datetime-local" dir="ltr" value={dueAt} onChange={(e) => setDueAt(e.target.value)} required /></label>
          <label className="text-sm">{t("נציג אחראי", "Assigned agent")}<select aria-label={t("נציג למשימה חדשה", "Agent for new task")} className="block w-full rounded border p-2 bg-bg" value={assignee} onChange={(e) => setAssignee(e.target.value)} required>{assignees.map((a) => <option key={a.id} value={a.id}>{a.fullName}</option>)}</select></label>
          <Button type="submit" disabled={saving || loading}>{saving ? t("שומר...", "Saving...") : t("צור משימת מעקב", "Create follow-up task")}</Button>
        </form>
        {!tasks.length && <p className="text-sm text-muted-foreground">{t("אין משימות להצגה", "No tasks to show")}</p>}
        {tasks.map((task) => <TaskEditor key={`${task.id}:${task.version}`} task={task} assignees={assignees} checkedAt={checkedAt} saved={() => load()} />)}
        <div className="flex items-center justify-between gap-2 text-sm"><Button variant="outline" disabled={loading || page <= 1} onClick={() => load(page - 1)}>{t("הקודם", "Previous")}</Button><span>{t(`עמוד ${page} מתוך ${Math.max(1, Math.ceil(total / 50))}`, `Page ${page} of ${Math.max(1, Math.ceil(total / 50))}`)}</span><Button variant="outline" disabled={loading || page * 50 >= total} onClick={() => load(page + 1)}>{t("הבא", "Next")}</Button></div>
      </>}
    </div>
  </details>;
}
