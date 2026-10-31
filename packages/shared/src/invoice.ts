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
