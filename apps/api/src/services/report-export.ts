/**
 * Generic tabular export used by every report: one or more
 * {title, subtitle, columns, rows, totals} tables rendered as an Excel
 * workbook (one sheet per table) or a PDF (tables one after another).
 * Money columns hold integer paise and are shown in rupees.
 */
import type { Response } from "express";
import ExcelJS from "exceljs";
import PDFDocument from "pdfkit";

export type ColumnType = "text" | "int" | "number" | "money" | "percent";

export interface ExportColumn {
  key: string;
  header: string;
  type?: ColumnType;
  /** Relative width (Excel characters; scaled for PDF). */
  width?: number;
}

export type ExportRow = Record<string, unknown>;

export interface ExportTable {
  title: string;
  subtitle?: string;
  columns: ExportColumn[];
  rows: ExportRow[];
  /** Totals row; `true` = sum every int/number/money column automatically. */
  totals?: ExportRow | true;
}

export type ExportFormat = "xlsx" | "pdf";

const SUMMABLE: ColumnType[] = ["int", "number", "money"];

/** Sum every summable column; the first text column gets the label "Total". */
export function computeTotals(columns: ExportColumn[], rows: ExportRow[]): ExportRow {
  const out: ExportRow = {};
  const label = columns.find((c) => (c.type ?? "text") === "text");
  if (label) out[label.key] = "Total";
  for (const c of columns) {
    if (!SUMMABLE.includes(c.type ?? "text")) continue;
    out[c.key] = rows.reduce((s, r) => s + (typeof r[c.key] === "number" ? (r[c.key] as number) : 0), 0);
  }
  return out;
}

export function resolveTotals(t: ExportTable): ExportRow | undefined {
  if (!t.totals) return undefined;
  return t.totals === true ? computeTotals(t.columns, t.rows) : t.totals;
}

const inr = new Intl.NumberFormat("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const num = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2 });

/** Human-readable cell text (PDF / CSV). Money is paise → "1,234.56". */
export function formatCell(value: unknown, type: ColumnType = "text"): string {
  if (value === null || value === undefined || value === "") return "";
  if (typeof value !== "number") return value instanceof Date ? value.toISOString() : String(value);
  switch (type) {
    case "money":
      return inr.format(value / 100);
    case "percent":
      return `${num.format(value)}%`;
    case "int":
      return String(Math.round(value));
    default:
      return num.format(value);
  }
}

/**
 * Text that a spreadsheet would read as a formula (=, +, -, @, tab, CR first — CSV/formula
 * injection, OWASP) gets a leading apostrophe so it stays text even after a CSV round trip.
 * Names, notes and reasons in exports are typed by staff and customers.
 */
export function safeCellText(s: string): string {
  return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
}

/** Value written to an Excel cell: money converted to rupees (numeric), text made formula-safe. */
export function excelValue(value: unknown, type: ColumnType = "text"): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" && type === "money") return Math.round(value) / 100;
  if (typeof value === "object" && !(value instanceof Date)) return safeCellText(JSON.stringify(value));
  if (typeof value === "string") return safeCellText(value);
  return value;
}

const NUM_FMT: Partial<Record<ColumnType, string>> = {
  money: "#,##0.00",
  percent: '0.0"%"',
  number: "#,##0.##",
  int: "0",
};

/** Excel sheet names: ≤31 chars, no []:*?/\ and unique within a workbook. */
export function sheetName(title: string, used: Set<string>): string {
  const base = title.replace(/[[\]:*?/\\]/g, " ").trim().slice(0, 31) || "Sheet";
  let name = base;
  for (let i = 2; used.has(name.toLowerCase()); i++) name = `${base.slice(0, 28)} ${i}`;
  used.add(name.toLowerCase());
  return name;
}

export function buildWorkbook(tables: ExportTable[]): ExcelJS.Workbook {
  const wb = new ExcelJS.Workbook();
  wb.creator = "CANAVO";
  wb.created = new Date();
  const used = new Set<string>();
  for (const t of tables) {
    const ws = wb.addWorksheet(sheetName(t.title, used));
    ws.addRow([t.title]).font = { bold: true, size: 14 };
    if (t.subtitle) ws.addRow([t.subtitle]).font = { italic: true, color: { argb: "FF666666" } };
    ws.addRow([]);
    const header = ws.addRow(t.columns.map((c) => c.header + (c.type === "money" ? " (Rs)" : "")));
    header.font = { bold: true };
    header.eachCell((cell) => {
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFE5D9" } };
    });
    const headerRow = header.number;
    for (const r of t.rows) ws.addRow(t.columns.map((c) => excelValue(r[c.key], c.type)));
    const totals = resolveTotals(t);
    if (totals) ws.addRow(t.columns.map((c) => excelValue(totals[c.key], c.type))).font = { bold: true };
    t.columns.forEach((c, i) => {
      const col = ws.getColumn(i + 1);
      col.width = c.width ?? Math.max(10, Math.min(40, c.header.length + 4));
      const fmt = NUM_FMT[c.type ?? "text"];
      if (fmt) col.eachCell((cell, rowNo) => rowNo > headerRow && (cell.numFmt = fmt));
    });
    ws.views = [{ state: "frozen", ySplit: headerRow }];
  }
  if (tables.length === 0) wb.addWorksheet("Empty").addRow(["No data"]);
  return wb;
}

export async function toXlsx(tables: ExportTable[]): Promise<Buffer> {
  const ab = await buildWorkbook(tables).xlsx.writeBuffer();
  return Buffer.from(ab as ArrayBuffer);
}

/** Render tables into a PDF (landscape A4 when wide). Standard fonts lack ₹, so headers say "(Rs)". */
export function toPdf(tables: ExportTable[], docTitle?: string): Promise<Buffer> {
  const wide = tables.some((t) => t.columns.length > 6);
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", layout: wide ? "landscape" : "portrait", margin: 36, bufferPages: true });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const left = doc.page.margins.left;
    const width = doc.page.width - left - doc.page.margins.right;
    const bottom = () => doc.page.height - doc.page.margins.bottom - 20;
    const saffron = "#FF6B35";

    if (docTitle) {
      doc.fillColor(saffron).font("Helvetica-Bold").fontSize(16).text(docTitle, left, doc.y, { width });
      doc.moveDown(0.5);
    }

    tables.forEach((t, ti) => {
      if (ti > 0) doc.moveDown(1);
      if (doc.y > bottom() - 60) doc.addPage();
      doc.fillColor("#000").font("Helvetica-Bold").fontSize(12).text(t.title, left, doc.y, { width });
      if (t.subtitle) doc.fillColor("#666").font("Helvetica").fontSize(8.5).text(t.subtitle, left, doc.y, { width });
      doc.moveDown(0.4);

      const weights = t.columns.map((c) => c.width ?? Math.max(8, c.header.length + 2));
      const totalW = weights.reduce((a, b) => a + b, 0);
      const widths = weights.map((w) => (w / totalW) * width);
      const xs = widths.map((_, i) => left + widths.slice(0, i).reduce((a, b) => a + b, 0));
      const fontSize = t.columns.length > 10 ? 6.5 : t.columns.length > 7 ? 7.5 : 8.5;
      const isNum = (c: ExportColumn) => (c.type ?? "text") !== "text";

      const drawRow = (cells: string[], opts: { bold?: boolean; fill?: string } = {}) => {
        doc.font(opts.bold ? "Helvetica-Bold" : "Helvetica").fontSize(fontSize);
        const h = Math.max(...cells.map((txt, i) => doc.heightOfString(txt, { width: widths[i] - 4 }))) + 4;
        if (doc.y + h > bottom()) {
          doc.addPage();
          drawHeader();
          doc.font(opts.bold ? "Helvetica-Bold" : "Helvetica").fontSize(fontSize);
        }
        const y = doc.y;
        if (opts.fill) doc.rect(left, y, width, h).fill(opts.fill);
        doc.fillColor("#111");
        cells.forEach((txt, i) => {
          doc.text(txt, xs[i] + 2, y + 2, { width: widths[i] - 4, align: isNum(t.columns[i]) ? "right" : "left" });
        });
        doc.y = y + h;
        doc.moveTo(left, doc.y).lineTo(left + width, doc.y).strokeColor("#e5e5e5").lineWidth(0.5).stroke();
      };
      const drawHeader = () =>
        drawRow(
          t.columns.map((c) => c.header + (c.type === "money" ? " (Rs)" : "")),
          { bold: true, fill: "#FFE5D9" },
        );

      drawHeader();
      if (t.rows.length === 0) {
        doc.font("Helvetica-Oblique").fontSize(fontSize).fillColor("#666").text("No data for this period", left + 2, doc.y + 3);
        doc.moveDown(0.5);
      }
      for (const r of t.rows) drawRow(t.columns.map((c) => formatCell(r[c.key], c.type)));
      const totals = resolveTotals(t);
      if (totals) drawRow(t.columns.map((c) => formatCell(totals[c.key], c.type)), { bold: true, fill: "#F5F5F5" });
    });

    // Footer with page numbers
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      const y = doc.page.height - doc.page.margins.bottom - 10;
      doc.font("Helvetica").fontSize(7).fillColor("#999")
        .text(`CANAVO · generated ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC · page ${i + 1} of ${range.count}`,
          left, y, { width, align: "center", lineBreak: false });
    }
    doc.end();
  });
}

export const CONTENT_TYPES: Record<ExportFormat, string> = {
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pdf: "application/pdf",
};

export async function renderExport(format: ExportFormat, tables: ExportTable[], title?: string): Promise<Buffer> {
  return format === "xlsx" ? toXlsx(tables) : toPdf(tables, title);
}

export async function sendExport(res: Response, format: ExportFormat, filename: string, tables: ExportTable[], title?: string) {
  const body = await renderExport(format, tables, title);
  res.setHeader("content-disposition", `attachment; filename="${filename}.${format}"`);
  res.type(CONTENT_TYPES[format]).send(body);
}
