"use client";

/** "זמינה עכשיו" tag for a lead whose WhatsApp reply put it at the head of the dial queue. */
export function AvailableNowTag({ at, text, compact = false }: { at: string | Date; text: string; compact?: boolean }) {
  const t = new Date(at).toLocaleTimeString("he-IL", { hour: "2-digit", minute: "2-digit" });
  return (
    <span className="inline-flex items-center gap-1 rounded-md bg-good/15 text-good border border-good/40 px-1.5 py-0.5 text-xs font-semibold" title={`״${text}״ · ${t}`} data-testid="available-now-tag">
      {compact ? "זמינה עכשיו" : "זמינה עכשיו — התקבלה תשובה בוואטסאפ"} · {t}{!compact && <span className="font-normal italic truncate max-w-[220px]">״{text}״</span>}
    </span>
  );
}
