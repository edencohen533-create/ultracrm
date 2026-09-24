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
