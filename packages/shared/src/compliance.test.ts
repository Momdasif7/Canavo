/**
 * QA Phase 14 — compliance & domain correctness (GST bills vs hand-calculated values,
 * Rule 46 / 49 document fields, Indian identifiers, IST business day under any server TZ).
 * Run under different server timezones too: TZ=UTC / TZ=America/New_York npx vitest run.
 */
import { describe, expect, it } from "vitest";
import { computeBill, TaxConfig } from "./gst";
import { formatInvoiceNumber, financialYearStart, parseInvoiceNumber } from "./invoice";
import { formatINR } from "./money";
import { formatReceiptText, hsnCodesOf, ReceiptData, receiptTaxLines } from "./receipt";
import { gstinCheckChar, gstinProblem, gstinSchema, isValidFssai, isValidGstin, normalizeIndianMobile, placeOfSupplyLabel } from "./india";
import { indianPhone, outletSchema } from "./schemas";

const cfg: TaxConfig = { pricesIncludeTax: false, interState: false, compositionScheme: false, serviceChargeEnabled: false, serviceChargePercent: 0, roundOff: false };
const gst = (rate: number, cess = 0) => ({ name: `GST ${rate}%`, cgst: rate / 2, sgst: rate / 2, igst: rate, cess });

describe("GST sample bills (hand-calculated)", () => {
  it.each([
    // [rate, cess, price ₹, qty, CGST, SGST, cess, total] — all paise
    [0, 0, 10000, 1, 0, 0, 0, 10000],
    [5, 0, 20000, 2, 1000, 1000, 0, 42000],
    [12, 0, 15000, 1, 900, 900, 0, 16800],
    [18, 0, 100000, 1, 9000, 9000, 0, 118000],
    [28, 12, 10000, 1, 1400, 1400, 1200, 14000], // aerated drink: 28 % + 12 % compensation cess
  ])("%i%% (+%i%% cess): exclusive price", (rate, cess, price, qty, c, s, ce, total) => {
    const r = computeBill([{ unitPrice: price, quantity: qty, tax: gst(rate, cess) }], cfg);
    expect([r.cgst, r.sgst, r.cess, r.igst, r.grandTotal]).toEqual([c, s, ce, 0, total]);
    expect(r.taxBreakup[0]).toMatchObject({ rate, cgstRate: rate / 2, sgstRate: rate / 2, taxableValue: price * qty });
  });

  it("inter-state: IGST only, same total", () => {
    const r = computeBill([{ unitPrice: 100000, quantity: 1, tax: gst(18) }], { ...cfg, interState: true });
    expect([r.cgst, r.sgst, r.igst, r.grandTotal]).toEqual([0, 0, 18000, 118000]);
  });

  it("tax-inclusive menu price: ₹105 at 5 % = ₹100 taxable + ₹2.50 + ₹2.50", () => {
    const r = computeBill([{ unitPrice: 10500, quantity: 1, tax: gst(5) }], { ...cfg, pricesIncludeTax: true });
    expect([r.taxableValue, r.cgst, r.sgst, r.grandTotal]).toEqual([10000, 250, 250, 10500]);
  });

  it("discount is applied before tax across mixed rates, then rounded off to the rupee", () => {
    // ₹500 @5 % + ₹500 @18 %, 10 % off → 450 + 450 taxable; tax 22.50 + 81.00; 1003.50 → 1004.00
    const r = computeBill(
      [{ unitPrice: 50000, quantity: 1, tax: gst(5) }, { unitPrice: 50000, quantity: 1, tax: gst(18) }],
      { ...cfg, roundOff: true },
      { type: "PERCENT", value: 10 },
    );
    expect([r.discount, r.taxableValue, r.totalTax, r.roundOff, r.grandTotal]).toEqual([10000, 90000, 10350, 50, 100400]);
  });

  it("service charge is part of the value of supply and taxed at the line's rate", () => {
    // ₹1000 @18 % + 10 % service charge → base 1100 → GST 198 → 1298
    const r = computeBill([{ unitPrice: 100000, quantity: 1, tax: gst(18) }], { ...cfg, serviceChargeEnabled: true, serviceChargePercent: 10 });
    expect([r.serviceCharge, r.totalTax, r.grandTotal]).toEqual([10000, 19800, 129800]);
    expect(r.taxBreakup[0]!.taxableValue).toBe(110000);
  });

  it("packaging / delivery fee follows the principal supply's rate (composite supply)", () => {
    // ₹200 @5 % + ₹40 packaging → 240 → GST 12 → 252
    const r = computeBill([{ unitPrice: 20000, quantity: 1, tax: gst(5) }], { ...cfg, extraCharges: [{ label: "Packaging", amount: 4000 }] });
    expect([r.extraCharges, r.cgst, r.sgst, r.grandTotal]).toEqual([4000, 600, 600, 25200]);
  });

  it("composition scheme: Bill of Supply, no tax collected", () => {
    const r = computeBill([{ unitPrice: 20000, quantity: 1, tax: gst(5) }], { ...cfg, compositionScheme: true });
    expect(r.documentType).toBe("BILL_OF_SUPPLY");
    expect([r.totalTax, r.cgst, r.sgst, r.igst, r.taxBreakup.length, r.grandTotal]).toEqual([0, 0, 0, 0, 0, 20000]);
  });

  it("GST off: plain BILL, inclusive menu prices charged as they are", () => {
    const r = computeBill([{ unitPrice: 10500, quantity: 1, tax: gst(5) }], { ...cfg, pricesIncludeTax: true, taxEnabled: false });
    expect(r.documentType).toBe("BILL");
    expect([r.totalTax, r.grandTotal]).toEqual([0, 10500]);
  });
});

describe("Rule 46 invoice numbers", () => {
  it("unique per FY, at most 16 characters, IST financial year", () => {
    expect(formatInvoiceNumber("INV", 2026, 1)).toBe("INV-2026-00001");
    expect(formatInvoiceNumber("ABCDE", 2026, 99999)).toHaveLength(16);
    // 31 Mar 2027 19:00 UTC = 1 Apr 2027 00:30 IST → FY 2027-28
    expect(financialYearStart(new Date("2027-03-31T19:00:00Z"))).toBe(2027);
    expect(financialYearStart(new Date("2027-03-31T18:00:00Z"))).toBe(2026);
  });
  it("cmp-2: a 5-character prefix past 99,999 bills keeps billing (2-digit FY) instead of throwing", () => {
    const n = formatInvoiceNumber("ABCDE", 2026, 100000);
    expect(n).toBe("ABCDE-26-100000");
    expect(n.length).toBeLessThanOrEqual(16);
    expect(parseInvoiceNumber(n)).toEqual({ prefix: "ABCDE", fyStart: 2026, seq: 100000 });
  });
});

describe("Indian identifiers", () => {
  it("GSTIN: shape, state code and check character", () => {
    expect(isValidGstin("27AAPFU0939F1ZV")).toBe(true);
    expect(gstinCheckChar("29ABCDE1234F1Z")).toBe("W");
    expect(gstinProblem("27AAPFU0939F1ZX")).toMatch(/check character/);
    expect(gstinProblem("00AAPFU0939F1ZV")).toMatch(/state code/);
    expect(gstinProblem("27AAPFU0939F1AV")).toMatch(/15-character/);
    expect(gstinSchema.parse(" 27aapfu0939f1zv ")).toBe("27AAPFU0939F1ZV");
    expect(outletSchema.safeParse({ name: "Test", stateCode: "29", gstin: "29ABCDE1234F1Z5" }).success).toBe(false);
    expect(outletSchema.safeParse({ name: "Test", stateCode: "29", gstin: "29ABCDE1234F1ZW" }).success).toBe(true);
    expect(outletSchema.safeParse({ name: "Test", stateCode: "00" }).success).toBe(false);
  });
  it("mobile: +91 / 0 prefixes normalised, 10 digits starting 6-9", () => {
    for (const p of ["+91 98765 43210", "+91-9876543210", "919876543210", "09876543210", "9876543210"]) expect(indianPhone.parse(p)).toBe("9876543210");
    for (const p of ["5876543210", "987654321", "+1 9876543210", "98765432101"]) expect(indianPhone.safeParse(p).success).toBe(false);
    expect(normalizeIndianMobile("+44 7700 900123")).toBe("+447700900123");
  });
  it("FSSAI licence is 14 digits; place of supply carries the state name", () => {
    expect(isValidFssai("12345678901234")).toBe(true);
    expect(isValidFssai("1234567890123")).toBe(false);
    expect(placeOfSupplyLabel("29")).toBe("29-Karnataka");
  });
  it("rupees use lakh / crore grouping", () => {
    expect(formatINR(1234567890)).toBe("₹1,23,45,678.90");
    expect(formatINR(-10000000)).toBe("-₹1,00,000.00");
  });
});

const receipt = (over: Partial<ReceiptData> = {}): ReceiptData => ({
  documentType: "TAX_INVOICE",
  invoiceNumber: "INV-2026-00042",
  issuedAt: "2026-11-08T18:45:00Z", // 9 Nov 00:15 IST
  outlet: { name: "Canavo Cafe", legalName: "Canavo Foods Pvt Ltd", address: "MG Road, Bengaluru", gstin: "29ABCDE1234F1ZW", fssai: "11223344556677", phone: "9876543210" },
  orderType: "DINE_IN",
  cashierName: "Asha",
  items: [{ name: "Masala Dosa", quantity: 2, unitPrice: 10000, amount: 20000, gstRate: 5, hsnCode: "996331" }],
  subtotal: 20000,
  discount: 0,
  serviceCharge: 0,
  cgst: 500,
  sgst: 500,
  igst: 0,
  roundOff: 0,
  grandTotal: 21000,
  taxBreakup: [{ rate: 5, cgstRate: 2.5, sgstRate: 2.5, taxableValue: 20000, cgst: 500, sgst: 500, igst: 0 }],
  interState: false,
  placeOfSupply: "29-Karnataka",
  payments: [{ mode: "CASH", amount: 21000 }],
  ...over,
});

describe("Receipt mandatory fields (Rule 46 tax invoice / Rule 49 bill of supply / FSSAI)", () => {
  it("tax invoice: title, supplier name + address + GSTIN, FSSAI, number, IST date, place of supply, HSN/SAC, rate-wise tax", () => {
    const t = formatReceiptText(receipt(), 48).join("\n");
    for (const s of ["TAX INVOICE", "CANAVO CAFE", "Canavo Foods Pvt Ltd", "MG Road", "GSTIN: 29ABCDE1234F1ZW", "FSSAI: 11223344556677", "No: INV-2026-00042", "9/11/2026", "Place of supply: 29-Karnataka", "HSN/SAC: 996331", "CGST @2.5%", "SGST @2.5%", "Computer-generated"]) {
      expect(t).toContain(s);
    }
  });
  it("bill of supply: no tax lines, composition declaration, still GSTIN + HSN", () => {
    const r = receipt({ documentType: "BILL_OF_SUPPLY", cgst: 0, sgst: 0, taxBreakup: [], grandTotal: 20000 });
    const t = formatReceiptText(r, 48).join("\n");
    expect(t).toContain("BILL OF SUPPLY");
    expect(t).toContain("Composition taxable person");
    expect(t).toContain("GSTIN: 29ABCDE1234F1ZW");
    expect(t).toContain("HSN/SAC: 996331");
    expect(receiptTaxLines(r)).toEqual([]);
    expect(t).not.toMatch(/CGST|SGST|IGST/);
  });
  it("GST-off plain bill: no GSTIN, tax lines, HSN or place of supply — FSSAI still printed", () => {
    const r = receipt({ documentType: "BILL", outlet: { ...receipt().outlet, gstin: null }, cgst: 0, sgst: 0, taxBreakup: [] });
    const t = formatReceiptText(r, 58).join("\n");
    expect(t).toMatch(/^\s*BILL$/m);
    expect(t).not.toMatch(/GSTIN|CGST|HSN|Place of supply/);
    expect(t).toContain("FSSAI: 11223344556677");
    expect(hsnCodesOf(r)).toEqual([]);
  });
  it("inter-state invoice prints IGST", () => {
    const r = receipt({ interState: true, cgst: 0, sgst: 0, igst: 1000, taxBreakup: [{ rate: 5, igstRate: 5, taxableValue: 20000, cgst: 0, sgst: 0, igst: 1000 }] });
    expect(receiptTaxLines(r)).toEqual([{ label: "IGST @5%", amount: 1000 }]);
  });
});

describe(`IST business day regardless of server TZ (process TZ=${process.env.TZ ?? "unset"})`, () => {
  it("financial year and receipt date follow Asia/Kolkata", () => {
    expect(financialYearStart(new Date("2026-03-31T18:30:00Z"))).toBe(2026); // 1 Apr 00:00 IST
    expect(financialYearStart(new Date("2026-03-31T18:29:59Z"))).toBe(2025);
    const t = formatReceiptText(receipt({ issuedAt: "2026-03-31T18:30:00Z" }), 48).join("\n");
    expect(t).toContain("1/4/2026");
  });
});
