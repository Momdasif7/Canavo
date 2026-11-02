/**
 * GSTR-1 builder (pure; no DB). Produces the JSON accepted by the GSTN
 * offline utility / portal "Upload JSON" for a canteen that only makes B2C
 * supplies:
 *
 *  - b2cs  : B2C (small) supplies grouped by place of supply + rate + supply type
 *  - hsn   : HSN/SAC summary per HSN + rate
 *  - doc_issue : invoice series ranges per financial-year series
 *
 * Amounts in the GSTN JSON are rupees with 2 decimals; inputs are paise.
 *
 * Place of supply: we don't capture the customer's state. Restaurant service
 * is supplied where the outlet is, so POS = outlet state code. Bills flagged
 * `interState` (IGST charged) are reported as sply_ty "INTER" with the same
 * POS — the portal may flag INTER + POS == supplier state; such bills should
 * be reviewed (they are listed in `warnings`).
 *
 * Plain BILLs (outlet not GST registered / GST switched off) carry no tax and
 * are excluded too (counted in `notes`).
 *
 * Cess goes to `csamt`; `rt` is the GST rate (IGST, or CGST + SGST). Other
 * non-GST levies (e.g. VAT) are excluded from the taxable value.
 *
 * Bills of supply (composition scheme) are excluded: composition dealers file
 * CMP-08 / GSTR-4, not GSTR-1. B2B (registered buyer GSTIN), B2CL (inter-state
 * > ₹1 lakh) and credit notes are not produced because the POS does not capture
 * buyer GSTINs or issue credit notes.
 */

export interface Gstr1Line {
  hsnCode: string;
  gstRate: number;
  quantity: number;
  /** Line taxable value excluding service charge / extra charge shares, paise */
  taxableValue: number;
  serviceCharge: number;
  cgst: number;
  sgst: number;
  igst: number;
  cess?: number;
  /** Non-GST taxes on the line (e.g. VAT), paise */
  otherTaxes?: number;
  /** Rate snapshot {cgst, sgst, igst, cess, ...} (orders billed after custom tax rates) */
  taxRates?: unknown;
  /** Line total incl. tax (and service/extra charge shares), paise */
  total: number;
}

export interface Gstr1Order {
  invoiceNumber: string;
  status: "OPEN" | "PAID" | "CANCELLED";
  documentType: "TAX_INVOICE" | "BILL_OF_SUPPLY" | "BILL";
  interState: boolean;
  items: Gstr1Line[];
}

export interface Gstr1Input {
  gstin: string | null;
  stateCode: string;
  /** "YYYY-MM" */
  month: string;
  compositionScheme: boolean;
  orders: Gstr1Order[];
  /** HSN code → description (defaults to a restaurant-service description) */
  hsnDescriptions?: Record<string, string>;
}

export interface B2csEntry {
  sply_ty: "INTRA" | "INTER";
  pos: string;
  typ: "OE";
  rt: number;
  txval: number;
  iamt: number;
  camt: number;
  samt: number;
  csamt: number;
}

export interface HsnEntry {
  num: number;
  hsn_sc: string;
  desc: string;
  uqc: string;
  qty: number;
  rt: number;
  txval: number;
  iamt: number;
  camt: number;
  samt: number;
  csamt: number;
}

export interface DocRange {
  num: number;
  from: string;
  to: string;
  totnum: number;
  cancel: number;
  net_issue: number;
}

export interface Gstr1Payload {
  gstin: string;
  fp: string;
  b2cs: B2csEntry[];
  hsn: { data: HsnEntry[] };
  doc_issue: { doc_det: { doc_num: number; doc_typ: string; docs: DocRange[] }[] };
}

export interface Gstr1Totals {
  invoices: number;
  txval: number;
  iamt: number;
  camt: number;
  samt: number;
  csamt: number;
  /** Paise totals (exact) for reconciliation with /reports/gst */
  paise: { taxable: number; cgst: number; sgst: number; igst: number; cess: number };
}

export interface Gstr1Result {
  excluded: boolean;
  payload: Gstr1Payload;
  totals: Gstr1Totals;
  notes: string[];
  warnings: string[];
}

export const rupees = (paise: number) => Math.round(paise) / 100;
export const fpOf = (month: string) => `${month.slice(5, 7)}${month.slice(0, 4)}`;

/** Value of supply for one line: everything except the tax (taxable + service charge + extra-charge share). */
export const lineTxval = (l: Gstr1Line) => l.total - l.cgst - l.sgst - l.igst - (l.cess ?? 0) - (l.otherTaxes ?? 0);

/** GST rate of a line: IGST inter-state, else CGST + SGST (from the snapshot when present). */
export function lineRate(l: Gstr1Line, interState: boolean): number {
  const t = l.taxRates as { cgst?: unknown; sgst?: unknown; igst?: unknown } | null | undefined;
  if (t && typeof t.cgst === "number" && typeof t.sgst === "number" && typeof t.igst === "number") {
    return Math.round((interState ? t.igst : t.cgst + t.sgst) * 1000) / 1000;
  }
  return l.gstRate;
}

/** Split "INV-2026-00012" into series "INV-2026-" and sequence 12. */
export function splitInvoiceNumber(inv: string): { series: string; seq: number } {
  // Linear scan for the trailing digits (the old /^(.*?)(\d+)$/ was super-linear).
  let i = inv.length;
  while (i > 0 && inv.charCodeAt(i - 1) >= 48 && inv.charCodeAt(i - 1) <= 57) i--;
  if (i === inv.length) return { series: inv, seq: 0 };
  return { series: inv.slice(0, i), seq: Number(inv.slice(i)) };
}

/** GSTN limits the HSN description to 30 characters. */
const DEFAULT_HSN_DESC: Record<string, string> = {
  "996331": "Restaurant services",
  "996332": "Restaurant services with bar",
  "996334": "Canteen services",
  "996337": "Contract food services",
};

export function buildGstr1(input: Gstr1Input): Gstr1Result {
  const notes: string[] = [];
  const warnings: string[] = [];
  const fp = fpOf(input.month);
  const empty: Gstr1Payload = {
    gstin: input.gstin ?? "",
    fp,
    b2cs: [],
    hsn: { data: [] },
    doc_issue: { doc_det: [] },
  };
  const zeroTotals: Gstr1Totals = { invoices: 0, txval: 0, iamt: 0, camt: 0, samt: 0, csamt: 0, paise: { taxable: 0, cgst: 0, sgst: 0, igst: 0, cess: 0 } };

  if (input.compositionScheme) {
    notes.push("Outlet is registered under the composition scheme (issues Bills of Supply): file CMP-08 quarterly and GSTR-4 annually — GSTR-1 is not applicable.");
    return { excluded: true, payload: empty, totals: zeroTotals, notes, warnings };
  }
  if (!input.gstin) warnings.push("Outlet has no GSTIN configured; set it before uploading.");

  const taxInvoices = input.orders.filter((o) => o.documentType === "TAX_INVOICE");
  const bos = input.orders.filter((o) => o.documentType === "BILL_OF_SUPPLY").length;
  const bills = input.orders.filter((o) => o.documentType === "BILL").length;
  if (bos) notes.push(`${bos} Bill(s) of Supply excluded (composition-period documents are not reported in GSTR-1).`);
  if (bills) notes.push(`${bills} plain BILL(s) excluded (issued while GST was switched off; no tax charged).`);
  const supplies = taxInvoices.filter((o) => o.status === "PAID");
  const open = taxInvoices.filter((o) => o.status === "OPEN");
  if (open.length) {
    warnings.push(`${open.length} unpaid (OPEN) invoice(s) in this period are not included in b2cs/hsn — settle or cancel them before filing: ${open.slice(0, 10).map((o) => o.invoiceNumber).join(", ")}${open.length > 10 ? "…" : ""}`);
  }

  // --- b2cs ---
  const b2cs = new Map<string, { sply_ty: "INTRA" | "INTER"; rt: number; txval: number; iamt: number; camt: number; samt: number; csamt: number }>();
  const hsn = new Map<string, { hsn: string; rt: number; qty: number; txval: number; iamt: number; camt: number; samt: number; csamt: number }>();
  const tot = { taxable: 0, cgst: 0, sgst: 0, igst: 0, cess: 0 };
  const interInvoices: string[] = [];
  for (const o of supplies) {
    if (o.interState) interInvoices.push(o.invoiceNumber);
    for (const l of o.items) {
      const sply_ty = o.interState ? "INTER" : "INTRA";
      const txval = lineTxval(l);
      const rt = lineRate(l, o.interState);
      const cess = l.cess ?? 0;
      const bk = `${sply_ty}|${rt}`;
      const b = b2cs.get(bk) ?? { sply_ty, rt, txval: 0, iamt: 0, camt: 0, samt: 0, csamt: 0 };
      b.txval += txval;
      b.iamt += l.igst;
      b.camt += l.cgst;
      b.samt += l.sgst;
      b.csamt += cess;
      b2cs.set(bk, b);

      const hk = `${l.hsnCode}|${rt}`;
      const h = hsn.get(hk) ?? { hsn: l.hsnCode, rt, qty: 0, txval: 0, iamt: 0, camt: 0, samt: 0, csamt: 0 };
      h.qty += l.quantity;
      h.txval += txval;
      h.iamt += l.igst;
      h.camt += l.cgst;
      h.samt += l.sgst;
      h.csamt += cess;
      hsn.set(hk, h);

      tot.taxable += txval;
      tot.cgst += l.cgst;
      tot.sgst += l.sgst;
      tot.igst += l.igst;
      tot.cess += cess;
    }
  }
  if (interInvoices.length) {
    warnings.push(`${interInvoices.length} inter-state (IGST) bill(s) reported as INTER with POS ${input.stateCode} (customer state not captured): ${interInvoices.slice(0, 10).join(", ")}${interInvoices.length > 10 ? "…" : ""}`);
  }

  const b2csOut: B2csEntry[] = [...b2cs.values()]
    .filter((b) => b.txval !== 0 || b.iamt + b.camt + b.samt + b.csamt !== 0)
    .sort((a, b) => a.sply_ty.localeCompare(b.sply_ty) || a.rt - b.rt)
    .map((b) => ({
      sply_ty: b.sply_ty,
      pos: input.stateCode,
      typ: "OE" as const,
      rt: b.rt,
      txval: rupees(b.txval),
      iamt: rupees(b.iamt),
      camt: rupees(b.camt),
      samt: rupees(b.samt),
      csamt: rupees(b.csamt),
    }));

  const descs = { ...DEFAULT_HSN_DESC, ...(input.hsnDescriptions ?? {}) };
  const hsnOut: HsnEntry[] = [...hsn.values()]
    .sort((a, b) => a.hsn.localeCompare(b.hsn) || a.rt - b.rt)
    .map((h, i) => ({
      num: i + 1,
      hsn_sc: h.hsn,
      desc: (descs[h.hsn] ?? "Food and beverages").slice(0, 30),
      uqc: "NOS",
      qty: h.qty,
      rt: h.rt,
      txval: rupees(h.txval),
      iamt: rupees(h.iamt),
      camt: rupees(h.camt),
      samt: rupees(h.samt),
      csamt: rupees(h.csamt),
    }));

  // --- doc_issue: every tax invoice number issued in the period, per series ---
  // Plain BILLs / Bills of Supply share the invoice series; their numbers are not gaps.
  const otherSeqs = new Map<string, Set<number>>();
  for (const o of input.orders) {
    if (o.documentType === "TAX_INVOICE") continue;
    const { series: s, seq } = splitInvoiceNumber(o.invoiceNumber);
    otherSeqs.set(s, (otherSeqs.get(s) ?? new Set()).add(seq));
  }
  const series = new Map<string, { seqs: { seq: number; inv: string }[]; cancel: number }>();
  for (const o of taxInvoices) {
    const { series: s, seq } = splitInvoiceNumber(o.invoiceNumber);
    const e = series.get(s) ?? { seqs: [], cancel: 0 };
    e.seqs.push({ seq, inv: o.invoiceNumber });
    if (o.status === "CANCELLED") e.cancel++;
    series.set(s, e);
  }
  const docs: DocRange[] = [...series.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([s, e], i) => {
      e.seqs.sort((a, b) => a.seq - b.seq);
      const first = e.seqs[0];
      const last = e.seqs[e.seqs.length - 1];
      const span = last.seq - first.seq + 1;
      const others = [...(otherSeqs.get(s) ?? [])].filter((n) => n > first.seq && n < last.seq).length;
      const missing = span - e.seqs.length - others;
      if (missing > 0) {
        warnings.push(`Series ${s}: ${missing} invoice number(s) missing between ${first.inv} and ${last.inv} (issued in another period or not found).`);
      }
      return { num: i + 1, from: first.inv, to: last.inv, totnum: e.seqs.length, cancel: e.cancel, net_issue: e.seqs.length - e.cancel };
    });

  const payload: Gstr1Payload = {
    gstin: input.gstin ?? "",
    fp,
    b2cs: b2csOut,
    hsn: { data: hsnOut },
    doc_issue: { doc_det: docs.length ? [{ doc_num: 1, doc_typ: "Invoices for outward supply", docs }] : [] },
  };
  notes.push(
    "Place of supply = outlet state (customer state is not captured).",
    "B2B, B2CL, exports and credit/debit notes are not generated (the POS does not record buyer GSTINs or issue credit notes).",
  );
  return {
    excluded: false,
    payload,
    totals: {
      invoices: supplies.length,
      txval: rupees(tot.taxable),
      iamt: rupees(tot.igst),
      camt: rupees(tot.cgst),
      samt: rupees(tot.sgst),
      csamt: rupees(tot.cess),
      paise: tot,
    },
    notes,
    warnings,
  };
}
