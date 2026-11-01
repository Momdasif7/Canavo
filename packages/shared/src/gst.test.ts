import { describe, expect, it } from "vitest";
import { computeBill, TaxConfig, withTaxMode } from "./gst";
import { allocate } from "./money";
import { financialYearStart, formatInvoiceNumber } from "./invoice";
import { distanceMeters } from "./geo";

const base: TaxConfig = {
  pricesIncludeTax: false,
  interState: false,
  compositionScheme: false,
  serviceChargeEnabled: false,
  serviceChargePercent: 0,
  roundOff: true,
};

describe("allocate", () => {
  it("splits exactly with no lost paise", () => {
    const parts = allocate(100, [1, 1, 1]);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(100);
    expect(parts.sort()).toEqual([33, 33, 34]);
  });
  it("handles zero weights", () => {
    expect(allocate(50, [0, 0])).toEqual([0, 0]);
  });
});

describe("computeBill", () => {
  it("splits CGST/SGST for tax-exclusive prices", () => {
    const r = computeBill([{ unitPrice: 10000, quantity: 2, gstRate: 5 }], base);
    expect(r.taxableValue).toBe(20000);
    expect(r.cgst).toBe(500);
    expect(r.sgst).toBe(500);
    expect(r.igst).toBe(0);
    expect(r.grandTotal).toBe(21000);
    expect(r.documentType).toBe("TAX_INVOICE");
  });

  it("uses IGST for inter-state supply", () => {
    const r = computeBill([{ unitPrice: 10000, quantity: 1, gstRate: 18 }], { ...base, interState: true });
    expect(r.igst).toBe(1800);
    expect(r.cgst + r.sgst).toBe(0);
  });

  it("back-calculates tax from inclusive prices so the menu price is what the customer pays", () => {
    const r = computeBill([{ unitPrice: 10000, quantity: 1, gstRate: 5 }], { ...base, pricesIncludeTax: true });
    expect(r.taxableValue).toBe(9524);
    expect(r.totalTax).toBe(476);
    expect(r.grandTotal).toBe(10000);
  });

  it("applies bill discount before tax and distributes it across mixed rates", () => {
    const r = computeBill(
      [
        { unitPrice: 10000, quantity: 1, gstRate: 5 },
        { unitPrice: 10000, quantity: 1, gstRate: 18 },
      ],
      base,
      { type: "PERCENT", value: 10 },
    );
    expect(r.discount).toBe(2000);
    expect(r.taxableValue).toBe(18000);
    expect(r.totalTax).toBe(450 + 1620);
    expect(r.taxBreakup.map((b) => b.rate)).toEqual([5, 18]);
  });

  it("taxes service charge at the line rate", () => {
    const r = computeBill([{ unitPrice: 10000, quantity: 1, gstRate: 5 }], {
      ...base,
      serviceChargeEnabled: true,
      serviceChargePercent: 10,
    });
    expect(r.serviceCharge).toBe(1000);
    expect(r.totalTax).toBe(550);
    expect(r.grandTotal).toBe(11600);
  });

  it("rounds off to the nearest rupee", () => {
    const r = computeBill([{ unitPrice: 4550, quantity: 1, gstRate: 5 }], base);
    // 45.50 + 2.28 = 47.78 → 48.00
    expect(r.grandTotal).toBe(4800);
    expect(r.roundOff).toBe(22);
  });

  it("issues a bill of supply with no tax under composition scheme", () => {
    const r = computeBill([{ unitPrice: 10000, quantity: 1, gstRate: 5 }], {
      ...base,
      pricesIncludeTax: true,
      compositionScheme: true,
    });
    expect(r.documentType).toBe("BILL_OF_SUPPLY");
    expect(r.totalTax).toBe(0);
    expect(r.grandTotal).toBe(10000);
    expect(r.taxBreakup).toEqual([]);
  });

  it("never lets discount exceed the bill", () => {
    const r = computeBill([{ unitPrice: 5000, quantity: 1, gstRate: 5 }], base, { type: "FLAT", value: 99999 });
    expect(r.grandTotal).toBe(0);
  });
});

describe("invoice numbering", () => {
  it("uses April–March financial years in IST", () => {
    expect(financialYearStart(new Date("2026-03-31T19:00:00Z"))).toBe(2026); // 00:30 on 1 Apr 2026 IST
    expect(financialYearStart(new Date("2026-03-31T10:00:00Z"))).toBe(2025);
    expect(financialYearStart(new Date("2026-10-02T10:00:00Z"))).toBe(2026);
  });
  it("formats and enforces the 16-char limit", () => {
    expect(formatInvoiceNumber("INV", 2025, 234)).toBe("INV-2025-00234");
    expect(() => formatInvoiceNumber("TOOLONG", 2025, 1)).toThrow();
  });
});

describe("distanceMeters", () => {
  it("is roughly correct", () => {
    const d = distanceMeters({ latitude: 12.9716, longitude: 77.5946 }, { latitude: 12.9726, longitude: 77.5946 });
    expect(d).toBeGreaterThan(100);
    expect(d).toBeLessThan(120);
  });
});

describe("computeBill — stacked discounts and extra charges", () => {
  it("applies multiple bill discounts sequentially", () => {
    const r = computeBill([{ unitPrice: 10000, quantity: 1, gstRate: 5 }], base, [
      { type: "PERCENT", value: 10 },
      { type: "FLAT", value: 1000 },
    ]);
    expect(r.discount).toBe(2000);
    expect(r.taxableValue).toBe(8000);
  });
  it("taxes delivery/packaging charges at the line rate", () => {
    const r = computeBill([{ unitPrice: 10000, quantity: 1, gstRate: 5 }], {
      ...base,
      extraCharges: [{ label: "Delivery", amount: 2000 }],
    });
    expect(r.extraCharges).toBe(2000);
    expect(r.totalTax).toBe(600);
    expect(r.grandTotal).toBe(12600);
  });
});

describe("computeBill — custom tax compositions", () => {
  const gst5 = { name: "GST 5%", cgst: 2.5, sgst: 2.5, igst: 5 };
  const gst5cess = { name: "GST 5% + Cess 1%", cgst: 2.5, sgst: 2.5, igst: 5, cess: 1 };
  const gst28cess = { name: "GST 28% + Cess 12%", cgst: 14, sgst: 14, igst: 28, cess: 12 };
  const gst5vat = { name: "GST 5% + VAT", cgst: 2.5, sgst: 2.5, igst: 5, extras: [{ label: "VAT", percent: 14.5 }] };

  it("matches the legacy gstRate path for a plain GST rate", () => {
    const a = computeBill([{ unitPrice: 12345, quantity: 3, gstRate: 18 }], { ...base, pricesIncludeTax: true });
    const b = computeBill([{ unitPrice: 12345, quantity: 3, tax: { cgst: 9, sgst: 9, igst: 18 } }], { ...base, pricesIncludeTax: true });
    expect(b.grandTotal).toBe(a.grandTotal);
    expect([b.cgst, b.sgst, b.taxableValue]).toEqual([a.cgst, a.sgst, a.taxableValue]);
  });

  it("splits unequal CGST/SGST proportionally", () => {
    const r = computeBill([{ unitPrice: 10000, quantity: 1, tax: { cgst: 3, sgst: 2, igst: 5 } }], base);
    expect(r.cgst).toBe(300);
    expect(r.sgst).toBe(200);
    expect(r.taxBreakup[0]).toMatchObject({ rate: 5, cgstRate: 3, sgstRate: 2, cgst: 300, sgst: 200 });
  });

  it("charges cess on top of GST", () => {
    const r = computeBill([{ unitPrice: 10000, quantity: 1, tax: gst5cess }], base);
    expect([r.cgst, r.sgst, r.cess, r.otherTaxes]).toEqual([250, 250, 100, 0]);
    expect(r.totalTax).toBe(600);
    expect(r.grandTotal).toBe(10600);
    expect(r.lines[0]).toMatchObject({ cess: 100, tax: 600, total: 10600 });
    expect(r.taxBreakup[0]).toMatchObject({ name: "GST 5% + Cess 1%", cessRate: 1, cess: 100 });
  });

  it("charges extra named taxes and reports them in taxDetails", () => {
    const r = computeBill([{ unitPrice: 10000, quantity: 1, tax: gst5vat }], base);
    expect(r.otherTaxes).toBe(1450);
    expect(r.taxDetails).toEqual([{ label: "VAT", percent: 14.5, amount: 1450 }]);
    expect(r.totalTax).toBe(1950);
    expect(r.grandTotal).toBe(12000);
    expect(r.roundOff).toBe(50);
    expect(r.taxBreakup[0].extras).toEqual([{ label: "VAT", percent: 14.5, amount: 1450 }]);
  });

  it("extracts the total rate (GST + cess) from inclusive prices", () => {
    const r = computeBill([{ unitPrice: 10600, quantity: 1, tax: gst5cess }], { ...base, pricesIncludeTax: true });
    expect(r.taxableValue).toBe(10000);
    expect(r.cgst + r.sgst).toBe(500);
    expect(r.cess).toBe(100);
    expect(r.grandTotal).toBe(10600);
  });

  it("extracts GST + extras from inclusive prices", () => {
    const r = computeBill([{ unitPrice: 11950, quantity: 2, tax: gst5vat }], { ...base, pricesIncludeTax: true, roundOff: false });
    expect(r.taxableValue).toBe(20000);
    expect(r.otherTaxes).toBe(2900);
    expect(r.grandTotal).toBe(23900);
  });

  it("uses IGST for inter-state supply and still charges cess", () => {
    const r = computeBill([{ unitPrice: 10000, quantity: 1, tax: gst5cess }], { ...base, interState: true });
    expect([r.cgst, r.sgst, r.igst, r.cess]).toEqual([0, 0, 500, 100]);
    expect(r.taxBreakup[0]).toMatchObject({ rate: 5, igst: 500, cess: 100 });
  });

  it("uses the igst percentage (not cgst+sgst) inter-state, including inclusive extraction", () => {
    const t = { cgst: 2.5, sgst: 2.5, igst: 6 };
    const r = computeBill([{ unitPrice: 10600, quantity: 1, tax: t }], { ...base, interState: true, pricesIncludeTax: true });
    expect(r.taxableValue).toBe(10000);
    expect(r.igst).toBe(600);
  });

  it("taxes service charge and extra charges at the line's full composition", () => {
    const r = computeBill([{ unitPrice: 10000, quantity: 1, tax: gst5cess }], {
      ...base,
      roundOff: false,
      serviceChargeEnabled: true,
      serviceChargePercent: 10,
      extraCharges: [{ label: "Packaging", amount: 1000 }],
    });
    // base = 10000 + 1000 SC + 1000 packaging = 12000
    expect(r.cgst + r.sgst).toBe(600);
    expect(r.cess).toBe(120);
    expect(r.grandTotal).toBe(12720);
  });

  it("issues a BILL with no tax when tax is disabled, charging inclusive menu prices as-is", () => {
    const r = computeBill([{ unitPrice: 10000, quantity: 3, tax: gst5cess }], { ...base, pricesIncludeTax: true, taxEnabled: false });
    expect(r.documentType).toBe("BILL");
    expect(r.subtotal).toBe(30000);
    expect(r.taxableValue).toBe(30000);
    expect([r.totalTax, r.cgst, r.sgst, r.igst, r.cess, r.otherTaxes]).toEqual([0, 0, 0, 0, 0, 0]);
    expect(r.grandTotal).toBe(30000);
    expect(r.taxBreakup).toEqual([]);
    expect(r.taxDetails).toEqual([]);
  });

  it("BILL takes precedence over composition and still rounds off", () => {
    const r = computeBill([{ unitPrice: 4550, quantity: 1, gstRate: 5 }], { ...base, compositionScheme: true, taxEnabled: false });
    expect(r.documentType).toBe("BILL");
    expect(r.grandTotal).toBe(4600);
    expect(r.roundOff).toBe(50);
  });

  it("groups mixed compositions in the breakup with exact totals", () => {
    const r = computeBill(
      [
        { unitPrice: 10000, quantity: 1, tax: gst5 },
        { unitPrice: 10000, quantity: 1, tax: gst28cess },
        { unitPrice: 10000, quantity: 1, tax: gst5vat },
        { unitPrice: 5000, quantity: 1, gstRate: 5, lineDiscount: 0 },
      ],
      base,
      { type: "PERCENT", value: 7 },
    );
    expect(r.taxBreakup.map((b) => b.name)).toEqual(["GST 5%", "GST 5% + VAT", "GST 28% + Cess 12%"]);
    const gst5Row = r.taxBreakup[0];
    // Two GST 5% lines (named and legacy) share a row.
    expect(gst5Row.taxableValue).toBe(r.lines[0].taxableValue + r.lines[3].taxableValue);
    const b28 = r.taxBreakup[2];
    expect(b28.cess).toBe(r.cess);
    expect(r.taxBreakup.reduce((s, b) => s + b.cgst + b.sgst + b.igst + b.cess + b.otherTaxes, 0)).toBe(r.totalTax);
    const lineSum = r.lines.reduce((s, l) => s + l.total, 0);
    expect(lineSum + r.roundOff).toBe(r.grandTotal);
    expect(r.taxBreakup.reduce((s, b) => s + b.taxableValue, 0)).toBe(r.taxableValue);
  });

  it("aggregates extras by label and percent", () => {
    const r = computeBill(
      [
        { unitPrice: 10000, quantity: 1, tax: gst5vat },
        { unitPrice: 20000, quantity: 1, tax: { ...gst5vat, name: "Other" } },
        { unitPrice: 10000, quantity: 1, tax: { cgst: 0, sgst: 0, igst: 0, extras: [{ label: "VAT", percent: 5 }] } },
      ],
      base,
    );
    expect(r.taxDetails).toEqual([
      { label: "VAT", percent: 14.5, amount: 4350 },
      { label: "VAT", percent: 5, amount: 500 },
    ]);
    expect(r.otherTaxes).toBe(4850);
  });
});

describe("flat discounts and GST (D1, Phase 3.6)", () => {
  const cfg: TaxConfig = { pricesIncludeTax: false, interState: false, compositionScheme: false, serviceChargeEnabled: false, serviceChargePercent: 0, roundOff: false };
  const lines = [{ unitPrice: 20000, quantity: 1, tax: { cgst: 2.5, sgst: 2.5, igst: 5 } }];

  it("default (pre-tax): ₹50 off takes ₹50 off the taxable value, saving ₹52.50 incl. GST", () => {
    const full = computeBill(lines, cfg);
    const b = computeBill(lines, cfg, { type: "FLAT", value: 5000 });
    expect(b.taxableValue).toBe(15000);
    expect(full.grandTotal - b.grandTotal).toBe(5250);
  });

  it("GST-inclusive: ₹50 off takes exactly ₹50 off the total", () => {
    const full = computeBill(lines, cfg);
    const b = computeBill(lines, cfg, { type: "FLAT", value: 5000, includesTax: true });
    expect(full.grandTotal - b.grandTotal).toBe(5000);
  });

  it("withTaxMode marks only ₹ discounts, and bills without GST take ₹50 off either way", () => {
    expect(withTaxMode({ type: "PERCENT", value: 10 }, true)).toEqual({ type: "PERCENT", value: 10 });
    expect(withTaxMode({ type: "FLAT", value: 100 }, true)).toEqual({ type: "FLAT", value: 100, includesTax: true });
    expect(withTaxMode({ type: "FLAT", value: 100 }, false)).toEqual({ type: "FLAT", value: 100 });
    const noGst = { ...cfg, taxEnabled: false };
    expect(computeBill(lines, noGst, { type: "FLAT", value: 5000, includesTax: true }).grandTotal).toBe(15000);
  });
});
