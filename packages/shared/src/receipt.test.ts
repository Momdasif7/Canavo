import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { charsPerLine, documentTitle, formatReceiptText, receiptTaxLines, toEscPos, type ReceiptData } from "./receipt";

const base = (over: Partial<ReceiptData> = {}): ReceiptData => ({
  documentType: "TAX_INVOICE",
  invoiceNumber: "INV-2026-00042",
  issuedAt: "2026-04-01T04:30:00.000Z", // 10:00 IST
  outlet: { name: "Saravana Test", legalName: "Saravana Foods Pvt Ltd", address: "12 Anna Salai, Chennai 600002", gstin: "33ABCDE1234F1Z5", fssai: "12345678901234", phone: "9876543210" },
  orderType: "DINE_IN",
  tableLabel: "T4",
  cashierName: "Priya",
  customerName: "Arun",
  items: [{ name: "Masala Dosa", quantity: 2, unitPrice: 8000, amount: 16000, gstRate: 5, hsnCode: "996331" }],
  subtotal: 16000,
  discount: 1000,
  serviceCharge: 500,
  charges: [{ label: "Packaging", amount: 500 }],
  cgst: 400,
  sgst: 400,
  igst: 0,
  roundOff: 0,
  grandTotal: 16800,
  taxBreakup: [{ name: "GST 5%", rate: 5, cgstRate: 2.5, sgstRate: 2.5, igstRate: 5, cessRate: 0, taxableValue: 16000, cgst: 400, sgst: 400, igst: 0 }],
  payments: [{ mode: "CASH", amount: 16800 }],
  ...over,
});

describe("receipt text (UT-RCP)", () => {
  it("UT-RCP-001 tax invoice shows title, GSTIN, FSSAI, legal name, CGST/SGST lines, IST date/time", () => {
    const t = formatReceiptText(base(), 80).join("\n");
    for (const s of ["SARAVANA TEST", "Saravana Foods Pvt Ltd", "GSTIN: 33ABCDE1234F1Z5", "FSSAI: 12345678901234", "TAX INVOICE", "CGST @2.5%", "SGST @2.5%", "Table: T4", "Customer: Arun", "Paid (CASH)", "DINE-IN"]) expect(t).toContain(s);
    expect(t).toMatch(/1\/4\/2026\s+10:00/);
  });

  it("UT-RCP-002 Bill of Supply: title + mandatory composition declaration, no tax lines", () => {
    const t = formatReceiptText(base({ documentType: "BILL_OF_SUPPLY" })).join("\n");
    expect(t).toContain("BILL OF SUPPLY");
    expect(t).toContain("Composition taxable person,");
    expect(t).toContain("not eligible to collect tax.");
    expect(t).not.toMatch(/CGST|SGST|IGST/);
  });

  it("UT-RCP-003 GST-off plain BILL never prints the GSTIN or tax lines", () => {
    const t = formatReceiptText(base({ documentType: "BILL" })).join("\n");
    expect(t).toContain("BILL");
    expect(t).not.toContain("GSTIN");
    expect(t).not.toMatch(/CGST|SGST/);
  });

  it("UT-RCP-004 tax lines: IGST inter-state, cess, extras, and legacy breakups without rates", () => {
    expect(receiptTaxLines(base({ interState: true, taxBreakup: [{ rate: 18, taxableValue: 10000, cgst: 0, sgst: 0, igst: 1800 }] }))).toEqual([{ label: "IGST @18%", amount: 1800 }]);
    // inferred inter-state from amounts when interState is absent
    expect(receiptTaxLines(base({ taxBreakup: [{ rate: 12, taxableValue: 100, cgst: 0, sgst: 0, igst: 12 }] }))[0].label).toBe("IGST @12%");
    expect(receiptTaxLines(base({ taxBreakup: [{ rate: 28, cessRate: 12, taxableValue: 10000, cgst: 1400, sgst: 1400, igst: 0, cess: 1200, extras: [{ label: "VAT", percent: 14.5, amount: 1450 }] }] })))
      .toEqual([{ label: "CGST @14%", amount: 1400 }, { label: "SGST @14%", amount: 1400 }, { label: "Cess @12%", amount: 1200 }, { label: "VAT @14.5%", amount: 1450 }]);
    expect(receiptTaxLines(base({ documentType: "BILL_OF_SUPPLY" }))).toEqual([]);
    expect(receiptTaxLines(base({ taxBreakup: undefined as never }))).toEqual([]);
  });

  it("UT-RCP-005 COD due, round-off, custom footer, document titles, paper widths", () => {
    const t = formatReceiptText(base({ codDue: 16800, roundOff: -25, footer: "Nandri!" })).join("\n");
    expect(t).toContain("** CASH ON DELIVERY **");
    expect(t).toContain("Round off");
    expect(t).toContain("Nandri!");
    expect(documentTitle("TAX_INVOICE")).toBe("TAX INVOICE");
    expect([charsPerLine(58), charsPerLine(80)]).toEqual([32, 48]);
  });

  it("UT-RCP-006 long item names wrap and keep qty/amount aligned on the last line", () => {
    const lines = formatReceiptText(base({ items: [{ name: "Special Ghee Roast Masala Dosa with Extra Chutney", quantity: 1, unitPrice: 25000, amount: 25000, gstRate: 5, hsnCode: "996331" }] }), 58);
    expect(lines.some((l) => l.trimEnd().endsWith("250.00"))).toBe(true);
  });

  const arbReceipt = fc.record({
    name: fc.string({ minLength: 1, maxLength: 60 }),
    // fast-check's default size bias keeps strings short — force long unbroken words explicitly.
    word: fc.integer({ min: 1, max: 90 }).map((n) => "W".repeat(n)),
    person: fc.integer({ min: 1, max: 80 }).map((n) => "Customer" + "x".repeat(n)),
    tamil: fc.constantFrom("மசாலா தோசை", "पनीर टिक्का", "🍵 Masala Chai", "Idli"),
    qty: fc.integer({ min: 1, max: 999 }),
    amount: fc.integer({ min: 0, max: 99_999_999_99 }),
    outlet: fc.string({ minLength: 1, maxLength: 80 }),
  });

  it("PBT-RCP-001 no printed line is wider than the paper (58 mm = 32, 80 mm = 48 chars)", () => {
    fc.assert(
      fc.property(arbReceipt, fc.constantFrom(58 as const, 80 as const), (r, paper) => {
        const lines = formatReceiptText(
          base({
            outlet: { ...base().outlet, name: r.outlet, address: r.name },
            customerName: r.person,
            cashierName: r.person,
            tableLabel: r.word.slice(0, 20),
            items: [r.name, r.word, r.tamil].map((name) => ({ name, quantity: r.qty, unitPrice: r.amount, amount: r.amount, gstRate: 5, hsnCode: "996331" })),
            grandTotal: r.amount,
          }),
          paper,
        );
        const w = charsPerLine(paper);
        for (const l of lines) expect([...l].length, JSON.stringify(l)).toBeLessThanOrEqual(w);
      }),
      { numRuns: 3000 },
    );
  });
});

describe("ESC/POS (UT-ESC)", () => {
  it("UT-ESC-001 init, bold header, rupee → Rs, feed and partial cut", () => {
    const bytes = toEscPos(["HEADER", "Total ₹10"]);
    expect([...bytes.slice(0, 5)]).toEqual([0x1b, 0x40, 0x1b, 0x45, 1]);
    expect(new TextDecoder().decode(bytes)).toContain("Total Rs10");
    expect([...bytes.slice(-6)]).toEqual([0x1b, 0x64, 4, 0x1d, 0x56, 1]);
  });
});

describe("golden receipts (visual regression for thermal output)", () => {
  it("UT-RCP-GOLD-58 58 mm tax invoice", () => {
    expect(formatReceiptText(base({ codDue: 2000, roundOff: -20 }), 58).join("\n")).toMatchSnapshot();
  });
  it("UT-RCP-GOLD-80 80 mm bill of supply with long names", () => {
    expect(
      formatReceiptText(base({ documentType: "BILL_OF_SUPPLY", items: [{ name: "Special Ghee Roast Masala Dosa with Extra Sambar and Two Chutneys", quantity: 12, unitPrice: 12000, amount: 144000, gstRate: 0, hsnCode: "996331" }] }), 80).join("\n"),
    ).toMatchSnapshot();
  });
});
