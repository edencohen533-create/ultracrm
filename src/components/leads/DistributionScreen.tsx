"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "@/lib/client/api";
import { Badge, Button, Input, Select, Spinner, Textarea, cx } from "@/components/ui";
import { useT } from "@/components/i18n/LangProvider";
import type { LeadAssignmentSettings } from "@/lib/lead-statuses";

interface Agent { id: string; name: string; role: string; openLeads: number; untouched: number; online: boolean; cap: number | null; eligible: boolean; why: string | null }
interface Summary { trigger: string; conditions: string; action: string; scope: string; validity: string; limits: string; approval: string }
interface RuleRow { id: string; name: string; status: "draft" | "active" | "paused"; priority: number; autonomy: string; sourceText: string | null; config: BonusConfig; summary: Summary | null; today: { condition: { state: string; text: string }; request: { status: string; requestedCount: number | null } | null } | null; conflicts: string[] }
interface Overview { policy: LeadAssignmentSettings; timezone: string; loadCap: number | null; agents: Agent[]; next: { id: string; name: string } | null; rules: RuleRow[] }
interface BonusConfig { agentId?: string; threshold?: number; minHandled?: number; bonusCount?: number; frequency?: string; source?: string | null; listId?: string | null; fromUnassigned?: boolean }
interface Question { field: string; question: string; proposed: number | string | boolean; options?: Array<{ value: string; label: string }> }
interface Interp { kind: string | null; name: string; config: BonusConfig; autonomy: "recommend" | "auto"; questions: Question[]; summary: Summary | null; note: string | null; analyzer: string; policyHint?: "round_robin" | "least_loaded" | null }
interface Sim { rows: Array<{ n: number; agent: string; why: string }>; tally: Array<{ agent: string; leads: number }>; ruleNote: string | null }

const STATUS_LABEL: Record<string, string> = { draft: "טיוטה – לא פעיל", active: "פעיל", paused: "מושהה" };
const REQ_LABEL: Record<string, string> = { pending_manager: "ממתין לאישור מנהל", pending_agent: "ממתין לתשובת הנציג", executing: "בביצוע", active: "תוספת פעילה", completed: "התוספת הושלמה", rejected: "נדחה", expired: "פג תוקף", failed: "לא בוצע", needs_adjustment: "נדרשת התאמה" };

/**
 * "חלוקת לידים" (owner only – the server enforces it): the regular policy (round robin / least loaded, who takes part,
 * caps, availability, what happens when nobody is eligible) and distribution rules written in free text → a structured
 * rule, shown in Hebrew, previewed, saved as a draft, and activated only by the owner.
 */
export function DistributionScreen() {
  const t = useT();
  const [o, setO] = useState<Overview | null>(null);
  const [p, setP] = useState<LeadAssignmentSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const load = useCallback(async () => { try { const r = await api.get<Overview>("/api/distribution"); setO(r); setP(r.policy); } catch (e) { toast.error((e as Error).message); } }, []);
  useEffect(() => { void load(); }, [load]);
  async function savePolicy(next = p) {
    if (!next) return; setSaving(true);
    try { await api.patch("/api/lead-statuses", { leadAssignment: { mode: next.mode, maxOpenLeadsPerAgent: next.maxOpenLeadsPerAgent, agentIds: next.agentIds, perAgentMax: next.perAgentMax ?? {}, requireOnline: Boolean(next.requireOnline), whenNoneOnline: next.whenNoneOnline ?? "unassigned" } }); toast.success(t("החלוקה נשמרה", "Distribution saved")); await load(); }
    catch (e) { toast.error((e as Error).message); } finally { setSaving(false); }
  }
  if (!o || !p) return <div className="flex justify-center p-10"><Spinner /></div>;
  const inPool = (id: string) => !p.agentIds.length || p.agentIds.includes(id);
  const rr = p.mode === "round_robin";
  return (
    <div className="space-y-5" data-testid="distribution-screen">
      <section className="space-y-3" aria-labelledby="dist-policy">
        <h3 id="dist-policy" className="text-sm font-semibold">{t("איך מחולקים לידים חדשים", "How new leads are distributed")}</h3>
        <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label={t("שיטת חלוקה", "Distribution method")}>
          {([["round_robin", t("סבב – Round Robin", "Round robin"), t("כל ליד חדש לנציג הבא בתור, לפי הסדר. נציג שלא זכאי כרגע מדולג, והסבב ממשיך ממקומו.", "Each new lead to the next agent in turn. An agent not eligible right now is skipped; the rotation continues from their place.")], ["least_loaded", t("לנציג עם הכי פחות לידים פתוחים", "To the agent with the fewest open leads"), t("מאזן לפי עומס: הליד הולך למי שיש לו הכי מעט לידים פתוחים כרגע.", "Balances by load: the lead goes to whoever has the fewest open leads right now.")]] as const).map(([k, title, text]) => (
            <label key={k} className={cx("cursor-pointer rounded-lg border p-3 text-sm", p.mode === k ? "border-accent bg-accent/5" : "border-line")} data-testid={`dist-mode-${k}`}>
              <span className="flex items-center gap-2 font-medium"><input type="radio" name="dist-mode" checked={p.mode === k} onChange={() => setP({ ...p, mode: k })} />{title}</span>
              <span className="mt-1 block text-xs text-muted">{text}</span>
            </label>
          ))}
        </div>
        {rr && o.next && <p className="text-xs" data-testid="dist-next">{t("הבא בתור עכשיו:", "Next in turn now:")} <b>{o.next.name}</b></p>}
        <div className="overflow-x-auto rounded-lg border border-line">
          <table className="w-full min-w-[520px] text-sm" data-testid="dist-agents">
            <thead><tr className="text-xs text-muted"><th className="p-2 text-start">{t("משתתף", "Takes part")}</th><th className="p-2 text-start">{t("נציג", "Agent")}</th><th className="p-2 text-start">{t("לידים פתוחים", "Open leads")}</th><th className="p-2 text-start">{t("מקסימום פתוחים", "Max open")}</th><th className="p-2 text-start">{t("מקבל עכשיו?", "Receives now?")}</th></tr></thead>
            <tbody>{o.agents.map((a) => { const per = p.perAgentMax ?? {}; return (
              <tr key={a.id} className="border-t border-line">
                <td className="p-2"><input type="checkbox" checked={p.agentIds.includes(a.id)} onChange={(e) => setP({ ...p, agentIds: e.target.checked ? [...p.agentIds, a.id] : p.agentIds.filter((x) => x !== a.id) })} aria-label={t(`${a.name} בחלוקה`, `${a.name} in distribution`)} /></td>
                <td className={cx("p-2", !inPool(a.id) && "text-muted")}>{a.name}{p.requireOnline && <span className={cx("ms-1 inline-block h-2 w-2 rounded-full", a.online ? "bg-good" : "bg-line")} title={a.online ? t("מחובר לחייגן", "Connected") : t("לא מחובר", "Not connected")} />}</td>
                <td className="p-2 tabular-nums">{a.openLeads}</td>
                <td className="p-2"><input type="number" min={0} className="h-8 w-24 rounded-md border border-line px-2 ltr" placeholder={p.maxOpenLeadsPerAgent ? String(p.maxOpenLeadsPerAgent) : t("ללא", "None")} value={per[a.id] ?? ""} onChange={(e) => { const v = e.target.value; const next = { ...per }; if (v === "") delete next[a.id]; else next[a.id] = Math.max(0, Number(v) || 0); setP({ ...p, perAgentMax: next }); }} /></td>
                <td className="p-2 text-xs">{a.eligible ? <span className="text-good">{t("כן", "Yes")}</span> : <span className="text-muted">{a.why ?? "—"}</span>}</td>
              </tr>); })}</tbody>
          </table>
        </div>
        <p className="text-[11px] text-muted">{t("לא סומן אף נציג = כולם משתתפים. ״מקבל עכשיו״ מחושב לפי מה שנשמר.", "No agent checked = everyone takes part. \"Receives now\" reflects what's saved.")}</p>
        <div className="grid gap-2 sm:grid-cols-2">
          <Input label={t("ברירת מחדל: מקסימום לידים פתוחים לנציג (0 = ללא)", "Default: max open leads per agent (0 = none)")} type="number" min={0} value={String(p.maxOpenLeadsPerAgent)} onChange={(e) => setP({ ...p, maxOpenLeadsPerAgent: Math.max(0, Number(e.target.value) || 0) })} ltr />
          <div className="space-y-1 text-sm">
            <label className="flex items-center gap-2"><input type="checkbox" checked={Boolean(p.requireOnline)} onChange={(e) => setP({ ...p, requireOnline: e.target.checked })} data-testid="dist-require-online" />{t("רק נציגים שמחוברים לחייגן כרגע", "Only agents connected to the dialer now")}</label>
            {p.requireOnline && <Select aria-label={t("כשאף נציג לא מחובר", "When nobody is connected")} value={p.whenNoneOnline ?? "unassigned"} onChange={(e) => setP({ ...p, whenNoneOnline: e.target.value as "unassigned" | "any_eligible" })}><option value="unassigned">{t("כשאף אחד לא מחובר – הליד נשאר ללא שיוך", "Nobody connected – the lead stays unassigned")}</option><option value="any_eligible">{t("כשאף אחד לא מחובר – לכל נציג זכאי אחר", "Nobody connected – to any other eligible agent")}</option></Select>}
          </div>
        </div>
        <ul className="list-disc space-y-0.5 rounded-lg bg-bg p-3 ps-6 text-xs text-muted" data-testid="dist-explain">
          <li>{t("זכאי לקבל ליד: נציג פעיל שמשתתף בחלוקה, מתחת למקסימום הלידים הפתוחים שלו", "Eligible: an active agent in the distribution, under their max open leads")}{o.loadCap ? t(`, עם פחות מ-${o.loadCap} לידים שטרם טופלו (כלל עומס)`, `, with fewer than ${o.loadCap} untouched leads (load rule)`) : ""}{p.requireOnline ? t(" ומחובר לחייגן (5 הדקות האחרונות)", " and connected to the dialer (last 5 minutes)") : ""}.</li>
          <li>{t("אין נציג זכאי → הליד נשאר ״ללא שיוך״ (מסנן בלשונית הלידים) והסיבה נרשמת.", "No eligible agent → the lead stays \"unassigned\" (a filter on the leads tab) and the reason is recorded.")}</li>
          <li>{t("כמה לידים שנכנסים באותו רגע מחולקים אחד-אחד (נעילה) – אף ליד לא ניתן פעמיים ואף תור לא מדולג.", "Leads arriving at the same moment are handed out one by one (a lock) – no lead twice, no turn skipped.")}</li>
          <li>{t("לידים שכבר שייכים לנציג לא מועברים כדי לאזן – רק העברה מפורשת ומורשית משנה בעלות.", "Leads that already belong to an agent are never moved to balance – only an explicit, authorized transfer changes ownership.")}</li>
          <li>{t("לכל ליד נרשם למה הוקצה (או למה נשאר ללא שיוך) בהיסטוריית הליד.", "Each lead records why it was assigned (or left unassigned) in its history.")}</li>
        </ul>
        <div className="flex justify-end"><Button onClick={() => void savePolicy()} loading={saving} data-testid="assignment-save">{t("שמור חלוקה", "Save distribution")}</Button></div>
      </section>
      <RulesSection overview={o} onChanged={load} onApplyPolicy={(mode) => { const next = { ...p, mode }; setP(next); void savePolicy(next); }} />
    </div>
  );
}

function RulesSection({ overview, onChanged, onApplyPolicy }: { overview: Overview; onChanged: () => void; onApplyPolicy: (m: "round_robin" | "least_loaded") => void }) {
  const t = useT();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [interp, setInterp] = useState<Interp | null>(null);
  const [answers, setAnswers] = useState<BonusConfig>({});
  const [confirmedFreq, setConfirmedFreq] = useState(false);
  const [sim, setSim] = useState<{ title: string; data: Sim } | null>(null);
  const names = Object.fromEntries(overview.agents.map((a) => [a.id, a.name]));
  const config: BonusConfig = { ...Object.fromEntries((interp?.questions ?? []).filter((q) => q.proposed !== "" && q.field !== "frequency").map((q) => [q.field, q.proposed])), ...(interp?.config ?? {}), ...answers, frequency: "once_per_day" };
  const needsFreq = Boolean(interp?.questions.some((q) => q.field === "frequency"));
  const complete = Boolean(interp?.kind === "performance_bonus" && config.agentId && config.threshold && config.minHandled && config.bonusCount && (!needsFreq || confirmedFreq));

  async function interpret() {
    setBusy("interpret"); setSim(null);
    try { const r = await api.post<Interp>("/api/distribution/interpret", { text }); setInterp(r); setAnswers({}); setConfirmedFreq(false); }
    catch (e) { toast.error((e as Error).message); } finally { setBusy(null); }
  }
  async function preview(cfg: BonusConfig, title: string) {
    setBusy("preview");
    try { setSim({ title, data: await api.post<Sim>("/api/distribution/simulate", { count: 20, rule: { config: cfg }, assumeConditionMet: true }) }); }
    catch (e) { toast.error((e as Error).message); } finally { setBusy(null); }
  }
  async function saveDraft() {
    if (!interp) return; setBusy("save");
    try { await api.post("/api/distribution/rules", { name: interp.name, config, autonomy: interp.autonomy, sourceText: text }); toast.success(t("נשמר כטיוטה – לא פעיל עד שתאשר", "Saved as a draft – inactive until you approve")); setInterp(null); setText(""); onChanged(); }
    catch (e) { toast.error((e as Error).message); } finally { setBusy(null); }
  }
  async function setStatus(r: RuleRow, status: "active" | "paused" | "draft") {
    setBusy(r.id);
    try { const u = await api.patch<{ conflicts: string[] }>(`/api/distribution/rules/${r.id}`, { status }); toast.success(status === "active" ? t("הכלל אושר והופעל", "Rule approved and activated") : t("עודכן", "Updated")); if (u.conflicts?.length) toast.warning(u.conflicts.join(" · ")); onChanged(); }
    catch (e) { toast.error((e as Error).message); } finally { setBusy(null); }
  }
  async function remove(r: RuleRow) {
    if (!window.confirm(t(`למחוק את הכלל "${r.name}"? מה שכבר הוקצה נשאר.`, `Delete "${r.name}"? What was already assigned stays.`))) return;
    setBusy(r.id); try { await api.delete(`/api/distribution/rules/${r.id}`); onChanged(); } catch (e) { toast.error((e as Error).message); } finally { setBusy(null); }
  }
  const fields = (c: BonusConfig, s: Summary | null) => [
    [t("נציג", "Agent"), c.agentId ? names[c.agentId] ?? "—" : "—"],
    [t("מדד", "Metric"), t("יחס סגירה היום = עסקאות שנסגרו בזכייה ÷ לידים שטופלו (חויגו בפועל)", "Today's close rate = deals won ÷ leads handled (really dialed)")],
    [t("תנאי", "Condition"), c.threshold ? t(`מעל ${Math.round(c.threshold * 1000) / 10}%, אחרי לפחות ${c.minHandled ?? "?"} לידים שטופלו היום`, `Above ${Math.round(c.threshold * 1000) / 10}%, after at least ${c.minHandled ?? "?"} leads handled today`) : "—"],
    [t("תקופה", "Period"), t(`היום, לפי שעון העסק (${overview.timezone})`, `Today, business time (${overview.timezone})`)],
    [t("פעולה", "Action"), c.bonusCount && c.agentId ? t(`תוספת חד-פעמית של ${c.bonusCount} לידים חדשים שטרם הוקצו היום ל${names[c.agentId] ?? "נציג"} – על חשבון החלוקה הרגילה: הלידים נלקחים מהתור של האחרים והסבב לא מתקדם; אחרי ${c.bonusCount} הלידים חוזרים לחלוקה הרגילה.`, `A one-time bonus of ${c.bonusCount} new, not-yet-assigned leads today for ${names[c.agentId] ?? "the agent"} – at the expense of the regular split: taken from the others' turns, the rotation doesn't advance; after ${c.bonusCount} leads, back to normal.`) : s?.action ?? "—"],
    [t("מכסה", "Cap"), c.bonusCount ? t(`${c.bonusCount} לידים, עד הקיבולת הפנויה של הנציג`, `${c.bonusCount} leads, up to the agent's spare capacity`) : "—"],
    [t("תדירות", "Frequency"), t("פעם אחת ביום עסקים; לא מופעל שוב באותו יום", "Once per business day; not again the same day")],
    [t("תוקף", "Validity"), t("עד סוף היום או המשמרת; הכלל עצמו עד שתשהה או תמחק", "Until the end of the day / shift; the rule until you pause or delete it")],
    [t("אישורים", "Approvals"), s?.approval ?? t("הכלל פועל רק אחרי אישורך. כל תוספת עוברת את מדיניות האישור של העסק (ברירת מחדל: אישור מנהל) ואת אישור הנציג לפי מדיניות ״לידים נוספים״.", "The rule works only after you approve it. Each bonus goes through the business's approval policy (default: manager approval) and the agent's confirmation per the extra-leads policy.")],
  ] as Array<[string, string]>;

  return (
    <section className="space-y-3 border-t border-line pt-4" aria-labelledby="dist-rules">
      <h3 id="dist-rules" className="text-sm font-semibold">{t("כללי חלוקה", "Distribution rules")}</h3>
      <Textarea label={t("תאר איך לחלק את הלידים", "Describe how to distribute leads")} rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder={t("לדוגמה: חלק לידים בצורה שווה לכולם, אבל אם יחס הסגירה של אבי היום עולה על 17%, תן לו 7 לידים נוספים על חשבון החלוקה הרגילה.", "e.g. Split leads evenly, but if Avi's close rate today is above 17%, give him 7 extra leads at the expense of the regular split.")} data-testid="dist-rule-text" />
      <div className="flex gap-2"><Button size="sm" onClick={interpret} loading={busy === "interpret"} disabled={text.trim().length < 5} data-testid="dist-rule-interpret">{t("הצג פרשנות", "Interpret")}</Button></div>
      {interp && (
        <div className="space-y-3 rounded-lg border border-accent/40 p-3" data-testid="dist-interpretation">
          {!interp.kind || interp.kind !== "performance_bonus" ? <p className="text-sm">{interp.note ?? t("לא זוהה כלל חלוקה נתמך. אפשר לנסח מחדש.", "No supported distribution rule was recognised. Try rephrasing.")}</p> : <>
            <p className="text-sm font-medium">{t("כך הבנתי את הכלל:", "This is how I understood the rule:")}</p>
            <dl className="grid gap-x-3 gap-y-1 text-sm sm:grid-cols-[8rem_1fr]">{fields(config, interp.summary).map(([k, v]) => <div key={k} className="contents"><dt className="text-muted">{k}</dt><dd>{v}</dd></div>)}</dl>
            {interp.policyHint && interp.policyHint !== overview.policy.mode && <p className="rounded bg-warn/10 p-2 text-xs">{t("החלק ״חלק בצורה שווה״ = סבב (Round Robin). כרגע החלוקה היא לפי עומס.", "\"Split evenly\" = round robin. Right now distribution is by load.")} <button type="button" className="underline" onClick={() => onApplyPolicy("round_robin")} data-testid="dist-apply-rr">{t("להחליף לסבב", "Switch to round robin")}</button></p>}
            {interp.questions.length > 0 && <div className="space-y-2" data-testid="dist-questions"><p className="text-xs font-medium">{t("לפני שמירה – כמה הבהרות שמשנות את משמעות הכלל:", "Before saving – a few clarifications that change the rule's meaning:")}</p>
              {interp.questions.map((q) => (
                <div key={q.field} className="rounded bg-bg p-2 text-sm">
                  <p className="mb-1">{q.question}</p>
                  {q.field === "agentId" ? <Select aria-label={q.question} value={answers.agentId ?? ""} onChange={(e) => setAnswers({ ...answers, agentId: e.target.value })}><option value="">{t("בחר נציג", "Choose agent")}</option>{(q.options ?? []).map((op) => <option key={op.value} value={op.value}>{op.label}</option>)}</Select>
                    : q.field === "frequency" ? <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={confirmedFreq} onChange={(e) => setConfirmedFreq(e.target.checked)} data-testid="dist-confirm-frequency" />{t("כן – פעם אחת ביום, ואחרי מימוש התוספת חוזרים לחלוקה הרגילה", "Yes – once a day; after the bonus, back to the regular split")}</label>
                    : q.field === "threshold" ? <Input type="number" min={1} max={100} aria-label={q.question} value={String(Math.round(((answers.threshold ?? (q.proposed as number)) || 0) * 100))} onChange={(e) => setAnswers({ ...answers, threshold: Number(e.target.value) / 100 })} className="w-28" ltr />
                    : <Input type="number" min={1} aria-label={q.question} value={String((answers as Record<string, unknown>)[q.field] ?? q.proposed)} onChange={(e) => setAnswers({ ...answers, [q.field]: Number(e.target.value) })} className="w-28" ltr data-testid={`dist-q-${q.field}`} />}
                </div>
              ))}</div>}
            {interp.note && <p className="text-xs text-muted">{interp.note}</p>}
            <p className="text-[11px] text-muted">{interp.analyzer === "ai" ? t("פורש על ידי AI; הביצוע במנוע הכללים.", "Interpreted by AI; executed by the rules engine.") : t("פורש על ידי מנתח כללים; הביצוע במנוע הכללים.", "Interpreted by the rules parser; executed by the rules engine.")}</p>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="secondary" onClick={() => void preview(config, t("תצוגה מקדימה של הכלל החדש", "Preview of the new rule"))} disabled={!complete} loading={busy === "preview"} data-testid="dist-preview">{t("תצוגה מקדימה (20 לידים)", "Preview (20 leads)")}</Button>
              <Button size="sm" onClick={saveDraft} disabled={!complete} loading={busy === "save"} data-testid="dist-save-draft">{t("שמור כטיוטה", "Save as draft")}</Button>
            </div>
          </>}
        </div>
      )}
      {sim && <SimTable sim={sim} onClose={() => setSim(null)} />}
      {overview.rules.length > 0 && (
        <ul className="space-y-2" data-testid="dist-rules-list">
          {overview.rules.map((r) => (
            <li key={r.id} className="rounded-lg border border-line p-3 text-sm" data-testid={`dist-rule-${r.id}`}>
              <div className="flex flex-wrap items-center gap-2"><b className="flex-1">{r.name}</b><Badge tone={r.status === "active" ? "good" : r.status === "draft" ? "warn" : "neutral"}>{STATUS_LABEL[r.status] ?? r.status}</Badge></div>
              {r.sourceText && <p className="mt-1 text-xs text-muted">״{r.sourceText}״</p>}
              {r.summary && <p className="mt-1 text-xs">{r.summary.conditions} {r.summary.action}</p>}
              {r.today && r.status === "active" && <p className="mt-1 text-xs" data-testid="dist-rule-today">{t("היום:", "Today:")} {r.today.request ? (REQ_LABEL[r.today.request.status] ?? r.today.request.status) : r.today.condition.text}</p>}
              {r.conflicts.map((c) => <p key={c} className="mt-1 text-xs text-warn">{c}</p>)}
              <div className="mt-2 flex flex-wrap gap-2">
                {r.status !== "active" && <Button size="sm" onClick={() => void setStatus(r, "active")} loading={busy === r.id} data-testid={`dist-rule-activate-${r.id}`}>{r.status === "draft" ? t("אשר והפעל", "Approve & activate") : t("הפעל", "Activate")}</Button>}
                {r.status === "active" && <Button size="sm" variant="secondary" onClick={() => void setStatus(r, "paused")} loading={busy === r.id}>{t("השהה", "Pause")}</Button>}
                <Button size="sm" variant="ghost" onClick={() => void preview(r.config, t(`תצוגה מקדימה: ${r.name}`, `Preview: ${r.name}`))}>{t("תצוגה מקדימה", "Preview")}</Button>
                <Button size="sm" variant="ghost" className="text-bad" onClick={() => void remove(r)}>{t("מחק", "Delete")}</Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function SimTable({ sim, onClose }: { sim: { title: string; data: Sim }; onClose: () => void }) {
  const t = useT();
  return (
    <div className="rounded-lg border border-line p-3 text-sm" data-testid="dist-sim">
      <div className="mb-1 flex items-center justify-between"><b>{sim.title}</b><button type="button" className="text-xs underline" onClick={onClose}>{t("סגור", "Close")}</button></div>
      <p className="mb-2 text-xs text-muted">{t("סימולציה בלבד – לא הוקצו לידים. מניחה שהתנאי מתקיים עכשיו ושלא נכנסים לידים אחרים בינתיים.", "Simulation only – no leads were assigned. Assumes the condition holds now and no other leads arrive meanwhile.")}</p>
      {sim.data.ruleNote && <p className="mb-2 text-xs">{sim.data.ruleNote}</p>}
      <p className="mb-2 text-xs">{sim.data.tally.map((x) => `${x.agent}: ${x.leads}`).join(" · ")}</p>
      <div className="max-h-64 overflow-auto"><table className="w-full text-xs"><thead><tr className="text-muted"><th className="p-1 text-start">#</th><th className="p-1 text-start">{t("נציג", "Agent")}</th><th className="p-1 text-start">{t("למה", "Why")}</th></tr></thead><tbody>{sim.data.rows.map((r) => <tr key={r.n} className="border-t border-line"><td className="p-1">{r.n}</td><td className="p-1">{r.agent}</td><td className="p-1 text-muted">{r.why}</td></tr>)}</tbody></table></div>
    </div>
  );
}
