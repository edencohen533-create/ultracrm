"use client";

import { Fragment, useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/client/api";
import { Badge, Button, EmptyState, ErrorState, Panel, Spinner, Textarea, cx } from "@/components/ui";
import { useT } from "@/components/i18n/LangProvider";
import { HelpTip } from "./HelpTip";

interface Impact { id: string; agentName: string | null; at: string; until: string | null; status: string; approved: number | null; allocated: number; dialed: number; won: number; compare: { leads: number; won: number; from: string; to: string } | null; minSample: number; smallSample: boolean; compareSmall: boolean }
type Rate = { handled: number; answered: number; wins: number; rate: number | null };
interface Cap { known: boolean; reason: string | null; shift: { start: string; end: string } | null; shiftEnd: string | null; remainingMinutes: number; pacePerHour: number | null; paceBasis: string | null; untouched: number; followUpsBeforeEnd: number; load: number; capacityLeads: number; spare: number }
interface Agent { id: string; name: string; today: Rate; baseline: Rate & { days: number }; peers: Rate; sources: string[]; avgLeadAgeDays: number | null; untouched: number; online: boolean; inCall: boolean; inPool: boolean; assessment: { state: string; reasons: string[]; lowerBound: number | null; lift: number | null } | null; capacity: Cap; shift: { start: string; end: string; days: number[] } | null }
interface Proposal { leadId?: string; mode: "extra" | "priority" | "share"; count: number; sharePct: number; source: string | null; listId: string | null; listName?: string | null; fromUnassigned: boolean; until: string | null; toAgentName?: string | null }
interface Rec { id: string; kind: string; status: string; statusLabel: string; code: string; title: string; explanation: string; agentId: string | null; agentName: string | null; evidence: { agent?: Agent; capacity?: Cap; interpretation?: string | null; lowerBound?: number | null; thresholds?: Record<string, unknown> }; proposal: Proposal; requestedCount: number | null; managerApprovedCount: number | null; agentApprovedCount: number | null; agentReply: string | null; expiresAt: string; createdAt: string; result: { responseSeconds?: number; reason?: string; agentRequest?: { delivery: string; detail: string | null }; approved?: number; assignedNow?: number } | null; override: { assigned: number; total: number; leadLimit: number; status: string; expiresAt: string; mode: string } | null; allocated: number }
interface Rule { id: string; kind: string; kindLabel: string; name: string; sourceText: string | null; config: Record<string, unknown>; autonomy: string; autonomyLabel: string; allowedAutonomy: string[]; status: string; priority: number; expired: boolean; summary: Record<string, string> | null }
interface Interp { allowedAutonomy?: string[]; kind: string | null; name: string; config: Record<string, unknown>; autonomy: string; questions: Array<{ field: string; question: string; proposed: number | string | boolean }>; summary: Record<string, string> | null; analyzer: string; note: string | null }
interface Data { settings: { enabled: boolean; notifyWhatsApp: boolean; maxAlertsPerDay: number; cooldownMinutes: number }; timezone: string; aiConnected: boolean; rules: Rule[]; recommendations: Rec[]; team: Agent[]; impact: Impact[]; log: Array<{ id: string; action: string; createdAt: string; payload: Record<string, unknown> | null; actor: { fullName: string } | null }>; lists: Array<{ id: string; name: string }>; sources: string[]; whatsappLinked: string[] }

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
const ACTION: Record<string, [string, string]> = { "ai_ops.sla_needs_attention": ["חריגה מיעד חיוג ראשון", "First-dial deadline missed"], "ai_ops.sla_completed": ["נמדד חיוג ראשון", "First dial measured"], "ai_ops.sla_cancelled": ["מעקב זמן תגובה בוטל", "Response-time tracking cancelled"], "ai_ops.sla_delivery": ["מצב משלוח התראת זמן תגובה", "Response-time alert delivery"], "ai_ops.followup_asked": ["נשלחה בקשת פולואפ לנציג", "Follow-up request sent to agent"], "ai_ops.followup_answer": ["התקבלה תשובת נציג", "Agent replied"], "ai_ops.followup_completed": ["הנציג התחבר", "Agent connected"], "ai_ops.followup_expired": ["בקשת פולואפ פגה", "Follow-up request expired"], "ai_ops.followup_cancelled": ["בקשת פולואפ בוטלה", "Follow-up request cancelled"], "ai_ops.detected": ["זוהה", "Detected"], "ai_ops.manager_approved": ["מנהל אישר", "Manager approved"], "ai_ops.rejected": ["נדחה", "Rejected"], "ai_ops.agent_approved": ["נציג אישר", "Agent approved"], "ai_ops.agent_declined": ["נציג סירב", "Agent declined"], "ai_ops.allocation_started": ["הקצאה הופעלה", "Allocation started"], "ai_ops.allocation_ended": ["הקצאה הסתיימה – חזרה לחלוקה הרגילה", "Allocation ended – back to normal distribution"], "ai_ops.lead_allocated": ["ליד הוקצה במסגרת אישור", "Lead allocated under approval"], "ai_ops.expired": ["פג תוקף", "Expired"], "ai_ops.cancelled": ["בוטל", "Cancelled"], "ai_ops.failed": ["לא בוצע", "Not executed"], "ai_ops.needs_adjustment": ["נדרשת התאמה", "Needs adjustment"], "ai_ops.transfer_executed": ["ליד הועבר לנציג זמין", "Lead transferred to an available agent"], "ai_ops.settings_updated": ["הגדרות עודכנו", "Settings updated"], "ops_rule.created": ["כלל נוצר", "Rule created"], "ops_rule.updated": ["כלל עודכן", "Rule updated"], "ops_rule.deleted": ["כלל נמחק", "Rule deleted"] };
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
      {r.kind === "lead_response_sla" && r.proposal.leadId && <a className="text-xs underline" href={`/leads?leadId=${encodeURIComponent(r.proposal.leadId)}`}>{t("פתח ליד לטיפול", "Open lead")}</a>}
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
      {r.status === "pending_agent" && <div className="flex flex-wrap items-center gap-2 text-xs"><span>{t(`ממתין לתשובת ${r.agentName} עד ${time(r.expiresAt, loc)}`, `Waiting for ${r.agentName}'s reply until ${time(r.expiresAt, loc)}`)} · {r.result?.agentRequest?.delivery === "sent" ? t("נשלח בוואטסאפ", "Sent on WhatsApp") : r.result?.agentRequest?.delivery === "template" ? t("נשלחה התראה בוואטסאפ (תבנית)", "WhatsApp notification sent (template)") : t(`במערכת בלבד${r.result?.agentRequest?.detail ? ` (${r.result.agentRequest.detail})` : ""}`, `In-app only${r.result?.agentRequest?.detail ? ` (${r.result.agentRequest.detail})` : ""}`)}. {r.kind === "followup_checkin" ? t("הליד נשאר אצל הנציג עד להחלטה.", "The lead stays with the agent until a decision.") : t("בזמן ההמתנה החלוקה הרגילה ממשיכה.", "Normal distribution continues while waiting.")}</span><Button size="sm" variant="ghost" loading={busy} onClick={() => act("cancel")}>{t("ביטול", "Cancel")}</Button></div>}
      {["followup_checkin", "lead_response_sla"].includes(r.kind) && r.result?.reason && <p className="text-xs text-muted">{r.result.reason}</p>}
      {r.status === "waiting_connection" && <p className="text-xs">{t(`הנציג אמר שיתחבר. נבדוק התחברות בפועל עד ${time(r.expiresAt, loc)}; אם לא יתחבר, תתקבל התראה ללא העברה אוטומטית.`, `The agent said they will connect. We will check for an actual connection until ${time(r.expiresAt, loc)}; if they don't connect, you will get an alert with no automatic transfer.`)}</p>}
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
        <label key={k} className="flex flex-col">{t(...(({ minutes: ["דקות לחיוג ראשון", "Minutes to first dial"], requestMinutes: ["דקות להמתנה לתשובה", "Minutes to wait for a reply"], connectMinutes: ["דקות להתחברות לחייגן", "Minutes to connect to the dialer"] } as Record<string, [string, string]>)[k] ?? [k, k]))}
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
      <Textarea label={t("כתוב כלל במילים שלך", "Write a rule in your own words")} rows={2} value={text} onChange={(e) => { setText(e.target.value); setIt(null); }} placeholder={t("למשל: כשמגיע פולואפ והנציג לא מחובר לחייגן, שאל אותו בוואטסאפ אם הוא מתחבר או רוצה להעביר לנציג אחר.", "e.g. When a follow-up is due and the agent is not connected to the dialer, ask them on WhatsApp whether they are connecting or want to transfer to another agent.")} data-testid="ops-rule-text" />
      <p className="text-xs text-muted">{t("אפשר לכתוב כאן הוראות קבועות. רק חוק נתמך שתאשר יופעל; בקשה שאינה נתמכת תוצג במפורש ככזו שדורשת פיתוח. הכללים אינם משנים את סדר תור העבודה שהגדרת.", "You can write standing instructions here. Only a supported rule you approve is activated; an unsupported request is shown explicitly as needing development. Rules do not change the work-queue order you set.")}</p>
      <Button size="sm" loading={busy} disabled={text.trim().length < 5} onClick={interpret} data-testid="ops-rule-interpret">{t("הבן את הכלל", "Interpret rule")}</Button>
      {it && (
        <div className="rounded-md border border-line p-3 text-sm space-y-2" data-testid="ops-rule-preview">
          {!it.kind && <p className="text-warn" data-testid="ops-rule-unsupported">{it.note ?? t("הכלל לא נשמר ולא הופעל. נדרש בירור או פיתוח יכולת חדשה.", "The rule was not saved or activated. It needs clarification or a new capability.")}</p>}
          {it.kind && it.summary ? <>
            <div className="flex items-center gap-2"><b>{it.name}</b><Badge tone="info">{it.analyzer === "ai" ? t("פוענח ע״י המודל", "Interpreted by the model") : t("פוענח לפי תבניות", "Interpreted by patterns")}</Badge></div>
            <p className="text-xs text-muted">{t("הפירוש הראשוני מוצג כאן. הערכים ואופן האישור שתבחר למטה הם שיישמרו:", "The initial interpretation is shown here. The values and approval mode you choose below are what will be saved:")}</p>
            <dl className="grid grid-cols-[110px_1fr] gap-x-2 gap-y-1 text-xs">{Object.entries({ trigger: ["טריגר", "Trigger"], conditions: ["תנאים", "Conditions"], action: ["פעולה", "Action"], scope: ["היקף", "Scope"], validity: ["תוקף", "Validity"], limits: ["מגבלות", "Limits"], approval: ["אופן אישור", "Approval mode"] }).map(([k, [l, en]]) => <Fragment key={k}><dt className="text-muted">{t(l, en)}</dt><dd>{it.summary![k]}</dd></Fragment>)}</dl>
            {it.note && <p className="text-xs text-warn">{it.note}</p>}
          </> : null}
          {it.questions.length > 0 && <div className="space-y-1" data-testid="ops-rule-questions">{it.questions.map((q) => <label key={q.field} className="block text-xs"><span className="text-warn">❓ {q.question}</span>{q.field !== "kind" && q.field !== "config" && <input className="ms-2 h-7 w-24 rounded border border-line bg-bg px-1" value={String(answers[q.field] ?? "")} onChange={(e) => setAnswers({ ...answers, [q.field]: typeof q.proposed === "number" ? Number(e.target.value) : e.target.value })} />}</label>)}</div>}
          {it.kind && <div className="flex items-center gap-2"><select className="h-8 rounded border border-line bg-bg px-2 text-xs" value={it.autonomy} onChange={(e) => setIt({ ...it, autonomy: e.target.value })}>{(it.allowedAutonomy ?? [it.autonomy]).map(x => <option key={x} value={x}>{t(...(({ insight: ["תובנה בלבד", "Insight only"], recommend: ["המלצה באישור", "Recommend with approval"], auto: ["ביצוע אוטומטי בגבולות", "Automatic within limits"] } as Record<string, [string, string]>)[x] ?? [x, x]))}</option>)}</select><Button size="sm" onClick={save} data-testid="ops-rule-save">{t("אשר והפעל", "Approve & activate")}</Button><Button size="sm" variant="ghost" onClick={() => setIt(null)}>{t("ביטול", "Cancel")}</Button></div>}
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
  const recsOpen = d.recommendations.filter((r) => ["pending_manager", "needs_adjustment"].includes(r.status));
  const requestsOpen = d.recommendations.filter((r) => ["pending_agent", "waiting_connection", "needs_attention", "active"].includes(r.status));
  const insights = d.recommendations.filter((r) => r.status === "insight").slice(0, 8);
  const history = d.recommendations.filter((r) => ["completed", "rejected", "expired", "cancelled", "failed"].includes(r.status)).slice(0, 15);
  const setting = async (patch: Record<string, unknown>) => { try { await api.patch("/api/ops/settings", patch); await load(); } catch (e) { toast.error((e as Error).message); } };
  const rule = async (id: string, patch: Record<string, unknown> | null) => { try { if (patch) await api.patch(`/api/ops/rules/${id}`, patch); else await api.delete(`/api/ops/rules/${id}`); await load(); } catch (e) { toast.error((e as Error).message); } };
  return (
    <div className="space-y-4" data-testid="ops-tab">
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <OpsToggle field="enabled" value={d.settings.enabled} label={t("מנהל AI פעיל", "AI Manager active")} onSaved={load} help={
          <HelpTip label={t("מנהל AI פעיל", "AI Manager active")} testId="help-enabled">{t("כשהמתג פעיל, המערכת בודקת את הכללים הפעילים (למטה) בערך כל 2 דקות ויוצרת המלצות, בקשות והתראות לפיהם. ״בדוק עכשיו״ מריץ בדיקה מיד. כשהמתג כבוי לא נוצרות המלצות ובקשות חדשות ולא נשלחות התראות. הקצאות שכבר אושרו אינן מבוטלות אוטומטית – אפשר לבטל אותן מ״בקשות פתוחות״.", "When on, the system checks the active rules (below) about every 2 minutes and creates recommendations, requests and alerts from them. “Check now” runs a check immediately. When off, no new recommendations or requests are created and no alerts are sent. Allocations already approved are not cancelled automatically – you can cancel them under “Open requests”.")}</HelpTip>} />
        <OpsToggle field="notifyWhatsApp" value={d.settings.notifyWhatsApp} label={t("התראות ואישורים בוואטסאפ (למספרים מאומתים)", "Alerts and approvals on WhatsApp (verified numbers)")} onSaved={load} help={
          <HelpTip label={t("התראות ואישורים בוואטסאפ", "WhatsApp alerts and approvals")} testId="help-whatsapp">{t(`כשהמתג פעיל, המלצות ובקשות נשלחות גם בוואטסאפ למנהלים ולנציגים שחיברו ואימתו מספר אצל העוזר האישי בוואטסאפ, ואפשר לאשר או לדחות בתשובה עם מספר הבקשה (למשל ״אשר 4821״). נדרש שהעוזר בוואטסאפ יהיה פעיל. יש מגבלה של עד ${d.settings.maxAlertsPerDay} התראות ביום ו-${d.settings.cooldownMinutes} דקות צינון בין התראות מאותו סוג לאותו נציג. כשהמתג כבוי הכול ממשיך לפעול בעמוד הזה בלבד.`, `When on, recommendations and requests are also sent on WhatsApp to managers and agents who linked and verified a number with the WhatsApp assistant, and they can approve or reject by replying with the request number (e.g. “approve 4821”). The WhatsApp assistant must be enabled. Up to ${d.settings.maxAlertsPerDay} alerts a day and a ${d.settings.cooldownMinutes}-minute cooldown between alerts of the same kind for the same agent. When off, everything keeps working on this page only.`)}</HelpTip>} />
        <span className="text-xs text-muted">{t(`עד ${d.settings.maxAlertsPerDay} התראות ביום · צינון ${d.settings.cooldownMinutes} דק׳`, `Up to ${d.settings.maxAlertsPerDay} alerts/day · ${d.settings.cooldownMinutes} min cooldown`)}</span>
        {!d.aiConnected && <span className="rounded-md bg-warn/15 px-2 py-0.5 text-xs font-medium text-warn" data-testid="ops-no-model">{t("ללא מודל: המספרים והטקסטים מחושבים בקוד; פענוח כללים לפי תבניות", "No model: numbers and texts are computed in code; rules interpreted by patterns")}</span>}
        <Button size="sm" variant="secondary" className="ms-auto" loading={checking} onClick={async () => { setChecking(true); try { await api.post("/api/ops/evaluate", {}); await load(); } finally { setChecking(false); } }} data-testid="ops-evaluate">{t("בדוק עכשיו", "Check now")}</Button>
      </div>

      <Panel title={<>{t(`המלצות (${recsOpen.length})`, `Recommendations (${recsOpen.length})`)}<HelpTip label={t("המלצות", "Recommendations")} testId="help-recommendations">{t("הצעות שהמערכת יצרה לפי הכללים הפעילים וממתינות להחלטה שלך – למשל להקצות לידים נוספים לנציג שמצליח היום (״נציג במומנטום״). בכל המלצה מוצגים המספרים שעליהם היא מבוססת. אפשר לשנות את הכמות ולאשר, או לדחות. אישור של הקצאת לידים שולח בקשה לנציג, וההקצאה מתחילה רק אחרי אישורו. דחייה סוגרת את ההמלצה בלי שינוי. המלצה שלא נענתה פגה ולא מבוצעת.", "Suggestions the system created from the active rules that wait for your decision – e.g. allocating extra leads to an agent who is doing well today (“Agent on a roll”). Each shows the numbers it is based on. You can change the count and approve, or reject. Approving a lead allocation sends a request to the agent, and the allocation starts only after they approve. Rejecting closes it with no change. An unanswered recommendation expires and is never carried out.")}</HelpTip></>}>
        {recsOpen.length ? <div className="space-y-3">{recsOpen.map((r) => <RecCard key={r.id} r={r} data={d} onDone={load} />)}</div> : <EmptyState title={t("אין המלצות שממתינות להחלטה", "No recommendations waiting for a decision")} hint={t("כשמנהל AI פעיל, הכללים נבדקים בערך כל 2 דקות. המלצה תופיע כאן כשיתקיימו תנאי כלל.", "When the AI Manager is on, the rules are checked about every 2 minutes. A recommendation appears here when a rule's conditions are met.")} />}
      </Panel>

      <Panel title={<>{t(`בקשות פתוחות (${requestsOpen.length})`, `Open requests (${requestsOpen.length})`)}<HelpTip label={t("בקשות פתוחות", "Open requests")} testId="help-requests">{t("פריטים שכבר בתהליך ואינם ממתינים להחלטה שלך: בקשה שנשלחה לנציג וממתינה לתשובתו, הקצאה שמחכה שהנציג יתחבר לחייגן, הקצאה פעילה (לידים חדשים עוברים לנציג עד הכמות או המועד שאושרו), וחריגה מיעד הזמן לחיוג ראשון. אפשר לבטל בקשה או הקצאה פעילה. בסיום או בביטול, החלוקה חוזרת להיות הרגילה. לידים שכבר הוקצו נשארים אצל הנציג.", "Items already in progress that are not waiting for your decision: a request sent to an agent waiting for their answer, an allocation waiting for the agent to connect to the dialer, an active allocation (new leads go to the agent up to the approved count or time), and a missed first-dial deadline. You can cancel a request or an active allocation. When it ends or is cancelled, distribution goes back to normal. Leads already allocated stay with the agent.")}</HelpTip></>}>
        {requestsOpen.length ? <div className="space-y-3">{requestsOpen.map((r) => <RecCard key={r.id} r={r} data={d} onDone={load} />)}</div> : <EmptyState title={t("אין בקשות פתוחות", "No open requests")} hint={t("בקשות שנשלחו לנציגים והקצאות פעילות יופיעו כאן.", "Requests sent to agents and active allocations appear here.")} />}
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

      <Panel title={<>{t("השפעה נמדדת", "Measured impact")}<HelpTip label={t("השפעה נמדדת", "Measured impact")} testId="help-impact">{t("מה קרה ללידים שהוקצו לנציג במסגרת הקצאה שאושרה: כמה חויגו וכמה נסגרו לעסקה מאז תחילת ההקצאה. לצד זה מוצגת השוואה ליחידה זהה: הלידים שאותו נציג קיבל ב-14 הימים שלפני ההקצאה, וכמה מהם נסגרו עד תחילתה. זה נתון תיאורי בלבד – אין קבוצת ביקורת, ולכן ההבדל אינו מוכיח שהמערכת גרמה לשינוי. אחוזים מוצגים רק מ-20 לידים ומעלה.", "What happened to the leads allocated to an agent under an approved allocation: how many were dialed and how many closed since the allocation started. Next to it, a comparison with the same unit: the leads the same agent received in the 14 days before, and how many of them closed before it started. This is descriptive only – there is no control group, so a difference does not prove the system caused a change. Percentages are shown only from 20 leads.")}</HelpTip></>}>
        <ImpactView rows={d.impact} loc={loc} />
      </Panel>

      <Panel title={t("היסטוריה ויומן", "History & log")}>
        {history.length > 0 && <ul className="text-xs space-y-1 mb-3">{history.map((r) => <li key={r.id}><Badge tone={TERMINAL[r.status] ?? "good"}>{r.statusLabel}</Badge> {r.title} {r.result?.reason ? `– ${r.result.reason}` : ""}{typeof r.result?.responseSeconds === "number" ? t(` (${Math.floor(r.result.responseSeconds / 60)} דק׳ ו-${r.result.responseSeconds % 60} שנ׳)`, ` (${Math.floor(r.result.responseSeconds / 60)} min ${r.result.responseSeconds % 60} s)`) : ""}</li>)}</ul>}
        <ul className="text-xs space-y-0.5 max-h-72 overflow-auto" data-testid="ops-log">{d.log.map((l) => <li key={l.id}><span className="text-muted">{new Date(l.createdAt).toLocaleString(loc)}</span> · {ACTION[l.action] ? t(ACTION[l.action][0], ACTION[l.action][1]) : l.action}{l.actor ? ` · ${l.actor.fullName}` : ` · ${t("מערכת", "System")}`}{l.payload && "via" in l.payload ? ` · ${t("דרך", "via")} ${l.payload.via === "whatsapp" ? t("וואטסאפ", "WhatsApp") : l.payload.via === "app" ? t("המערכת", "the app") : String(l.payload.via)}` : ""}</li>)}</ul>
      </Panel>
    </div>
  );
}

/** A settings switch that changes on the first click, saves, and goes back (with an error) if saving fails. */
export function OpsToggle({ field, value, label, help, onSaved }: { field: "enabled" | "notifyWhatsApp"; value: boolean; label: string; help: React.ReactNode; onSaved: () => void }) {
  const t = useT();
  const [checked, setChecked] = useState(value);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Follow the server when ITS value changes (reload / 20s refresh) – never while our own save is in flight, and
  // never "back" to a value the server sent before our save (the reload after saving brings the new one).
  const [lastServer, setLastServer] = useState(value);
  if (!saving && value !== lastServer) { setLastServer(value); setChecked(value); }
  async function change(next: boolean) {
    if (saving) return; // a second click during the save is ignored, not queued
    const before = checked;
    setChecked(next); setSaving(true); setError(null);
    try {
      const saved = await api.patch<Record<string, boolean>>("/api/ops/settings", { [field]: next });
      setChecked(typeof saved?.[field] === "boolean" ? saved[field] : next);
      onSaved();
    } catch (e) {
      setChecked(before);
      const msg = (e as Error).message || t("השמירה נכשלה", "Saving failed");
      setError(msg); toast.error(t(`השינוי לא נשמר: ${msg}`, `The change was not saved: ${msg}`));
    } finally { setSaving(false); }
  }
  return (
    <span className="inline-flex flex-wrap items-center gap-1" data-testid={`ops-toggle-${field}`}>
      <label className={cx("inline-flex cursor-pointer items-center gap-1.5", saving && "opacity-70")}>
        <input type="checkbox" checked={checked} aria-disabled={saving} aria-busy={saving} onClick={(e) => { if (saving) e.preventDefault(); /* a click during the save does not toggle */ }} onChange={(e) => void change(e.target.checked)} data-testid={`ops-${field}`} />
        {label}
      </label>
      {help}
      {saving && <span className="text-[11px] text-muted" role="status">{t("שומר…", "Saving…")}</span>}
      {error && <span className="text-[11px] text-bad" role="alert" data-testid={`ops-${field}-error`}>{t("לא נשמר", "Not saved")}</span>}
    </span>
  );
}

/** "השפעה נמדדת": observed numbers vs. a comparison with the same unit; no percentages from tiny samples, no causal claim. */
export function ImpactView({ rows, loc }: { rows: Impact[]; loc: string }) {
  const t = useT();
  const date = (s: string | null) => (s ? new Date(s).toLocaleDateString(loc) : null);
  const pctOf = (a: number, b: number) => `${Math.round((a / b) * 100)}%`;
  if (!rows.length) return (
    <div className="py-4 text-sm" data-testid="ops-impact-empty">
      <p className="font-medium">{t("עדיין אין מה למדוד", "Nothing to measure yet")}</p>
      <p className="mt-1 text-xs text-muted">{t("הנתונים יופיעו אחרי שהקצאת לידים תאושר ותתחיל (המלצת ״נציג במומנטום״ שאושרה על ידי מנהל ונציג). לא מוצגים מספרים עד אז.", "Data appears after a lead allocation is approved and starts (an “Agent on a roll” recommendation approved by a manager and the agent). No numbers are shown until then.")}</p>
    </div>
  );
  return (
    <div className="space-y-3" data-testid="ops-impact">
      <p className="text-xs text-muted">{t("נתון נצפה = מה שקרה בפועל ללידים שהוקצו. השוואה = לידים שאותו נציג קיבל ב-14 הימים שלפני ההקצאה. אין קבוצת ביקורת – ההבדל אינו הוכחה להשפעה של ה-AI.", "Observed = what actually happened to the allocated leads. Comparison = leads the same agent received in the 14 days before the allocation. No control group – a difference is not proof of an AI effect.")}</p>
      {rows.map((i) => (
        <article key={i.id} className="rounded-md border border-line p-3 text-xs" data-testid="ops-impact-row">
          <div className="flex flex-wrap items-center gap-2"><b className="text-sm">{i.agentName ?? "—"}</b>
            <span className="text-muted">{t("תקופה:", "Period:")} {date(i.at)} – {i.until ? date(i.until) : t("היום (פעילה)", "today (active)")}</span>
            {i.approved != null && <span className="text-muted">· {t(`אושרו ${i.approved} לידים`, `${i.approved} leads approved`)}</span>}
          </div>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            <div className="rounded bg-panel-2 p-2">
              <p className="font-semibold">{t("נתון נצפה – הלידים שהוקצו", "Observed – the allocated leads")}</p>
              <p className="mt-1">{t(`הוקצו ${i.allocated} · חויגו ${i.dialed} · נסגרו לעסקה ${i.won}`, `Allocated ${i.allocated} · dialed ${i.dialed} · closed ${i.won}`)}</p>
              <p className="mt-1">{i.smallSample ? <span className="text-muted">{t(`מדגם קטן (פחות מ-${i.minSample} לידים) – לא מוצג אחוז`, `Small sample (under ${i.minSample} leads) – no percentage shown`)}</span> : t(`אחוז סגירה: ${pctOf(i.won, i.allocated)} (עסקאות מתוך הלידים שהוקצו)`, `Close rate: ${pctOf(i.won, i.allocated)} (deals out of allocated leads)`)}</p>
            </div>
            <div className="rounded bg-panel-2 p-2">
              <p className="font-semibold">{t("השוואה – 14 הימים שלפני", "Comparison – the 14 days before")}</p>
              {i.compare ? <>
                <p className="mt-1">{t(`${i.compare.leads} לידים שקיבל הנציג (${date(i.compare.from)}–${date(i.compare.to)}) · נסגרו ${i.compare.won}`, `${i.compare.leads} leads the agent received (${date(i.compare.from)}–${date(i.compare.to)}) · closed ${i.compare.won}`)}</p>
                <p className="mt-1">{i.compareSmall ? <span className="text-muted">{t("אין מספיק נתוני השוואה – לא מוצג אחוז", "Not enough comparison data – no percentage shown")}</span> : t(`אחוז סגירה: ${pctOf(i.compare.won, i.compare.leads)}`, `Close rate: ${pctOf(i.compare.won, i.compare.leads)}`)}</p>
              </> : <p className="mt-1 text-muted">{t("אין נתוני השוואה", "No comparison data")}</p>}
            </div>
          </div>
          {!i.until && <p className="mt-2 text-muted">{t("ההקצאה עדיין פעילה – לידים עשויים עוד להיסגר, ולכן המספרים הנצפים חלקיים.", "The allocation is still active – leads may still close, so the observed numbers are partial.")}</p>}
        </article>
      ))}
    </div>
  );
}
