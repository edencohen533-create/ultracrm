"use client";

import { useEffect, useEffectEvent, useRef, useState } from "react";
import { toast } from "sonner";
import { AlarmClock, CalendarClock, PhoneCall } from "lucide-react";
import { api, qs, ApiClientError } from "@/lib/client/api";
import { Button, Input, Modal, Select, Spinner, Textarea } from "@/components/ui";
import { OUTCOME_BY_KEY } from "@/lib/outcomes";
import { useT } from "@/components/i18n/LangProvider";

export interface FollowUpInfo { taskId: string; dueAt: string; note: string | null; overdue: boolean }
const TZ_DEFAULT = "Asia/Jerusalem";

/** Date/time strings of an instant in the business timezone (the pickers always work in business time). */
export function zoned(tz: string, at: Date) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(at).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}
export const fmtBiz = (tz: string, iso: string | Date, locale = "he-IL") => new Intl.DateTimeFormat(locale, { timeZone: tz, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(iso));

/** Follow-up time in the list / card: date+time (business tz), "באיחור" when overdue, "נדרש תזמון" without a time. */
export function FollowUpBadge({ followUp, needsSchedule, tz, onClick }: { followUp: FollowUpInfo | null; needsSchedule: boolean; tz: string; onClick?: () => void }) {
  const t = useT();
  const loc = t.lang === "en" ? "en-GB" : "he-IL";
  if (followUp) return <button type="button" className={`lead-followup${followUp.overdue ? " overdue" : ""}`} onClick={onClick} title={followUp.note ?? t("ערוך פולואפ", "Edit follow-up")} data-testid="followup-badge"><CalendarClock size={14}/><span dir="ltr">{fmtBiz(tz, followUp.dueAt, loc)}</span>{followUp.overdue && <b>{t("באיחור", "Overdue")}</b>}</button>;
  if (needsSchedule) return <button type="button" className="lead-followup needs" onClick={onClick} data-testid="followup-needs-schedule"><AlarmClock size={14}/>{t("נדרש תזמון", "Needs scheduling")}</button>;
  return <span className="text-muted">—</span>;
}

/** Choosing "פולואפ" opens this at once: date + time are mandatory, a note for the call is optional. */
export function FollowUpModal({ leadId, name, tz = TZ_DEFAULT, current, statusId, onClose, onSaved }: { leadId: string; name: string; tz?: string; current?: FollowUpInfo | null; /** A follow-up status of the business (default: the system "פולואפ"). */ statusId?: string; onClose: () => void; onSaved: () => void }) {
  // Default: the next round hour, in business time (computed once when the modal opens).
  const [init] = useState(() => { const z = current ? zoned(tz, new Date(current.dueAt)) : zoned(tz, new Date(Date.now() + 3600_000)); return current ? z : { ...z, time: `${z.time.slice(0, 2)}:00` }; });
  const [date, setDate] = useState(init.date);
  const [time, setTime] = useState(init.time);
  const [note, setNote] = useState(current?.note ?? "");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<{ message: string; suggestion: { date: string; time: string } | null } | null>(null);
  const t = useT();
  async function save() {
    setBusy(true); setProblem(null);
    try { await api.put(`/api/leads/${leadId}/follow-up`, { date, time, note: note.trim() || undefined, statusId }); toast.success(current ? t("מועד הפולואפ עודכן", "Follow-up time updated") : t("הפולואפ נקבע", "Follow-up scheduled")); onSaved(); onClose(); }
    catch (e) {
      const err = e as ApiClientError;
      if (err.code === "outside_dial_window") setProblem({ message: err.message, suggestion: (err.details as { suggestion?: { date: string; time: string } } | undefined)?.suggestion ?? null });
      else setProblem({ message: err.message, suggestion: null });
    } finally { setBusy(false); }
  }
  async function cancel() {
    if (!window.confirm(t("לבטל את הפולואפ? הליד יחזור לסטטוס 'נוצר קשר' ולא יחויג במועד שנקבע.", "Cancel the follow-up? The lead will return to 'Contacted' status and won't be dialed at the scheduled time."))) return;
    setBusy(true);
    try { await api.delete(`/api/leads/${leadId}/follow-up`); toast.success(t("הפולואפ בוטל", "Follow-up cancelled")); onSaved(); onClose(); } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  }
  return (
    <Modal open onClose={() => !busy && onClose()} title={current ? t(`עריכת פולואפ – ${name}`, `Edit follow-up – ${name}`) : t(`קביעת פולואפ – ${name}`, `Schedule follow-up – ${name}`)}
      footer={<>{current && <Button variant="ghost" onClick={cancel} disabled={busy} data-testid="followup-cancel">{t("בטל פולואפ", "Cancel follow-up")}</Button>}<Button variant="ghost" onClick={onClose} disabled={busy}>{t("סגור", "Close")}</Button><Button onClick={save} loading={busy} disabled={!date || !time} data-testid="followup-save">{t("שמור מועד", "Save time")}</Button></>}>
      <div className="space-y-3" data-testid="followup-modal">
        <p className="text-xs text-muted">{t(`המועד הוא הזמן המוקדם ביותר שבו הליד ייכנס לתור החיוג של הנציג המשויך (לפי שעון העסק, ${tz}). החייגן לא יחייג לפניו.`, `This is the earliest time the lead will enter the assigned agent's dial queue (business time, ${tz}). The dialer won't call before it.`)}</p>
        <div className="flex gap-2">
          <Input label={t("תאריך", "Date")} type="date" value={date} onChange={(e) => setDate(e.target.value)} required ltr data-testid="followup-date" />
          <Input label={t("שעה", "Time")} type="time" value={time} onChange={(e) => setTime(e.target.value)} required ltr data-testid="followup-time" />
        </div>
        <Textarea label={t("הערה לקראת השיחה (לא חובה)", "Note for the call (optional)")} value={note} onChange={(e) => setNote(e.target.value)} rows={3} maxLength={1000} data-testid="followup-note" />
        {problem && <div role="alert" className="rounded-md border border-warn/40 bg-warn/10 p-2 text-sm" data-testid="followup-problem">{problem.message}
          {problem.suggestion && <div className="mt-1"><Button size="sm" variant="ghost" onClick={() => { setDate(problem.suggestion!.date); setTime(problem.suggestion!.time); setProblem(null); }} data-testid="followup-use-suggestion">{t("השתמש במועד התקין הקרוב:", "Use the nearest valid time:")} {problem.suggestion.date.split("-").reverse().join(".")} {problem.suggestion.time}</Button></div>}</div>}
      </div>
    </Modal>
  );
}

interface Attempt { id: string; at: string; agent: string; mode: string; result: string | null; outcome: string | null; answered: boolean; talkSeconds: number | null; note: string | null }
const RESULT: Record<string, [string, string]> = { answered: ["נענתה", "Answered"], no_answer: ["לא נענתה", "No answer"], busy: ["תפוס", "Busy"], failed: ["נכשלה", "Failed"], cancelled: ["בוטלה", "Cancelled"], rejected: ["נדחתה", "Rejected"] };
const OUTCOME: Record<string, string> = Object.fromEntries(Object.entries(OUTCOME_BY_KEY).map(([k, d]) => [k, d.label]));

/** Click on the attempts counter: every real dial attempt with date, time, agent and result. */
export function AttemptsModal({ leadId, name, tz = TZ_DEFAULT, onClose }: { leadId: string; name: string; tz?: string; onClose: () => void }) {
  const [items, setItems] = useState<Attempt[] | null>(null);
  const t = useT();
  const loc = t.lang === "en" ? "en-GB" : "he-IL";
  useEffect(() => { api.get<{ items: Attempt[] }>(`/api/leads/${leadId}/attempts`).then((r) => setItems(r.items)).catch((e) => { toast.error((e as Error).message); setItems([]); }); }, [leadId]);
  const d = (iso: string) => new Intl.DateTimeFormat(loc, { timeZone: tz, day: "2-digit", month: "2-digit", year: "numeric" }).format(new Date(iso));
  const hm = (iso: string) => new Intl.DateTimeFormat(loc, { timeZone: tz, hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
  return (
    <Modal open onClose={onClose} title={t(`ניסיונות חיוג – ${name}`, `Dial attempts – ${name}`)} width="max-w-2xl">
      {!items ? <div className="py-8 flex justify-center"><Spinner /></div> : !items.length ? <p className="text-sm text-muted py-4">{t("עדיין לא בוצעו ניסיונות חיוג לליד הזה.", "No dial attempts for this lead yet.")}</p> :
        <table className="w-full text-sm" data-testid="attempts-table"><thead className="text-xs text-muted"><tr><th className="text-start h-8">{t("תאריך", "Date")}</th><th className="text-start">{t("שעה", "Time")}</th><th className="text-start">{t("נציג", "Agent")}</th><th className="text-start">{t("תוצאה", "Result")}</th></tr></thead>
          <tbody className="divide-y divide-line">{items.map((a) => <tr key={a.id}><td className="h-9" dir="ltr">{d(a.at)}</td><td dir="ltr">{hm(a.at)}</td><td>{a.agent}</td><td>{a.outcome ? OUTCOME[a.outcome] ?? a.outcome : a.result ? (RESULT[a.result] ? t(...RESULT[a.result]) : a.result) : t("בתהליך", "In progress")}{a.answered && a.talkSeconds ? ` · ${Math.floor(a.talkSeconds / 60)}:${String(a.talkSeconds % 60).padStart(2, "0")}` : ""}{a.mode !== "manual" ? t(" · חייגן אוטומטי", " · Auto dialer") : t(" · ידני", " · Manual")}</td></tr>)}</tbody></table>}
      <p className="text-[11px] text-muted mt-3">{t("נספרים רק ניסיונות שבהם המספר חויג בפועל (חייגן אוטומטי וחיוג ידני). ההיסטוריה נשמרת גם אחרי העברה לנציג אחר.", "Only attempts where the number was actually dialed are counted (auto dialer and manual). The history is kept even after transfer to another agent.")}</p>
    </Modal>
  );
}

/** Attempts counter + last attempt time; opens the history. */
export function AttemptsCell({ count, lastAt, onOpen, tz = TZ_DEFAULT, limit }: { count: number; lastAt: string | null; onOpen: () => void; tz?: string; limit?: number | null }) {
  const t = useT();
  const loc = t.lang === "en" ? "en-GB" : "he-IL";
  const full = Boolean(limit && count >= limit);
  const title = [lastAt ? t(`ניסיון אחרון: ${fmtBiz(tz, lastAt, loc)}`, `Last attempt: ${fmtBiz(tz, lastAt, loc)}`) : t("אין ניסיונות", "No attempts"), limit ? t(`מכסה: ${limit} ניסיונות ללא מענה לפני "לא רלוונטי"`, `Limit: ${limit} unanswered attempts before "Not relevant"`) : ""].filter(Boolean).join(" · ");
  return <button type="button" className="lead-attempts" onClick={onOpen} title={title} data-testid="attempts-count"><PhoneCall size={13}/><b className={full ? "text-bad" : undefined}>{count}{limit ? <span data-testid="attempts-limit">/{limit}</span> : null}</b>{lastAt && <small dir="ltr">{fmtBiz(tz, lastAt, loc)}</small>}</button>;
}

/** Manager: transfer one or many leads to an active agent. */
export function TransferModal({ leadIds, users, currentOwnerId, onClose, onDone }: { leadIds: string[]; users: Array<{ id: string; fullName: string }>; currentOwnerId?: string | null; onClose: () => void; onDone: () => void }) {
  const [to, setTo] = useState("");
  const [busy, setBusy] = useState(false);
  const [targets, setTargets] = useState(users);
  const t = useT();
  useEffect(() => { api.get<{ items: Array<{ id: string; fullName: string }> }>("/api/users/transfer-targets").then((r) => setTargets(r.items)).catch(() => undefined); }, []);
  async function go() {
    setBusy(true);
    try {
      const r = await api.post<{ transferred: string[]; reopened?: string[]; pending: string[]; unchanged: string[]; notFound: string[]; to: { fullName: string } }>("/api/leads/transfer", { leadIds, toUserId: to });
      if (r.transferred.length) toast.success(t(`${r.transferred.length === 1 ? "הליד הועבר" : `${r.transferred.length} לידים הועברו`} ל${r.to.fullName}`, `${r.transferred.length === 1 ? "Lead transferred" : `${r.transferred.length} leads transferred`} to ${r.to.fullName}`));
      if (r.reopened?.length) toast.message(t(`${r.reopened.length === 1 ? "הליד היה במצב אבוד ויופיע" : `${r.reopened.length} לידים אבודים יופיעו`} אצל ${r.to.fullName} כליד חדש. ההיסטוריה המלאה נשמרה בכרטיס הליד.`, `${r.reopened.length === 1 ? "The lead was lost and will appear" : `${r.reopened.length} lost leads will appear`} for ${r.to.fullName} as a new lead. The full history was kept on the lead card.`), { duration: 8000 });
      if (r.pending.length) toast.message(t(`${r.pending.length === 1 ? "הליד נמצא" : `${r.pending.length} לידים נמצאים`} בשיחה פעילה – ההעברה תתבצע מיד בסיום השיחה, בלי לנתק אותה.`, `${r.pending.length === 1 ? "The lead is" : `${r.pending.length} leads are`} on an active call – the transfer will happen as soon as the call ends, without disconnecting it.`), { duration: 8000 });
      if (r.notFound.length) toast.error(t(`${r.notFound.length} לידים לא נמצאו או שאין הרשאה`, `${r.notFound.length} leads weren't found or you lack permission`));
      onDone(); onClose();
    } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  }
  return (
    <Modal open onClose={() => !busy && onClose()} title={leadIds.length === 1 ? t("העבר לנציג", "Transfer to agent") : t(`העברת ${leadIds.length} לידים לנציג`, `Transfer ${leadIds.length} leads to an agent`)}
      footer={<><Button variant="ghost" onClick={onClose} disabled={busy}>{t("ביטול", "Cancel")}</Button><Button onClick={go} loading={busy} disabled={!to} data-testid="transfer-submit">{t("העבר", "Transfer")}</Button></>}>
      <div className="space-y-3" data-testid="transfer-modal">
        <Select label={t("נציג יעד", "Target agent")} value={to} onChange={(e) => setTo(e.target.value)} data-testid="transfer-to"><option value="">{t("בחר נציג פעיל", "Choose an active agent")}</option>{targets.filter((u) => u.id !== currentOwnerId).map((u) => <option key={u.id} value={u.id}>{u.fullName}</option>)}</Select>
        <p className="text-xs text-muted">{t("הליד יוסר מיד מהרשימה ומתור החיוג של הנציג הקודם, וגישתו אליו תיחסם. הנציג החדש יקבל את כל ההערות, השיחות, ניסיונות החיוג והפולואפים (באותו מועד). ליד שנמצא בשיחה פעילה יועבר בסיום השיחה. ליד במצב ״אבוד״ יופיע אצל הנציג החדש כ״ליד חדש״ (ספירת הניסיונות מתחילה מאפס), וכל ההיסטוריה שלו נשמרת ומתועדת בכרטיס הליד.", "The lead is immediately removed from the previous agent's list and dial queue, and their access is blocked. The new agent gets all notes, calls, dial attempts and follow-ups (at the same times). A lead on an active call is transferred when the call ends. A \"Lost\" lead appears for the new agent as a \"New lead\" (the attempt count restarts from zero), and all its history is kept and logged on the lead card.")}</p>
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
  const tr = useT();
  const alive = useRef(true);
  const get = useEffectEvent(() => api.get<Waiting>(`/api/leads/waiting${qs({ agent: agent || undefined })}`).then((r) => { if (alive.current) { setW(r); setFailed(false); } }).catch(() => { if (alive.current) setFailed(true); }));
  // Fetch on mount + poll; afterwards every list reload (version) refreshes the counts – including an agent change,
  // which reloads the list too. The list's first load right after mount is skipped (the mount fetch covers it).
  useEffect(() => {
    alive.current = true; void get();
    const t = setInterval(() => { if (document.visibilityState === "visible") void get(); }, 30_000);
    return () => { alive.current = false; clearInterval(t); };
  }, []);
  const skipFirst = useRef(true);
  useEffect(() => {
    if (version === null || version === undefined) return;
    if (skipFirst.current) { skipFirst.current = false; return; }
    void get();
  }, [version]);
  const cat = (k: WaitingKey, label: string, n: number | undefined, tone = "") => <button type="button" className={`waiting-cat ${tone}${active === k ? " active" : ""}`} onClick={() => onPick(active === k ? "" : k)} data-testid={`waiting-${k}`}><b>{n ?? "…"}</b><span>{label}</span></button>;
  return (
    <article className="lead-stat waiting-card" data-testid="waiting-card">
      <header>
        <button type="button" className={`waiting-total${active === "total" ? " active" : ""}`} onClick={() => onPick(active === "total" ? "" : "total")} data-testid="waiting-total"><strong>{failed ? "—" : w?.counts.total ?? "…"}</strong><span>{tr("ממתינים לשיחה היום", "Waiting for a call today")}</span></button>
        <select aria-label={tr("נציג בכרטיס הממתינים", "Agent in the waiting card")} value={agent} onChange={(e) => onAgent(e.target.value)} data-testid="waiting-agent"><option value="">{tr("כל העסק", "Whole business")}</option><option value="unassigned">{tr("ללא שיוך", "Unassigned")}</option>{users.map((u) => <option key={u.id} value={u.id}>{u.fullName}</option>)}</select>
      </header>
      {failed ? <p className="text-xs text-bad">{tr("לא ניתן לטעון כרגע – הנתון אינו 0, נסו לרענן.", "Can't load right now – the number isn't 0, try refreshing.")}</p> : <div className="waiting-cats">
        {cat("new", tr("לידים חדשים שטרם חויגו", "New leads not yet dialed"), w?.counts.new)}
        {cat("today", tr("פולואפים להיום", "Follow-ups for today"), w?.counts.today)}
        {cat("overdue", tr("פולואפים באיחור", "Overdue follow-ups"), w?.counts.overdue, "bad")}
        {cat("schedule", tr("פולואפ ללא מועד", "Follow-up without a time"), w?.counts.schedule, "warn")}
      </div>}
      <footer>{w && w.counts.unassigned > 0 ? <span data-testid="waiting-unassigned">{tr(`מתוכם ${w.counts.unassigned} ללא שיוך – לא ייכנסו לחיוג עד שיוך לנציג`, `Of these, ${w.counts.unassigned} are unassigned – they won't be dialed until assigned to an agent`)}</span> : <span>{tr("כל ליד נספר פעם אחת · מתעדכן אוטומטית", "Each lead counted once · updates automatically")}</span>}</footer>
    </article>
  );
}
