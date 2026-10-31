import { ApiError, api } from "./api";
import type { TaxExtra, TaxRate, TaxRateRef } from "./types";

/** Body of POST /tax-rates and PATCH /tax-rates/:id */
export interface TaxRateInput {
  name: string;
  cgst: number;
  sgst: number;
  igst?: number;
  cess?: number;
  extras?: TaxExtra[];
  isDefault?: boolean;
  active?: boolean;
}

/** Write responses carry optional advisories (e.g. CGST ≠ SGST). */
export type TaxRateWriteResult = TaxRate & { warnings?: string[] };

/** 409 body details when deleting a rate that menu items still use. */
export interface TaxRateInUse {
  itemCount: number;
}

/** Sentinel thrown when the API doesn't have /tax-rates yet (older server). */
export class TaxApiUnavailable extends Error {
  constructor() {
    super("Tax rates are not available on this server yet");
    this.name = "TaxApiUnavailable";
  }
}

export async function fetchTaxRates(): Promise<TaxRate[]> {
  try {
    return await api.get<TaxRate[]>("/tax-rates");
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) throw new TaxApiUnavailable();
    throw e;
  }
}

/** Total percentage charged on intra-state supply: CGST + SGST + cess + extras. */
export function totalPercent(r: Pick<TaxRateRef, "cgst" | "sgst" | "cess" | "extras">): number {
  return round2(r.cgst + r.sgst + r.cess + (r.extras ?? []).reduce((s, x) => s + x.percent, 0));
}

export const round2 = (n: number) => Math.round(n * 100) / 100;

/** "2.5" / "5" / "0.25" — trims trailing zeros. */
export const pct = (n: number) => `${round2(n)}`.replace(/\.0+$/, "");

/** Short summary for chips and selects: "CGST 2.5% + SGST 2.5% + Cess 1%". */
export function describeRate(r: Pick<TaxRateRef, "cgst" | "sgst" | "cess" | "extras">): string {
  const parts: string[] = [];
  if (r.cgst || r.sgst) parts.push(`CGST ${pct(r.cgst)}% + SGST ${pct(r.sgst)}%`);
  if (r.cess) parts.push(`Cess ${pct(r.cess)}%`);
  for (const x of r.extras ?? []) if (x.percent) parts.push(`${x.label} ${pct(x.percent)}%`);
  return parts.length ? parts.join(" + ") : "No tax";
}

/**
 * Worked example on a taxable value (paise), e.g. ₹100 → CGST ₹2.50 + SGST
 * ₹2.50 + Cess ₹1.00 = ₹106.00. Mirrors the API's per-component rounding.
 */
export function taxExample(r: Pick<TaxRateRef, "cgst" | "sgst" | "cess" | "extras">, base = 10_000) {
  const amt = (p: number) => Math.round((base * p) / 100);
  const parts: { label: string; amount: number }[] = [
    { label: "CGST", amount: amt(r.cgst) },
    { label: "SGST", amount: amt(r.sgst) },
    { label: "Cess", amount: amt(r.cess) },
    ...(r.extras ?? []).map((x) => ({ label: x.label || "Extra", amount: amt(x.percent) })),
  ].filter((p) => p.amount > 0);
  return { base, parts, total: base + parts.reduce((s, p) => s + p.amount, 0) };
}
