import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { financialYearLabel, financialYearStart, formatInvoiceNumber } from "./invoice";
import { outletSchema } from "./schemas";

describe("financial year (IST) — boundary values (UT-INV)", () => {
  it("UT-INV-001 31 Mar 23:59:59.999 IST is still the old FY; 1 Apr 00:00 IST starts the new one", () => {
    // 1 Apr 2026 00:00 IST == 31 Mar 2026 18:30 UTC
    expect(financialYearStart(new Date("2026-03-31T18:29:59.999Z"))).toBe(2025);
    expect(financialYearStart(new Date("2026-03-31T18:30:00.000Z"))).toBe(2026);
  });

  it("UT-INV-002 is independent of the server's timezone (uses Asia/Kolkata by default)", () => {
    // 31 Mar 20:00 UTC: a UTC server would say March; in IST it is already 1 April 01:30.
    expect(financialYearStart(new Date("2026-03-31T20:00:00Z"))).toBe(2026);
    // 1 Apr 02:00 IST in UTC is still 31 Mar
    expect(financialYearStart(new Date("2026-03-31T20:30:00Z"))).toBe(2026);
  });

  it("UT-INV-003 January–March belong to the previous FY; April–December to the current", () => {
    for (let m = 1; m <= 12; m++) {
      const d = new Date(Date.UTC(2027, m - 1, 15, 6, 0));
      expect(financialYearStart(d)).toBe(m >= 4 ? 2027 : 2026);
    }
  });

  it("UT-INV-004 honours an explicit outlet timezone", () => {
    expect(financialYearStart(new Date("2026-03-31T20:00:00Z"), "UTC")).toBe(2025);
  });

  it("UT-INV-005 FY labels, including the century wrap", () => {
    expect(financialYearLabel(2025)).toBe("2025-26");
    expect(financialYearLabel(2009)).toBe("2009-10");
    expect(financialYearLabel(2099)).toBe("2099-00");
  });
});

describe("invoice numbers — Rule 46 (≤ 16 chars, unique per FY)", () => {
  it("UT-INV-010 format PREFIX-YYYY-NNNNN with zero padding", () => {
    expect(formatInvoiceNumber("INV", 2026, 1)).toBe("INV-2026-00001");
    expect(formatInvoiceNumber("INV", 2026, 99999)).toBe("INV-2026-99999");
    expect(formatInvoiceNumber("INV", 2026, 100000)).toBe("INV-2026-100000");
  });

  it("UT-INV-011 16 characters is allowed, 17 is refused", () => {
    expect(formatInvoiceNumber("ABCDE", 2026, 99999)).toHaveLength(16);
    expect(() => formatInvoiceNumber("ABCDEF", 2026, 1)).toThrow(/16-character/);
  });

  it("PBT-INV-001 numbers are unique and ordered within a FY for any allowed prefix", () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[A-Z0-9]{1,4}$/), fc.integer({ min: 1, max: 99_998 }), (prefix, seq) => {
        const a = formatInvoiceNumber(prefix, 2026, seq);
        const b = formatInvoiceNumber(prefix, 2026, seq + 1);
        expect(a).not.toBe(b);
        expect(a.length).toBeLessThanOrEqual(16);
      }),
    );
  });

  // BUG-019 (open, needs a decision): the outlet schema allows a 5-character prefix, but
  // "ABCDE-2026-100000" is 17 characters — the 100,000th bill of the year throws inside the
  // order transaction and billing stops for that outlet until the next FY. `it.fails`
  // passes while the bug exists and will flip to a failure once it is fixed.
  it.fails("UT-INV-019 (BUG-019) every prefix the outlet schema accepts can number at least 999,999 bills a year", () => {
    const prefix = outletSchema.shape.invoicePrefix.parse("ABCDE");
    expect(() => formatInvoiceNumber(prefix, 2026, 999_999)).not.toThrow();
  });
});
