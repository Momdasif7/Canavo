/**
 * Anomaly rules for the owner's push alerts (Phase 4.3). Pure: today's numbers
 * for one outlet in → anomalies out. Each anomaly has a stable `key` so the job
 * sends it at most once per outlet per day. Money in paise.
 */

/** (a) Voids today at or above this count… */
export const VOID_COUNT_LIMIT = 3;
/** …or void value above this share of today's sales. */
export const VOID_SHARE_OF_SALES = 0.05;
/** (b) A single refund or void above ₹2,000. */
export const BIG_SINGLE_AMOUNT = 200_000;
/** (c) A closed cash shift with a difference of ₹200 or more (short or over). */
export const CASH_VARIANCE_LIMIT = 20_000;
/** (d) Discounts above the outlet's approval limit today at or above this count. */
export const BIG_DISCOUNT_COUNT_LIMIT = 3;
/** (e) Sales so far below this share of the same weekday last week by the same time… */
export const SLOW_SALES_SHARE = 0.5;
/** …only when last week had at least this many bills by then (too few bills = noise). */
export const SLOW_SALES_MIN_BILLS = 10;

export interface AnomalyInput {
  outletName: string;
  /** Gross sales (paid bills) so far today */
  sales: number;
  bills: number;
  voids: { id: string; label: string; amount: number }[];
  refunds: { id: string; label: string; amount: number }[];
  /** Cash shifts closed today */
  closedShifts: { id: string; variance: number }[];
  bigDiscounts: number;
  discountLimitPercent: number;
  /** Same weekday last week, up to the same time of day */
  lastWeek: { sales: number; bills: number };
}

export interface Anomaly {
  key: string;
  title: string;
  body: string;
}

const rs = (paise: number) => `₹${Math.round(paise / 100).toLocaleString("en-IN")}`;

export function detectAnomalies(i: AnomalyInput): Anomaly[] {
  const out: Anomaly[] = [];
  const at = i.outletName;

  // (a) Many voids, or voids worth a big share of sales. The share rule needs some
  // sales, otherwise one small void before the first bill would trip it.
  const voidValue = i.voids.reduce((s, v) => s + v.amount, 0);
  if (i.voids.length >= VOID_COUNT_LIMIT || (i.sales > 0 && voidValue > i.sales * VOID_SHARE_OF_SALES)) {
    out.push({
      key: "voids",
      title: `Unusual voids at ${at}`,
      body: `${i.voids.length} bill${i.voids.length === 1 ? "" : "s"} voided today worth ${rs(voidValue)}${i.sales > 0 ? ` (${Math.round((voidValue / i.sales) * 100)}% of sales)` : ""}.`,
    });
  }

  // (b) One big refund or void, each reported once.
  for (const v of i.voids) {
    if (v.amount > BIG_SINGLE_AMOUNT) out.push({ key: `void:${v.id}`, title: `Large void at ${at}`, body: `Bill ${v.label} for ${rs(v.amount)} was voided.` });
  }
  for (const r of i.refunds) {
    if (r.amount > BIG_SINGLE_AMOUNT) out.push({ key: `refund:${r.id}`, title: `Large refund at ${at}`, body: `Refund ${r.label} for ${rs(r.amount)} was issued.` });
  }

  // (c) Cash drawer closed short or over.
  for (const s of i.closedShifts) {
    if (Math.abs(s.variance) >= CASH_VARIANCE_LIMIT) {
      out.push({ key: `shift:${s.id}`, title: `Cash ${s.variance < 0 ? "short" : "over"} at ${at}`, body: `A cash shift closed ${rs(Math.abs(s.variance))} ${s.variance < 0 ? "short" : "over"}.` });
    }
  }

  // (d) Repeated discounts above the approval limit.
  if (i.bigDiscounts >= BIG_DISCOUNT_COUNT_LIMIT) {
    out.push({ key: "discounts", title: `Big discounts at ${at}`, body: `${i.bigDiscounts} bills today had a discount above ${i.discountLimitPercent}%.` });
  }

  // (e) Sales well behind last week at the same time (only on a busy comparison day).
  if (i.lastWeek.bills >= SLOW_SALES_MIN_BILLS && i.sales < i.lastWeek.sales * SLOW_SALES_SHARE) {
    out.push({
      key: "slowSales",
      title: `Slow sales at ${at}`,
      body: `${rs(i.sales)} so far (${i.bills} bills) vs ${rs(i.lastWeek.sales)} (${i.lastWeek.bills} bills) by this time last week.`,
    });
  }
  return out;
}
