"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";

/** Who handles this conversation: the customer-service AI or a person. "קח טיפול" stops the AI immediately (server-side). */
export function AiHandlingBar({ conversationId, aiMode, enabledHere, reason, summary }: { conversationId: string; aiMode: string | null; enabledHere: boolean; reason: string | null; summary: string | null }) {
  const router = useRouter(); const [busy, setBusy] = useState(false);
  const human = aiMode === "human"; const handoff = aiMode === "handoff";
  async function set(mode: "human" | "ai") {
    setBusy(true);
    try { const r = await fetch(`/api/conversations/${conversationId}/ai`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode }) }); const j = await r.json(); if (!r.ok || j.success === false) throw new Error(j.error ?? "שגיאה"); toast.success(mode === "human" ? "לקחת את הטיפול – הנציג האוטומטי לא יענה בשיחה" : "השיחה הוחזרה לנציג ה-AI"); router.refresh(); }
    catch (e) { toast.error((e as Error).message); } finally { setBusy(false); }
  }
  return (
    <div className={`border-b px-3 py-2 text-sm flex flex-wrap items-center gap-2 ${handoff ? "bg-amber-500/10" : human ? "" : "bg-violet-500/10"}`} data-testid="ai-handling-bar" data-mode={aiMode ?? "ai"}>
      <span className="font-medium">{human ? "👤 נציג אנושי מטפל" : handoff ? "⏳ הועבר לנציג – ממתין לטיפול" : "🤖 נציג AI מטפל"}</span>
      {!enabledHere && !human && <span className="text-xs text-muted-foreground">(המענה האוטומטי כבוי לערוץ הזה)</span>}
      {handoff && reason && <span className="text-xs">סיבה: {reason}</span>}
      {handoff && summary && <span className="text-xs text-muted-foreground w-full">סיכום: {summary}</span>}
      <span className="ms-auto flex gap-2">
        {!human && <Button size="sm" onClick={() => set("human")} disabled={busy} data-testid="ai-take-over">קח טיפול</Button>}
        {(human || handoff) && enabledHere && <Button size="sm" variant="outline" onClick={() => set("ai")} disabled={busy} data-testid="ai-return">החזר ל-AI</Button>}
      </span>
    </div>
  );
}
