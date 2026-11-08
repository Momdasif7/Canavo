/**
 * Cinema seat ordering (THEATRE module): web types and API helpers.
 * The contract is docs/build/theatre-contract.md; request schemas live in @canavo/shared (schemas-theatre.ts).
 */
import type { SeatBulkInput, SeatTiming, ShowTimeInput, TheatreSettings } from "@canavo/shared";
import { api } from "./api";
import { publicCall, type TableOrder, type TablePage } from "./storefront";

export type { SeatTiming, TheatreSettings };

// ---------- Staff types (contract "Staff API") ----------

export type ShowStatus = "UPCOMING" | "RUNNING" | "INTERVAL" | "ENDED";

export interface ShowTime {
  id: string;
  screenId: string;
  screenName: string;
  title: string;
  startsAt: string;
  intervalAt: string | null;
  endsAt: string;
  orderCutoffMin: number;
  /** endsAt − orderCutoffMin */
  closesAt: string;
  status: ShowStatus;
}

export interface Seat {
  id: string;
  label: string;
  seatNumber: number;
  qrToken: string;
  active: boolean;
}

export interface Screen {
  id: string;
  name: string;
  /** e.g. "S2" */
  code: string;
  sortOrder: number;
  /** Screen QR: /s/<qrToken> */
  qrToken: string;
  seatCount: number;
  rows: { row: string; seats: Seat[] }[];
  currentShow: ShowTime | null;
  nextShow: ShowTime | null;
}

export type BoardStage = "WAITING" | "PREPARING" | "READY" | "DELIVERED";

export interface BoardOrder {
  requestId: string;
  orderId: string | null;
  publicToken: string;
  screenId: string;
  screenName: string;
  seatLabel: string;
  row: string | null;
  seatNumber: number | null;
  timing: SeatTiming;
  pickupToken: number | null;
  /** WAITING = interval order held until its KOT is released */
  stage: BoardStage;
  /** When an interval order goes to the kitchen */
  releaseAt: string | null;
  items: { name: string; quantity: number; notes?: string }[];
  total: number;
  paid: boolean;
  createdAt: string;
  customerName: string | null;
}

export interface RunnerBoard {
  screens: { id: string; name: string; code: string; currentShow: ShowTime | null; rows: { row: string; orders: BoardOrder[] }[] }[];
  /** Timing COUNTER, ordered by pickupToken */
  counter: BoardOrder[];
}

export interface TheatreReport {
  from: string;
  to: string;
  totals: { orders: number; sales: number; avgOrder: number };
  byScreen: { screenId: string; name: string; orders: number; sales: number }[];
  byShow: { showTimeId: string; title: string; screenName: string; startsAt: string; orders: number; sales: number }[];
  byTiming: { timing: SeatTiming; orders: number; sales: number }[];
}

// ---------- Staff API ----------

export const theatreApi = {
  screens: () => api.get<Screen[]>("/theatre/screens"),
  createScreen: (body: { name: string; sortOrder?: number }) => api.post<Screen>("/theatre/screens", body),
  updateScreen: (id: string, body: { name?: string; sortOrder?: number }) => api.patch<Screen>(`/theatre/screens/${id}`, body),
  deleteScreen: (id: string) => api.del(`/theatre/screens/${id}`),
  addSeats: (screenId: string, body: SeatBulkInput) => api.post<{ created: number; skipped: number; total: number }>(`/theatre/screens/${screenId}/seats`, body),
  deleteSeat: (id: string) => api.del(`/theatre/seats/${id}`),
  rotateScreenQr: (id: string) => api.post<Screen>(`/theatre/screens/${id}/qr/rotate`),
  showtimes: (date: string, screenId?: string) => api.get<ShowTime[]>("/theatre/showtimes", { query: { date, screenId } }),
  createShow: (body: ShowTimeInput) => api.post<ShowTime>("/theatre/showtimes", body),
  updateShow: (id: string, body: Partial<Omit<ShowTimeInput, "screenId">>) => api.patch<ShowTime>(`/theatre/showtimes/${id}`, body),
  deleteShow: (id: string) => api.del(`/theatre/showtimes/${id}`),
  settings: () => api.get<TheatreSettings>("/theatre/settings"),
  saveSettings: (body: Partial<TheatreSettings>) => api.patch<TheatreSettings>("/theatre/settings", body),
  board: (screenId?: string) => api.get<RunnerBoard>("/theatre/board", { query: { screenId } }),
  ready: (requestId: string) => api.post<BoardOrder>(`/theatre/orders/${requestId}/ready`),
  delivered: (requestId: string) => api.post<BoardOrder>(`/theatre/orders/${requestId}/delivered`),
};

// ---------- Public (guest) types ----------

export interface SeatShow extends ShowTime {
  orderingOpen: boolean;
  /** "No show on this screen now", "Ordering has closed for this show" */
  reason?: string;
}

export interface SeatInfo {
  seat: { label: string; screenName: string; screenCode: string; row: string; seatNumber: number };
  show: SeatShow | null;
  /** Interval only if the show has an interval still ahead (minus lead time) */
  options: { now: boolean; interval: boolean; counter: boolean };
  settings: { intervalLeadMin: number };
}

/** GET /public/t/:token — a seat adds `theatre`. */
export interface SeatTablePage extends TablePage {
  theatre?: SeatInfo | null;
}

export interface ScreenPickerPage {
  outletName: string;
  screen: { name: string; code: string };
  show: ShowTime | null;
  rows: { row: string; seats: { label: string; seatNumber: number; token: string }[] }[];
}

export interface SeatUpi {
  qrPayload: string;
  imageUrl?: string | null;
  amount: number;
  mock?: boolean;
}

/** POST /public/t/:token/orders for a seat (online-order response shape plus timing / pickup token). */
export interface SeatOrderPlaced {
  token?: string;
  id?: string;
  status?: string;
  upi?: SeatUpi | null;
  timing?: SeatTiming;
  pickupToken?: number | null;
}

/** GET /public/t/:token/orders for a seat: the table order plus timing, pickup token and the board stage. */
export interface SeatOrder extends Omit<TableOrder, "stage"> {
  status?: string;
  /** The table-order stage (waiting, received, …) or the board stage (WAITING, PREPARING, …) */
  stage: string;
  seatStage?: BoardStage;
  timing?: SeatTiming | null;
  pickupToken?: number | null;
  paid?: boolean;
  token?: string;
  publicToken?: string;
  releaseAt?: string | null;
  upi?: SeatUpi | null;
}

export const publicTheatre = {
  screen: (token: string) => publicCall<ScreenPickerPage>("GET", `/public/s/${token}`),
};

// ---------- Helpers ----------

const BOARD_STAGES: BoardStage[] = ["WAITING", "PREPARING", "READY", "DELIVERED"];

/** Guest-facing stage of a seat order, whichever way the API spells it. */
export type GuestStage = "PAYMENT" | "CANCELLED" | BoardStage;

export function guestStage(o: SeatOrder): GuestStage {
  const raw = o.seatStage ?? o.stage;
  if (raw === "cancelled" || raw === "CANCELLED") return "CANCELLED";
  if (o.paid === false) return "PAYMENT";
  if ((BOARD_STAGES as string[]).includes(raw)) return raw as BoardStage;
  switch (raw) {
    case "waiting":
      return o.paid === undefined ? "PAYMENT" : o.timing === "INTERVAL" ? "WAITING" : "PREPARING";
    case "confirmed":
      return o.timing === "INTERVAL" ? "WAITING" : "PREPARING";
    case "ready":
      return "READY";
    case "served":
      return "DELIVERED";
    default:
      return "PREPARING";
  }
}

export const TIMING_SHORT: Record<SeatTiming, string> = { NOW: "Now", INTERVAL: "Interval", COUNTER: "Counter" };

/** "S2-F12" → "F12" */
export const seatPart = (label: string) => label.split("-").pop() ?? label;

/** mm:ss or h:mm:ss until `iso` (0:00 when passed). */
export function countdown(iso: string, now: number): string {
  const s = Math.max(0, Math.round((new Date(iso).getTime() - now) / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

/** "25 min", "1 h 5 min", "less than a minute" */
export function minutesUntil(iso: string, now: number): string {
  const min = Math.ceil((new Date(iso).getTime() - now) / 60_000);
  if (min <= 1) return "less than a minute";
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)} h${min % 60 ? ` ${min % 60} min` : ""}`;
}

/** Clock time in a time zone ("7:45 pm"). */
export function clock(iso: string, timeZone?: string): string {
  return new Date(iso).toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", hour12: true, timeZone });
}

/** Offset (ms) of a time zone from UTC at an instant. */
function tzOffsetMs(at: number, timeZone: string): number {
  const p = new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
    .formatToParts(new Date(at))
    .reduce<Record<string, number>>((o, x) => (x.type === "literal" ? o : { ...o, [x.type]: Number(x.value) }), {});
  return Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute, p.second) - Math.floor(at / 1000) * 1000;
}

/** Local date + "HH:MM" in a time zone → ISO instant (UTC). */
export function zonedIso(date: string, time: string, timeZone: string): string {
  const [y, mo, d] = date.split("-").map(Number);
  const [h, mi] = time.split(":").map(Number);
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  let at = guess - tzOffsetMs(guess, timeZone);
  // Second pass for DST edges (not needed in India, harmless elsewhere).
  at = guess - tzOffsetMs(at, timeZone);
  return new Date(at).toISOString();
}

/** ISO instant → { date: YYYY-MM-DD, time: HH:MM } in a time zone. */
export function zonedParts(iso: string, timeZone: string): { date: string; time: string } {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
    .formatToParts(new Date(iso))
    .reduce<Record<string, string>>((o, x) => ({ ...o, [x.type]: x.value }), {});
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour === "24" ? "00" : p.hour}:${p.minute}` };
}

/**
 * Seat KOT header: `SCREEN <code> · <row><n> · NOW|INTERVAL|COUNTER #<token>` (contract "KOT text").
 * Looked for in the given strings (a header field, the order notes, item notes).
 */
export interface SeatKotLine {
  screen: string;
  seat: string;
  timing: SeatTiming;
  token: number | null;
}
const SEAT_HEADER = /SCREEN\s+([A-Z0-9]+)\s*[·|-]\s*([A-Z]{1,2}\d{1,3})\s*[·|-]\s*(NOW|INTERVAL|COUNTER)(?:\s*#\s*(\d+))?/i;
export function parseSeatHeader(...texts: (string | null | undefined)[]): SeatKotLine | null {
  for (const t of texts) {
    if (!t) continue;
    const m = SEAT_HEADER.exec(t);
    if (m) return { screen: m[1].toUpperCase(), seat: m[2].toUpperCase(), timing: m[3].toUpperCase() as SeatTiming, token: m[4] ? Number(m[4]) : null };
  }
  return null;
}

/** Rows "A-M" / "A,B,C" / "A-C, F" → ["A", …]. Null when it doesn't parse. */
export function parseRows(input: string): string[] | null {
  const out: string[] = [];
  const idx = (s: string) => (s.length === 1 ? s.charCodeAt(0) - 65 : 26 + (s.charCodeAt(0) - 65) * 26 + (s.charCodeAt(1) - 65));
  const label = (n: number) => (n < 26 ? String.fromCharCode(65 + n) : String.fromCharCode(65 + Math.floor((n - 26) / 26)) + String.fromCharCode(65 + ((n - 26) % 26)));
  for (const part of input.toUpperCase().split(/[,\s]+/).filter(Boolean)) {
    const m = /^([A-Z]{1,2})(?:-([A-Z]{1,2}))?$/.exec(part);
    if (!m) return null;
    const a = idx(m[1]);
    const b = m[2] ? idx(m[2]) : a;
    if (b < a || b - a > 60) return null;
    for (let i = a; i <= b; i++) if (!out.includes(label(i))) out.push(label(i));
  }
  return out.length ? out : null;
}
