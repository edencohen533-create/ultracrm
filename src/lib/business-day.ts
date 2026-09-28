/** UTC instant of midnight in the business timezone, independent of the host TZ. */
export function businessDayStart(timeZone: string, now = new Date()): Date {
  const format = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
  const parts = (date: Date) => Object.fromEntries(format.formatToParts(date).map(p => [p.type, p.value]));
  const local = parts(now);
  const midnight = Date.UTC(Number(local.year), Number(local.month) - 1, Number(local.day));
  let instant = midnight;
  for (let i = 0; i < 3; i++) {
    const p = parts(new Date(instant));
    const localInstant = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
    instant += midnight - localInstant;
  }
  return new Date(instant);
}

/** UTC instant of a wall-clock date/time in the business timezone ("2026-09-27", "14:30"), DST-safe. */
export function zonedDateTime(timeZone: string, date: string, time: string): Date | null {
  const d = date.match(/^(\d{4})-(\d{2})-(\d{2})$/); const t = time.match(/^(\d{2}):(\d{2})$/);
  if (!d || !t) return null;
  const [y, m, day, h, mi] = [Number(d[1]), Number(d[2]), Number(d[3]), Number(t[1]), Number(t[2])];
  if (m < 1 || m > 12 || day < 1 || day > 31 || h > 23 || mi > 59) return null;
  const format = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" });
  const want = Date.UTC(y, m - 1, day, h, mi);
  let instant = want;
  for (let i = 0; i < 3; i++) {
    const p = Object.fromEntries(format.formatToParts(new Date(instant)).map((x) => [x.type, x.value]));
    instant += want - Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
  }
  const result = new Date(instant);
  // Date.UTC normalizes impossible dates; DST gaps can also shift the requested wall time.
  const actual = zonedParts(timeZone, result);
  return actual.date === date && actual.time === time ? result : null;
}

/** "2026-09-27" / "14:30" of an instant in the business timezone (for pickers and messages). */
export function zonedParts(timeZone: string, at: Date) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(at).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}
