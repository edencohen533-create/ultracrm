"use client";

import { Fragment, useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/client/api";
import { Badge, Button, EmptyState, ErrorState, Panel, Spinner, Textarea, cx } from "@/components/ui";

type Rate = { handled: number; answered: number; wins: number; rate: number | null };
interface Cap { known: boolean; reason: string | null; shift: { start: string; end: string } | null; shiftEnd: string | null; remainingMinutes: number; pacePerHour: number | null; paceBasis: string | null; untouched: number; followUpsBeforeEnd: number; load: number; capacityLeads: number; spare: number }
interface Agent { id: string; name: string; today: Rate; baseline: Rate & { days: number }; peers: Rate; sources: string[]; avgLeadAgeDays: number | null; untouched: number; online: boolean; inCall: boolean; inPool: boolean; assessment: { state: string; reasons: string[]; lowerBound: number | null; lift: number | null } | null; capacity: Cap; shift: { start: string; end: string; days: number[] } | null }
interface Proposal { mode: "extra" | "priority" | "share"; count: number; sharePct: number; source: string | null; listId: string | null; listName?: string | null; fromUnassigned: boolean; until: string | null; toAgentName?: string | null }
interface Rec { id: string; kind: string; status: string; statusLabel: string; code: string; title: string; explanation: string; agentId: string | null; agentName: string | null; evidence: { agent?: Agent; capacity?: Cap; interpretation?: string | null; lowerBound?: number | null; thresholds?: Record<string, unknown> }; proposal: Proposal; requestedCount: number | null; managerApprovedCount: number | null; agentApprovedCount: number | null; agentReply: string | null; expiresAt: string; createdAt: string; result: { reason?: string; agentRequest?: { delivery: string; detail: string | null }; approved?: number; assignedNow?: number } | null; override: { assigned: number; total: number; leadLimit: number; status: string; expiresAt: string; mode: string } | null; allocated: number }
interface Rule { id: string; kind: string; kindLabel: string; name: string; sourceText: string | null; config: Record<string, unknown>; autonomy: string; autonomyLabel: string; allowedAutonomy: string[]; status: string; priority: number; expired: boolean; summary: Record<string, string> | null }
interface Interp { kind: string | null; name: string; config: Record<string, unknown>; autonomy: string; questions: Array<{ field: string; question: string; proposed: number | string | boolean }>; summary: Record<string, string> | null; analyzer: string; note: string | null }
interface Data { settings: { enabled: boolean; notifyWhatsApp: boolean; maxAlertsPerDay: number; cooldownMinutes: number }; timezone: string; aiConnected: boolean; rules: Rule[]; recommendations: Rec[]; team: Agent[]; impact: Array<{ id: string; agentName: string | null; at: string; approved: number | null; allocated: number; dialed: number; won: number; baselineRate: number | null; smallSample: boolean }>; log: Array<{ id: string; action: string; createdAt: string; payload: Record<string, unknown> | null; actor: { fullName: string } | null }>; lists: Array<{ id: string; name: string }>; sources: string[]; whatsappLinked: string[] }

const pct = (x: number | null | undefined) => (x === null || x === undefined ? "—" : `${Math.round(x * 100)}%`);
const time = (s: string | null | undefined) => (s ? new Date(s).toLocaleTimeString("he-IL", { hour: "2-digit", minute: "2-digit" }) : "—");
const MODES: Array<[Proposal["mode"], string, string]> = [
  ["extra", "לידים נוספים מעבר לחלקו הרגיל", "הנציג ממשיך לקבל את התור הרגיל שלו בחלוקה, ובנוסף מקבל את הכמות הזו מתורות של נציגים אחרים."],
  ["priority", "קדימות בלידים החדשים הבאים", "הכמות הזו של הלידים החדשים הבאים תגיע אליו (כולל תורו הרגיל)."],
  ["share", "חלוקה משוקללת (אחוז)", "אחוז מהלידים החדשים הבאים יגיע אליו; השאר בחלוקה הרגילה."],
];
const STAGES = [["pending_manager", "אישור מנהל"], ["pending_agent", "אישור נציג"], ["active", "הקצאה פעילה"], ["completed", "הושלם"]] as const;
const TERMINAL: Record<string, "bad" | "warn" | "neutral"> = { rejected: "bad", expired: "warn", cancelled: "neutral", failed: "bad", needs_adjustment: "warn" };
const STATE: Record<string, [string, "good" | "warn" | "bad" | "neutral" | "info"]> = { momentum: ["במומנטום", "good"], insufficient_data: ["אין מספיק נתונים", "neutral"], normal: ["רגיל", "neutral"], overloaded: ["עמוס", "warn"], not_available: ["לא בחלוקה", "neutral"] };
const ACTION: Record<string, string> = { "ai_ops.detected": "זוהה", "ai_ops.manager_approved": "מנהל אישר", "ai_ops.rejected": "נדחה", "ai_ops.agent_approved": "נציג אישר", "ai_ops.agent_declined": "נציג סירב", "ai_ops.allocation_started": "הקצאה הופעלה", "ai_ops.allocation_ended": "הקצאה הסתיימה – חזרה לחלוקה הרגילה", "ai_ops.lead_allocated": "ליד הוקצה במסגרת אישור", "ai_ops.expired": "פג תוקף", "ai_ops.cancelled": "בוטל", "ai_ops.failed": "לא בוצע", "ai_ops.needs_adjustment": "נדרשת התאמה", "ai_ops.transfer_executed": "ליד הועבר לנציג זמין", "ai_ops.settings_updated": "הגדרות עודכנו", "ops_rule.created": "כלל נוצר", "ops_rule.updated": "כלל עודכן", "ops_rule.deleted": "כלל נמחק" };
const DAYS = ["א", "ב", "ג", "ד", "ה", "ו", "ש"];

function Stepper({ status }: { status: string }) {
  const idx = STAGES.findIndex(([k]) => k === status);
  const terminal = TERMINAL[status];
  return (
    <div className="flex flex-wrap items-center gap-1 text-[11px]" data-testid="ops-stepper">
      {STAGES.map(([k, l], i) => <span key={k} className={cx("px-2 py-0.5 rounded-full border", i < idx || status === "completed" ? "bg-good/15 border-good/40 text-good" : i === idx ? "bg-accent text-white border-accent font-semibold" : "border-line text-muted")}>{l}</span>)}
      {terminal && <Badge tone={terminal}>{({ rejected: "נדחה", expired: "פג תוקף", cancelled: "בוטל", failed: "לא בוצע", needs_adjustment: "נדרשת התאמה" } as Record<string, string>)[status]}</Badge>}
    </div>
  );
}

function Evidence({ r }: { r: Rec }) {
  const a = r.evidence.agent; const c = r.evidence.capacity;
  if (!a) return null;
  return (
    <div className="grid md:grid-cols-2 gap-3 text-xs" data-testid="ops-evidence">
      <table className="w-full"><tbody className="[&_td]:py-0.5">
        <tr><td className="text-muted">היום</td><td>{a.today.wins} סגירות / {a.today.handled} לידים שטופלו ({pct(a.today.rate)}) · {a.today.answered} שיחות נענו</td></tr>
        <tr><td className="text-muted">ממוצע אישי</td><td>{pct(a.baseline.rate)} ({a.baseline.wins}/{a.baseline.handled} ב-{a.baseline.days} ימים)</td></tr>
        <tr><td className="text-muted">נציגים על לידים דומים</td><td>{pct(a.peers.rate)} ({a.peers.wins}/{a.peers.handled})</td></tr>
        <tr><td className="text-muted">גבול תחתון (ביטחון)</td><td>{pct(r.evidence.lowerBound ?? null)}</td></tr>
        <tr><td className="text-muted">מקורות / גיל ליד</td><td>{a.sources.join(", ") || "—"} · {a.avgLeadAgeDays ?? "—"} ימים בממוצע</td></tr>
      </tbody></table>
      {c && <table className="w-full"><tbody className="[&_td]:py-0.5">
        <tr><td className="text-muted">משמרת</td><td>{c.shift ? `${c.shift.start}–${c.shift.end}` : "לא ידועה"} · נותרו {c.remainingMinutes} דק׳</td></tr>
        <tr><td className="text-muted">קצב טיפול</td><td>{c.pacePerHour ?? "—"} לידים לשעה {c.paceBasis ? `(${c.paceBasis})` : ""}</td></tr>
        <tr><td className="text-muted">עומס קיים</td><td>{c.untouched} שטרם טופלו + {c.followUpsBeforeEnd} פולואפים = {c.load}</td></tr>
        <tr><td className="text-muted">הערכת קיבולת</td><td>{c.capacityLeads} לידים עד סוף המשמרת → פנוי ל-<b>{c.spare}</b></td></tr>
        {c.reason && <tr><td className="text-muted">הערה</td><td>{c.reason}</td></tr>}
      </tbody></table>}
      {r.evidence.interpretation && <p className="md:col-span-2 text-muted italic">פרשנות המודל: {r.evidence.interpretation}</p>}
    </div>
  );
}

function RecCard({ r, data, onDone }: { r: Rec; data: Data; onDone: () => void }) {
  const [edit, setEdit] = useState<Proposal>({ ...r.proposal });
  const [busy, setBusy] = useState(false);
  const act = async (action: "approve" | "reject" | "cancel") => {
    setBusy(true);
    try { const res = await api.post<{ status: string; reason?: string }>(`/api/ops/recommendations/${r.id}`, action === "approve" && r.kind === "momentum" ? { action, edits: { mode: edit.mode, count: edit.count, sharePct: edit.sharePct, source: edit.source, listId: edit.listId, fromUnassigned: edit.fromUnassigned } } : { action }); toast.success(res.status === "pending_agent" ? "אושר – נשלחה בקשה לנציג" : res.status === "rejected" ? "נדחה" : res.status === "cancelled" ? "בוטל" : `סטטוס: ${res.status}`); onDone(); }
    catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  };
  const mode = MODES.find(([k]) => k === (r.proposal.mode ?? "extra"));
  const linked = r.agentId ? data.whatsappLinked.includes(r.agentId) : false;
  return (
    <div className="rounded-lg border border-line bg-panel p-3 space-y-2" data-testid={`ops-rec-${r.id}`} data-status={r.status}>
      <div className="flex flex-wrap items-center justify-between gap-2"><b className="text-sm">{r.title}</b><span className="text-[11px] text-muted">#{r.code} · {time(r.createdAt)}</span></div>
      {r.kind === "momentum" && <Stepper status={r.status} />}
      <p className="text-sm">{r.explanation}</p>
      {r.kind === "momentum" && <Evidence r={r} />}
      {r.kind === "momentum" && r.status !== "insight" && (
        <div className="text-xs rounded-md bg-muted-bg p-2 space-y-1" data-testid="ops-change">
          <div><b>השינוי המדויק:</b> {mode?.[1]}{r.proposal.mode === "share" ? ` – ${r.proposal.sharePct}% מתוך ${r.proposal.count} הלידים הבאים` : ` – ${r.proposal.count} לידים`}{r.proposal.listName ? ` · קמפיין ${r.proposal.listName}` : ""}{r.proposal.source ? ` · מקור ${r.proposal.source}` : ""} · עד {time(r.proposal.until)}. <span className="text-muted">כרגע: החלוקה הרגילה (ללא שינוי) · רק לידים חדשים{r.proposal.fromUnassigned ? " + לידים ללא שיוך" : ""}; לידים של נציגים אחרים לא מועברים.</span></div>
          <div data-testid="ops-counts">הומלצו: {r.requestedCount ?? "—"} · אושרו ע״י מנהל: {r.managerApprovedCount ?? "—"} · אושרו ע״י הנציג: {r.agentApprovedCount ?? "—"} · <b>הוקצו בפועל: {r.allocated}</b>{r.override ? ` (מתוך ${r.override.leadLimit}${r.override.mode === "share" ? ` לידים בחלון, ${r.override.assigned} אליו` : ""})` : ""}</div>
          {r.agentReply && <div>תשובת הנציג: ״{r.agentReply}״</div>}
          {r.result?.reason && <div className="text-warn">{r.result.reason}</div>}
        </div>
      )}
      {r.status === "pending_manager" && r.kind === "momentum" && (
        <div className="space-y-2 border-t border-line pt-2" data-testid="ops-edit">
          <div className="grid md:grid-cols-3 gap-2">{MODES.map(([k, l, h]) => <label key={k} className={cx("rounded-md border p-2 text-xs cursor-pointer", edit.mode === k ? "border-accent bg-accent/5" : "border-line")}><input type="radio" name={`mode-${r.id}`} checked={edit.mode === k} onChange={() => setEdit({ ...edit, mode: k })} className="me-1" /><b>{l}</b><div className="text-muted mt-1">{h}</div></label>)}</div>
          <div className="flex flex-wrap items-end gap-2 text-xs">
            <label>כמות לידים<input type="number" min={1} max={100} value={edit.count} onChange={(e) => setEdit({ ...edit, count: Number(e.target.value) })} className="block h-8 w-20 rounded border border-line bg-bg px-2" data-testid="ops-count" /></label>
            {edit.mode === "share" && <label>אחוז<input type="number" min={10} max={100} value={edit.sharePct} onChange={(e) => setEdit({ ...edit, sharePct: Number(e.target.value) })} className="block h-8 w-20 rounded border border-line bg-bg px-2" /></label>}
            <label>קמפיין (לתור החיוג)<select value={edit.listId ?? ""} onChange={(e) => setEdit({ ...edit, listId: e.target.value || null })} className="block h-8 rounded border border-line bg-bg px-2"><option value="">ללא</option>{data.lists.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></label>
            <label>מקור ליד<select value={edit.source ?? ""} onChange={(e) => setEdit({ ...edit, source: e.target.value || null })} className="block h-8 rounded border border-line bg-bg px-2"><option value="">כל המקורות</option>{data.sources.map((s) => <option key={s} value={s}>{s}</option>)}</select></label>
            {edit.mode !== "share" && <label className="flex items-center gap-1"><input type="checkbox" checked={edit.fromUnassigned} onChange={(e) => setEdit({ ...edit, fromUnassigned: e.target.checked })} />להתחיל מלידים קיימים ללא שיוך</label>}
          </div>
          <p className="text-[11px] text-muted">אישור מנהל <b>לא מקצה עדיין</b> – הנציג יישאל {linked ? "בוואטסאפ ובמערכת" : "במערכת (אין לו וואטסאפ מאומת)"} אם יספיק לטפל בהם היום, וההקצאה תופעל רק אחרי שיאשר (עד הכמות שאישרת).</p>
          <div className="flex gap-2"><Button size="sm" loading={busy} onClick={() => act("approve")} data-testid="ops-approve">אישור</Button><Button size="sm" variant="secondary" loading={busy} onClick={() => act("reject")} data-testid="ops-reject">דחייה</Button></div>
        </div>
      )}
      {r.status === "pending_manager" && r.kind !== "momentum" && <div className="flex gap-2"><Button size="sm" loading={busy} onClick={() => act("approve")} data-testid="ops-approve">אישור</Button><Button size="sm" variant="secondary" loading={busy} onClick={() => act("reject")}>דחייה</Button></div>}
      {r.status === "pending_agent" && <div className="flex flex-wrap items-center gap-2 text-xs"><span>ממתין לתשובת {r.agentName} עד {time(r.expiresAt)} · {r.result?.agentRequest?.delivery === "sent" ? "נשלח בוואטסאפ" : r.result?.agentRequest?.delivery === "template" ? "נשלחה התראה בוואטסאפ (תבנית)" : `במערכת בלבד${r.result?.agentRequest?.detail ? ` (${r.result.agentRequest.detail})` : ""}`}. בזמן ההמתנה החלוקה הרגילה ממשיכה.</span><Button size="sm" variant="ghost" loading={busy} onClick={() => act("cancel")}>ביטול</Button></div>}
      {r.status === "active" && <div className="flex flex-wrap items-center gap-2 text-xs"><span>הקצאה פעילה עד {time(r.override?.expiresAt)} · {r.override?.assigned ?? 0}/{r.override?.leadLimit ?? 0}</span><Button size="sm" variant="ghost" loading={busy} onClick={() => act("cancel")} data-testid="ops-cancel">עצור הקצאה</Button><span className="text-muted">(לידים שכבר הוקצו נשארים אצל הנציג)</span></div>}
    </div>
  );
}

function RuleForm({ rule, onSaved }: { rule: Rule; onSaved: () => void }) {
  const [cfg, setCfg] = useState<Record<string, unknown>>(rule.config);
  const enumOf: Record<string, string[]> = { mode: ["extra", "priority", "share"], fallback: ["alert_manager", "transfer_to_available", "none"], confidence: ["0.8", "0.9", "0.95"] };
  const save = async () => { try { await api.patch(`/api/ops/rules/${rule.id}`, { config: cfg }); toast.success("הכלל עודכן"); onSaved(); } catch (e) { toast.error((e as Error).message); } };
  return (
    <div className="flex flex-wrap items-end gap-2 text-xs border-t border-line pt-2">
      {Object.entries(cfg).map(([k, v]) => (
        <label key={k} className="flex flex-col">{k}
          {typeof v === "boolean" ? <input type="checkbox" checked={v} onChange={(e) => setCfg({ ...cfg, [k]: e.target.checked })} />
            : enumOf[k] ? <select value={String(v)} onChange={(e) => setCfg({ ...cfg, [k]: k === "confidence" ? Number(e.target.value) : e.target.value })} className="h-8 rounded border border-line bg-bg px-1">{enumOf[k].map((o) => <option key={o}>{o}</option>)}</select>
            : Array.isArray(v) ? <span>{(["assignment", "ownership"]).map((o) => <label key={o} className="me-2"><input type="checkbox" checked={(v as string[]).includes(o)} onChange={(e) => setCfg({ ...cfg, [k]: e.target.checked ? [...(v as string[]), o] : (v as string[]).filter((x) => x !== o) })} /> {o === "assignment" ? "חלוקה" : "בעלות"}</label>)}</span>
            : typeof v === "number" ? <input type="number" value={v} onChange={(e) => setCfg({ ...cfg, [k]: Number(e.target.value) })} className="h-8 w-20 rounded border border-line bg-bg px-1" />
            : <input value={String(v ?? "")} onChange={(e) => setCfg({ ...cfg, [k]: e.target.value || null })} className="h-8 w-32 rounded border border-line bg-bg px-1" />}
        </label>
      ))}
      <Button size="sm" onClick={save}>שמור</Button>
    </div>
  );
}

function RuleBuilder({ onSaved }: { onSaved: () => void }) {
  const [text, setText] = useState(""); const [busy, setBusy] = useState(false);
  const [it, setIt] = useState<Interp | null>(null); const [answers, setAnswers] = useState<Record<string, unknown>>({});
  const interpret = async () => { setBusy(true); try { const r = await api.post<Interp>("/api/ops/rules/interpret", { text }); setIt(r); setAnswers(Object.fromEntries(r.questions.filter((q) => q.field !== "kind" && q.field !== "config").map((q) => [q.field, q.proposed]))); } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); } };
  const save = async () => {
    if (!it?.kind) return;
    try { await api.post("/api/ops/rules", { kind: it.kind, name: it.name, config: { ...it.config, ...answers }, autonomy: it.autonomy, sourceText: text, priority: 40 }); toast.success("הכלל נשמר והופעל"); setIt(null); setText(""); onSaved(); }
    catch (e) { toast.error((e as Error).message); }
  };
  return (
    <div className="space-y-2" data-testid="ops-rule-builder">
      <Textarea label="כתוב כלל במילים שלך" rows={2} value={text} onChange={(e) => setText(e.target.value)} placeholder="למשל: אם לנציג יש יותר מ-15 לידים שטרם טופלו, עצור הקצאת לידים חדשים אליו עד שהעומס יורד." data-testid="ops-rule-text" />
      <Button size="sm" loading={busy} disabled={text.trim().length < 5} onClick={interpret} data-testid="ops-rule-interpret">הבן את הכלל</Button>
      {it && (
        <div className="rounded-md border border-line p-3 text-sm space-y-2" data-testid="ops-rule-preview">
          {it.kind && it.summary ? <>
            <div className="flex items-center gap-2"><b>{it.name}</b><Badge tone="info">{it.analyzer === "ai" ? "פוענח ע״י המודל" : "פוענח לפי תבניות"}</Badge></div>
            <p className="text-xs text-muted">כך המערכת הבינה – ייכנס לתוקף רק אחרי שתאשר:</p>
            <dl className="grid grid-cols-[110px_1fr] gap-x-2 gap-y-1 text-xs">{Object.entries({ trigger: "טריגר", conditions: "תנאים", action: "פעולה", scope: "היקף", validity: "תוקף", limits: "מגבלות", approval: "אופן אישור" }).map(([k, l]) => <Fragment key={k}><dt className="text-muted">{l}</dt><dd>{it.summary![k]}</dd></Fragment>)}</dl>
            {it.note && <p className="text-xs text-warn">{it.note}</p>}
          </> : null}
          {it.questions.length > 0 && <div className="space-y-1" data-testid="ops-rule-questions">{it.questions.map((q) => <label key={q.field} className="block text-xs"><span className="text-warn">❓ {q.question}</span>{q.field !== "kind" && q.field !== "config" && <input className="ms-2 h-7 w-24 rounded border border-line bg-bg px-1" value={String(answers[q.field] ?? "")} onChange={(e) => setAnswers({ ...answers, [q.field]: typeof q.proposed === "number" ? Number(e.target.value) : e.target.value })} />}</label>)}</div>}
          {it.kind && <div className="flex items-center gap-2"><select className="h-8 rounded border border-line bg-bg px-2 text-xs" value={it.autonomy} onChange={(e) => setIt({ ...it, autonomy: e.target.value })}><option value="insight">תובנה בלבד</option><option value="recommend">המלצה באישור</option><option value="auto">ביצוע אוטומטי בגבולות</option></select><Button size="sm" onClick={save} data-testid="ops-rule-save">אשר והפעל</Button><Button size="sm" variant="ghost" onClick={() => setIt(null)}>ביטול</Button></div>}
        </div>
      )}
    </div>
  );
}

function ShiftCell({ a, onSaved }: { a: Agent; onSaved: () => void }) {
  const [open, setOpen] = useState(false); const [v, setV] = useState(a.shift ?? { start: "09:00", end: "17:00", days: [0, 1, 2, 3, 4] });
  const save = async (value: typeof v | null) => { try { await api.patch("/api/ops/settings", { shift: { userId: a.id, value } }); toast.success("המשמרת נשמרה"); setOpen(false); onSaved(); } catch (e) { toast.error((e as Error).message); } };
  if (!open) return <button className="underline text-xs" onClick={() => setOpen(true)} data-testid={`ops-shift-${a.id}`}>{a.shift ? `${a.shift.start}–${a.shift.end}` : "הגדר משמרת"}</button>;
  return (
    <div className="flex flex-wrap items-center gap-1 text-xs">
      <input type="time" value={v.start} onChange={(e) => setV({ ...v, start: e.target.value })} className="h-7 rounded border border-line bg-bg px-1 ltr" />–<input type="time" value={v.end} onChange={(e) => setV({ ...v, end: e.target.value })} className="h-7 rounded border border-line bg-bg px-1 ltr" />
      {DAYS.map((d, i) => <button key={i} className={cx("w-6 h-6 rounded border", v.days.includes(i) ? "bg-accent text-white border-accent" : "border-line")} onClick={() => setV({ ...v, days: v.days.includes(i) ? v.days.filter((x) => x !== i) : [...v.days, i].sort() })}>{d}</button>)}
      <Button size="sm" onClick={() => save(v)} data-testid="ops-shift-save">שמור</Button>{a.shift && <Button size="sm" variant="ghost" onClick={() => save(null)}>הסר</Button>}
    </div>
  );
}

/** "מנהל AI": recommendations with the numbers behind them, approvals, active allocations, rules, team today, log, impact. */
export function OpsTab() {
  const [d, setD] = useState<Data | null>(null); const [err, setErr] = useState<string | null>(null); const [checking, setChecking] = useState(false);
  const [editRule, setEditRule] = useState<string | null>(null);
  const load = useCallback(async () => { try { setD(await api.get<Data>("/api/ops")); setErr(null); } catch (e) { setErr((e as Error).message); } }, []);
  useEffect(() => { void load(); const t = setInterval(() => void load(), 20_000); return () => clearInterval(t); }, [load]);
  if (err) return <ErrorState message={err} retry={load} />;
  if (!d) return <div className="py-16 flex justify-center"><Spinner /></div>;
  const open = d.recommendations.filter((r) => ["pending_manager", "pending_agent", "active", "needs_adjustment"].includes(r.status));
  const insights = d.recommendations.filter((r) => r.status === "insight").slice(0, 8);
  const history = d.recommendations.filter((r) => ["completed", "rejected", "expired", "cancelled", "failed"].includes(r.status)).slice(0, 15);
  const setting = async (patch: Record<string, unknown>) => { try { await api.patch("/api/ops/settings", patch); await load(); } catch (e) { toast.error((e as Error).message); } };
  const rule = async (id: string, patch: Record<string, unknown> | null) => { try { if (patch) await api.patch(`/api/ops/rules/${id}`, patch); else await api.delete(`/api/ops/rules/${id}`); await load(); } catch (e) { toast.error((e as Error).message); } };
  return (
    <div className="space-y-4" data-testid="ops-tab">
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <label className="flex items-center gap-1"><input type="checkbox" checked={d.settings.enabled} onChange={(e) => setting({ enabled: e.target.checked })} /> מנהל AI פעיל</label>
        <label className="flex items-center gap-1"><input type="checkbox" checked={d.settings.notifyWhatsApp} onChange={(e) => setting({ notifyWhatsApp: e.target.checked })} /> התראות ואישורים בוואטסאפ (למספרים מאומתים)</label>
        <span className="text-xs text-muted">עד {d.settings.maxAlertsPerDay} התראות ביום · צינון {d.settings.cooldownMinutes} דק׳</span>
        {!d.aiConnected && <Badge tone="warn">ללא מודל: המספרים והטקסטים מחושבים בקוד; פענוח כללים לפי תבניות</Badge>}
        <Button size="sm" variant="secondary" className="ms-auto" loading={checking} onClick={async () => { setChecking(true); try { await api.post("/api/ops/evaluate", {}); await load(); } finally { setChecking(false); } }} data-testid="ops-evaluate">בדוק עכשיו</Button>
      </div>

      <Panel title={`המלצות ובקשות פתוחות (${open.length})`}>
        {open.length ? <div className="space-y-3">{open.map((r) => <RecCard key={r.id} r={r} data={d} onDone={load} />)}</div> : <EmptyState title="אין המלצות פתוחות" hint="המערכת בודקת כל 2 דקות. המלצה נוצרת רק כשיש מספיק נתונים, ביטחון סטטיסטי וקיבולת פנויה." />}
      </Panel>

      <Panel title="הצוות היום – הנתונים שמאחורי ההמלצות">
        <div className="overflow-auto"><table className="w-full text-xs" data-testid="ops-team"><thead className="text-muted"><tr><th className="text-start p-1">נציג</th><th className="text-start">היום</th><th className="text-start">ממוצע אישי</th><th className="text-start">דומים</th><th className="text-start">מצב</th><th className="text-start">משמרת</th><th className="text-start">קיבולת פנויה</th></tr></thead>
          <tbody>{d.team.map((a) => { const [l, tone] = STATE[a.assessment?.state ?? "normal"] ?? ["—", "neutral"]; return (
            <tr key={a.id} className="border-t border-line align-top"><td className="p-1">{a.name}{a.online && <Badge tone="good" className="ms-1">מחובר</Badge>}{a.inCall && <Badge tone="info" className="ms-1">בשיחה</Badge>}</td>
              <td>{a.today.wins}/{a.today.handled} ({pct(a.today.rate)})</td><td>{pct(a.baseline.rate)} <span className="text-muted">({a.baseline.handled})</span></td><td>{pct(a.peers.rate)}</td>
              <td><Badge tone={tone}>{l}</Badge>{a.assessment?.reasons.length ? <div className="text-muted mt-0.5">{a.assessment.reasons.join(" · ")}</div> : null}</td>
              <td><ShiftCell a={a} onSaved={load} /></td>
              <td>{a.capacity.known ? `${a.capacity.spare} (${a.capacity.untouched} ממתינים)` : <span className="text-warn">{a.capacity.reason}</span>}</td></tr>); })}</tbody></table></div>
      </Panel>

      <Panel title="כללים">
        <RuleBuilder onSaved={load} />
        <div className="mt-3 space-y-2" data-testid="ops-rules">{d.rules.map((r) => (
          <div key={r.id} className={cx("rounded-md border border-line p-2 text-xs space-y-1", r.status !== "active" && "opacity-60")} data-testid={`ops-rule-${r.kind}`}>
            <div className="flex flex-wrap items-center gap-2"><Badge tone="neutral">{r.kindLabel}</Badge><b className="text-sm">{r.name}</b>{r.status !== "active" && <Badge tone="warn">מושהה</Badge>}{r.expired && <Badge tone="warn">פג תוקף</Badge>}<span className="text-muted">עדיפות {r.priority}</span>
              <select className="ms-auto h-7 rounded border border-line bg-bg px-1" value={r.autonomy} onChange={(e) => rule(r.id, { autonomy: e.target.value })}>{r.allowedAutonomy.map((x) => <option key={x} value={x}>{({ insight: "תובנה בלבד", recommend: "המלצה באישור", auto: "ביצוע אוטומטי בגבולות" } as Record<string, string>)[x]}</option>)}</select>
              <Button size="sm" variant="ghost" onClick={() => setEditRule(editRule === r.id ? null : r.id)}>עריכה</Button>
              <Button size="sm" variant="ghost" onClick={() => rule(r.id, { status: r.status === "active" ? "paused" : "active" })} data-testid={`ops-rule-toggle-${r.kind}`}>{r.status === "active" ? "השהה" : "הפעל"}</Button>
              <Button size="sm" variant="ghost" onClick={() => { if (confirm("למחוק את הכלל?")) void rule(r.id, null); }}>מחק</Button></div>
            {r.sourceText && <div className="text-muted">״{r.sourceText}״</div>}
            {r.summary && <div><b>טריגר:</b> {r.summary.trigger} · <b>תנאים:</b> {r.summary.conditions} · <b>פעולה:</b> {r.summary.action} · <b>אישור:</b> {r.summary.approval}</div>}
            {editRule === r.id && <RuleForm rule={r} onSaved={() => { setEditRule(null); void load(); }} />}
          </div>
        ))}</div>
      </Panel>

      {insights.length > 0 && <Panel title="תובנות (ללא פעולה)"><ul className="text-xs space-y-1">{insights.map((r) => <li key={r.id}><b>{r.title}</b> – {r.explanation}</li>)}</ul></Panel>}

      <Panel title="השפעה נמדדת">
        <p className="text-xs text-muted mb-2">השוואה תיאורית בלבד של הלידים שהוקצו במסגרת אישורים – לא הוכחה שהמערכת גרמה לשינוי (אין קבוצת ביקורת). מדגם קטן מסומן.</p>
        {d.impact.length ? <table className="w-full text-xs" data-testid="ops-impact"><thead className="text-muted"><tr><th className="text-start">נציג</th><th className="text-start">מתי</th><th className="text-start">אושרו</th><th className="text-start">הוקצו</th><th className="text-start">חויגו</th><th className="text-start">נסגרו</th><th className="text-start">ממוצע אישי לפני</th></tr></thead>
          <tbody>{d.impact.map((i) => <tr key={i.id} className="border-t border-line"><td>{i.agentName}</td><td>{new Date(i.at).toLocaleDateString("he-IL")}</td><td>{i.approved ?? "—"}</td><td>{i.allocated}</td><td>{i.dialed}</td><td>{i.won}{i.smallSample && <Badge tone="neutral" className="ms-1">מדגם קטן</Badge>}</td><td>{pct(i.baselineRate)}</td></tr>)}</tbody></table> : <p className="text-xs text-muted">עדיין אין הקצאות שהסתיימו.</p>}
      </Panel>

      <Panel title="היסטוריה ויומן">
        {history.length > 0 && <ul className="text-xs space-y-1 mb-3">{history.map((r) => <li key={r.id}><Badge tone={TERMINAL[r.status] ?? "good"}>{r.statusLabel}</Badge> {r.title} {r.result?.reason ? `– ${r.result.reason}` : ""}</li>)}</ul>}
        <ul className="text-xs space-y-0.5 max-h-72 overflow-auto" data-testid="ops-log">{d.log.map((l) => <li key={l.id}><span className="text-muted">{new Date(l.createdAt).toLocaleString("he-IL")}</span> · {ACTION[l.action] ?? l.action}{l.actor ? ` · ${l.actor.fullName}` : " · מערכת"}{l.payload && "via" in l.payload ? ` · דרך ${l.payload.via === "whatsapp" ? "וואטסאפ" : l.payload.via === "app" ? "המערכת" : String(l.payload.via)}` : ""}</li>)}</ul>
      </Panel>
    </div>
  );
}
