"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useT } from "@/components/i18n/LangProvider";

interface Suggestion { id: string; text: string; handoffReason: string | null }

/** "הצעות" mode: the service AI's reply waits here – the agent edits / sends / dismisses. Nothing is sent without it. */
export function AiSuggestion({ conversationId }: { conversationId: string }) {
  const t = useT(); const router = useRouter();
  const [s, setS] = useState<Suggestion | null>(null); const [text, setText] = useState(""); const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    const r = await fetch(`/api/conversations/${conversationId}/ai/suggestion`, { cache: "no-store" }).then((x) => x.json()).catch(() => null);
    const next = (r?.data ?? null) as Suggestion | null;
    setS((prev) => { if (next?.id !== prev?.id) setText(next?.text ?? ""); return next; });
  }, [conversationId]);
  useEffect(() => { void load(); const iv = setInterval(() => { if (document.visibilityState === "visible") void load(); }, 8000); return () => clearInterval(iv); }, [load]);
  if (!s) return null;
  async function decide(decision: "send" | "dismiss") {
    setBusy(true);
    try {
      const r = await fetch(`/api/conversations/${conversationId}/ai/suggestion`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ actionId: s!.id, decision, ...(decision === "send" ? { text } : {}) }) });
      const j = await r.json(); if (!r.ok || j.success === false) throw new Error(j.error ?? "שגיאה");
      toast.success(decision === "send" ? t("התשובה נשלחה", "Reply sent") : t("ההצעה נדחתה", "Suggestion dismissed"));
      setS(null); router.refresh();
    } catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  }
  return (
    <div className="border-b bg-violet-500/5 px-3 py-2 text-sm" data-testid="ai-suggestion">
      <p className="text-xs font-medium">{t("🤖 הצעת תשובה של נציג ה-AI – ממתינה לאישורך", "🤖 AI reply suggestion – awaiting your approval")}{s.handoffReason ? ` · ${s.handoffReason}` : ""}</p>
      <textarea className="mt-1 w-full rounded-md border border-line bg-background p-2 text-sm" rows={3} value={text} onChange={(e) => setText(e.target.value)} aria-label={t("עריכת ההצעה", "Edit suggestion")} data-testid="ai-suggestion-text" />
      <div className="mt-1 flex gap-2">
        <Button size="sm" onClick={() => void decide("send")} disabled={busy || !text.trim()} data-testid="ai-suggestion-send">{t("שלח ללקוח", "Send to customer")}</Button>
        <Button size="sm" variant="outline" onClick={() => void decide("dismiss")} disabled={busy} data-testid="ai-suggestion-dismiss">{t("בטל", "Dismiss")}</Button>
      </div>
    </div>
  );
}
