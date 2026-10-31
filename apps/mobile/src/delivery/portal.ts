/**
 * Delivery partner portal: request shapes and pure helpers.
 *
 * No React Native imports, so the same request specs and money/date rules can
 * be exercised from a node script against the real API (see README →
 * "Delivery partner portal"). `src/lib/api.ts` executes these specs.
 */
import type {
  CashHandover,
  Delivery,
  DeliveryCompleteResult,
  DeliveryIssueReason,
  DeliveryPayment,
  DeliverySummary,
  HandoverResult,
  MyCash,
  PartnerActivity,
  PartnerAvailability,
  PartnerCash,
  PartnerLocationResult,
  PartnerUnavailableDetails,
  PartnerTimeline,
} from "../lib/types";
import { addDaysYmd, inr, ymd } from "../lib/format";

// ---------- Request specs ----------
export type HttpMethod = "GET" | "POST" | "PATCH" | "DELETE";

/** One API call. `T` is the response type (phantom: only used for typing). */
export interface RequestSpec<T> {
  method: HttpMethod;
  path: string;
  query?: Record<string, string | undefined>;
  body?: unknown;
  /** Never set at runtime; carries the response type. */
  readonly __response?: T;
}

const spec = <T>(method: HttpMethod, path: string, extra: Pick<RequestSpec<T>, "query" | "body"> = {}): RequestSpec<T> => ({
  method,
  path,
  ...extra,
});

export interface DateRange {
  from: string;
  to: string;
}

export interface HandoverInput {
  agentId: string;
  /** paise */
  amount: number;
  note?: string;
  receivedAt?: string;
}

export interface HandoverUpdate {
  amount?: number;
  note?: string | null;
  receivedAt?: string;
}

/** Only `/delivery/*` endpoints: delivery partners have no `order:view` / `bills:view`. */
export const deliveryRequests = {
  mine: () => spec<Delivery[]>("GET", "/delivery/mine", { query: { view: "active" } }),
  history: (r?: DateRange) => spec<Delivery[]>("GET", "/delivery/mine", { query: { view: "history", from: r?.from, to: r?.to } }),
  summary: (r?: DateRange) => spec<DeliverySummary>("GET", "/delivery/mine/summary", { query: { from: r?.from, to: r?.to } }),
  /** Partner: cash to hand over, today's movement, pending orders, handovers. */
  myCash: () => spec<MyCash>("GET", "/delivery/mine/cash"),
  get: (id: string) => spec<Delivery>("GET", `/delivery/${id}`),
  /** Partner: own dispatch availability (null when not a delivery partner here). */
  myStatus: () => spec<PartnerAvailability | null>("GET", "/delivery/me/status"),
  /** Partner: foreground GPS while clocked in — tells the outlet when they're back. */
  myLocation: (lat: number, lng: number, accuracy?: number) =>
    spec<PartnerLocationResult>("POST", "/delivery/me/location", { body: { lat, lng, ...(accuracy != null ? { accuracy } : {}) } }),
  /** Accept / out for delivery. Delivering goes through `complete`. */
  status: (id: string, status: Delivery["status"], note?: string) => spec<Delivery>("PATCH", `/delivery/${id}/status`, { body: { status, note } }),
  /**
   * One tap at the door. Unpaid / COD → the amount due is recorded as cash
   * collected by the partner and the bill is paid; paid → just delivered.
   * `cashCollected` is the amount the partner saw (409 if it changed).
   */
  complete: (id: string, cashCollected?: number) =>
    spec<DeliveryCompleteResult>("POST", `/delivery/${id}/complete`, { body: cashCollected !== undefined ? { cashCollected } : {} }),
  issue: (id: string, reason: DeliveryIssueReason, note?: string) =>
    spec<Delivery>("POST", `/delivery/${id}/issue`, { body: { reason, ...(note ? { note } : {}) } }),
  // Manager (delivery:manage)
  /** Manager override: partner is back at the outlet (409 while orders are still out). */
  markBack: (agentId: string) => spec<PartnerAvailability>("POST", `/delivery/agents/${agentId}/back`),
  assign: (id: string, agentId: string | null, force?: boolean) =>
    spec<Delivery>("PATCH", `/delivery/${id}/assign`, { body: { agentId, ...(force ? { force: true } : {}) } }),
  cash: () => spec<PartnerCash[]>("GET", "/delivery/cash"),
  handovers: (q: { agentId?: string; from?: string; to?: string } = {}) => spec<CashHandover[]>("GET", "/delivery/cash/handovers", { query: q }),
  recordHandover: (input: HandoverInput) => spec<HandoverResult>("POST", "/delivery/cash/handovers", { body: input }),
  updateHandover: (id: string, input: HandoverUpdate) => spec<HandoverResult>("PATCH", `/delivery/cash/handovers/${id}`, { body: input }),
  deleteHandover: (id: string) => spec<{ balance: number }>("DELETE", `/delivery/cash/handovers/${id}`),
  settleCash: (agentId: string) => spec<{ settled: number; amount: number }>("POST", "/delivery/cash/settle", { body: { agentId } }),
  activity: (q: { from?: string; to?: string; agentId?: string } = {}) => spec<PartnerActivity>("GET", "/delivery/partners/activity", { query: q }),
  timeline: (agentId: string, date?: string) => spec<PartnerTimeline>("GET", `/delivery/partners/${agentId}/timeline`, { query: { date } }),
};

// ---------- Dispatch limit ----------
/** 409 "<Name> can't take this order: <reason>" from assign / POST /orders → its details, else null. */
export function partnerUnavailable(e: unknown): PartnerUnavailableDetails | null {
  if (!e || typeof e !== "object") return null;
  const { status, details } = e as { status?: number; details?: unknown };
  if (status !== 409 || !details || typeof details !== "object") return null;
  const d = details as Partial<PartnerUnavailableDetails>;
  return d.code === "PARTNER_UNAVAILABLE" ? { code: d.code, reason: String(d.reason ?? ""), canForce: !!d.canForce } : null;
}

export type PartnerState = "available" | "busy" | "out" | "returning" | "off";

/** Where a partner stands for dispatch. */
export function partnerState(a: Pick<PartnerAvailability, "onDuty" | "available" | "outForDelivery" | "atOutlet" | "onRunSince">): PartnerState {
  if (!a.onDuty) return "off";
  if (a.available) return "available";
  if (a.outForDelivery > 0) return "out";
  if (a.onRunSince || !a.atOutlet) return "returning";
  return "busy";
}

/** Short badge: "Available 1/2" / "2 of 2" / "Out for delivery" / "Returning" / "Off duty". */
export function partnerBadge(a: Pick<PartnerAvailability, "onDuty" | "available" | "outForDelivery" | "atOutlet" | "onRunSince" | "active" | "max">): string {
  switch (partnerState(a)) {
    case "off":
      return "Off duty";
    case "available":
      return a.active ? `Available ${a.active}/${a.max}` : "Available";
    case "out":
      return "Out for delivery";
    case "returning":
      return "Returning";
    default:
      return `${a.active} of ${a.max}`;
  }
}

/** Manager can tap "Mark back at outlet": on duty, away, nothing still out. */
export const canMarkBack = (a: Pick<PartnerAvailability, "onDuty" | "atOutlet" | "outForDelivery">) => a.onDuty && !a.atOutlet && a.outForDelivery === 0;

/** Distance for the partner's "Returning" card: "350 m" / "1.2 km". */
export const metresText = (m: number) => (m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1)} km`);

// ---------- One-tap delivery ----------
/** Statuses from which `POST /delivery/:id/complete` works. */
export const canComplete = (s: Delivery["status"]) => s === "ACCEPTED" || s === "PREPARING" || s === "OUT_FOR_DELIVERY";

/** The single "done" button on a partner's card. */
export function completeAction(d: Pick<Delivery, "amountDue" | "customerName">): { title: string; confirm: { title: string; message: string; ok: string } | null } {
  if (d.amountDue > 0) {
    return {
      title: "Cash collected & delivered",
      confirm: {
        title: `Collect ${inr(d.amountDue)} cash`,
        message: `Did you collect ${inr(d.amountDue)} cash from ${d.customerName}?`,
        ok: `Yes, collected ${inr(d.amountDue)}`,
      },
    };
  }
  return { title: "Delivered", confirm: null };
}

/** Next forward step before delivery (PATCH /status). */
export function nextPartnerStep(s: Delivery["status"]): { status: Delivery["status"]; label: string } | null {
  if (s === "PENDING") return { status: "ACCEPTED", label: "Accept delivery" };
  if (s === "ACCEPTED" || s === "PREPARING") return { status: "OUT_FOR_DELIVERY", label: "Picked up · Start delivery" };
  return null;
}

/** 409 from /complete when the bill changed since the partner loaded it → refresh. */
export function isAmountChanged(e: unknown): boolean {
  if (!e || typeof e !== "object") return false;
  const { status, message } = e as { status?: number; message?: string };
  return status === 409 && /amount due changed/i.test(message ?? "");
}

/** Handover amount typed in rupees → paise (null when empty / invalid / not positive). */
export function parseHandoverAmount(text: string): number | null {
  const cleaned = text.replace(/[^\d.]/g, "");
  if (!cleaned || !/^\d*(\.\d{0,2})?$/.test(cleaned)) return null;
  const paise = Math.round(Number(cleaned) * 100);
  return Number.isFinite(paise) && paise > 0 ? paise : null;
}

/** Paise → editable rupee text ("120" / "120.50"). */
export const rupeesText = (paise: number) => (paise <= 0 ? "" : paise % 100 === 0 ? String(paise / 100) : (paise / 100).toFixed(2));

// ---------- Periods ----------
export type Period = "today" | "yesterday" | "week" | "month";
export const PERIODS: { value: Period; label: string }[] = [
  { value: "today", label: "Today" },
  { value: "yesterday", label: "Yesterday" },
  { value: "week", label: "This week" },
  { value: "month", label: "This month" },
];

/** Local date range for a period. Weeks start on Monday. */
export function periodRange(p: Period, now: Date = new Date()): DateRange {
  const today = ymd(now);
  if (p === "today") return { from: today, to: today };
  if (p === "yesterday") {
    const y = addDaysYmd(today, -1);
    return { from: y, to: y };
  }
  if (p === "week") return { from: addDaysYmd(today, -((now.getDay() + 6) % 7)), to: today };
  return { from: `${today.slice(0, 8)}01`, to: today };
}

/** Manager partner activity: Today / This week / This month. */
export const ACTIVITY_PERIODS: { value: Period; label: string }[] = PERIODS.filter((p) => p.value !== "yesterday");

export type HistoryRange = "today" | "yesterday" | "7d" | "month";
export const HISTORY_RANGES: { value: HistoryRange; label: string }[] = [
  { value: "today", label: "Today" },
  { value: "yesterday", label: "Yesterday" },
  { value: "7d", label: "Last 7 days" },
  { value: "month", label: "This month" },
];

export function historyRange(r: HistoryRange, now: Date = new Date()): DateRange {
  if (r === "7d") {
    const today = ymd(now);
    return { from: addDaysYmd(today, -6), to: today };
  }
  return periodRange(r, now);
}

/** Every day in [from, to] with the server's per-day counts (missing days = 0). */
export function fillDays(byDay: DeliverySummary["byDay"], r: DateRange): { date: string; deliveries: number; collected: number }[] {
  const out: { date: string; deliveries: number; collected: number }[] = [];
  for (let d = r.from, guard = 0; d <= r.to && guard < 62; d = addDaysYmd(d, 1), guard++) {
    const row = byDay.find((x) => x.date === d);
    out.push({ date: d, deliveries: row?.deliveries ?? 0, collected: row?.collected ?? 0 });
  }
  return out;
}

// ---------- How an order was paid ----------
export const MODE_LABEL: Record<string, string> = { CASH: "Cash", UPI: "UPI", CARD: "Card", KHATA: "Khata" };

/** How an order was paid, from this partner's point of view: "Cash ₹200", "UPI ₹150 · UTR 1234", "Prepaid ₹300". */
export function paidHow(payments: DeliveryPayment[] | undefined, agentId: string | null): { label: string; mode: "CASH" | "UPI" | "CARD" | "PREPAID" | "OTHER" }[] {
  const ok = (payments ?? []).filter((p) => p.status === "SUCCESS");
  const out: { label: string; mode: "CASH" | "UPI" | "CARD" | "PREPAID" | "OTHER" }[] = [];
  const prepaid = ok.filter((p) => !agentId || p.collectedById !== agentId).reduce((s, p) => s + p.amount, 0);
  for (const p of ok) {
    if (agentId && p.collectedById === agentId) {
      const mode = p.mode === "CASH" || p.mode === "UPI" || p.mode === "CARD" ? p.mode : "OTHER";
      const ref = p.reference ? ` · ${p.mode === "UPI" ? "UTR" : "Ref"} ${p.reference}` : "";
      out.push({ label: `${MODE_LABEL[p.mode] ?? p.mode} ${inr(p.amount)}${ref}`, mode });
    }
  }
  if (prepaid > 0) out.unshift({ label: `Prepaid ${inr(prepaid)}`, mode: "PREPAID" });
  return out;
}

// ---------- ETA ----------
/** "in 12 min" / "8 min late" / null when there's no ETA. */
export function etaCountdown(etaAt: string | null | undefined, now: number = Date.now()): { text: string; late: boolean } | null {
  if (!etaAt) return null;
  const mins = Math.round((new Date(etaAt).getTime() - now) / 60_000);
  if (mins >= 0) return { text: mins === 0 ? "due now" : `in ${fmtMins(mins)}`, late: false };
  return { text: `${fmtMins(-mins)} late`, late: true };
}

const fmtMins = (m: number) => (m < 60 ? `${m} min` : `${Math.floor(m / 60)}h ${m % 60}m`);

// ---------- Issues ----------
export const ISSUE_REASONS: { value: DeliveryIssueReason; label: string; icon: string }[] = [
  { value: "CUSTOMER_UNREACHABLE", label: "Customer not reachable", icon: "call-outline" },
  { value: "WRONG_ADDRESS", label: "Wrong / incomplete address", icon: "location-outline" },
  { value: "CUSTOMER_REFUSED", label: "Customer refused the order", icon: "hand-left-outline" },
  { value: "VEHICLE_PROBLEM", label: "Vehicle problem", icon: "construct-outline" },
  { value: "OTHER", label: "Something else", icon: "help-circle-outline" },
];

/** Partner-reported problems are appended to the delivery notes as "ISSUE: …" lines. */
export function splitNotes(notes: string | null | undefined): { issues: string[]; other: string[] } {
  const lines = (notes ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
  return {
    issues: lines.filter((l) => l.startsWith("ISSUE:")).map((l) => l.slice(6).trim()),
    other: lines.filter((l) => !l.startsWith("ISSUE:")),
  };
}

/** Short area for list rows: the last two address parts ("Indiranagar, Bengaluru"). */
export function areaOf(address: string): string {
  const parts = address.split(",").map((p) => p.trim()).filter(Boolean);
  return parts.length > 2 ? parts.slice(-2).join(", ") : address;
}
