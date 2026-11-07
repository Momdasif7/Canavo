"use client";

import clsx from "clsx";
import { formatINR } from "@canavo/shared";
import { addDaysISO } from "@/lib/dates";
import { ORDER_CHANNELS, type OrderChannel } from "@canavo/shared";
import type { OrderStatus, OrderType, PaymentMode } from "@/lib/types";
import { Card } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";

/** The API caps the bills range at 366 days. */
export const MAX_BILL_RANGE_DAYS = 366;
export const BILLS_PAGE_SIZE = 50;

export type BillPreset = "today" | "yesterday" | "last7" | "thisMonth" | "custom";
export type BillPaymentFilter = PaymentMode | "COD";

export const BILL_PRESETS: { value: BillPreset; label: string }[] = [
  { value: "today", label: "Today" },
  { value: "yesterday", label: "Yesterday" },
  { value: "last7", label: "Last 7 days" },
  { value: "thisMonth", label: "This month" },
  { value: "custom", label: "Custom range" },
];

export interface BillFilterState {
  from: string;
  to: string;
  status: OrderStatus | "";
  paymentMode: BillPaymentFilter | "";
  orderType: OrderType | "";
  /** Phase 6: where the bill came from (counter, QR, Zomato …) */
  channel?: OrderChannel | "";
  /** Debounced search (invoice / phone / customer name) — searches all dates */
  search: string;
  /** "COD pending" chip: unpaid Cash-on-Delivery bills */
  cod: boolean;
}

/** GET /orders/summary (paise; cancelled bills excluded from billed / byMode). */
export interface BillSummary {
  count: number;
  billed: number;
  paidCount: number;
  openCount: number;
  openAmount: number;
  cancelledCount: number;
  cancelledAmount: number;
  byMode: Partial<Record<PaymentMode, { amount: number; count: number }>>;
  cod: { count: number; amount: number };
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;

export function daysInRange(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
}

export function presetDates(preset: Exclude<BillPreset, "custom">, today: string): { from: string; to: string } {
  switch (preset) {
    case "today":
      return { from: today, to: today };
    case "yesterday": {
      const y = addDaysISO(today, -1);
      return { from: y, to: y };
    }
    case "last7":
      return { from: addDaysISO(today, -6), to: today };
    case "thisMonth":
      return { from: `${today.slice(0, 7)}-01`, to: today };
  }
}

/** Which preset a from/to pair is (custom when none matches). */
export function matchPreset(from: string, to: string, today: string): BillPreset {
  for (const p of ["today", "yesterday", "last7", "thisMonth"] as const) {
    const r = presetDates(p, today);
    if (r.from === from && r.to === to) return p;
  }
  return "custom";
}

const STATUSES: OrderStatus[] = ["OPEN", "PAID", "CANCELLED"];
const MODES: BillPaymentFilter[] = ["CASH", "UPI", "CARD", "KHATA", "ONLINE", "COD"];
const TYPES: OrderType[] = ["DINE_IN", "TAKEAWAY", "DELIVERY", "PRE_ORDER"];

/** Filters from the page URL (?range=last7 | ?from=…&to=…, status, payment, type, search, cod=1). */
export function filtersFromQuery(q: URLSearchParams, today: string): BillFilterState {
  const range = q.get("range");
  let from = q.get("from") ?? "";
  let to = q.get("to") ?? q.get("from") ?? "";
  const date = q.get("date"); // older links
  if (date && ISO.test(date) && !from) from = to = date;
  if (range && range !== "custom" && BILL_PRESETS.some((p) => p.value === range)) ({ from, to } = presetDates(range as Exclude<BillPreset, "custom">, today));
  if (!ISO.test(from) || !ISO.test(to) || from > to || to > today || daysInRange(from, to) > MAX_BILL_RANGE_DAYS) ({ from, to } = presetDates("today", today));
  const pick = <T extends string>(v: string | null, all: readonly T[]): T | "" => (v && (all as readonly string[]).includes(v) ? (v as T) : "");
  return {
    from,
    to,
    status: pick(q.get("status"), STATUSES),
    paymentMode: pick(q.get("payment"), MODES),
    orderType: pick(q.get("type"), TYPES),
    channel: pick(q.get("channel"), ORDER_CHANNELS),
    search: (q.get("search") ?? "").trim().slice(0, 100),
    cod: q.get("cod") === "1",
  };
}

export function filtersToQuery(f: BillFilterState, today: string): string {
  const q = new URLSearchParams();
  const preset = matchPreset(f.from, f.to, today);
  if (preset === "custom") {
    q.set("from", f.from);
    q.set("to", f.to);
  } else if (preset !== "today") q.set("range", preset);
  if (f.status) q.set("status", f.status);
  if (f.paymentMode) q.set("payment", f.paymentMode);
  if (f.orderType) q.set("type", f.orderType);
  if (f.channel) q.set("channel", f.channel);
  if (f.search) q.set("search", f.search);
  if (f.cod) q.set("cod", "1");
  return q.toString();
}

/** Query params for /orders, /orders/summary and /orders/export. A search looks through all dates. */
export function apiQuery(f: BillFilterState): Record<string, string | undefined> {
  return {
    from: f.search ? undefined : f.from,
    to: f.search ? undefined : f.to,
    status: f.cod ? "OPEN" : f.status || undefined,
    paymentMode: f.cod ? "COD" : f.paymentMode || undefined,
    orderType: f.orderType || undefined,
    channel: f.channel || undefined,
    search: f.search || undefined,
  };
}

const fmtDay = (iso: string, withYear: boolean) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", month: "short", ...(withYear && { year: "numeric" }), timeZone: "UTC" });

/** "Today · 31 Oct 2026", "25 Oct – 31 Oct 2026". */
export function rangeLabel(from: string, to: string, today: string): string {
  const preset = matchPreset(from, to, today);
  const span = from === to ? fmtDay(from, true) : `${fmtDay(from, from.slice(0, 4) !== to.slice(0, 4))} – ${fmtDay(to, true)}`;
  const name = BILL_PRESETS.find((p) => p.value === preset && p.value !== "custom")?.label;
  return name ? `${name} · ${span}` : span;
}

/** Quick range chips + custom from/to inputs. */
export function RangePicker({
  from,
  to,
  today,
  customOpen,
  disabled,
  onPreset,
  onCustom,
}: {
  from: string;
  to: string;
  today: string;
  customOpen: boolean;
  disabled?: boolean;
  onPreset: (p: BillPreset) => void;
  onCustom: (from: string, to: string) => void;
}) {
  const active = customOpen ? "custom" : matchPreset(from, to, today);
  const tooLong = daysInRange(from, to) > MAX_BILL_RANGE_DAYS;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="flex flex-wrap gap-2" role="group" aria-label="Date range">
        {BILL_PRESETS.map((p) => (
          <button
            key={p.value}
            type="button"
            disabled={disabled}
            aria-pressed={active === p.value}
            onClick={() => onPreset(p.value)}
            className={clsx(
              "inline-flex min-h-[40px] items-center rounded-full border px-3.5 text-sm font-semibold transition-colors disabled:opacity-50",
              active === p.value ? "border-primary bg-primary text-primary-fg" : "border-line bg-surface text-fg hover:bg-surface-2",
            )}
          >
            {p.label}
          </button>
        ))}
      </div>
      {active === "custom" && (
        <div className="flex flex-wrap items-center gap-2">
          <Input
            type="date"
            aria-label="From date"
            value={from}
            max={to < today ? to : today}
            disabled={disabled}
            onChange={(e) => e.target.value && onCustom(e.target.value, to < e.target.value ? e.target.value : to)}
          />
          <span className="text-sm text-muted">to</span>
          <Input
            type="date"
            aria-label="To date"
            value={to}
            min={from}
            max={today}
            disabled={disabled}
            onChange={(e) => e.target.value && onCustom(from > e.target.value ? e.target.value : from, e.target.value)}
          />
          {tooLong && <span className="text-xs font-semibold text-red-600">Pick at most {MAX_BILL_RANGE_DAYS} days</span>}
        </div>
      )}
    </div>
  );
}

/** Totals for the filtered bills. */
export function BillSummaryStrip({ summary }: { summary: BillSummary }) {
  const mode = (m: PaymentMode) => summary.byMode[m] ?? { amount: 0, count: 0 };
  const stats: { label: string; value: string; sub?: string; tone?: "warn" | "danger" }[] = [
    { label: "Bills", value: String(summary.count), sub: `${summary.paidCount} paid` },
    { label: "Total billed", value: formatINR(summary.billed) },
    { label: "Cash", value: formatINR(mode("CASH").amount), sub: `${mode("CASH").count} payments` },
    { label: "UPI", value: formatINR(mode("UPI").amount), sub: `${mode("UPI").count} payments` },
    { label: "Card", value: formatINR(mode("CARD").amount), sub: `${mode("CARD").count} payments` },
    { label: "Khata", value: formatINR(mode("KHATA").amount), sub: `${mode("KHATA").count} on credit` },
    { label: "COD", value: formatINR(summary.cod.amount), sub: `${summary.cod.count} delivery bills` },
    { label: "Unpaid", value: formatINR(summary.openAmount), sub: `${summary.openCount} open`, tone: summary.openCount ? "warn" : undefined },
    { label: "Cancelled", value: String(summary.cancelledCount), sub: summary.cancelledCount ? formatINR(summary.cancelledAmount) : undefined, tone: summary.cancelledCount ? "danger" : undefined },
  ];
  return (
    <Card className="mb-5 grid grid-cols-2 gap-x-4 gap-y-3 p-4 sm:grid-cols-3 lg:grid-cols-5 2xl:grid-cols-9" data-testid="bills-summary">
      {stats.map((s) => (
        <div key={s.label} className="min-w-0">
          <p className="truncate text-xs font-semibold uppercase tracking-wide text-muted">{s.label}</p>
          <p
            className={clsx(
              "tabular truncate text-lg font-extrabold",
              s.tone === "warn" && "text-amber-700 dark:text-amber-300",
              s.tone === "danger" && "text-red-600 dark:text-red-400",
            )}
          >
            {s.value}
          </p>
          {s.sub && <p className="tabular truncate text-xs text-muted">{s.sub}</p>}
        </div>
      ))}
    </Card>
  );
}
