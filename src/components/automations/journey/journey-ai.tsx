"use client";

import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";
import { Sparkles, X } from "lucide-react";
import { api } from "@/lib/client/api";
import { useT } from "@/components/i18n/LangProvider";
import type { DraftDef, Interpretation } from "@/server/automations/translate";

export type { Interpretation };

const EXAMPLE = "כשנכנס ליד חדש, הקצה אותו לנציג. אם לא ענה לשיחה, שלח וואטסאפ. אם כתב שהוא פנוי עכשיו, קדם אותו בתור החיוג.";

/**
 * Free text → a DRAFT (same server engine for journeys and single rules). Shows what was understood, what is not
 * supported (never drawn as a node), existing settings that already do a part, and focused questions. Nothing is
 * saved or activated here – "החלה" only fills the editor; saving / activating are separate, explicit steps.
 */
export function JourneyAiPanel({ mode, current, onApply, onClose }: { mode: "journey" | "rule"; current: DraftDef | Record<string, unknown> | null; onApply: (r: Interpretation) => void; onClose?: () => void }) {
  const t = useT();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<Interpretation | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  async function run(correct: boolean) {
    if (text.trim().length < 3) return;
    setBusy(true); setAnswers({});
    try { setRes(await api.post<Interpretation>("/api/automations/interpret", { text, mode, current: correct ? current : null })); }
    catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  }
  /** Answers to template questions fill the matching send step; nothing is guessed. */
  function withAnswers(r: Interpretation): Interpretation {
    if (!r.definition) return r;
    const steps = r.definition.steps.map((s, i) => { const q = r.questions.find((x) => x.field === `template:${s.channel}:${i}`) ?? r.questions.find((x) => x.field.startsWith(`template:${s.channel}:`)); return s.action === "send" && !s.templateId && q && answers[q.field] ? { ...s, templateId: answers[q.field] } : s; });
    const trig = answers.trigger as DraftDef["trigger"] | undefined;
    return { ...r, definition: { ...r.definition, trigger: trig ?? r.definition.trigger, steps } };
  }
  return (
    <section className="jr-ai" aria-label={t("בנייה בשפה חופשית", "Build from plain language")} data-testid="journey-ai">
      <header><strong><Sparkles size={15} /> {mode === "rule" ? t("תארו את החוק במילים", "Describe the rule in words") : t("תארו את המסע במילים", "Describe the journey in words")}</strong>{onClose && <button onClick={onClose} aria-label={t("סגור", "Close")}><X size={16} /></button>}</header>
      <textarea value={text} onChange={(e) => setText(e.target.value)} rows={3} maxLength={2000} placeholder={t(`למשל: ${EXAMPLE}`, `e.g. ${EXAMPLE}`)} data-testid="journey-ai-text" />
      <div className="jr-ai-actions">
        <button className="wz-btn primary small" onClick={() => void run(false)} disabled={busy || text.trim().length < 3} data-testid="journey-ai-run">{busy ? t("מנתח…", "Analyzing…") : t("יצירת טיוטה", "Create draft")}</button>
        {current && <button className="wz-btn ghost small" onClick={() => void run(true)} disabled={busy || text.trim().length < 3} data-testid="journey-ai-correct">{t("תיקון הטיוטה הנוכחית", "Correct the current draft")}</button>}
        <span className="jr-hint">{t("ה-AI מציע מבנה בלבד; המערכת בודקת אותו ורק אתם שומרים ומפעילים.", "The AI only proposes a structure; the system validates it and only you save and activate.")}</span>
      </div>
      {res && <div className="jr-ai-result" data-testid="journey-ai-result">
        {res.analyzer === "rules" && <p className="jr-hint">{t("ניתוח לפי כללים (חיבור AI לא פעיל) – מזהה רק ניסוחים נתמכים.", "Rule-based analysis (AI not connected) – recognizes supported phrasing only.")}</p>}
        {res.summary.length > 0 && <div><h4>{t("מה הבנו", "What we understood")}</h4><ul data-testid="journey-ai-summary">{res.summary.map((l) => <li key={l}>{l}</li>)}</ul></div>}
        {res.related.length > 0 && <div><h4>{t("כבר קיים במערכת (לא צומת במסע)", "Already handled elsewhere (not a journey node)")}</h4><ul data-testid="journey-ai-related">{res.related.map((r) => <li key={r.title}><b>{r.title}</b> – {r.detail} <Link href={r.href}>{t("להגדרה", "Settings")}</Link></li>)}</ul></div>}
        {res.unsupported.length > 0 && <div className="warn"><h4>{t("לא נתמך – לא נוסף לתרשים", "Not supported – not added to the diagram")}</h4><ul data-testid="journey-ai-unsupported">{res.unsupported.map((u) => <li key={u.text + u.reason}><b>{u.text}</b> – {u.reason}</li>)}</ul></div>}
        {res.questions.length > 0 && <div><h4>{t("חסר מידע", "Missing information")}</h4>{res.questions.map((q) => <label key={q.field} className="jr-ai-q">{q.question}{q.options?.length ? <select value={answers[q.field] ?? ""} onChange={(e) => setAnswers((a) => ({ ...a, [q.field]: e.target.value }))} data-testid={`journey-ai-q-${q.field.split(":")[0]}`}><option value="">{t("בחרו…", "Choose…")}</option>{q.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select> : <span className="jr-hint">{t("אפשר לענות בטקסט ולבחור \"תיקון הטיוטה\", או להשלים ידנית בתרשים.", "Answer in text and choose \"Correct\", or complete it manually in the diagram.")}</span>}</label>)}</div>}
        {res.definition ? <button className="wz-btn primary small" onClick={() => onApply(withAnswers(res))} data-testid="journey-ai-apply">{mode === "rule" ? t("יצירת טיוטה לעריכה", "Create a draft to edit") : t("החלה על התרשים", "Apply to the diagram")}</button>
          : <p className="jr-hint" data-testid="journey-ai-nothing">{t("לא זוהו טריגר ופעולה נתמכים – נסו לנסח מחדש או לבנות ידנית.", "No supported trigger and action were recognized – rephrase or build manually.")}</p>}
      </div>}
    </section>
  );
}
