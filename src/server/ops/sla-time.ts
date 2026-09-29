import { zonedParts, zonedDateTime } from "@/lib/business-day";
import type { DialWindow } from "@/lib/settings";
/** Counts working milliseconds; closed days consume none. No mutation of the existing dial queue. */
export function slaDeadline(
  start: Date,
  minutes: number,
  window?: DialWindow,
): Date | null {
  if (!window) return new Date(start.getTime() + minutes * 60000);
  if (!window.days.length || window.start >= window.end) return null;
  const tz = window.timezone ?? "Asia/Jerusalem",
    first = zonedParts(tz, start).date;
  let remaining = minutes * 60000;
  // A one-minute weekly window can require years for a 1,440-minute target.
  // Bound work and reject impractical schedules rather than silently counting closed time.
  for (let day = 0; day < 370; day++) {
    const date = new Date(Date.parse(first + "T12:00:00Z") + day * 86400000);
    if (!window.days.includes(date.getUTCDay())) continue;
    const localDate = date.toISOString().slice(0, 10),
      opens = zonedDateTime(tz, localDate, window.start),
      closes = zonedDateTime(tz, localDate, window.end);
    if (!opens || !closes) continue;
    const from = Math.max(start.getTime(), opens.getTime()),
      available = Math.max(0, closes.getTime() - from);
    if (available >= remaining) return new Date(from + remaining);
    remaining -= available;
  }
  return null;
}
