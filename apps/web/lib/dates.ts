/** Local calendar helpers using YYYY-MM-DD strings (matches the API). */
const pad = (n: number) => String(n).padStart(2, "0");

export function todayISO(timeZone = "Asia/Kolkata"): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone }).format(new Date());
}

export function addDaysISO(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

export const currentMonth = (timeZone = "Asia/Kolkata") => todayISO(timeZone).slice(0, 7);

export function monthLabel(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-IN", { month: "long", year: "numeric", timeZone: "UTC" });
}

/** Minutes since midnight, now, in the given timezone. */
export function nowMinutes(timeZone = "Asia/Kolkata"): number {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date());
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return get("hour") * 60 + get("minute");
}

const toMin = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};

/** Mirrors the API's serving-window check (handles windows that cross midnight). */
export function inServingWindow(from: string | null, to: string | null, minutes: number): boolean {
  if (!from || !to) return true;
  const f = toMin(from);
  const t = toMin(to);
  return f <= t ? minutes >= f && minutes < t : minutes >= f || minutes < t;
}
