"use client";

import { Fragment, useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/client/api";
import { Badge, Button, EmptyState, ErrorState, Panel, Spinner, Textarea, cx } from "@/components/ui";
import { useT } from "@/components/i18n/LangProvider";

type Rate = { handled: number; answered: number; wins: number; rate: number | null };
interface Cap { known: boolean; reason: string | null; shift: { start: string; end: string } | null; shiftEnd: string | null; remainingMinutes: number; pacePerHour: number | null; paceBasis: string | null; untouched: number; followUpsBeforeEnd: number; load: number; capacityLeads: number; spare: number }
interface Agent { id: string; name: string; today: Rate; baseline: Rate & { days: number }; peers: Rate; sources: string[]; avgLeadAgeDays: number | null; untouched: number; online: boolean; inCall: boolean; inPool: boolean; assessment: { state: string; reasons: string[]; lowerBound: number | null; lift: number | null } | null; capacity: Cap; shift: { start: string; end: string; days: number[] } | null }
interface Proposal { mode: "extra" | "priority" | "share"; count: number; sharePct: number; source: string | null; listId: string | null; listName?: string | null; fromUnassigned: boolean; until: string | null; toAgentName?: string | null }
interface Rec { id: string; kind: string; status: string; statusLabel: string; code: string; title: string; explanation: string; agentId: string | null; agentName: string | null; evidence: { agent?: Agent; capacity?: Cap; interpretation?: string | null; lowerBound?: number | null; thresholds?: Record<string, unknown> }; proposal: Proposal; requestedCount: number | null; managerApprovedCount: number | null; agentApprovedCount: number | null; agentReply: string | null; expiresAt: string; createdAt: string; result: { reason?: string; agentRequest?: { delivery: string; detail: string | null }; approved?: number; assignedNow?: number } | null; override: { assigned: number; total: number; leadLimit: number; status: string; expiresAt: string; mode: string } | null; allocated: number }
interface Rule { id: string; kind: string; kindLabel: string; name: string; sourceText: string | null; config: Record<string, unknown>; autonomy: string; autonomyLabel: string; allowedAutonomy: string[]; status: string; priority: number; expired: boolean; summary: Record<string, string> | null }
interface Interp { kind: string | null; name: string; config: Record<string, unknown>; autonomy: string; questions: Array<{ field: string; question: string; proposed: number | string | boolean }>; summary: Record<string, string> | null; analyzer: string; note: string | null }
interface Data { settings: { enabled: boolean; notifyWhatsApp: boolean; maxAlertsPerDay: number; cooldownMinutes: number }; timezone: string; aiConnected: boolean; rules: Rule[]; recommendations: Rec[]; team: Agent[]; impact: Array<{ id: string; agentName: string | null; at: string; approved: number | null; allocated: number; dialed: number; won: number; baselineRate: number | null; smallSample: boolean }>; log: Array<{ id: string; action: string; createdAt: string; payload: Record<string, unknown> | null; actor: { fullName: string } | null }>; lists: Array<{ id: string; name: string }>; sources: string[]; whatsappLinked: string[] }

const pct = (x: number | null | undefined) => (x === null || x === undefined ? "—" : `${Math.round(x * 100)}%`);
const time = (s: string | null | undefined, locale = "he-IL") => (s ? new Date(s).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" }) : "—");
const MODES: Array<[Proposal["mode"], string, string, string, string]> = [
  ["extra", "לידים נוספים מעבר לחלקו הרגיל", "הנציג ממשיך לקבל את התור הרגיל שלו בחלוקה, ובנוסף מקבל את הכמות הזו מתורות של נציגים אחרים.", "Extra leads beyond their normal share", "The agent keeps getting their normal turn in distribution, and additionally receives this amount from other agents' turns."],
  ["priority", "קדימות בלידים החדשים הבאים", "הכמות הזו של הלידים החדשים הבאים תגיע אליו (כולל תורו הרגיל).", "Priority on the next new leads", "This number of the next new leads will go to them (including their normal turn)."],
  ["share", "חלוקה משוקללת (אחוז)", "אחוז מהלידים החדשים הבאים יגיע אליו; השאר בחלוקה הרגילה.", "Weighted distribution (percent)", "A percentage of the next new leads will go to them; the rest via normal distribution."],
];
const STAGES = [["pending_manager", "אישור מנהל", "Manager approval"], ["pending_agent", "אישור נציג", "Agent approval"], ["active", "הקצאה פעילה", "Active allocation"], ["completed", "הושלם", "Completed"]] as const;
const TERMINAL: Record<string, "bad" | "warn" | "neutral"> = { rejected: "bad", expired: "warn", cancelled: "neutral", failed: "bad", needs_adjustment: "warn" };
/** Rule kinds and capacity notes arrive from the server in Hebrew; English versions keyed by kind / text. */
const KIND_EN: Record<string, string> = { momentum: "Agent on a roll", extra_leads_policy: "Extra leads with agent approval", availability: "Availability from WhatsApp", load_cap: "Stop assigning under load", approval_policy: "Approval policy" };
const reasonEn = (r: string) => r === "שעות העבודה של הנציג לא הוגדרו – לא מניחים שהוא פנוי" ? "Agent working hours not set – not assuming availability"
  : r === "הנציג לא במשמרת היום" ? "Agent is not on shift today"
  : r === "אין מספיק נתונים על קצב הטיפול של הנציג" ? "Not enough data on the agent's handling pace"
  : r.replace(/^המשמרת הסתיימה \((.*)\)$/, "Shift ended ($1)");
const STATE: Record<string, [string, "good" | "warn" | "bad" | "neutral" | "info", string]> = { momentum: ["במומנטום", "good", "On a roll"], insufficient_data: ["אין מספיק נתונים", "neutral", "Not enough data"], normal: ["רגיל", "neutral", "Normal"], overloaded: ["עמוס", "warn", "Overloaded"], not_available: ["לא בחלוקה", "neutral", "Not in distribution"] };
const ACTION: Record<string, [string, string]> = { "ai_ops.detected": ["זוהה", "Detected"], "ai_ops.manager_approved": ["מנהל אישר", "Manager approved"], "ai_ops.rejected": ["נדחה", "Rejected"], "ai_ops.agent_approved": ["נציג אישר", "Agent approved"], "ai_ops.agent_declined": ["נציג סירב", "Agent declined"], "ai_ops.allocation_started": ["הקצאה הופעלה", "Allocation started"], "ai_ops.allocation_ended": ["הקצאה הסתיימה – חזרה לחלוקה הרגילה", "Allocation ended – back to normal distribution"], "ai_ops.lead_allocated": ["ליד הוקצה במסגרת אישור", "Lead allocated under approval"], "ai_ops.expired": ["פג תוקף", "Expired"], "ai_ops.cancelled": ["בוטל", "Cancelled"], "ai_ops.failed": ["לא בוצע", "Not executed"], "ai_ops.needs_adjustment": ["נדרשת התאמה", "Needs adjustment"], "ai_ops.transfer_executed": ["ליד הועבר לנציג זמין", "Lead transferred to an available agent"], "ai_ops.settings_updated": ["הגדרות עודכנו", "Settings updated"], "ops_rule.created": ["כלל נוצר", "Rule created"], "ops_rule.updated": ["כלל עודכן", "Rule updated"], "ops_rule.deleted": ["כלל נמחק", "Rule deleted"] };
const DAYS: Array<[string, string]> = [["א", "S"], ["ב", "M"], ["ג", "T"], ["ד", "W"], ["ה", "T"], ["ו", "F"], ["ש", "S"]];

function Stepper({ status }: { status: string }) {
  const t = useT();
  const idx = STAGES.findIndex(([k]) => k === status);
  const terminal = TERMINAL[status];
  return (
    <div className="flex flex-wrap items-center gap-1 text-[11px]" data-testid="ops-stepper">
      {STAGES.map(([k, l, en], i) => <span key={k} className={cx("px-2 py-0.5 rounded-full border", i < idx || status === "completed" ? "bg-good/15 border-good/40 text-good" : i === idx ? "bg-accent text-white border-accent font-semibold" : "border-line text-muted")}>{t(l, en)}</span>)}
      {terminal && <Badge tone={terminal}>{t(({ rejected: "נדחה", expired: "פג תוקף", cancelled: "בוטל", failed: "לא בוצע", needs_adjustment: "נדרשת התאמה" } as Record<string, string>)[status], ({ rejected: "Rejected", expired: "Expired", cancelled: "Cancelled", failed: "Not executed", needs_adjustment: "Needs adjustment" } as Record<string, string>)[status])}</Badge>}
    </div>
  );
}

function Evidence({ r }: { r: Rec }) {
  const t = useT();
  const a = r.evidence.agent; const c = r.evidence.capacity;
  if (!a) return null;
  return (
    <div className="grid md:grid-cols-2 gap-3 text-xs" data-testid="ops-evidence">
      <table className="w-full"><tbody className="[&_td]:py-0.5">
        <tr><td className="text-muted">{t("היום", "Today")}</td><td>{t(`${a.today.wins} סגירות / ${a.today.handled} לידים שטופלו (${pct(a.today.rate)}) · ${a.today.answered} שיחות נענו`, `${a.today.wins} closed / ${a.today.handled} leads handled (${pct(a.today.rate)}) · ${a.today.answered} calls answered`)}</td></tr>
        <tr><td className="text-muted">{t("ממוצע אישי", "Personal average")}</td><td>{t(`${pct(a.baseline.rate)} (${a.baseline.wins}/${a.baseline.handled} ב-${a.baseline.days} ימים)`, `${pct(a.baseline.rate)} (${a.baseline.wins}/${a.baseline.handled} over ${a.baseline.days} days)`)}</td></tr>
        <tr><td className="text-muted">{t("נציגים על לידים דומים", "Agents on similar leads")}</td><td>{pct(a.peers.rate)} ({a.peers.wins}/{a.peers.handled})</td></tr>
        <tr><td className="text-muted">{t("גבול תחתון (ביטחון)", "Lower bound (confidence)")}</td><td>{pct(r.evidence.lowerBound ?? null)}</td></tr>
        <tr><td className="text-muted">{t("מקורות / גיל ליד", "Sources / lead age")}</td><td>{a.sources.join(", ") || "—"} · {a.avgLeadAgeDays ?? "—"} {t("ימים בממוצע", "days on average")}</td></tr>
      </tbody></table>
      {c && <table className="w-full"><tbody className="[&_td]:py-0.5">
        <tr><td className="text-muted">{t("משמרת", "Shift")}</td><td>{c.shift ? `${c.shift.start}–${c.shift.end}` : t("לא ידועה", "Unknown")} · {t(`נותרו ${c.remainingMinutes} דק׳`, `${c.remainingMinutes} min left`)}</td></tr>
        <tr><td className="text-muted">{t("קצב טיפול", "Handling pace")}</td><td>{c.pacePerHour ?? "—"} {t("לידים לשעה", "leads/hour")} {c.paceBasis ? `(${c.paceBasis})` : ""}</td></tr>
        <tr><td className="text-muted">{t("עומס קיים", "Current load")}</td><td>{t(`${c.untouched} שטרם טופלו + ${c.followUpsBeforeEnd} פולואפים = ${c.load}`, `${c.untouched} untouched + ${c.followUpsBeforeEnd} follow-ups = ${c.load}`)}</td></tr>
        <tr><td className="text-muted">{t("הערכת קיבולת", "Capacity estimate")}</td><td>{t(`${c.capacityLeads} לידים עד סוף המשמרת → פנוי ל-`, `${c.capacityLeads} leads until end of shift → room for `)}<b>{c.spare}</b></td></tr>
        {c.reason && <tr><td className="text-muted">{t("הערה", "Note")}</td><td>{t(c.reason, reasonEn(c.reason))}</td></tr>}
      </tbody></table>}
      {r.evidence.interpretation && <p className="md:col-span-2 text-muted italic">{t("פרשנות המודל:", "Model interpretation:")} {r.evidence.interpretation}</p>}
    </div>
  );
}

function RecCard({ r, data, onDone }: { r: Rec; data: Data; onDone: () => void }) {
  const t = useT(); const loc = t.lang === "en" ? "en-GB" : "he-IL";
  const [edit, setEdit] = useState<Proposal>({ ...r.proposal });
  const [busy, setBusy] = useState(false);
  const act = async (action: "approve" | "reject" | "cancel") => {
    setBusy(true);
    try { const res = await api.post<{ status: string; reason?: string }>(`/api/ops/recommendations/${r.id}`, action === "approve" && r.kind === "momentum" ? { action, edits: { mode: edit.mode, count: edit.count, sharePct: edit.sharePct, source: edit.source, listId: edit.listId, fromUnassigned: edit.fromUnassigned } } : { action }); toast.success(res.status === "pending_agent" ? t("אושר – נשלחה בקשה לנציג", "Approved – request sent to the agent") : res.status === "rejected" ? t("נדחה", "Rejected") : res.status === "cancelled" ? t("בוטל", "Cancelled") : t(`סטטוס: ${res.status}`, `Status: ${res.status}`)); onDone(); }
    catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  };
  const mode = MODES.find(([k]) => k === (r.proposal.mode ?? "extra"));
  const linked = r.agentId ? data.whatsappLinked.includes(r.agentId) : false;
  return (
    <div className="rounded-lg border border-line bg-panel p-3 space-y-2" data-testid={`ops-rec-${r.id}`} data-status={r.status}>
      <div className="flex flex-wrap items-center justify-between gap-2"><b className="text-sm">{r.title}</b><span className="text-[11px] text-muted">#{r.code} · {time(r.createdAt, loc)}</span></div>
      {r.kind === "momentum" && <Stepper status={r.status} />}
      <p className="text-sm">{r.explanation}</p>
      {r.kind === "momentum" && <Evidence r={r} />}
      {r.kind === "momentum" && r.status !== "insight" && (
        <div className="text-xs rounded-md bg-muted-bg p-2 space-y-1" data-testid="ops-change">
          <div><b>{t("השינוי המדויק:", "Exact change:")}</b> {mode ? t(mode[1], mode[3]) : undefined}{r.proposal.mode === "share" ? t(` – ${r.proposal.sharePct}% מתוך ${r.proposal.count} הלידים הבאים`, ` – ${r.proposal.sharePct}% of the next ${r.proposal.count} leads`) : t(` – ${r.proposal.count} לידים`, ` – ${r.proposal.count} leads`)}{r.proposal.listName ? t(` · קמפיין ${r.proposal.listName}`, ` · Campaign ${r.proposal.listName}`) : ""}{r.proposal.source ? t(` · מקור ${r.proposal.source}`, ` · Source ${r.proposal.source}`) : ""} · {t("עד", "until")} {time(r.proposal.until, loc)}. <span className="text-muted">{t("כרגע: החלוקה הרגילה (ללא שינוי) · רק לידים חדשים", "Currently: normal distribution (unchanged) · new leads only")}{r.proposal.fromUnassigned ? t(" + לידים ללא שיוך", " + unassigned leads") : ""}{t("; לידים של נציגים אחרים לא מועברים.", "; other agents' leads are not moved.")}</span></div>
          <div data-testid="ops-counts">{t("הומלצו:", "Recommended:")} {r.requestedCount ?? "—"} · {t("אושרו ע״י מנהל:", "Manager approved:")} {r.managerApprovedCount ?? "—"} · {t("אושרו ע״י הנציג:", "Agent approved:")} {r.agentApprovedCount ?? "—"} · <b>{t("הוקצו בפועל:", "Actually allocated:")} {r.allocated}</b>{r.override ? t(` (מתוך ${r.override.leadLimit}${r.override.mode === "share" ? ` לידים בחלון, ${r.override.assigned} אליו` : ""})`, ` (of ${r.override.leadLimit}${r.override.mode === "share" ? ` leads in the window, ${r.override.assigned} to them` : ""})`) : ""}</div>
          {r.agentReply && <div>{t("תשובת הנציג:", "Agent's reply:")} ״{r.agentReply}״</div>}
          {r.result?.reason && <div className="text-warn">{r.result.reason}</div>}
        </div>
      )}
      {r.status === "pending_manager" && r.kind === "momentum" && (
        <div className="space-y-2 border-t border-line pt-2" data-testid="ops-edit">
          <div className="grid md:grid-cols-3 gap-2">{MODES.map(([k, l, h, lEn, hEn]) => <label key={k} className={cx("rounded-md border p-2 text-xs cursor-pointer", edit.mode === k ? "border-accent bg-accent/5" : "border-line")}><input type="radio" name={`mode-${r.id}`} checked={edit.mode === k} onChange={() => setEdit({ ...edit, mode: k })} className="me-1" /><b>{t(l, lEn)}</b><div className="text-muted mt-1">{t(h, hEn)}</div></label>)}</div>
          <div className="flex flex-wrap items-end gap-2 text-xs">
            <label>{t("כמות לידים", "Number of leads")}<input type="number" min={1} max={100} value={edit.count} onChange={(e) => setEdit({ ...edit, count: Number(e.target.value) })} className="block h-8 w-20 rounded border border-line bg-bg px-2" data-testid="ops-count" /></label>
            {edit.mode === "share" && <label>{t("אחוז", "Percent")}<input type="number" min={10} max={100} value={edit.sharePct} onChange={(e) => setEdit({ ...edit, sharePct: Number(e.target.value) })} className="block h-8 w-20 rounded border border-line bg-bg px-2" /></label>}
            <label>{t("קמפיין (לתור החיוג)", "Campaign (for the dial queue)")}<select value={edit.listId ?? ""} onChange={(e) => setEdit({ ...edit, listId: e.target.value || null })} className="block h-8 rounded border border-line bg-bg px-2"><option value="">{t("ללא", "None")}</option>{data.lists.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}</select></label>
            <label>{t("מקור ליד", "Lead source")}<select value={edit.source ?? ""} onChange={(e) => setEdit({ ...edit, source: e.target.value || null })} className="block h-8 rounded border border-line bg-bg px-2"><option value="">{t("כל המקורות", "All sources")}</option>{data.sources.map((s) => <option key={s} value={s}>{s}</option>)}</select></label>
            {edit.mode !== "share" && <label className="flex items-center gap-1"><input type="checkbox" checked={edit.fromUnassigned} onChange={(e) => setEdit({ ...edit, fromUnassigned: e.target.checked })} />{t("להתחיל מלידים קיימים ללא שיוך", "Start with existing unassigned leads")}</label>}
          </div>
          <p className="text-[11px] text-muted">{t("אישור מנהל", "Manager approval")} <b>{t("לא מקצה עדיין", "does not allocate yet")}</b> – {t("הנציג יישאל", "the agent will be asked")} {linked ? t("בוואטסאפ ובמערכת", "on WhatsApp and in the app") : t("במערכת (אין לו וואטסאפ מאומת)", "in the app (no verified WhatsApp)")} {t("אם יספיק לטפל בהם היום, וההקצאה תופעל רק אחרי שיאשר (עד הכמות שאישרת).", "whether they can handle them today, and the allocation starts only after they confirm (up to the amount you approved).")}</p>
          <div className="flex gap-2"><Button size="sm" loading={busy} onClick={() => act("approve")} data-testid="ops-approve">{t("אישור", "Approve")}</Button><Button size="sm" variant="secondary" loading={busy} onClick={() => act("reject")} data-testid="ops-reject">{t("דחייה", "Reject")}</Button></div>
        </div>
      )}
      {r.status === "pending_manager" && r.kind !== "momentum" && <div className="flex gap-2"><Button size="sm" loading={busy} onClick={() => act("approve")} data-testid="ops-approve">{t("אישור", "Approve")}</Button><Button size="sm" variant="secondary" loading={busy} onClick={() => act("reject")}>{t("דחייה", "Reject")}</Button></div>}
      {r.status === "pending_agent" && <div className="flex flex-wrap items-center gap-2 text-xs"><span>{t(`ממתין לתשובת ${r.agentName} עד ${time(r.expiresAt, loc)}`, `Waiting for ${r.agentName}'s reply until ${time(r.expiresAt, loc)}`)} · {r.result?.agentRequest?.delivery === "sent" ? t("נשלח בוואטסאפ", "Sent on WhatsApp") : r.result?.agentRequest?.delivery === "template" ? t("נשלחה התראה בוואטסאפ (תבנית)", "WhatsApp notification sent (template)") : t(`במערכת בלבד${r.result?.agentRequest?.detail ? ` (${r.result.agentRequest.detail})` : ""}`, `In-app only${r.result?.agentRequest?.detail ? ` (${r.result.agentRequest.detail})` : ""}`)}. {t("בזמן ההמתנה החלוקה הרגילה ממשיכה.", "Normal distribution continues while waiting.")}</span><Button size="sm" variant="ghost" loading={busy} onClick={() => act("cancel")}>{t("ביטול", "Cancel")}</Button></div>}
      {r.status === "active" && <div className="flex flex-wrap items-center gap-2 text-xs"><span>{t("הקצאה פעילה עד", "Allocation active until")} {time(r.override?.expiresAt, loc)} · {r.override?.assigned ?? 0}/{r.override?.leadLimit ?? 0}</span><Button size="sm" variant="ghost" loading={busy} onClick={() => act("cancel")} data-testid="ops-cancel">{t("עצור הקצאה", "Stop allocation")}</Button><span className="text-muted">{t("(לידים שכבר הוקצו נשארים אצל הנציג)", "(leads already allocated stay with the agent)")}</span></div>}
    </div>
  );
}

function RuleForm({ rule, onSaved }: { rule: Rule; onSaved: () => void }) {
  const t = useT();
  const [cfg, setCfg] = useState<Record<string, unknown>>(rule.config);
  const enumOf: Record<string, string[]> = { mode: ["extra", "priority", "share"], fallback: ["alert_manager", "transfer_to_available", "none"], confidence: ["0.8", "0.9", "0.95"] };
  const save = async () => { try { await api.patch(`/api/ops/rules/${rule.id}`, { config: cfg }); toast.success(t("הכלל עודכן", "Rule updated")); onSaved(); } catch (e) { toast.error((e as Error).message); } };
  return (
    <div className="flex flex-wrap items-end gap-2 text-xs border-t border-line pt-2">
      {Object.entries(cfg).map(([k, v]) => (
        <label key={k} className="flex flex-col">{k}
          {typeof v === "boolean" ? <input type="checkbox" checked={v} onChange={(e) => setCfg({ ...cfg, [k]: e.target.checked })} />
            : enumOf[k] ? <select value={String(v)} onChange={(e) => setCfg({ ...cfg, [k]: k === "confidence" ? Number(e.target.value) : e.target.value })} className="h-8 rounded border border-line bg-bg px-1">{enumOf[k].map((o) => <option key={o}>{o}</option>)}</select>
            : Array.isArray(v) ? <span>{(["assignment", "ownership"]).map((o) => <label key={o} className="me-2"><input type="checkbox" checked={(v as string[]).includes(o)} onChange={(e) => setCfg({ ...cfg, [k]: e.target.checked ? [...(v as string[]), o] : (v as string[]).filter((x) => x !== o) })} /> {o === "assignment" ? t("חלוקה", "Distribution") : t("בעלות", "Ownership")}</label>)}</span>
            : typeof v === "number" ? <input type="number" value={v} onChange={(e) => setCfg({ ...cfg, [k]: Number(e.target.value) })} className="h-8 w-20 rounded border border-line bg-bg px-1" />
            : <input value={String(v ?? "")} onChange={(e) => setCfg({ ...cfg, [k]: e.target.value || null })} className="h-8 w-32 rounded border border-line bg-bg px-1" />}
        </label>
      ))}
      <Button size="sm" onClick={save}>{t("שמור", "Save")}</Button>
    </div>
  );
}

function RuleBuilder({ onSaved }: { onSaved: () => void }) {
  const t = useT();
  const [text, setText] = useState(""); const [busy, setBusy] = useState(false);
  const [it, setIt] = useState<Interp | null>(null); const [answers, setAnswers] = useState<Record<string, unknown>>({});
  const interpret = async () => { setBusy(true); try { const r = await api.post<Interp>("/api/ops/rules/interpret", { text }); setIt(r); setAnswers(Object.fromEntries(r.questions.filter((q) => q.field !== "kind" && q.field !== "config").map((q) => [q.field, q.proposed]))); } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); } };
  const save = async () => {
    if (!it?.kind) return;
    try { await api.post("/api/ops/rules", { kind: it.kind, name: it.name, config: { ...it.config, ...answers }, autonomy: it.autonomy, sourceText: text, priority: 40 }); toast.success(t("הכלל נשמר והופעל", "Rule saved and activated")); setIt(null); setText(""); onSaved(); }
    catch (e) { toast.error((e as Error).message); }
  };
  return (
    <div className="space-y-2" data-testid="ops-rule-builder">
      <Textarea label={t("כתוב כלל במילים שלך", "Write a rule in your own words")} rows={2} value={text} onChange={(e) => setText(e.target.value)} placeholder={t("למשל: אם לנציג יש יותר מ-15 לידים שטרם טופלו, עצור הקצאת לידים חדשים אליו עד שהעומס יורד.", "e.g. If an agent has more than 15 untouched leads, stop assigning new leads to them until the load drops.")} data-testid="ops-rule-text" />
      <Button size="sm" loading={busy} disabled={text.trim().length < 5} onClick={interpret} data-testid="ops-rule-interpret">{t("הבן את הכלל", "Interpret rule")}</Button>
      {it && (
        <div className="rounded-md border border-line p-3 text-sm space-y-2" data-testid="ops-rule-preview">
          {it.kind && it.summary ? <>
            <div className="flex items-center gap-2"><b>{it.name}</b><Badge tone="info">{it.analyzer === "ai" ? t("פוענח ע״י המודל", "Interpreted by the model") : t("פוענח לפי תבניות", "Interpreted by patterns")}</Badge></div>
            <p className="text-xs text-muted">{t("כך המערכת הבינה – ייכנס לתוקף רק אחרי שתאשר:", "Here is how the system understood it – takes effect only after you approve:")}</p>
            <dl className="grid grid-cols-[110px_1fr] gap-x-2 gap-y-1 text-xs">{Object.entries({ trigger: ["טריגר", "Trigger"], conditions: ["תנאים", "Conditions"], action: ["פעולה", "Action"], scope: ["היקף", "Scope"], validity: ["תוקף", "Validity"], limits: ["מגבלות", "Limits"], approval: ["אופן אישור", "Approval mode"] }).map(([k, [l, en]]) => <Fragment key={k}><dt className="text-muted">{t(l, en)}</dt><dd>{it.summary![k]}</dd></Fragment>)}</dl>
            {it.note && <p className="text-xs text-warn">{it.note}</p>}
          </> : null}
          {it.questions.length > 0 && <div className="space-y-1" data-testid="ops-rule-questions">{it.questions.map((q) => <label key={q.field} className="block text-xs"><span className="text-warn">❓ {q.question}</span>{q.field !== "kind" && q.field !== "config" && <input className="ms-2 h-7 w-24 rounded border border-line bg-bg px-1" value={String(answers[q.field] ?? "")} onChange={(e) => setAnswers({ ...answers, [q.field]: typeof q.proposed === "number" ? Number(e.target.value) : e.target.value })} />}</label>)}</div>}
          {it.kind && <div className="flex items-center gap-2"><select className="h-8 rounded border border-line bg-bg px-2 text-xs" value={it.autonomy} onChange={(e) => setIt({ ...it, autonomy: e.target.value })}><option value="insight">{t("תובנה בלבד", "Insight only")}</option><option value="recommend">{t("המלצה באישור", "Recommend with approval")}</option><option value="auto">{t("ביצוע אוטומטי בגבולות", "Automatic within limits")}</option></select><Button size="sm" onClick={save} data-testid="ops-rule-save">{t("אשר והפעל", "Approve & activate")}</Button><Button size="sm" variant="ghost" onClick={() => setIt(null)}>{t("ביטול", "Cancel")}</Button></div>}
        </div>
      )}
    </div>
  );
}

function ShiftCell({ a, onSaved }: { a: Agent; onSaved: () => void }) {
  const t = useT();
  const [open, setOpen] = useState(false); const [v, setV] = useState(a.shift ?? { start: "09:00", end: "17:00", days: [0, 1, 2, 3, 4] });
  const save = async (value: typeof v | null) => { try { await api.patch("/api/ops/settings", { shift: { userId: a.id, value } }); toast.success(t("המשמרת נשמרה", "Shift saved")); setOpen(false); onSaved(); } catch (e) { toast.error((e as Error).message); } };
  if (!open) return <button className="underline text-xs" onClick={() => setOpen(true)} data-testid={`ops-shift-${a.id}`}>{a.shift ? `${a.shift.start}–${a.shift.end}` : t("הגדר משמרת", "Set shift")}</button>;
  return (
    <div className="flex flex-wrap items-center gap-1 text-xs">
      <input type="time" value={v.start} onChange={(e) => setV({ ...v, start: e.target.value })} className="h-7 rounded border border-line bg-bg px-1 ltr" />–<input type="time" value={v.end} onChange={(e) => setV({ ...v, end: e.target.value })} className="h-7 rounded border border-line bg-bg px-1 ltr" />
      {DAYS.map(([dHe, dEn], i) => <button key={i} className={cx("w-6 h-6 rounded border", v.days.includes(i) ? "bg-accent text-white border-accent" : "border-line")} onClick={() => setV({ ...v, days: v.days.includes(i) ? v.days.filter((x) => x !== i) : [...v.days, i].sort() })}>{t(dHe, dEn)}</button>)}
      <Button size="sm" onClick={() => save(v)} data-testid="ops-shift-save">{t("שמור", "Save")}</Button>{a.shift && <Button size="sm" variant="ghost" onClick={() => save(null)}>{t("הסר", "Remove")}</Button>}
    </div>
  );
}

/** "מנהל AI": recommendations with the numbers behind them, approvals, active allocations, rules, team today, log, impact. */
export function OpsTab() {
  const t = useT(); const loc = t.lang === "en" ? "en-GB" : "he-IL";
  const [d, setD] = useState<Data | null>(null); const [err, setErr] = useState<string | null>(null); const [checking, setChecking] = useState(false);
  const [editRule, setEditRule] = useState<string | null>(null);
  const load = useCallback(async () => { try { setD(await api.get<Data>("/api/ops")); setErr(null); } catch (e) { setErr((e as Error).message); } }, []);
  useEffect(() => { void load(); const iv = setInterval(() => void load(), 20_000); return () => clearInterval(iv); }, [load]);
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
        <label className="flex items-center gap-1"><input type="checkbox" checked={d.settings.enabled} onChange={(e) => setting({ enabled: e.target.checked })} /> {t("מנהל AI פעיל", "AI Manager active")}</label>
        <label className="flex items-center gap-1"><input type="checkbox" checked={d.settings.notifyWhatsApp} onChange={(e) => setting({ notifyWhatsApp: e.target.checked })} /> {t("התראות ואישורים בוואטסאפ (למספרים מאומתים)", "Alerts and approvals on WhatsApp (verified numbers)")}</label>
        <span className="text-xs text-muted">{t(`עד ${d.settings.maxAlertsPerDay} התראות ביום · צינון ${d.settings.cooldownMinutes} דק׳`, `Up to ${d.settings.maxAlertsPerDay} alerts/day · ${d.settings.cooldownMinutes} min cooldown`)}</span>
        {!d.aiConnected && <Badge tone="warn">{t("ללא מודל: המספרים והטקסטים מחושבים בקוד; פענוח כללים לפי תבניות", "No model: numbers and texts are computed in code; rules interpreted by patterns")}</Badge>}
        <Button size="sm" variant="secondary" className="ms-auto" loading={checking} onClick={async () => { setChecking(true); try { await api.post("/api/ops/evaluate", {}); await load(); } finally { setChecking(false); } }} data-testid="ops-evaluate">{t("בדוק עכשיו", "Check now")}</Button>
      </div>

      <Panel title={t(`המלצות ובקשות פתוחות (${open.length})`, `Open recommendations & requests (${open.length})`)}>
        {open.length ? <div className="space-y-3">{open.map((r) => <RecCard key={r.id} r={r} data={d} onDone={load} />)}</div> : <EmptyState title={t("אין המלצות פתוחות", "No open recommendations")} hint={t("המערכת בודקת כל 2 דקות. המלצה נוצרת רק כשיש מספיק נתונים, ביטחון סטטיסטי וקיבולת פנויה.", "The system checks every 2 minutes. A recommendation is created only when there is enough data, statistical confidence and spare capacity.")} />}
      </Panel>

      <Panel title={t("הצוות היום – הנתונים שמאחורי ההמלצות", "Team today – the data behind the recommendations")}>
        <div className="overflow-auto"><table className="w-full text-xs" data-testid="ops-team"><thead className="text-muted"><tr><th className="text-start p-1">{t("נציג", "Agent")}</th><th className="text-start">{t("היום", "Today")}</th><th className="text-start">{t("ממוצע אישי", "Personal avg")}</th><th className="text-start">{t("דומים", "Peers")}</th><th className="text-start">{t("מצב", "State")}</th><th className="text-start">{t("משמרת", "Shift")}</th><th className="text-start">{t("קיבולת פנויה", "Spare capacity")}</th></tr></thead>
          <tbody>{d.team.map((a) => { const [l, tone, lEn] = STATE[a.assessment?.state ?? "normal"] ?? ["—", "neutral", "—"]; return (
            <tr key={a.id} className="border-t border-line align-top"><td className="p-1">{a.name}{a.online && <Badge tone="good" className="ms-1">{t("מחובר", "Online")}</Badge>}{a.inCall && <Badge tone="info" className="ms-1">{t("בשיחה", "On a call")}</Badge>}</td>
              <td>{a.today.wins}/{a.today.handled} ({pct(a.today.rate)})</td><td>{pct(a.baseline.rate)} <span className="text-muted">({a.baseline.handled})</span></td><td>{pct(a.peers.rate)}</td>
              <td><Badge tone={tone}>{t(l, lEn)}</Badge>{a.assessment?.reasons.length ? <div className="text-muted mt-0.5">{a.assessment.reasons.join(" · ")}</div> : null}</td>
              <td><ShiftCell a={a} onSaved={load} /></td>
              <td>{a.capacity.known ? t(`${a.capacity.spare} (${a.capacity.untouched} ממתינים)`, `${a.capacity.spare} (${a.capacity.untouched} waiting)`) : <span className="text-warn">{a.capacity.reason && t(a.capacity.reason, reasonEn(a.capacity.reason))}</span>}</td></tr>); })}</tbody></table></div>
      </Panel>

      <Panel title={t("כללים", "Rules")}>
        <RuleBuilder onSaved={load} />
        <div className="mt-3 space-y-2" data-testid="ops-rules">{d.rules.map((r) => (
          <div key={r.id} className={cx("rounded-md border border-line p-2 text-xs space-y-1", r.status !== "active" && "opacity-60")} data-testid={`ops-rule-${r.kind}`}>
            <div className="flex flex-wrap items-center gap-2"><Badge tone="neutral">{t(r.kindLabel, KIND_EN[r.kind] ?? r.kindLabel)}</Badge><b className="text-sm">{r.name}</b>{r.status !== "active" && <Badge tone="warn">{t("מושהה", "Paused")}</Badge>}{r.expired && <Badge tone="warn">{t("פג תוקף", "Expired")}</Badge>}<span className="text-muted">{t("עדיפות", "Priority")} {r.priority}</span>
              <select className="ms-auto h-7 rounded border border-line bg-bg px-1" value={r.autonomy} onChange={(e) => rule(r.id, { autonomy: e.target.value })}>{r.allowedAutonomy.map((x) => <option key={x} value={x}>{t(({ insight: "תובנה בלבד", recommend: "המלצה באישור", auto: "ביצוע אוטומטי בגבולות" } as Record<string, string>)[x], ({ insight: "Insight only", recommend: "Recommend with approval", auto: "Automatic within limits" } as Record<string, string>)[x])}</option>)}</select>
              <Button size="sm" variant="ghost" onClick={() => setEditRule(editRule === r.id ? null : r.id)}>{t("עריכה", "Edit")}</Button>
              <Button size="sm" variant="ghost" onClick={() => rule(r.id, { status: r.status === "active" ? "paused" : "active" })} data-testid={`ops-rule-toggle-${r.kind}`}>{r.status === "active" ? t("השהה", "Pause") : t("הפעל", "Activate")}</Button>
              <Button size="sm" variant="ghost" onClick={() => { if (confirm(t("למחוק את הכלל?", "Delete this rule?"))) void rule(r.id, null); }}>{t("מחק", "Delete")}</Button></div>
            {r.sourceText && <div className="text-muted">״{r.sourceText}״</div>}
            {r.summary && <div><b>{t("טריגר:", "Trigger:")}</b> {r.summary.trigger} · <b>{t("תנאים:", "Conditions:")}</b> {r.summary.conditions} · <b>{t("פעולה:", "Action:")}</b> {r.summary.action} · <b>{t("אישור:", "Approval:")}</b> {r.summary.approval}</div>}
            {editRule === r.id && <RuleForm rule={r} onSaved={() => { setEditRule(null); void load(); }} />}
          </div>
        ))}</div>
      </Panel>

      {insights.length > 0 && <Panel title={t("תובנות (ללא פעולה)", "Insights (no action)")}><ul className="text-xs space-y-1">{insights.map((r) => <li key={r.id}><b>{r.title}</b> – {r.explanation}</li>)}</ul></Panel>}

      <Panel title={t("השפעה נמדדת", "Measured impact")}>
        <p className="text-xs text-muted mb-2">{t("השוואה תיאורית בלבד של הלידים שהוקצו במסגרת אישורים – לא הוכחה שהמערכת גרמה לשינוי (אין קבוצת ביקורת). מדגם קטן מסומן.", "A descriptive comparison only of leads allocated under approvals – not proof that the system caused the change (no control group). Small samples are marked.")}</p>
        {d.impact.length ? <table className="w-full text-xs" data-testid="ops-impact"><thead className="text-muted"><tr><th className="text-start">{t("נציג", "Agent")}</th><th className="text-start">{t("מתי", "When")}</th><th className="text-start">{t("אושרו", "Approved")}</th><th className="text-start">{t("הוקצו", "Allocated")}</th><th className="text-start">{t("חויגו", "Dialed")}</th><th className="text-start">{t("נסגרו", "Closed")}</th><th className="text-start">{t("ממוצע אישי לפני", "Personal avg before")}</th></tr></thead>
          <tbody>{d.impact.map((i) => <tr key={i.id} className="border-t border-line"><td>{i.agentName}</td><td>{new Date(i.at).toLocaleDateString(loc)}</td><td>{i.approved ?? "—"}</td><td>{i.allocated}</td><td>{i.dialed}</td><td>{i.won}{i.smallSample && <Badge tone="neutral" className="ms-1">{t("מדגם קטן", "Small sample")}</Badge>}</td><td>{pct(i.baselineRate)}</td></tr>)}</tbody></table> : <p className="text-xs text-muted">{t("עדיין אין הקצאות שהסתיימו.", "No completed allocations yet.")}</p>}
      </Panel>

      <Panel title={t("היסטוריה ויומן", "History & log")}>
        {history.length > 0 && <ul className="text-xs space-y-1 mb-3">{history.map((r) => <li key={r.id}><Badge tone={TERMINAL[r.status] ?? "good"}>{r.statusLabel}</Badge> {r.title} {r.result?.reason ? `– ${r.result.reason}` : ""}</li>)}</ul>}
        <ul className="text-xs space-y-0.5 max-h-72 overflow-auto" data-testid="ops-log">{d.log.map((l) => <li key={l.id}><span className="text-muted">{new Date(l.createdAt).toLocaleString(loc)}</span> · {ACTION[l.action] ? t(ACTION[l.action][0], ACTION[l.action][1]) : l.action}{l.actor ? ` · ${l.actor.fullName}` : ` · ${t("מערכת", "System")}`}{l.payload && "via" in l.payload ? ` · ${t("דרך", "via")} ${l.payload.via === "whatsapp" ? t("וואטסאפ", "WhatsApp") : l.payload.via === "app" ? t("המערכת", "the app") : String(l.payload.via)}` : ""}</li>)}</ul>
      </Panel>
    </div>
  );
}
