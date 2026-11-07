import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { computeTotals, excelValue, formatCell, resolveTotals, sheetName, toPdf, toXlsx, type ExportTable } from "./report-export";

const table: ExportTable = {
  title: "Sales",
  subtitle: "Test outlet · 2026-09-01 to 2026-09-30",
  columns: [
    { key: "period", header: "Date" },
    { key: "orders", header: "Orders", type: "int" },
    { key: "gross", header: "Gross", type: "money" },
    { key: "share", header: "Share", type: "percent" },
  ],
  rows: [
    { period: "2026-09-01", orders: 10, gross: 123456, share: 60.5 },
    { period: "2026-09-02", orders: 5, gross: 80000, share: 39.5 },
  ],
  totals: true,
};

describe("report-export helpers", () => {
  it("formats cells by type", () => {
    expect(formatCell(123456, "money")).toBe("1,234.56");
    expect(formatCell(10000000, "money")).toBe("1,00,000.00");
    expect(formatCell(12.5, "percent")).toBe("12.5%");
    expect(formatCell(3.6, "int")).toBe("4");
    expect(formatCell(null, "money")).toBe("");
    expect(formatCell("x")).toBe("x");
  });

  it("converts money to rupees for Excel", () => {
    expect(excelValue(123456, "money")).toBe(1234.56);
    expect(excelValue(5, "int")).toBe(5);
    expect(excelValue({ a: 1 })).toBe('{"a":1}');
  });

  it("keeps formula-looking text inert (CSV / formula injection)", () => {
    for (const s of ["=1+1", "+cmd|' /C calc'!A0", "-2+3", "@SUM(A1)", "\t=x", "\r=x"]) expect(excelValue(s)).toBe(`'${s}`);
    expect(excelValue("Masala chai")).toBe("Masala chai");
    expect(excelValue(-5, "int")).toBe(-5);
  });

  it("sums only numeric columns and labels the first text column", () => {
    expect(computeTotals(table.columns, table.rows)).toEqual({ period: "Total", orders: 15, gross: 203456 });
    expect(resolveTotals({ ...table, totals: { period: "All", gross: 1 } })).toEqual({ period: "All", gross: 1 });
    expect(resolveTotals({ ...table, totals: undefined })).toBeUndefined();
  });

  it("makes safe, unique Excel sheet names", () => {
    const used = new Set<string>();
    expect(sheetName("GST: by rate / type", used)).toBe("GST  by rate   type");
    expect(sheetName("A".repeat(40), used)).toHaveLength(31);
    expect(sheetName("A".repeat(40), used)).toBe(`${"A".repeat(28)} 2`);
  });

  it("writes an xlsx workbook with rupee values and a totals row", async () => {
    const buf = await toXlsx([table, { ...table, title: "Second", rows: [] }]);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
    expect(wb.worksheets.map((w) => w.name)).toEqual(["Sales", "Second"]);
    const ws = wb.worksheets[0];
    const values = ws.getSheetValues().filter(Boolean).map((r) => (r as unknown[]).slice(1));
    expect(values[0][0]).toBe("Sales");
    const header = values.find((r) => r[0] === "Date")!;
    expect(header).toEqual(["Date", "Orders", "Gross (Rs)", "Share"]);
    expect(values).toContainEqual(["2026-09-01", 10, 1234.56, 60.5]);
    expect(values[values.length - 1]).toEqual(["Total", 15, 2034.56]);
  });

  it("renders a PDF", async () => {
    const many = { ...table, rows: Array.from({ length: 120 }, (_, i) => ({ period: `Row ${i}`, orders: i, gross: i * 100, share: 1 })) };
    const buf = await toPdf([many, table], "Sales report");
    expect(buf.subarray(0, 5).toString()).toBe("%PDF-");
    expect(buf.length).toBeGreaterThan(2000);
  });
});
