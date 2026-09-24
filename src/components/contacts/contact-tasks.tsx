"use client";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
type Task = { id: string; title: string; dueAt: string; status: string; version: number; assignedToId: string; assignedTo: { name: string } };
type Assignee = { id: string; name: string };
const labels: Record<string, string> = { OPEN: "פתוחה", DONE: "הושלמה", CANCELLED: "בוטלה" };
function localDate(value: string) { const date = new Date(value); return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16); }
function TaskEditor({ task, assignees, checkedAt, saved }: { task: Task; assignees: Assignee[]; checkedAt: number; saved: () => Promise<void> }) {
  const [title, setTitle] = useState(task.title); const [dueAt, setDueAt] = useState(localDate(task.dueAt));
  const [assignedToId, setAssignedToId] = useState(task.assignedToId); const [status, setStatus] = useState(task.status);
  const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  async function submit(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    try {
      const response = await fetch(`/api/tasks/${task.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title, dueAt: new Date(dueAt).toISOString(), assignedToId, status, version: task.version }) });
      const data = await response.json(); if (!response.ok) { setError(data.error || "שמירת המשימה נכשלה"); return; }
      await saved();
    } catch { setError("לא ניתן לאמת את העדכון. יש לרענן את הרשימה לפני ניסיון נוסף"); }
    finally { setBusy(false); }
  }
  return <details className="rounded border p-2">
    <summary className="cursor-pointer break-words text-sm"><span dir="auto">{task.title}</span> · {labels[task.status]} · {new Date(task.dueAt).toLocaleString("he-IL")} · {task.assignedTo.name}{task.status === "OPEN" && Date.parse(task.dueAt) < checkedAt ? " · באיחור" : ""}</summary>
    <form className="mt-2 grid gap-2" onSubmit={submit}>
      <label className="text-sm">תיאור משימה<Input aria-label={`תיאור משימה ${task.id}`} dir="auto" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} required /></label>
      <label className="text-sm">מועד יעד<Input aria-label={`מועד משימה ${task.id}`} type="datetime-local" dir="ltr" value={dueAt} onChange={(e) => setDueAt(e.target.value)} required /></label>
      <label className="text-sm">נציג<select className="block w-full rounded border p-2" aria-label={`נציג למשימה ${task.id}`} value={assignedToId} onChange={(e) => setAssignedToId(e.target.value)}>{!assignees.some((a) => a.id === task.assignedToId) && <option value={task.assignedToId}>{task.assignedTo.name} (אינו זמין)</option>}{assignees.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
      <label className="text-sm">סטטוס<select className="block w-full rounded border p-2" aria-label={`סטטוס משימה ${task.id}`} value={status} onChange={(e) => setStatus(e.target.value)}>{Object.entries(labels).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <Button type="submit" disabled={busy}>{busy ? "שומר..." : "שמור משימה"}</Button>
    </form>
  </details>;
}
export function Tasks({ contactId, conversationId, userId }: { contactId: string; conversationId?: string; userId: string }) {
  const [loaded, setLoaded] = useState(false); const [loading, setLoading] = useState(false); const [error, setError] = useState("");
  const [tasks, setTasks] = useState<Task[]>([]); const [assignees, setAssignees] = useState<Assignee[]>([]);
  const [checkedAt, setCheckedAt] = useState(0);
  const [page, setPage] = useState(1); const [total, setTotal] = useState(0);
  const [title, setTitle] = useState(""); const [dueAt, setDueAt] = useState(""); const [assignedToId, setAssignedToId] = useState(userId);
  const [requestKey, setRequestKey] = useState(() => crypto.randomUUID()); const [saving, setSaving] = useState(false);
  async function load(targetPage = page) {
    setLoading(true); setError("");
    try {
      const params = new URLSearchParams({ contactId, page: String(targetPage), ...(conversationId ? { conversationId } : {}) });
      const response = await fetch(`/api/tasks?${params}`); const data = await response.json();
      if (!response.ok) { setError(data.error || "טעינת המשימות נכשלה"); return; }
      setCheckedAt(Date.now()); setTasks(data.tasks); setAssignees(data.assignees); setTotal(data.total); setPage(data.page); setLoaded(true);
    } catch { setError("טעינת המשימות נכשלה. אפשר לנסות שוב"); }
    finally { setLoading(false); }
  }
  async function create(event: React.FormEvent) {
    event.preventDefault(); setSaving(true); setError("");
    try {
      const response = await fetch("/api/tasks", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ contactId, conversationId, title, dueAt: new Date(dueAt).toISOString(), assignedToId, requestKey }) });
      const data = await response.json(); if (!response.ok) { setError(data.error || "יצירת המשימה נכשלה"); return; }
      setTitle(""); setDueAt(""); setRequestKey(crypto.randomUUID()); await load(1);
    } catch { setError("לא ניתן לאמת את השמירה. אפשר לנסות שוב עם אותם פרטים; הבקשה מוגנת מכפילות"); }
    finally { setSaving(false); }
  }
  return <details className="border-b px-3 py-2" onToggle={(event) => { if (event.currentTarget.open && !loaded && !loading) void load(); }}>
    <summary className="cursor-pointer text-sm font-medium">משימות מעקב{loaded ? ` (${total})` : ""}</summary>
    <div className="mt-2 max-h-[55dvh] space-y-3 overflow-y-auto p-1">
      <p className="text-xs text-muted-foreground">משימות פנימיות בלבד; אינן שולחות הודעה ללקוח. מועדים לפי אזור הזמן של הדפדפן.</p>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <Button variant="outline" disabled={loading || saving} onClick={() => load()}>{loading ? "טוען..." : "רענן משימות"}</Button>
      {loaded && <>
        <form onSubmit={create} className="grid gap-2 rounded border p-3">
          <label className="text-sm">משימה חדשה<Input aria-label="משימה חדשה" dir="auto" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} required /></label>
          <label className="text-sm">מועד יעד<Input aria-label="מועד יעד למשימה חדשה" type="datetime-local" dir="ltr" value={dueAt} onChange={(e) => setDueAt(e.target.value)} required /></label>
          <label className="text-sm">נציג אחראי<select aria-label="נציג למשימה חדשה" className="block w-full rounded border p-2" value={assignedToId} onChange={(e) => setAssignedToId(e.target.value)} required>{assignees.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
          <p className="text-xs text-muted-foreground">לנציג חייבת להיות גישה ללקוח ולשיחה.</p>
          <Button type="submit" disabled={saving || loading}>{saving ? "שומר..." : "צור משימת מעקב"}</Button>
        </form>
        {!tasks.length && <p className="text-sm text-muted-foreground">אין משימות להצגה</p>}
        {tasks.map((task) => <TaskEditor key={`${task.id}:${task.version}`} task={task} assignees={assignees} checkedAt={checkedAt} saved={() => load()} />)}
        <div className="flex items-center justify-between gap-2 text-sm"><Button variant="outline" disabled={loading || page <= 1} onClick={() => load(page - 1)}>הקודם</Button><span>עמוד {page} מתוך {Math.max(1, Math.ceil(total / 50))}</span><Button variant="outline" disabled={loading || page * 50 >= total} onClick={() => load(page + 1)}>הבא</Button></div>
      </>}
    </div>
  </details>;
}
