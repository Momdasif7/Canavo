import { computeBill, legacyTax, parseTaxExtras, type BillLineInput, type BillResult, type LineTax, type TaxConfig } from "@canavo/shared";
import type { DocumentType, MenuItem, OrderType, Outlet, TaxDetail } from "../lib/types";

/**
 * Local (offline / estimate) bill via the shared `computeBill`, using each
 * menu item's full tax composition (`taxRate`: CGST/SGST/IGST + cess + extra
 * taxes) when the server sends it, else the legacy `gstRate`.
 * An outlet with `gstEnabled === false` (not GST-registered) gets a zero-tax
 * plain "BILL".
 */
export type LocalBill = BillResult;

/** Not GST-registered. Missing flag (older server) = registered. */
export const isNonGst = (outlet: Pick<Outlet, "gstEnabled"> | null | undefined) => outlet?.gstEnabled === false;

export function taxConfigFor(outlet: Outlet, orderType: OrderType): TaxConfig {
  return {
    pricesIncludeTax: outlet.pricesIncludeTax,
    interState: false,
    compositionScheme: outlet.compositionScheme,
    taxEnabled: !isNonGst(outlet),
    // Mirrors the server: service charge only applies to dine-in.
    serviceChargeEnabled: outlet.serviceChargeEnabled && orderType === "DINE_IN",
    serviceChargePercent: outlet.serviceChargePercent,
    roundOff: outlet.roundOff,
  };
}

export interface LocalBillLine {
  item: Pick<MenuItem, "gstRate" | "taxRate">;
  unitPrice: number;
  quantity: number;
  /** Offer discount on the line (auto-added Buy-X-Get-Y item), e.g. 100 = free */
  discountPercent?: number;
}

export function lineTaxFor(item: LocalBillLine["item"]): LineTax {
  const tr = item.taxRate;
  if (!tr) return legacyTax(item.gstRate);
  return { name: tr.name, cgst: tr.cgst, sgst: tr.sgst, igst: tr.igst, cess: tr.cess ?? 0, extras: parseTaxExtras(tr.extras) };
}

function lineInput(l: LocalBillLine): BillLineInput {
  const pct = Math.min(100, Math.max(0, l.discountPercent ?? 0));
  const lineDiscount = pct ? Math.round((l.unitPrice * l.quantity * pct) / 100) : 0;
  return { unitPrice: l.unitPrice, quantity: l.quantity, gstRate: l.item.gstRate, tax: lineTaxFor(l.item), ...(lineDiscount && { lineDiscount }) };
}

export function computeLocalBill(lines: LocalBillLine[], outlet: Outlet, orderType: OrderType): LocalBill {
  const bill = computeBill(lines.map(lineInput), taxConfigFor(outlet, orderType));
  if (!isNonGst(outlet)) return bill;
  // Belt and braces: an unregistered seller never shows tax, whatever the inputs.
  return { ...bill, documentType: "BILL", cgst: 0, sgst: 0, igst: 0, cess: 0, otherTaxes: 0, taxDetails: [], totalTax: 0, taxBreakup: [] };
}

/** Totals block shape shared by the local bill and the server preview (older servers omit cess/extras). */
export interface TotalsLike {
  documentType: DocumentType;
  subtotal: number;
  serviceCharge: number;
  cgst: number;
  sgst: number;
  igst: number;
  cess?: number;
  otherTaxes?: number;
  taxDetails?: TaxDetail[];
  roundOff: number;
  grandTotal: number;
}

/**
 * Whether GST rows (CGST / SGST / IGST / cess / extra taxes, "excl. tax"
 * labels) may be shown. Never for a plain BILL / bill of supply, never when
 * the outlet has GST switched off, and never while the outlet's settings are
 * still unknown (pass `outlet: undefined` → hidden) — so a non-GST shop never
 * flashes tax rows.
 */
export function showGst(b: { documentType: DocumentType } | null | undefined, outlet: Pick<Outlet, "gstEnabled"> | null | undefined): boolean {
  if (!b || b.documentType !== "TAX_INVOICE") return false;
  if (!outlet) return false;
  return outlet.gstEnabled !== false;
}

/** Tax rows to display for a bill: CGST/SGST (or IGST), cess, then each extra tax by label. */
export function taxRows(b: TotalsLike, outlet?: Pick<Outlet, "gstEnabled"> | null): { label: string; amount: number }[] {
  if (b.documentType !== "TAX_INVOICE") return [];
  // Called with an outlet → also respect its GST switch.
  if (outlet !== undefined && !showGst(b, outlet)) return [];
  const rows: { label: string; amount: number }[] = [];
  if (b.igst) rows.push({ label: "IGST", amount: b.igst });
  if (b.cgst || !b.igst) rows.push({ label: "CGST", amount: b.cgst });
  if (b.sgst || !b.igst) rows.push({ label: "SGST", amount: b.sgst });
  if (b.cess) rows.push({ label: "Cess", amount: b.cess });
  const details = (b.taxDetails ?? []).filter((d) => d.amount);
  if (details.length) details.forEach((d) => rows.push({ label: `${d.label} ${d.percent}%`, amount: d.amount }));
  else if (b.otherTaxes) rows.push({ label: "Other taxes", amount: b.otherTaxes });
  return rows;
}

/** Note under the totals when no GST lines are shown. */
export function noTaxNote(type: DocumentType, gstEnabled?: boolean): string | null {
  if (type === "BILL" || gstEnabled === false) return "No GST — this outlet is not GST-registered";
  if (type === "BILL_OF_SUPPLY") return "Bill of supply (composition scheme) — no GST charged";
  return null;
}

export function documentLabel(type: DocumentType): string {
  return type === "TAX_INVOICE" ? "Tax invoice" : type === "BILL_OF_SUPPLY" ? "Bill of supply" : "Bill";
}

/**
 * A receipt safe to show / print: when the outlet isn't GST-registered
 * (`gstEnabled === false`) or it's a plain BILL, every tax figure is zeroed
 * and it's titled "BILL", whatever the stored document says.
 */
export function gstSafeReceipt<R extends { documentType: DocumentType; gstEnabled?: boolean }>(r: R): R {
  if (r.gstEnabled !== false && r.documentType !== "BILL") return r;
  const z: Record<string, unknown> = { documentType: "BILL" };
  for (const k of ["cgst", "sgst", "igst", "cess", "otherTaxes", "totalTax"]) if (k in r) z[k] = 0;
  if ("taxDetails" in r) z.taxDetails = [];
  if ("taxBreakup" in r) z.taxBreakup = [];
  const outlet = (r as { outlet?: unknown }).outlet;
  if (outlet && typeof outlet === "object") z.outlet = { ...outlet, gstin: null };
  return { ...r, ...z };
}
