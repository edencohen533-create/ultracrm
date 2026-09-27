"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { AlarmClock, CalendarClock, PhoneCall } from "lucide-react";
import { api, qs, ApiClientError } from "@/lib/client/api";
import { Button, Input, Modal, Select, Spinner, Textarea } from "@/components/ui";
import { OUTCOME_BY_KEY } from "@/lib/outcomes";

export interface FollowUpInfo { taskId: string; dueAt: string; note: string | null; overdue: boolean }
const TZ_DEFAULT = "Asia/Jerusalem";

/** Date/time strings of an instant in the business timezone (the pickers always work in business time). */
export function zoned(tz: string, at: Date) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(at).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}
export const fmtBiz = (tz: string, iso: string | Date) => new Intl.DateTimeFormat("he-IL", { timeZone: tz, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(iso));

/** Follow-up time in the list / card: date+time (business tz), "באיחור" when overdue, "נדרש תזמון" without a time. */
export function FollowUpBadge({ followUp, needsSchedule, tz, onClick }: { followUp: FollowUpInfo | null; needsSchedule: boolean; tz: string; onClick?: () => void }) {
  if (followUp) return <button type="button" className={`lead-followup${followUp.overdue ? " overdue" : ""}`} onClick={onClick} title={followUp.note ?? "ערוך פולואפ"} data-testid="followup-badge"><CalendarClock size={14}/><span dir="ltr">{fmtBiz(tz, followUp.dueAt)}</span>{followUp.overdue && <b>באיחור</b>}</button>;
  if (needsSchedule) return <button type="button" className="lead-followup needs" onClick={onClick} data-testid="followup-needs-schedule"><AlarmClock size={14}/>נדרש תזמון</button>;
  return <span className="text-muted">—</span>;
}

/** Choosing "פולואפ" opens this at once: date + time are mandatory, a note for the call is optional. */
export function FollowUpModal({ leadId, name, tz = TZ_DEFAULT, current, onClose, onSaved }: { leadId: string; name: string; tz?: string; current?: FollowUpInfo | null; onClose: () => void; onSaved: () => void }) {
  // Default: the next round hour, in business time (computed once when the modal opens).
  const [init] = useState(() => { const z = current ? zoned(tz, new Date(current.dueAt)) : zoned(tz, new Date(Date.now() + 3600_000)); return current ? z : { ...z, time: `${z.time.slice(0, 2)}:00` }; });
  const [date, setDate] = useState(init.date);
  const [time, setTime] = useState(init.time);
  const [note, setNote] = useState(current?.note ?? "");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<{ message: string; suggestion: { date: string; time: string } | null } | null>(null);
  async function save() {
    setBusy(true); setProblem(null);
    try { await api.put(`/api/leads/${leadId}/follow-up`, { date, time, note: note.trim() || undefined }); toast.success(current ? "מועד הפולואפ עודכן" : "הפולואפ נקבע"); onSaved(); onClose(); }
    catch (e) {
      const err = e as ApiClientError;
      if (err.code === "outside_dial_window") setProblem({ message: err.message, suggestion: (err.details as { suggestion?: { date: string; time: string } } | undefined)?.suggestion ?? null });
      else setProblem({ message: err.message, suggestion: null });
    } finally { setBusy(false); }
  }
  async function cancel() {
    if (!window.confirm("לבטל את הפולואפ? הליד יחזור לסטטוס 'נוצר קשר' ולא יחויג במועד שנקבע.")) return;
    setBusy(true);
    try { await api.delete(`/api/leads/${leadId}/follow-up`); toast.success("הפולואפ בוטל"); onSaved(); onClose(); } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  }
  return (
    <Modal open onClose={() => !busy && onClose()} title={`${current ? "עריכת" : "קביעת"} פולואפ – ${name}`}
      footer={<>{current && <Button variant="ghost" onClick={cancel} disabled={busy} data-testid="followup-cancel">בטל פולואפ</Button>}<Button variant="ghost" onClick={onClose} disabled={busy}>סגור</Button><Button onClick={save} loading={busy} disabled={!date || !time} data-testid="followup-save">שמור מועד</Button></>}>
      <div className="space-y-3" data-testid="followup-modal">
        <p className="text-xs text-muted">המועד הוא הזמן המוקדם ביותר שבו הליד ייכנס לתור החיוג של הנציג המשויך (לפי שעון העסק, {tz}). החייגן לא יחייג לפניו.</p>
        <div className="flex gap-2">
          <Input label="תאריך" type="date" value={date} onChange={(e) => setDate(e.target.value)} required ltr data-testid="followup-date" />
          <Input label="שעה" type="time" value={time} onChange={(e) => setTime(e.target.value)} required ltr data-testid="followup-time" />
        </div>
        <Textarea label="הערה לקראת השיחה (לא חובה)" value={note} onChange={(e) => setNote(e.target.value)} rows={3} maxLength={1000} data-testid="followup-note" />
        {problem && <div role="alert" className="rounded-md border border-warn/40 bg-warn/10 p-2 text-sm" data-testid="followup-problem">{problem.message}
          {problem.suggestion && <div className="mt-1"><Button size="sm" variant="ghost" onClick={() => { setDate(problem.suggestion!.date); setTime(problem.suggestion!.time); setProblem(null); }} data-testid="followup-use-suggestion">השתמש במועד התקין הקרוב: {problem.suggestion.date.split("-").reverse().join(".")} {problem.suggestion.time}</Button></div>}</div>}
      </div>
    </Modal>
  );
}

interface Attempt { id: string; at: string; agent: string; mode: string; result: string | null; outcome: string | null; answered: boolean; talkSeconds: number | null; note: string | null }
const RESULT: Record<string, string> = { answered: "נענתה", no_answer: "לא נענתה", busy: "תפוס", failed: "נכשלה", cancelled: "בוטלה", rejected: "נדחתה" };
const OUTCOME: Record<string, string> = Object.fromEntries(Object.entries(OUTCOME_BY_KEY).map(([k, d]) => [k, d.label]));

/** Click on the attempts counter: every real dial attempt with date, time, agent and result. */
export function AttemptsModal({ leadId, name, tz = TZ_DEFAULT, onClose }: { leadId: string; name: string; tz?: string; onClose: () => void }) {
  const [items, setItems] = useState<Attempt[] | null>(null);
  useEffect(() => { api.get<{ items: Attempt[] }>(`/api/leads/${leadId}/attempts`).then((r) => setItems(r.items)).catch((e) => { toast.error((e as Error).message); setItems([]); }); }, [leadId]);
  const d = (iso: string) => new Intl.DateTimeFormat("he-IL", { timeZone: tz, day: "2-digit", month: "2-digit", year: "numeric" }).format(new Date(iso));
  const t = (iso: string) => new Intl.DateTimeFormat("he-IL", { timeZone: tz, hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
  return (
    <Modal open onClose={onClose} title={`ניסיונות חיוג – ${name}`} width="max-w-2xl">
      {!items ? <div className="py-8 flex justify-center"><Spinner /></div> : !items.length ? <p className="text-sm text-muted py-4">עדיין לא בוצעו ניסיונות חיוג לליד הזה.</p> :
        <table className="w-full text-sm" data-testid="attempts-table"><thead className="text-xs text-muted"><tr><th className="text-start h-8">תאריך</th><th className="text-start">שעה</th><th className="text-start">נציג</th><th className="text-start">תוצאה</th></tr></thead>
          <tbody className="divide-y divide-line">{items.map((a) => <tr key={a.id}><td className="h-9" dir="ltr">{d(a.at)}</td><td dir="ltr">{t(a.at)}</td><td>{a.agent}</td><td>{a.outcome ? OUTCOME[a.outcome] ?? a.outcome : a.result ? RESULT[a.result] ?? a.result : "בתהליך"}{a.answered && a.talkSeconds ? ` · ${Math.floor(a.talkSeconds / 60)}:${String(a.talkSeconds % 60).padStart(2, "0")}` : ""}{a.mode !== "manual" ? " · חייגן אוטומטי" : " · ידני"}</td></tr>)}</tbody></table>}
      <p className="text-[11px] text-muted mt-3">נספרים רק ניסיונות שבהם המספר חויג בפועל (חייגן אוטומטי וחיוג ידני). ההיסטוריה נשמרת גם אחרי העברה לנציג אחר.</p>
    </Modal>
  );
}

/** Attempts counter + last attempt time; opens the history. */
export function AttemptsCell({ count, lastAt, onOpen, tz = TZ_DEFAULT, limit }: { count: number; lastAt: string | null; onOpen: () => void; tz?: string; limit?: number | null }) {
  const full = Boolean(limit && count >= limit);
  const title = [lastAt ? `ניסיון אחרון: ${fmtBiz(tz, lastAt)}` : "אין ניסיונות", limit ? `מכסה: ${limit} ניסיונות ללא מענה לפני "לא רלוונטי"` : ""].filter(Boolean).join(" · ");
  return <button type="button" className="lead-attempts" onClick={onOpen} title={title} data-testid="attempts-count"><PhoneCall size={13}/><b className={full ? "text-bad" : undefined}>{count}{limit ? <span data-testid="attempts-limit">/{limit}</span> : null}</b>{lastAt && <small dir="ltr">{fmtBiz(tz, lastAt)}</small>}</button>;
}

/** Manager: transfer one or many leads to an active agent. */
export function TransferModal({ leadIds, users, currentOwnerId, onClose, onDone }: { leadIds: string[]; users: Array<{ id: string; fullName: string }>; currentOwnerId?: string | null; onClose: () => void; onDone: () => void }) {
  const [to, setTo] = useState("");
  const [busy, setBusy] = useState(false);
  const [targets, setTargets] = useState(users);
  useEffect(() => { api.get<{ items: Array<{ id: string; fullName: string }> }>("/api/users/transfer-targets").then((r) => setTargets(r.items)).catch(() => undefined); }, []);
  async function go() {
    setBusy(true);
    try {
      const r = await api.post<{ transferred: string[]; pending: string[]; unchanged: string[]; notFound: string[]; to: { fullName: string } }>("/api/leads/transfer", { leadIds, toUserId: to });
      if (r.transferred.length) toast.success(`${r.transferred.length === 1 ? "הליד הועבר" : `${r.transferred.length} לידים הועברו`} ל${r.to.fullName}`);
      if (r.pending.length) toast.message(`${r.pending.length === 1 ? "הליד נמצא" : `${r.pending.length} לידים נמצאים`} בשיחה פעילה – ההעברה תתבצע מיד בסיום השיחה, בלי לנתק אותה.`, { duration: 8000 });
      if (r.notFound.length) toast.error(`${r.notFound.length} לידים לא נמצאו או שאין הרשאה`);
      onDone(); onClose();
    } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  }
  return (
    <Modal open onClose={() => !busy && onClose()} title={leadIds.length === 1 ? "העבר לנציג" : `העברת ${leadIds.length} לידים לנציג`}
      footer={<><Button variant="ghost" onClick={onClose} disabled={busy}>ביטול</Button><Button onClick={go} loading={busy} disabled={!to} data-testid="transfer-submit">העבר</Button></>}>
      <div className="space-y-3" data-testid="transfer-modal">
        <Select label="נציג יעד" value={to} onChange={(e) => setTo(e.target.value)} data-testid="transfer-to"><option value="">בחר נציג פעיל</option>{targets.filter((u) => u.id !== currentOwnerId).map((u) => <option key={u.id} value={u.id}>{u.fullName}</option>)}</Select>
        <p className="text-xs text-muted">הליד יוסר מיד מהרשימה ומתור החיוג של הנציג הקודם, וגישתו אליו תיחסם. הנציג החדש יקבל את כל ההערות, השיחות, ניסיונות החיוג והפולואפים (באותו מועד). ליד שנמצא בשיחה פעילה יועבר בסיום השיחה.</p>
      </div>
    </Modal>
  );
}

export type WaitingKey = "total" | "new" | "today" | "overdue" | "schedule";
interface Waiting { asOf: string; timezone: string; counts: { total: number; new: number; today: number; overdue: number; schedule: number; unassigned: number } }

/** Manager card "ממתינים לשיחה היום" – clickable total and categories filter the list with the same ids. */
export function WaitingCard({ agent, users, active, onPick, onAgent, version }: { agent: string; users: Array<{ id: string; fullName: string }>; active: WaitingKey | ""; onPick: (k: WaitingKey | "") => void; onAgent: (id: string) => void; version: unknown }) {
  const [w, setW] = useState<Waiting | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    const get = () => api.get<Waiting>(`/api/leads/waiting${qs({ agent: agent || undefined })}`).then((r) => { if (alive) { setW(r); setFailed(false); } }).catch(() => { if (alive) setFailed(true); });
    void get();
    const t = setInterval(() => { if (document.visibilityState === "visible") void get(); }, 30_000);
    return () => { alive = false; clearInterval(t); };
  }, [agent, version]);
  const cat = (k: WaitingKey, label: string, n: number | undefined, tone = "") => <button type="button" className={`waiting-cat ${tone}${active === k ? " active" : ""}`} onClick={() => onPick(active === k ? "" : k)} data-testid={`waiting-${k}`}><b>{n ?? "…"}</b><span>{label}</span></button>;
  return (
    <article className="lead-stat waiting-card" data-testid="waiting-card">
      <header>
        <button type="button" className={`waiting-total${active === "total" ? " active" : ""}`} onClick={() => onPick(active === "total" ? "" : "total")} data-testid="waiting-total"><strong>{failed ? "—" : w?.counts.total ?? "…"}</strong><span>ממתינים לשיחה היום</span></button>
        <select aria-label="נציג בכרטיס הממתינים" value={agent} onChange={(e) => onAgent(e.target.value)} data-testid="waiting-agent"><option value="">כל העסק</option><option value="unassigned">ללא שיוך</option>{users.map((u) => <option key={u.id} value={u.id}>{u.fullName}</option>)}</select>
      </header>
      {failed ? <p className="text-xs text-bad">לא ניתן לטעון כרגע – הנתון אינו 0, נסו לרענן.</p> : <div className="waiting-cats">
        {cat("new", "לידים חדשים שטרם חויגו", w?.counts.new)}
        {cat("today", "פולואפים להיום", w?.counts.today)}
        {cat("overdue", "פולואפים באיחור", w?.counts.overdue, "bad")}
        {cat("schedule", "פולואפ ללא מועד", w?.counts.schedule, "warn")}
      </div>}
      <footer>{w && w.counts.unassigned > 0 ? <span data-testid="waiting-unassigned">מתוכם {w.counts.unassigned} ללא שיוך – לא ייכנסו לחיוג עד שיוך לנציג</span> : <span>כל ליד נספר פעם אחת · מתעדכן אוטומטית</span>}</footer>
    </article>
  );
}
