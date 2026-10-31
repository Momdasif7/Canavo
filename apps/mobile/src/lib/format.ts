import { formatINR } from "@canavo/shared";

export const inr = (paise: number) => formatINR(paise);

/** Rupees with no decimals when whole: ₹120 / ₹120.50 */
export function inrShort(paise: number): string {
  return paise % 100 === 0 ? `₹${new Intl.NumberFormat("en-IN").format(paise / 100)}` : formatINR(paise);
}

/** Parse a rupee amount typed by the user ("120", "120.5") into paise. */
export function parseRupees(text: string): number | null {
  const cleaned = text.replace(/[^\d.]/g, "");
  if (!cleaned) return null;
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 100);
}

const pad = (n: number) => String(n).padStart(2, "0");

/** Local calendar date as YYYY-MM-DD */
export function ymd(d: Date = new Date()): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function ym(d: Date = new Date()): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
}

export function addDaysYmd(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return ymd(new Date(y, m - 1, d + days));
}

export function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });
}

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
}

/** HH:MM:SS from milliseconds */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}

export function formatMinutes(min: number): string {
  if (min < 60) return `${min}m`;
  return `${Math.floor(min / 60)}h ${pad(min % 60)}m`;
}

export const humanize = (s: string) => s.replace(/_/g, " ").toLowerCase().replace(/^\w/, (c) => c.toUpperCase());
