/**
 * Indian financial year runs 1 April – 31 March. Returns the starting
 * calendar year, e.g. 15 Feb 2026 → 2025 (FY 2025-26).
 */
export function financialYearStart(date: Date, timeZone = "Asia/Kolkata"): number {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "numeric",
  }).formatToParts(date);
  const year = Number(parts.find((p) => p.type === "year")!.value);
  const month = Number(parts.find((p) => p.type === "month")!.value);
  return month >= 4 ? year : year - 1;
}

export function financialYearLabel(fyStart: number): string {
  return `${fyStart}-${String((fyStart + 1) % 100).padStart(2, "0")}`;
}

/**
 * GST invoice numbers must be unique per FY and at most 16 characters
 * (Rule 46, CGST Rules). Format: PREFIX-YYYY-NNNNN, e.g. INV-2025-00234.
 */
export function formatInvoiceNumber(prefix: string, fyStart: number, seq: number): string {
  const num = `${prefix}-${fyStart}-${String(seq).padStart(5, "0")}`;
  if (num.length > 16) {
    throw new Error(`Invoice number "${num}" exceeds the 16-character GST limit; shorten the prefix`);
  }
  return num;
}

/**
 * Offline device series (Phase 3.4): each billing device gets its own series, e.g. "INVA1",
 * so a bill raised offline prints its final invoice number (GST allows several series, each
 * unique per financial year). Up to 3 characters of the outlet prefix + the device code.
 */
export const offlineSeriesPrefix = (invoicePrefix: string, deviceCode: string) => `${invoicePrefix.slice(0, 3)}${deviceCode}`;

/** "INVA1-2026-00007" → { prefix: "INVA1", fyStart: 2026, seq: 7 } */
export function parseInvoiceNumber(n: string): { prefix: string; fyStart: number; seq: number } | null {
  const m = /^(.+)-(\d{4})-(\d{5})$/.exec(n);
  return m ? { prefix: m[1]!, fyStart: Number(m[2]), seq: Number(m[3]) } : null;
}
