import { allocate, Paise } from "./money";

export const GST_RATES = [0, 5, 12, 18, 28] as const;
export type GstRate = (typeof GST_RATES)[number];

// ---------------------------------------------------------------------------
// Tax composition (custom tax rates)
// ---------------------------------------------------------------------------

/** An additional named tax on top of GST, e.g. { label: "VAT", percent: 14.5 }. */
export interface TaxExtra {
  label: string;
  percent: number;
}

/**
 * Tax composition applied to a line. Intra-state supply charges CGST + SGST,
 * inter-state supply charges IGST; cess and extras apply in both cases.
 */
export interface LineTax {
  /** Display name of the rate, e.g. "GST 5%" */
  name?: string;
  cgst: number;
  sgst: number;
  igst: number;
  cess?: number;
  extras?: TaxExtra[];
}

/** Round a percentage to 3 decimals (kills float noise such as 0.1 + 0.2). */
export const roundRate = (n: number) => Math.round(n * 1000) / 1000;

/** Legacy items without a tax rate: gstRate split equally into CGST/SGST. */
export function legacyTax(gstRate: number): LineTax {
  return { name: `GST ${roundRate(gstRate)}%`, cgst: roundRate(gstRate / 2), sgst: roundRate(gstRate / 2), igst: roundRate(gstRate), cess: 0, extras: [] };
}

/** Parse an `extras` JSON value defensively into [{label, percent}]. */
export function parseTaxExtras(value: unknown): TaxExtra[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((e): e is { label: unknown; percent: unknown } => !!e && typeof e === "object")
    .map((e) => ({ label: String(e.label ?? "").trim(), percent: Number(e.percent) }))
    .filter((e) => e.label && Number.isFinite(e.percent) && e.percent > 0);
}

/** Convert a stored TaxRate row into a LineTax. */
export function taxFromRate(rate: { name: string; cgst: number; sgst: number; igst: number; cess?: number | null; extras?: unknown }): LineTax {
  return {
    name: rate.name,
    cgst: rate.cgst,
    sgst: rate.sgst,
    igst: rate.igst,
    cess: rate.cess ?? 0,
    extras: parseTaxExtras(rate.extras),
  };
}

/** GST percentage that applies: IGST for inter-state, else CGST + SGST. */
export const gstPercent = (t: LineTax, interState = false) => roundRate(interState ? t.igst : t.cgst + t.sgst);

/** Total percentage charged on the value of supply (GST + cess + extras). */
export const totalTaxPercent = (t: LineTax, interState = false) =>
  roundRate(gstPercent(t, interState) + (t.cess ?? 0) + (t.extras ?? []).reduce((s, e) => s + e.percent, 0));

/** Effective GST shown on menu items (cgst + sgst). */
export const effectiveGstRate = (t: LineTax) => roundRate(t.cgst + t.sgst);

// ---------------------------------------------------------------------------
// Bill computation
// ---------------------------------------------------------------------------

export interface TaxConfig {
  /** Menu prices already include tax (common for canteens) */
  pricesIncludeTax: boolean;
  /** Customer is in a different state → IGST instead of CGST+SGST */
  interState: boolean;
  /**
   * Composition dealers may not collect GST from customers. They issue a
   * "Bill of Supply" with no tax lines and pay tax on turnover themselves.
   */
  compositionScheme: boolean;
  /**
   * false = the outlet is not GST registered: a plain BILL with no tax at all,
   * and menu prices are charged as they are (inclusive prices are not reduced).
   * Defaults to true.
   */
  taxEnabled?: boolean;
  serviceChargeEnabled: boolean;
  /** Percent of the post-discount taxable value, e.g. 5 for 5% */
  serviceChargePercent: number;
  roundOff: boolean;
  /**
   * Additional pre-tax charges (delivery fee, packaging). Like service charge,
   * they are part of the composite supply and taxed at each line's rate.
   */
  extraCharges?: { label: string; amount: Paise }[];
}

export interface BillLineInput {
  /** Unit price in paise, including variant and add-on prices */
  unitPrice: Paise;
  quantity: number;
  /** Legacy: total GST %, split equally into CGST/SGST. Ignored when `tax` is given. */
  gstRate?: number;
  /** Full tax composition of the line */
  tax?: LineTax;
  /** Item-level discount in paise for the whole line */
  lineDiscount?: Paise;
}

export type BillDiscount =
  | { type: "FLAT"; value: Paise }
  | { type: "PERCENT"; value: number };

export interface TaxDetail {
  label: string;
  percent: number;
  amount: Paise;
}

export interface BillLineResult {
  gross: Paise;
  discount: Paise;
  taxableValue: Paise;
  serviceCharge: Paise;
  extraCharges: Paise;
  cgst: Paise;
  sgst: Paise;
  igst: Paise;
  cess: Paise;
  /** Sum of extra taxes (e.g. VAT) */
  otherTaxes: Paise;
  extras: TaxDetail[];
  /** All tax on the line (GST + cess + extras) */
  tax: Paise;
  total: Paise;
}

export interface TaxBreakup {
  /** Rate name, e.g. "GST 5%" */
  name: string;
  /** Applicable GST %: IGST for inter-state, else CGST + SGST */
  rate: number;
  cgstRate: number;
  sgstRate: number;
  igstRate: number;
  cessRate: number;
  taxableValue: Paise;
  cgst: Paise;
  sgst: Paise;
  igst: Paise;
  cess: Paise;
  otherTaxes: Paise;
  extras: TaxDetail[];
}

export type DocumentKind = "TAX_INVOICE" | "BILL_OF_SUPPLY" | "BILL";

export interface BillResult {
  documentType: DocumentKind;
  lines: BillLineResult[];
  /** Sum of line taxable values before any discount */
  subtotal: Paise;
  discount: Paise;
  taxableValue: Paise;
  serviceCharge: Paise;
  extraCharges: Paise;
  cgst: Paise;
  sgst: Paise;
  igst: Paise;
  cess: Paise;
  otherTaxes: Paise;
  /** Extra taxes aggregated by label + percent */
  taxDetails: TaxDetail[];
  /** GST + cess + other taxes */
  totalTax: Paise;
  roundOff: Paise;
  grandTotal: Paise;
  taxBreakup: TaxBreakup[];
}

/** Extract the pre-tax value from a tax-inclusive amount. */
export function exclusiveOf(inclusive: Paise, rate: number): Paise {
  return Math.round((inclusive * 100) / (100 + rate));
}

/** Document type for a configuration: BILL when tax is off, Bill of Supply under composition. */
export function documentTypeFor(config: Pick<TaxConfig, "taxEnabled" | "compositionScheme">): DocumentKind {
  if (config.taxEnabled === false) return "BILL";
  return config.compositionScheme ? "BILL_OF_SUPPLY" : "TAX_INVOICE";
}

/** Resolve a line's tax composition (explicit `tax`, else legacy `gstRate`). */
export const lineTaxOf = (l: Pick<BillLineInput, "tax" | "gstRate">): LineTax => l.tax ?? legacyTax(l.gstRate ?? 0);

/**
 * Compute a complete bill.
 *
 * Order of operations (per CGST valuation rules): item discounts and bill
 * discounts reduce the taxable value; service charge and extra charges are part
 * of the value of supply and are taxed at the full composition of the line they
 * accrue on. Tax-inclusive prices are reduced by the TOTAL rate (GST + cess +
 * extras). All money is integer paise; shares are allocated exactly.
 */
export function computeBill(
  lines: BillLineInput[],
  config: TaxConfig,
  billDiscount?: BillDiscount | BillDiscount[],
): BillResult {
  const documentType = documentTypeFor(config);
  const noTax = documentType !== "TAX_INVOICE";
  const inter = config.interState;
  const taxes = lines.map(lineTaxOf);
  const inclusiveRate = taxes.map((t) => totalTaxPercent(t, inter));
  const strip = (amount: number, i: number) => (config.pricesIncludeTax && !noTax ? exclusiveOf(amount, inclusiveRate[i]) : amount);

  // 1. Pre-tax gross per line (strip tax when prices are tax-inclusive).
  const gross = lines.map((l, i) => strip(l.unitPrice * l.quantity, i));
  const lineDiscounts = lines.map((l, i) => Math.min(strip(l.lineDiscount ?? 0, i), gross[i]));
  const afterLineDiscount = gross.map((g, i) => g - lineDiscounts[i]);
  const subtotalAfterLine = afterLineDiscount.reduce((a, b) => a + b, 0);

  // 2. Bill-level discounts (manual, promotions, coupon, points), applied in
  //    order on the remaining value and distributed proportionally.
  let billDisc = 0;
  const discounts = billDiscount ? (Array.isArray(billDiscount) ? billDiscount : [billDiscount]) : [];
  for (const d of discounts) {
    const remaining = subtotalAfterLine - billDisc;
    const amount = d.type === "FLAT" ? d.value : Math.round((remaining * d.value) / 100);
    billDisc += Math.max(0, Math.min(amount, remaining));
  }
  const billDiscShares = allocate(billDisc, afterLineDiscount);
  const taxable = afterLineDiscount.map((v, i) => v - billDiscShares[i]);
  const taxableTotal = taxable.reduce((a, b) => a + b, 0);

  // 3. Service charge, distributed proportionally so it inherits line tax rates.
  const scTotal = config.serviceChargeEnabled
    ? Math.round((taxableTotal * config.serviceChargePercent) / 100)
    : 0;
  const scShares = allocate(scTotal, taxable);
  const extraTotal = (config.extraCharges ?? []).reduce((s, c) => s + Math.max(0, c.amount), 0);
  // If every line is fully discounted, spread extras by gross so they still carry tax.
  const extraShares = allocate(extraTotal, taxableTotal > 0 ? taxable : gross.some((g) => g > 0) ? gross : lines.map(() => 1));

  // 4. Tax per line.
  const resultLines: BillLineResult[] = lines.map((_, i) => {
    const t = taxes[i];
    const base = taxable[i] + scShares[i] + extraShares[i];
    let cgst = 0;
    let sgst = 0;
    let igst = 0;
    let cess = 0;
    let extras: TaxDetail[] = [];
    if (!noTax) {
      const pct = gstPercent(t, inter);
      const gst = Math.round((base * pct) / 100);
      if (inter) igst = gst;
      else if (t.cgst === t.sgst || pct === 0) {
        cgst = Math.floor(gst / 2);
        sgst = gst - cgst;
      } else {
        cgst = Math.round((gst * t.cgst) / pct);
        sgst = gst - cgst;
      }
      cess = Math.round((base * (t.cess ?? 0)) / 100);
      extras = (t.extras ?? []).map((e) => ({ label: e.label, percent: e.percent, amount: Math.round((base * e.percent) / 100) }));
    }
    const otherTaxes = extras.reduce((s, e) => s + e.amount, 0);
    const tax = cgst + sgst + igst + cess + otherTaxes;
    return {
      gross: gross[i],
      discount: lineDiscounts[i] + billDiscShares[i],
      taxableValue: taxable[i],
      serviceCharge: scShares[i],
      extraCharges: extraShares[i],
      cgst,
      sgst,
      igst,
      cess,
      otherTaxes,
      extras,
      tax,
      total: base + tax,
    };
  });

  const sum = (k: "discount" | "cgst" | "sgst" | "igst" | "cess" | "otherTaxes" | "tax") =>
    resultLines.reduce((a, l) => a + l[k], 0);
  const totalTax = sum("tax");
  const preRound = taxableTotal + scTotal + extraTotal + totalTax;
  const grandTotal = config.roundOff ? Math.round(preRound / 100) * 100 : preRound;

  const addDetail = (list: TaxDetail[], e: TaxDetail) => {
    const d = list.find((x) => x.label === e.label && x.percent === e.percent);
    if (d) d.amount += e.amount;
    else list.push({ ...e });
  };
  const taxDetails: TaxDetail[] = [];
  const breakupMap = new Map<string, TaxBreakup>();
  if (!noTax) {
    resultLines.forEach((r, i) => {
      const t = taxes[i];
      r.extras.forEach((e) => addDetail(taxDetails, e));
      const extrasKey = (t.extras ?? []).map((e) => `${e.label}:${e.percent}`).join(",");
      const name = t.name ?? `GST ${effectiveGstRate(t)}%`;
      const key = [name, t.cgst, t.sgst, t.igst, t.cess ?? 0, extrasKey].join("|");
      const b = breakupMap.get(key) ?? {
        name,
        rate: gstPercent(t, inter),
        cgstRate: t.cgst,
        sgstRate: t.sgst,
        igstRate: t.igst,
        cessRate: t.cess ?? 0,
        taxableValue: 0,
        cgst: 0,
        sgst: 0,
        igst: 0,
        cess: 0,
        otherTaxes: 0,
        extras: [],
      };
      b.taxableValue += r.taxableValue + r.serviceCharge + r.extraCharges;
      b.cgst += r.cgst;
      b.sgst += r.sgst;
      b.igst += r.igst;
      b.cess += r.cess;
      b.otherTaxes += r.otherTaxes;
      r.extras.forEach((e) => addDetail(b.extras, e));
      breakupMap.set(key, b);
    });
  }

  return {
    documentType,
    lines: resultLines,
    subtotal: gross.reduce((a, b) => a + b, 0),
    discount: sum("discount"),
    taxableValue: taxableTotal,
    serviceCharge: scTotal,
    extraCharges: extraTotal,
    cgst: sum("cgst"),
    sgst: sum("sgst"),
    igst: sum("igst"),
    cess: sum("cess"),
    otherTaxes: sum("otherTaxes"),
    taxDetails,
    totalTax,
    roundOff: grandTotal - preRound,
    grandTotal,
    taxBreakup: [...breakupMap.values()].sort((a, b) => a.rate - b.rate || a.cessRate - b.cessRate || a.name.localeCompare(b.name)),
  };
}
