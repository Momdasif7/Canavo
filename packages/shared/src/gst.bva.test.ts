/**
 * Hand-calculated oracles and boundary values for the bill engine (Phase 4).
 * Expected values below are worked out by hand in the comments, NOT copied from
 * the implementation's output.
 */
import { describe, expect, it } from "vitest";
import {
  computeBill, documentTypeFor, effectiveGstRate, exclusiveOf, gstPercent, legacyTax, lineTaxOf, parseTaxExtras, roundRate,
  taxFromRate, totalTaxPercent, type LineTax, type TaxConfig,
} from "./gst";
import { allocate, formatINR, toPaise, toRupees } from "./money";

const EXCL: TaxConfig = { pricesIncludeTax: false, interState: false, compositionScheme: false, serviceChargeEnabled: false, serviceChargePercent: 0, roundOff: true };
const INCL: TaxConfig = { ...EXCL, pricesIncludeTax: true };
const gst = (rate: number, cess = 0): LineTax => ({ cgst: rate / 2, sgst: rate / 2, igst: rate, cess, extras: [] });

describe("UT-GST oracles — each slab, exclusive prices, intra-state", () => {
  it.each([
    // [rate, cess, price, cgst, sgst, cess, grand]  ₹100.00 = 10000 paise
    [0, 0, 10000, 0, 0, 0, 10000], //   0%: no tax
    [5, 0, 10000, 250, 250, 0, 10500], //   5%: 2.5% + 2.5% of ₹100
    [12, 0, 10000, 600, 600, 0, 11200], // 12%: 6% + 6%
    [18, 0, 10000, 900, 900, 0, 11800], // 18%: 9% + 9%
    [28, 0, 10000, 1400, 1400, 0, 12800], // 28%: 14% + 14%
    [28, 12, 10000, 1400, 1400, 1200, 14000], // 28% + 12% compensation cess (aerated drinks)
  ])("UT-GST-%#: %i%% GST + %i%% cess on ₹100", (rate, cess, price, cgst, sgst, cessAmt, grand) => {
    const b = computeBill([{ unitPrice: price, quantity: 1, tax: gst(rate, cess) }], EXCL);
    expect([b.cgst, b.sgst, b.igst, b.cess, b.grandTotal]).toEqual([cgst, sgst, 0, cessAmt, grand]);
    expect(b.documentType).toBe("TAX_INVOICE");
  });

  it("UT-GST-010 IGST for inter-state: ₹100 @18% → IGST ₹18", () => {
    const b = computeBill([{ unitPrice: 10000, quantity: 1, gstRate: 18 }], { ...EXCL, interState: true });
    expect([b.cgst, b.sgst, b.igst, b.grandTotal]).toEqual([0, 0, 1800, 11800]);
  });

  it("UT-GST-011 legacy gstRate path equals an explicit composition", () => {
    const a = computeBill([{ unitPrice: 12345, quantity: 3, gstRate: 12 }], EXCL);
    const b = computeBill([{ unitPrice: 12345, quantity: 3, tax: gst(12) }], EXCL);
    expect(a.grandTotal).toBe(b.grandTotal);
    expect(a.totalTax).toBe(b.totalTax);
  });

  it("UT-GST-012 odd paise split: CGST gets the floor, SGST the remainder", () => {
    // ₹1.10 @5% → tax round(5.5) = 6 paise → CGST 3, SGST 3; ₹1.30 @5% → round(6.5)=7 → 3 + 4
    const b = computeBill([{ unitPrice: 130, quantity: 1, gstRate: 5 }], { ...EXCL, roundOff: false });
    expect([b.cgst, b.sgst]).toEqual([3, 4]);
  });
});

describe("UT-GST oracles — tax-inclusive prices (canteen menus)", () => {
  it.each([
    // menu price, rate, cess → taxable, total tax
    [10500, 5, 0, 10000, 500], //   ₹105 incl 5%  → ₹100 + ₹5
    [11800, 18, 0, 10000, 1800], // ₹118 incl 18% → ₹100 + ₹18
    [14000, 28, 12, 10000, 4000], // ₹140 incl 28% + 12% cess (total 40%) → ₹100 + ₹28 + ₹12
  ])("UT-GST-02%# ₹%i incl. %i%% (+%i%% cess)", (price, rate, cess, taxable, tax) => {
    const b = computeBill([{ unitPrice: price, quantity: 1, tax: gst(rate, cess) }], INCL);
    expect(b.taxableValue).toBe(taxable);
    expect(b.totalTax).toBe(tax);
    expect(b.grandTotal).toBe(price);
  });

  it("UT-GST-025 named extra tax (VAT 14.5%) is extracted from inclusive prices too", () => {
    // ₹119.50 incl 5% GST + 14.5% VAT = 19.5% → taxable ₹100.00; GST ₹5.00, VAT ₹14.50
    const b = computeBill([{ unitPrice: 11950, quantity: 1, tax: { ...gst(5), extras: [{ label: "VAT", percent: 14.5 }] } }], { ...INCL, roundOff: false });
    expect([b.taxableValue, b.cgst + b.sgst, b.otherTaxes, b.grandTotal]).toEqual([10000, 500, 1450, 11950]);
    expect(b.taxDetails).toEqual([{ label: "VAT", percent: 14.5, amount: 1450 }]);
  });
});

describe("UT-GST — composition scheme, GST off, discounts, charges", () => {
  it("UT-GST-030 composition: Bill of Supply, no tax, inclusive price charged as-is", () => {
    const b = computeBill([{ unitPrice: 10500, quantity: 2, gstRate: 5 }], { ...INCL, compositionScheme: true });
    expect(b.documentType).toBe("BILL_OF_SUPPLY");
    expect([b.totalTax, b.grandTotal, b.taxBreakup.length]).toEqual([0, 21000, 0]);
  });

  it("UT-GST-031 GST off: plain BILL even if composition is also set", () => {
    expect(documentTypeFor({ taxEnabled: false, compositionScheme: true })).toBe("BILL");
    expect(documentTypeFor({ taxEnabled: true, compositionScheme: false })).toBe("TAX_INVOICE");
    expect(documentTypeFor({ compositionScheme: false })).toBe("TAX_INVOICE");
  });

  it("UT-GST-032 a flat discount reduces the taxable value before tax", () => {
    // ₹100 @5% with ₹10 off → taxable ₹90, tax ₹4.50, total ₹94.50 → rounds HALF-UP to ₹95.00
    const b = computeBill([{ unitPrice: 10000, quantity: 1, gstRate: 5 }], EXCL, { type: "FLAT", value: 1000 });
    expect([b.taxableValue, b.totalTax, b.roundOff, b.grandTotal]).toEqual([9000, 450, 50, 9500]);
  });

  it("UT-GST-033 percent discount on a mixed cart is shared by value (₹100 @5% + ₹100 @18%, 20% off)", () => {
    // each line taxable ₹80 → tax ₹4.00 + ₹14.40 = ₹18.40 → ₹178.40 → ₹178.00
    const b = computeBill([{ unitPrice: 10000, quantity: 1, gstRate: 5 }, { unitPrice: 10000, quantity: 1, gstRate: 18 }], EXCL, { type: "PERCENT", value: 20 });
    expect([b.discount, b.totalTax, b.grandTotal, b.roundOff]).toEqual([4000, 1840, 17800, -40]);
  });

  it("UT-GST-034 service charge is taxed at the line rate", () => {
    // ₹100 @5% + 10% SC (₹10) → tax 5% of ₹110 = ₹5.50 → ₹115.50 → ₹116.00
    const b = computeBill([{ unitPrice: 10000, quantity: 1, gstRate: 5 }], { ...EXCL, serviceChargeEnabled: true, serviceChargePercent: 10 });
    expect([b.serviceCharge, b.totalTax, b.grandTotal]).toEqual([1000, 550, 11600]);
  });

  it("UT-GST-035 delivery fee + packaging are taxed at the line rate; negative charges are ignored", () => {
    // ₹100 @18% + ₹30 delivery + ₹10 packaging (+ a bogus −₹5) → tax 18% of ₹140 = ₹25.20 → ₹165.20 → ₹165
    const b = computeBill([{ unitPrice: 10000, quantity: 1, gstRate: 18 }], {
      ...EXCL, extraCharges: [{ label: "Delivery", amount: 3000 }, { label: "Packaging", amount: 1000 }, { label: "Bogus", amount: -500 }],
    });
    expect([b.extraCharges, b.totalTax, b.grandTotal]).toEqual([4000, 2520, 16500]);
  });

  it("UT-GST-036 fully discounted bill with a delivery fee still taxes the fee", () => {
    // 100% off the food; ₹30 delivery spread by gross onto the 18% line → ₹5.40 tax → ₹35.40 → ₹35
    const b = computeBill([{ unitPrice: 10000, quantity: 1, gstRate: 18 }], { ...EXCL, extraCharges: [{ label: "Delivery", amount: 3000 }] }, { type: "PERCENT", value: 100 });
    expect([b.taxableValue, b.extraCharges, b.totalTax, b.grandTotal]).toEqual([0, 3000, 540, 3500]);
  });

  it("UT-GST-037 all-free cart (₹0 items) with a delivery fee spreads it evenly", () => {
    const b = computeBill([{ unitPrice: 0, quantity: 1, gstRate: 5 }, { unitPrice: 0, quantity: 2, gstRate: 5 }], { ...EXCL, roundOff: false, extraCharges: [{ label: "Delivery", amount: 2001 }] });
    expect(b.lines.map((l) => l.extraCharges).sort()).toEqual([1000, 1001]);
    expect(b.totalTax).toBe(100); // 5% of 1000 = 50, of 1001 = round(50.05) = 50
  });

  it("UT-GST-038 line discount larger than the line is capped at the line", () => {
    const b = computeBill([{ unitPrice: 5000, quantity: 1, gstRate: 5, lineDiscount: 999999 }], EXCL);
    expect([b.lines[0].discount, b.taxableValue, b.grandTotal]).toEqual([5000, 0, 0]);
  });

  it("UT-GST-039 stacked discounts apply sequentially on what remains: ₹100, 10% then ₹20 then 50%", () => {
    // 10% of 100 = 10 → 90; ₹20 → 70; 50% of 70 = 35 → 35 taxable (0% GST)
    const b = computeBill([{ unitPrice: 10000, quantity: 1, gstRate: 0 }], EXCL, [
      { type: "PERCENT", value: 10 }, { type: "FLAT", value: 2000 }, { type: "PERCENT", value: 50 },
    ]);
    expect(b.taxableValue).toBe(3500);
  });
});

describe("UT-GST boundary values (BVA)", () => {
  it("UT-GST-050 1 paisa item: tax rounds to 0 and the bill rounds to ₹0", () => {
    const b = computeBill([{ unitPrice: 1, quantity: 1, gstRate: 5 }], EXCL);
    expect([b.totalTax, b.grandTotal, b.roundOff]).toEqual([0, 0, -1]);
  });

  it("UT-GST-051 ₹0 item: everything zero, still a valid tax invoice", () => {
    const b = computeBill([{ unitPrice: 0, quantity: 1, gstRate: 18 }], EXCL);
    expect([b.subtotal, b.totalTax, b.grandTotal]).toEqual([0, 0, 0]);
  });

  it("UT-GST-052 max qty 999 × ₹99,999.99 @28% + 12% cess stays exact (no float drift)", () => {
    const base = 9_999_999 * 999; // 9,989,999,001 paise ≈ ₹9.99 crore
    const gstAmt = Math.round((base * 28) / 100); // BigInt-safe: base*28 < 2^53
    const cessAmt = Math.round((base * 12) / 100);
    const pre = base + gstAmt + cessAmt;
    const b = computeBill([{ unitPrice: 9_999_999, quantity: 999, tax: gst(28, 12) }], EXCL);
    expect(Number(BigInt(base) * 28n / 100n)).toBe(Math.floor((base * 28) / 100)); // oracle sanity
    expect([b.taxableValue, b.cgst + b.sgst, b.cess]).toEqual([base, gstAmt, cessAmt]);
    expect(b.grandTotal).toBe(Math.round(pre / 100) * 100);
    expect(Number.isSafeInteger(b.grandTotal)).toBe(true);
  });

  it("UT-GST-053 round-off at exactly 50 paise rounds half-up; 49 rounds down", () => {
    const at = (p: number) => computeBill([{ unitPrice: p, quantity: 1, gstRate: 0 }], EXCL);
    expect(at(12350).grandTotal).toBe(12400);
    expect(at(12349).grandTotal).toBe(12300);
    expect(at(12351).grandTotal).toBe(12400);
  });

  it("UT-GST-054 100% percent discount, and percent discount above the bill is capped", () => {
    const b = computeBill([{ unitPrice: 10000, quantity: 1, gstRate: 5 }], EXCL, { type: "FLAT", value: 50_000 });
    expect([b.discount, b.grandTotal]).toEqual([10000, 0]);
  });

  it("UT-GST-055 exclusiveOf boundaries", () => {
    expect(exclusiveOf(0, 18)).toBe(0);
    expect(exclusiveOf(105, 5)).toBe(100);
    expect(exclusiveOf(100, 0)).toBe(100);
    expect(exclusiveOf(1, 28)).toBe(1); // round(0.78)
  });
});

describe("UT-GST tax-composition helpers", () => {
  it("UT-GST-060 legacyTax / roundRate kill float noise", () => {
    expect(roundRate(0.1 + 0.2)).toBe(0.3);
    expect(legacyTax(5)).toEqual({ name: "GST 5%", cgst: 2.5, sgst: 2.5, igst: 5, cess: 0, extras: [] });
    expect(legacyTax(0.25).cgst).toBe(0.125);
  });

  it("UT-GST-061 parseTaxExtras drops garbage defensively", () => {
    expect(parseTaxExtras(null)).toEqual([]);
    expect(parseTaxExtras("VAT")).toEqual([]);
    expect(parseTaxExtras([null, 3, { label: " VAT ", percent: "14.5" }, { label: "", percent: 5 }, { label: "X", percent: 0 }, { label: "Y", percent: -1 }, { label: "Z", percent: "abc" }, { label: 5, percent: 5 }]))
      .toEqual([{ label: "VAT", percent: 14.5 }]);
  });

  it("UT-GST-062 taxFromRate, gstPercent, totalTaxPercent, effectiveGstRate, lineTaxOf", () => {
    const t = taxFromRate({ name: "GST 28% + cess", cgst: 14, sgst: 14, igst: 28, cess: null, extras: [{ label: "VAT", percent: 2 }] });
    expect(t.cess).toBe(0);
    expect(gstPercent(t)).toBe(28);
    expect(gstPercent({ cgst: 2.5, sgst: 2.5, igst: 6 }, true)).toBe(6);
    expect(totalTaxPercent(t)).toBe(30);
    expect(totalTaxPercent({ cgst: 0, sgst: 0, igst: 0 })).toBe(0);
    expect(effectiveGstRate(t)).toBe(28);
    expect(lineTaxOf({})).toEqual(legacyTax(0));
    expect(lineTaxOf({ tax: t, gstRate: 5 })).toBe(t);
  });

  it("UT-GST-063 unequal CGST/SGST split is proportional; equal split floors CGST", () => {
    // 3% CGST + 2% SGST on ₹100 → GST ₹5 → CGST round(5 × 3/5) = ₹3, SGST ₹2
    const b = computeBill([{ unitPrice: 10000, quantity: 1, tax: { cgst: 3, sgst: 2, igst: 5 } }], EXCL);
    expect([b.cgst, b.sgst]).toEqual([300, 200]);
  });

  it("UT-GST-064 breakup groups by composition and sorts by rate", () => {
    const b = computeBill(
      [{ unitPrice: 10000, quantity: 1, gstRate: 18 }, { unitPrice: 10000, quantity: 1, gstRate: 5 }, { unitPrice: 5000, quantity: 1, gstRate: 5 }],
      EXCL,
    );
    expect(b.taxBreakup.map((x) => [x.rate, x.taxableValue])).toEqual([[5, 15000], [18, 10000]]);
  });
});

describe("UT-MONEY", () => {
  it("UT-MONEY-001 formatINR uses Indian lakh/crore grouping and two decimals", () => {
    expect(formatINR(0)).toBe("₹0.00");
    expect(formatINR(1)).toBe("₹0.01");
    expect(formatINR(12345678)).toBe("₹1,23,456.78");
    expect(formatINR(1234567890)).toBe("₹1,23,45,678.90");
    expect(formatINR(-5050)).toBe("-₹50.50");
    expect(formatINR(-5050, { symbol: false })).toBe("-50.50");
  });

  it("UT-MONEY-002 toPaise is exact for every 2-decimal rupee amount up to ₹10 lakh", () => {
    for (let p = 0; p <= 100_000_000; p += 7_919) expect(toPaise(Number((p / 100).toFixed(2)))).toBe(p);
    expect(toPaise(1.15)).toBe(115); // 1.15*100 = 114.99999999999999
    expect(toPaise(4.35)).toBe(435);
    expect(toRupees(12345)).toBe(123.45);
  });

  it("UT-MONEY-003 allocate edge cases", () => {
    expect(allocate(0, [1, 2])).toEqual([0, 0]);
    expect(allocate(10, [0, 0])).toEqual([0, 0]);
    expect(allocate(10, [])).toEqual([]);
    expect(allocate(1, [1, 1, 1]).reduce((a, b) => a + b)).toBe(1);
    expect(allocate(100, [1, 1, 1])).toEqual([34, 33, 33]);
    // tie broken by weight then key, not position (BUG-017)
    expect(allocate(1, [2, 2], ["b", "a"])).toEqual([0, 1]);
    expect(allocate(1, [2, 2], ["a", "b"])).toEqual([1, 0]);
  });
});

describe("mutation-driven tests (Phase 4 Stryker survivors)", () => {
  const X: TaxConfig = { ...EXCL, roundOff: false };

  it("MUT-GST-001 equal-value lines at different rates: the leftover paisa goes to the same line whatever the order", () => {
    // ₹100.01 @18% and ₹100.01 @5% share a 3-paise charge → 1.5 each → a tie broken by the line key.
    // 18% line base 10003 → tax round(1800.54) = 1801; base 10002 → 1800. Order must not matter.
    const a = { unitPrice: 10001, quantity: 1, gstRate: 18 };
    const b = { unitPrice: 10001, quantity: 1, gstRate: 5 };
    const cfg = { ...X, extraCharges: [{ label: "Packaging", amount: 3 }] };
    expect(computeBill([a, b], cfg).totalTax).toBe(computeBill([b, a], cfg).totalTax);
    expect(computeBill([a, b], cfg).grandTotal).toBe(computeBill([b, a], cfg).grandTotal);
  });

  it("MUT-GST-002 fully discounted cart: delivery fee follows gross value, not an equal split", () => {
    // ₹100 @18% and a ₹0 @5% item, 100% off; ₹10 delivery → all on the 18% line → ₹1.80 tax
    const b = computeBill([{ unitPrice: 10000, quantity: 1, gstRate: 18 }, { unitPrice: 0, quantity: 1, gstRate: 5 }], { ...X, extraCharges: [{ label: "Delivery", amount: 1000 }] }, { type: "PERCENT", value: 100 });
    expect(b.lines.map((l) => l.extraCharges)).toEqual([1000, 0]);
    expect(b.totalTax).toBe(180);
  });

  it("MUT-GST-003 breakup: default name, taxable value includes service + extra charges, distinct extras, sorted by rate then cess", () => {
    const b = computeBill(
      [
        { unitPrice: 10000, quantity: 1, tax: { cgst: 14, sgst: 14, igst: 28, cess: 12 } },
        { unitPrice: 10000, quantity: 1, tax: { cgst: 14, sgst: 14, igst: 28, cess: 0 } },
        { unitPrice: 10000, quantity: 1, tax: { cgst: 2.5, sgst: 2.5, igst: 5, extras: [{ label: "VAT", percent: 1 }, { label: "Luxury", percent: 2 }] } },
      ],
      { ...X, serviceChargeEnabled: true, serviceChargePercent: 10, extraCharges: [{ label: "Packaging", amount: 300 }] },
    );
    expect(b.taxBreakup.map((x) => [x.name, x.rate, x.cessRate])).toEqual([["GST 5%", 5, 0], ["GST 28%", 28, 0], ["GST 28%", 28, 12]]);
    // each line: ₹100 + ₹10 SC + ₹1 packaging = ₹111
    expect(b.taxBreakup.map((x) => x.taxableValue)).toEqual([11100, 11100, 11100]);
    expect(b.taxDetails).toEqual([{ label: "VAT", percent: 1, amount: 111 }, { label: "Luxury", percent: 2, amount: 222 }]);
  });

  it("MUT-GST-004 default interState=false in gstPercent / totalTaxPercent (asymmetric IGST)", () => {
    const t = { cgst: 2.5, sgst: 2.5, igst: 6, cess: 1 };
    expect(gstPercent(t)).toBe(5);
    expect(totalTaxPercent(t)).toBe(6);
    expect(totalTaxPercent(t, true)).toBe(7);
  });

  it("MUT-GST-005 equal CGST/SGST splits an odd GST paisa as floor/ceil, unequal splits proportionally", () => {
    const eq = computeBill([{ unitPrice: 130, quantity: 1, tax: { cgst: 2.5, sgst: 2.5, igst: 5 } }], X); // GST 7 paise
    expect([eq.cgst, eq.sgst]).toEqual([3, 4]);
    const zero = computeBill([{ unitPrice: 130, quantity: 1, tax: { cgst: 0, sgst: 0, igst: 5 } }], X);
    expect([zero.cgst, zero.sgst]).toEqual([0, 0]);
  });
});

describe("mutation-driven tests (2)", () => {
  it("MUT-GST-006 same GST rates but different extra taxes are separate breakup rows", () => {
    const b = computeBill(
      [
        { unitPrice: 10000, quantity: 1, tax: { name: "GST 5%", cgst: 2.5, sgst: 2.5, igst: 5 } },
        { unitPrice: 10000, quantity: 1, tax: { name: "GST 5%", cgst: 2.5, sgst: 2.5, igst: 5, extras: [{ label: "VAT", percent: 2 }] } },
      ],
      { ...EXCL, roundOff: false },
    );
    expect(b.taxBreakup).toHaveLength(2);
    expect(b.taxBreakup.map((x) => x.otherTaxes).sort()).toEqual([0, 200]);
  });
});
