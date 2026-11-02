/**
 * Property-based tests (fast-check) for the bill engine — Phase 4.
 * Every property runs against random carts: mixed GST rates, cess, named extra
 * taxes, inclusive/exclusive prices, inter/intra-state, composition, GST-off,
 * line + stacked bill discounts, service charge and extra charges.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { computeBill, type BillDiscount, type BillLineInput, type LineTax, type TaxConfig } from "./gst";
import { allocate } from "./money";

const RUNS = Number(process.env.PBT_RUNS ?? 2000);

const gstRate = fc.constantFrom(0, 5, 12, 18, 28);
const lineTax: fc.Arbitrary<LineTax> = fc
  .record({
    rate: gstRate,
    cess: fc.constantFrom(0, 0, 0, 1, 12, 15),
    extras: fc.array(fc.record({ label: fc.constantFrom("VAT", "Luxury"), percent: fc.constantFrom(1, 2.5, 14.5) }), { maxLength: 2 }),
    uneven: fc.boolean(),
  })
  .map(({ rate, cess, extras, uneven }) => {
    const cgst = uneven && rate > 0 ? rate / 2 + 1 : rate / 2;
    return { name: `T${rate}/${cess}`, cgst, sgst: rate - cgst, igst: rate, cess, extras };
  });

const line: fc.Arbitrary<BillLineInput> = fc
  .record({
    unitPrice: fc.oneof(fc.integer({ min: 0, max: 50_000 }), fc.constantFrom(0, 1, 50, 99, 100, 101, 9_999_999)),
    quantity: fc.integer({ min: 1, max: 999 }),
    tax: fc.option(lineTax, { nil: undefined }),
    gstRate,
    lineDiscount: fc.option(fc.integer({ min: 0, max: 100_000 }), { nil: undefined }),
  })
  .map((l) => (l.tax ? { ...l, gstRate: undefined } : { ...l, tax: undefined }));

const config: fc.Arbitrary<TaxConfig> = fc.record({
  pricesIncludeTax: fc.boolean(),
  interState: fc.boolean(),
  compositionScheme: fc.boolean(),
  taxEnabled: fc.option(fc.boolean(), { nil: undefined }),
  serviceChargeEnabled: fc.boolean(),
  serviceChargePercent: fc.constantFrom(0, 2.5, 5, 10),
  roundOff: fc.boolean(),
  extraCharges: fc.option(
    fc.array(fc.record({ label: fc.constantFrom("Packaging", "Delivery"), amount: fc.integer({ min: 0, max: 10_000 }) }), { maxLength: 2 }),
    { nil: undefined },
  ),
});

const discount: fc.Arbitrary<BillDiscount> = fc.oneof(
  fc.record({ type: fc.constant("FLAT" as const), value: fc.integer({ min: 0, max: 500_000 }) }),
  fc.record({ type: fc.constant("PERCENT" as const), value: fc.integer({ min: 0, max: 100 }) }),
);
const discounts = fc.option(fc.oneof(discount, fc.array(discount, { maxLength: 3 })), { nil: undefined });
const cart = fc.tuple(fc.array(line, { minLength: 1, maxLength: 8 }), config, discounts);

const MONEY_KEYS = ["subtotal", "discount", "taxableValue", "serviceCharge", "extraCharges", "cgst", "sgst", "igst", "cess", "otherTaxes", "totalTax", "grandTotal"] as const;

describe("computeBill — properties (PBT-GST)", () => {
  it("PBT-GST-001 every money field is an integer number of paise and never negative (except round-off)", () => {
    fc.assert(
      fc.property(cart, ([lines, cfg, d]) => {
        const b = computeBill(lines, cfg, d);
        for (const k of MONEY_KEYS) {
          expect(Number.isSafeInteger(b[k]), k).toBe(true);
          expect(b[k], k).toBeGreaterThanOrEqual(0);
        }
        expect(Number.isSafeInteger(b.roundOff)).toBe(true);
        for (const l of b.lines) for (const v of Object.values(l)) if (typeof v === "number") expect(Number.isSafeInteger(v) && v >= 0).toBe(true);
      }),
      { numRuns: RUNS },
    );
  });

  it("PBT-GST-002 grand total = taxable + service charge + extra charges + tax + round-off", () => {
    fc.assert(
      fc.property(cart, ([lines, cfg, d]) => {
        const b = computeBill(lines, cfg, d);
        expect(b.grandTotal).toBe(b.taxableValue + b.serviceCharge + b.extraCharges + b.totalTax + b.roundOff);
        expect(b.totalTax).toBe(b.cgst + b.sgst + b.igst + b.cess + b.otherTaxes);
        expect(b.subtotal - b.discount).toBe(b.taxableValue);
      }),
      { numRuns: RUNS },
    );
  });

  it("PBT-GST-003 line results sum exactly to the bill (no lost paise in allocation)", () => {
    fc.assert(
      fc.property(cart, ([lines, cfg, d]) => {
        const b = computeBill(lines, cfg, d);
        const sum = (k: keyof (typeof b.lines)[number]) => b.lines.reduce((s, l) => s + (l[k] as number), 0);
        expect(sum("taxableValue")).toBe(b.taxableValue);
        expect(sum("serviceCharge")).toBe(b.serviceCharge);
        expect(sum("discount")).toBe(b.discount);
        expect(sum("tax")).toBe(b.totalTax);
        expect(sum("total") + b.roundOff).toBe(b.grandTotal);
        if (b.documentType === "TAX_INVOICE" && b.lines.some((l) => l.taxableValue + l.serviceCharge + l.extraCharges > 0)) {
          expect(sum("extraCharges")).toBe(b.extraCharges);
        }
      }),
      { numRuns: RUNS },
    );
  });

  it("PBT-GST-004 tax breakup totals equal the bill's tax totals", () => {
    fc.assert(
      fc.property(cart, ([lines, cfg, d]) => {
        const b = computeBill(lines, cfg, d);
        const s = (k: "cgst" | "sgst" | "igst" | "cess" | "otherTaxes") => b.taxBreakup.reduce((a, x) => a + x[k], 0);
        expect([s("cgst"), s("sgst"), s("igst"), s("cess"), s("otherTaxes")]).toEqual([b.cgst, b.sgst, b.igst, b.cess, b.otherTaxes]);
        expect(b.taxDetails.reduce((a, x) => a + x.amount, 0)).toBe(b.otherTaxes);
      }),
      { numRuns: RUNS },
    );
  });

  it("PBT-GST-005 deterministic: same input, same output", () => {
    fc.assert(
      fc.property(cart, ([lines, cfg, d]) => {
        expect(computeBill(lines, cfg, d)).toEqual(computeBill(lines, cfg, d));
      }),
      { numRuns: 500 },
    );
  });

  it("PBT-GST-006 order-independent: shuffling the cart lines doesn't change any bill total", () => {
    fc.assert(
      fc.property(cart, fc.integer(), ([lines, cfg, d], seed) => {
        const shuffled = [...lines].map((l, i) => ({ l, k: Math.sin(seed + i) })).sort((a, b) => a.k - b.k).map((x) => x.l);
        const a = computeBill(lines, cfg, d);
        const b = computeBill(shuffled, cfg, d);
        for (const k of MONEY_KEYS) expect(b[k], k).toBe(a[k]);
      }),
      { numRuns: RUNS },
    );
  });

  it("PBT-GST-007 intra-state never charges IGST; inter-state never charges CGST/SGST", () => {
    fc.assert(
      fc.property(cart, ([lines, cfg, d]) => {
        const b = computeBill(lines, cfg, d);
        if (cfg.interState) expect(b.cgst + b.sgst).toBe(0);
        else expect(b.igst).toBe(0);
      }),
      { numRuns: RUNS },
    );
  });

  it("PBT-GST-008 Bill of Supply / plain bill carry no tax at all", () => {
    fc.assert(
      fc.property(cart, ([lines, cfg, d]) => {
        const b = computeBill(lines, cfg, d);
        if (cfg.taxEnabled === false) expect(b.documentType).toBe("BILL");
        else if (cfg.compositionScheme) expect(b.documentType).toBe("BILL_OF_SUPPLY");
        else expect(b.documentType).toBe("TAX_INVOICE");
        if (b.documentType !== "TAX_INVOICE") {
          expect(b.totalTax).toBe(0);
          expect(b.taxBreakup).toEqual([]);
          // no tax → inclusive menu prices are charged as they are
          expect(b.subtotal).toBe(lines.reduce((s, l) => s + l.unitPrice * l.quantity, 0));
        }
      }),
      { numRuns: RUNS },
    );
  });

  it("PBT-GST-009 discounts never exceed the bill and never make anything negative", () => {
    fc.assert(
      fc.property(cart, ([lines, cfg, d]) => {
        const b = computeBill(lines, cfg, d);
        expect(b.discount).toBeLessThanOrEqual(b.subtotal);
        expect(b.lines.every((l) => l.discount <= l.gross)).toBe(true);
      }),
      { numRuns: RUNS },
    );
  });

  it("PBT-GST-010 round-off yields whole rupees and moves the total by at most 50 paise", () => {
    fc.assert(
      fc.property(cart, ([lines, cfg, d]) => {
        const b = computeBill(lines, cfg, d);
        if (cfg.roundOff) {
          expect(b.grandTotal % 100).toBe(0);
          expect(Math.abs(b.roundOff)).toBeLessThanOrEqual(50);
        } else expect(b.roundOff).toBe(0);
      }),
      { numRuns: RUNS },
    );
  });

  it("PBT-GST-011 a bigger discount never increases the grand total (monotonic)", () => {
    fc.assert(
      fc.property(fc.array(line, { minLength: 1, maxLength: 6 }), config, fc.integer({ min: 0, max: 100_000 }), fc.integer({ min: 0, max: 100_000 }), (lines, cfg, x, y) => {
        const [lo, hi] = x <= y ? [x, y] : [y, x];
        // Fixed extra charges (packaging/delivery) are excluded: they are taxed at the rates
        // of the lines they are allocated to, so near-100% discounts can shift them onto a
        // higher-rate line (BUG-018, documented below).
        const c = { ...cfg, roundOff: false, extraCharges: undefined };
        const a = computeBill(lines, c, { type: "FLAT", value: lo });
        const b = computeBill(lines, c, { type: "FLAT", value: hi });
        // Allow 1 paisa per line of rounding jitter.
        expect(b.grandTotal).toBeLessThanOrEqual(a.grandTotal + lines.length);
      }),
      { numRuns: RUNS },
    );
  });

  it("PBT-GST-012 tax-inclusive menu prices: customer pays the menu price (within rounding) when nothing else applies", () => {
    fc.assert(
      fc.property(fc.array(line, { minLength: 1, maxLength: 6 }), (lines) => {
        const clean = lines.map((l) => ({ ...l, lineDiscount: undefined }));
        const b = computeBill(clean, {
          pricesIncludeTax: true, interState: false, compositionScheme: false, serviceChargeEnabled: false, serviceChargePercent: 0, roundOff: false,
        });
        const menu = clean.reduce((s, l) => s + l.unitPrice * l.quantity, 0);
        // Each line's taxable value and each tax component are rounded separately:
        // at most 1 paisa per component per line.
        const components = clean.reduce((s, l) => s + 2 + (l.tax?.extras?.length ?? 0) + 1, 0);
        expect(Math.abs(b.grandTotal - menu)).toBeLessThanOrEqual(components);
      }),
      { numRuns: RUNS },
    );
  });
});

describe("allocate — properties (PBT-MONEY)", () => {
  const weights = fc.array(fc.integer({ min: 0, max: 1_000_000 }), { minLength: 1, maxLength: 20 });
  it("PBT-MONEY-001 parts sum exactly to the total, are non-negative integers and within 1 paisa of proportional", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 10_000_000 }), weights, (total, w) => {
        const parts = allocate(total, w);
        const sum = w.reduce((a, b) => a + b, 0);
        expect(parts).toHaveLength(w.length);
        if (sum === 0) {
          expect(parts.every((p) => p === 0)).toBe(true);
          return;
        }
        expect(parts.reduce((a, b) => a + b, 0)).toBe(total);
        parts.forEach((p, i) => {
          expect(Number.isInteger(p) && p >= 0).toBe(true);
          expect(Math.abs(p - (total * w[i]) / sum)).toBeLessThan(1);
        });
      }),
      { numRuns: RUNS },
    );
  });
});

describe("computeBill — order independence regression (BUG-017)", () => {
  it("UT-GST-ORD-001 fast-check counterexample: swapping a 5% and a 0% line keeps the same total", () => {
    const A = { unitPrice: 4673, quantity: 320, gstRate: 5, lineDiscount: 99985 };
    const B = { unitPrice: 99, quantity: 369, gstRate: 0, lineDiscount: 16 };
    const cfg: TaxConfig = {
      pricesIncludeTax: false, interState: false, compositionScheme: false,
      serviceChargeEnabled: true, serviceChargePercent: 10, roundOff: false,
      extraCharges: [{ label: "Packaging", amount: 3404 }],
    };
    const ab = computeBill([A, B], cfg);
    const ba = computeBill([B, A], cfg);
    expect(ba.grandTotal).toBe(ab.grandTotal);
    expect(ba.totalTax).toBe(ab.totalTax);
    expect(ba.serviceCharge).toBe(ab.serviceCharge);
  });
});

describe("computeBill — extra-charge tax allocation near full discount (BUG-018, open)", () => {
  it("UT-GST-018 characterization: a bigger discount can raise the bill by at most extraCharges × (max rate − min rate)", () => {
    const lines = [
      { unitPrice: 100, quantity: 1, tax: { cgst: 0, sgst: 0, igst: 0, cess: 0, extras: [{ label: "VAT", percent: 14.5 }] }, lineDiscount: 41 },
      { unitPrice: 2, quantity: 13, gstRate: 0 },
    ];
    const cfg: TaxConfig = { pricesIncludeTax: true, interState: false, compositionScheme: false, serviceChargeEnabled: false, serviceChargePercent: 0, roundOff: false, extraCharges: [{ label: "Packaging", amount: 1686 }] };
    const small = computeBill(lines, cfg, { type: "FLAT", value: 3 });
    const big = computeBill(lines, cfg, { type: "FLAT", value: 76 });
    // Current behaviour (documented rule: charges taxed at the rate of the lines they accrue on):
    expect(big.grandTotal).toBeGreaterThan(small.grandTotal);
    expect(big.grandTotal - small.grandTotal).toBeLessThanOrEqual(Math.ceil(1686 * 0.145));
  });
});
