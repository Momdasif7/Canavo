import { describe, expect, it } from "vitest";
import { detectAnomalies, type AnomalyInput } from "./anomaly-rules";

const base: AnomalyInput = {
  outletName: "Main",
  sales: 1_000_000,
  bills: 40,
  voids: [],
  refunds: [],
  closedShifts: [],
  bigDiscounts: 0,
  discountLimitPercent: 10,
  lastWeek: { sales: 1_000_000, bills: 40 },
};
const keys = (i: Partial<AnomalyInput>) => detectAnomalies({ ...base, ...i }).map((a) => a.key);
const v = (id: string, amount: number) => ({ id, label: id, amount });

describe("detectAnomalies", () => {
  it("a normal day has no anomalies", () => {
    expect(keys({})).toEqual([]);
  });

  it("(a) three voids, or void value above 5% of sales", () => {
    expect(keys({ voids: [v("a", 100), v("b", 100)] })).toEqual([]);
    expect(keys({ voids: [v("a", 100), v("b", 100), v("c", 100)] })).toEqual(["voids"]);
    expect(keys({ voids: [v("a", 50_001)] })).toEqual(["voids"]);
    expect(keys({ voids: [v("a", 50_000)] })).toEqual([]); // exactly 5% is fine
    // No sales yet: one void doesn't trip the share rule.
    expect(keys({ sales: 0, bills: 0, lastWeek: { sales: 0, bills: 0 }, voids: [v("a", 1000)] })).toEqual([]);
  });

  it("(b) each refund or void above ₹2,000, keyed by id", () => {
    expect(keys({ sales: 100_000_000, voids: [v("x", 200_001)], refunds: [v("r1", 250_000), v("r2", 200_000)] })).toEqual(["void:x", "refund:r1"]);
  });

  it("(c) cash shift closed ₹200 or more short or over", () => {
    const a = detectAnomalies({ ...base, closedShifts: [{ id: "s1", variance: -20_000 }, { id: "s2", variance: 19_999 }, { id: "s3", variance: 30_000 }] });
    expect(a.map((x) => x.key)).toEqual(["shift:s1", "shift:s3"]);
    expect(a[0].title).toContain("short");
    expect(a[1].title).toContain("over");
  });

  it("(d) three discounts above the approval limit", () => {
    expect(keys({ bigDiscounts: 2 })).toEqual([]);
    expect(keys({ bigDiscounts: 3 })).toEqual(["discounts"]);
  });

  it("(e) sales under half of last week by now, only when last week had 10+ bills", () => {
    expect(keys({ sales: 400_000, lastWeek: { sales: 1_000_000, bills: 10 } })).toEqual(["slowSales"]);
    expect(keys({ sales: 500_000, lastWeek: { sales: 1_000_000, bills: 10 } })).toEqual([]);
    expect(keys({ sales: 0, lastWeek: { sales: 1_000_000, bills: 9 } })).toEqual([]);
  });
});
