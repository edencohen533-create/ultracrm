"use client";

import { useT } from "@/components/i18n/LangProvider";

/** "זמינה עכשיו" tag for a lead whose WhatsApp reply put it at the head of the dial queue. */
export function AvailableNowTag({ at, text, compact = false }: { at: string | Date; text: string; compact?: boolean }) {
  const t = useT();
  const tm = new Date(at).toLocaleTimeString(t.lang === "en" ? "en-GB" : "he-IL", { hour: "2-digit", minute: "2-digit" });
  return (
    <span className="inline-flex items-center gap-1 rounded-md bg-good/15 text-good border border-good/40 px-1.5 py-0.5 text-xs font-semibold" title={`״${text}״ · ${tm}`} data-testid="available-now-tag">
      {compact ? t("זמינה עכשיו", "Available now") : t("זמינה עכשיו — התקבלה תשובה בוואטסאפ", "Available now — replied on WhatsApp")} · {tm}{!compact && <span className="font-normal italic truncate max-w-[220px]">״{text}״</span>}
    </span>
  );
}
