/** Wall-clock parts of `date` in the given IANA timezone. */
export function zonedParts(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    minutes: Number(get("hour")) * 60 + Number(get("minute")),
  };
}

export const hhmmToMinutes = (t: string) => {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
};

/** UTC instant for local midnight of `ymd` in `timeZone` (handles fixed offsets like IST exactly). */
/** Midnight UTC of a YYYY-MM-DD calendar date; "2026-13-45" (Invalid Date) or "2026-02-30" (rolls into March) is a 400, not a 500 / a wrong day. */
function utcMidnight(ymd: string): Date {
  const d = new Date(`${ymd}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== ymd) {
    // A client error (400 via the error handler's `expose` branch). No import of ./http: this module
    // is also used by scripts (seed) that must not load the server env.
    throw Object.assign(new Error(`Invalid date ${ymd}`), { status: 400, expose: true });
  }
  return d;
}

export function startOfLocalDay(ymd: string, timeZone: string): Date {
  const guess = utcMidnight(ymd);
  const { minutes, date } = zonedParts(guess, timeZone);
  // Offset = local wall time − UTC wall time at the guess instant
  let offset = minutes;
  if (date < ymd) offset -= 24 * 60;
  return new Date(guess.getTime() - offset * 60_000);
}

export function addDays(ymd: string, days: number): string {
  const d = utcMidnight(ymd);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
