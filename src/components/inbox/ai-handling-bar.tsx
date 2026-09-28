"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useT } from "@/components/i18n/LangProvider";

/** Who handles this conversation: the customer-service AI or a person. "קח טיפול" stops the AI immediately (server-side). */
export function AiHandlingBar({ conversationId, aiMode, enabledHere, reason, summary }: { conversationId: string; aiMode: string | null; enabledHere: boolean; reason: string | null; summary: string | null }) {
  const t = useT();
  const router = useRouter(); const [busy, setBusy] = useState(false);
  const human = aiMode === "human"; const handoff = aiMode === "handoff";
  async function set(mode: "human" | "ai") {
    setBusy(true);
    try { const r = await fetch(`/api/conversations/${conversationId}/ai`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode }) }); const j = await r.json(); if (!r.ok || j.success === false) throw new Error(j.error ?? t("שגיאה", "Error")); toast.success(mode === "human" ? t("לקחת את הטיפול – הנציג האוטומטי לא יענה בשיחה", "You took over – the AI agent will no longer reply in this conversation") : t("השיחה הוחזרה לנציג ה-AI", "Conversation handed back to the AI agent")); router.refresh(); }
    catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  }
  return (
    <div className={`border-b px-3 py-2 text-sm flex flex-wrap items-center gap-2 ${handoff ? "bg-amber-500/10" : human ? "" : "bg-violet-500/10"}`} data-testid="ai-handling-bar" data-mode={aiMode ?? "ai"}>
      <span className="font-medium">{human ? t("👤 נציג אנושי מטפל", "👤 Human agent handling") : handoff ? t("⏳ הועבר לנציג – ממתין לטיפול", "⏳ Handed off to an agent – awaiting response") : t("🤖 נציג AI מטפל", "🤖 AI agent handling")}</span>
      {!enabledHere && !human && <span className="text-xs text-muted-foreground">{t("(המענה האוטומטי כבוי לערוץ הזה)", "(Auto-reply is off for this channel)")}</span>}
      {handoff && reason && <span className="text-xs">{t("סיבה:", "Reason:")} {reason}</span>}
      {handoff && summary && <span className="text-xs text-muted-foreground w-full">{t("סיכום:", "Summary:")} {summary}</span>}
      <span className="ms-auto flex gap-2">
        {!human && <Button size="sm" onClick={() => set("human")} disabled={busy} data-testid="ai-take-over">{t("קח טיפול", "Take over")}</Button>}
        {(human || handoff) && enabledHere && <Button size="sm" variant="outline" onClick={() => set("ai")} disabled={busy} data-testid="ai-return">{t("החזר ל-AI", "Return to AI")}</Button>}
      </span>
    </div>
  );
}
