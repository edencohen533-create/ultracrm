import { format, isToday, isYesterday } from "date-fns";
import { he } from "date-fns/locale";

export function DateSeparator({ date }: { date: Date }) {
  const label = isToday(date) ? "היום" : isYesterday(date) ? "אתמול" : format(date, "d בMMMM yyyy", { locale: he });

  return (
    <div className="my-3 flex items-center justify-center">
      <span className="rounded-full bg-muted px-3 py-1 text-xs text-muted-foreground">{label}</span>
    </div>
  );
}
