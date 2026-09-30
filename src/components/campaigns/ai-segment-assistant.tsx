"use client";
import { useState } from "react";
import { Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useT } from "@/components/i18n/LangProvider";
import type { AudienceNode } from "@/lib/audiences";

interface Draft { name: string; segment: AudienceNode; explanation: string; assumptions: string[]; unsupported: string[]; matched: number }

/** "תאר את הקהל במילים" – the AI proposes conditions; they land in the builder below for review / editing. Nothing is saved here. */
export function AiSegmentAssistant({ onDraft }: { onDraft: (d: { name: string; segment: AudienceNode }) => void }) {
  const t = useT();
  const [prompt, setPrompt] = useState(""); const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null); const [error, setError] = useState("");
  async function build() {
    setBusy(true); setError(""); setDraft(null);
    try {
      const r = await fetch("/api/distribution-lists/ai-draft", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error ?? t("בניית הסגמנט נכשלה", "Building the segment failed"));
      setDraft(d); onDraft({ name: d.name, segment: d.segment });
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  return (
    <div className="space-y-2 rounded-lg border border-violet-300/60 bg-violet-500/5 p-3" data-testid="ai-segment">
      <label className="block text-sm font-medium" htmlFor="ai-segment-prompt"><Sparkles size={14} className="inline me-1" aria-hidden />{t("תאר את הקהל במילים", "Describe the audience in words")}</label>
      <textarea id="ai-segment-prompt" className="w-full rounded-md border bg-background p-2 text-sm" rows={2} maxLength={1000} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder={t("למשל: אנשים שרכשו פרוביוטיקה ב-14 הימים האחרונים ואחרי שבוע רכשו מוצר נוסף", "e.g. people who bought probiotics in the last 14 days and a week later bought another product")} data-testid="ai-segment-prompt" />
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={() => void build()} disabled={busy || prompt.trim().length < 4} data-testid="ai-segment-build">{busy ? t("בונה…", "Building…") : t("בנה תנאים עם AI", "Build conditions with AI")}</Button>
        <span className="text-xs text-muted-foreground">{t("התנאים יופיעו למטה לבדיקה ועריכה לפני השמירה.", "The conditions appear below to review and edit before saving.")}</span>
      </div>
      {error && <p role="alert" className="text-sm text-destructive" data-testid="ai-segment-error">{error}</p>}
      {draft && <div className="space-y-1 text-sm" data-testid="ai-segment-result">
        <p><b>{t("איך הבנתי:", "How I understood it:")}</b> {draft.explanation}</p>
        {draft.assumptions.length > 0 && <ul className="list-disc ps-5 text-xs">{draft.assumptions.map((a, i) => <li key={i}>{t("הנחה:", "Assumption:")} {a}</li>)}</ul>}
        {draft.unsupported.length > 0 && <ul className="list-disc ps-5 text-xs text-warn" data-testid="ai-segment-unsupported">{draft.unsupported.map((a, i) => <li key={i}>{t("לא נכלל (אין תנאי כזה):", "Not included (no such condition):")} {a}</li>)}</ul>}
        <p className="text-xs">{t(`כרגע ${draft.matched.toLocaleString("he-IL")} אנשי קשר עומדים בתנאים.`, `${draft.matched} contacts currently match.`)}</p>
      </div>}
    </div>
  );
}
