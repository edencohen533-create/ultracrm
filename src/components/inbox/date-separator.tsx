"use client";

import { format, isToday, isYesterday } from "date-fns";
import { enGB, he } from "date-fns/locale";
import { useT } from "@/components/i18n/LangProvider";

export function DateSeparator({ date }: { date: Date }) {
  const t = useT();
  const label = isToday(date) ? t("היום", "Today") : isYesterday(date) ? t("אתמול", "Yesterday") : t.lang === "en" ? format(date, "d MMMM yyyy", { locale: enGB }) : format(date, "d בMMMM yyyy", { locale: he });

  return (
    <div className="my-3 flex items-center justify-center">
      <span className="rounded-full bg-muted px-3 py-1 text-xs text-muted-foreground">{label}</span>
    </div>
  );
}
