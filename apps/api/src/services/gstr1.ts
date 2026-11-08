/**
 * GSTR-1 builder (pure; no DB). Produces the JSON accepted by the GSTN
 * offline utility / portal "Upload JSON" for a canteen that only makes B2C
 * supplies:
 *
 *  - b2cs  : B2C (small) supplies grouped by place of supply + rate + supply type
 *  - hsn   : HSN/SAC summary per HSN + rate
 *  - doc_issue : document series ranges per financial-year series — nature 1 (invoices for
 *                outward supply) and nature 5 (credit notes issued in the month)
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
 * CMP-08 / GSTR-4, not GSTR-1.
 *
 * QA 16b (gap 2) — sections by recipient:
 *  - b2b   : bills with a buyer GSTIN (table 4A), grouped by buyer (ctin), one entry per invoice
 *  - b2cl  : unregistered inter-state invoices with invoice value > ₹1,00,000 (table 5). The limit was
 *            ₹2,50,000 until Notification 12/2024-Central Tax (10 Jul 2024; amended FORM GSTR-1 tables 5
 *            and 7) lowered it, effective 1 Aug 2024 (GSTN advisory of 3 Sep 2024).
 *  - b2cs  : everything else (table 7)
 *  - cdnr  : credit notes on B2B invoices (table 9B registered)
 *  - cdnur : credit notes on B2CL invoices (table 9B unregistered, typ "B2CL"); credit notes on B2CS
 *            bills keep reducing b2cs in the month they're issued.
 * Place of supply: the bill's placeOfSupply when captured, else the outlet's state.
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
  /** QA 16b: invoice date, invoice value (paise), registered buyer and place of supply (B2B / B2CL) */
  createdAt?: Date | string;
  grandTotal?: number;
  buyerGstin?: string | null;
  placeOfSupply?: string | null;
}

export interface Gstr1CreditNote {
  number: string;
  documentType: Gstr1Order["documentType"];
  interState: boolean;
  items: Gstr1Line[];
  /** QA 16b: note date, note value (paise), and the original invoice's buyer / place of supply / value */
  createdAt?: Date | string;
  amount?: number;
  buyerGstin?: string | null;
  placeOfSupply?: string | null;
  invoiceTotal?: number;
}

/** Unregistered inter-state invoices above this value (paise) go to B2CL: > ₹1 lakh since 1 Aug 2024 (Notification 12/2024-CT). */
export const B2CL_LIMIT_PAISE = 1_00_000_00;

export type SupplyKind = "B2B" | "B2CL" | "B2CS";
/** Which GSTR-1 table a bill belongs to. */
export function supplyKind(o: { buyerGstin?: string | null; interState: boolean; total?: number }): SupplyKind {
  if (o.buyerGstin) return "B2B";
  if (o.interState && (o.total ?? 0) > B2CL_LIMIT_PAISE) return "B2CL";
  return "B2CS";
}

export interface Gstr1Input {
  gstin: string | null;
  stateCode: string;
  /** "YYYY-MM" */
  month: string;
  compositionScheme: boolean;
  orders: Gstr1Order[];
  /** Credit notes issued in the month, as negative lines at the original rates (Phase 3.1) */
  creditNotes?: Gstr1CreditNote[];
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

export interface ItemDetail {
  num: number;
  itm_det: { rt: number; txval: number; iamt: number; camt?: number; samt?: number; csamt: number };
}
export interface B2bInvoice { inum: string; idt: string; val: number; pos: string; rchrg: "N"; inv_typ: "R"; itms: ItemDetail[] }
export interface B2bEntry { ctin: string; inv: B2bInvoice[] }
export interface B2clEntry { pos: string; inv: { inum: string; idt: string; val: number; itms: ItemDetail[] }[] }
export interface CdnrNote { ntty: "C"; nt_num: string; nt_dt: string; val: number; pos: string; rchrg: "N"; inv_typ: "R"; itms: ItemDetail[] }
export interface CdnrEntry { ctin: string; nt: CdnrNote[] }
export interface CdnurEntry { typ: "B2CL"; ntty: "C"; nt_num: string; nt_dt: string; val: number; pos: string; itms: ItemDetail[] }

export interface Gstr1Payload {
  gstin: string;
  fp: string;
  b2b?: B2bEntry[];
  b2cl?: B2clEntry[];
  cdnr?: CdnrEntry[];
  cdnur?: CdnurEntry[];
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
  const m = /^(.*?)(\d+)$/.exec(inv);
  if (!m) return { series: inv, seq: 0 };
  return { series: m[1], seq: Number(m[2]) };
}

/** GSTN limits the HSN description to 30 characters. */
const DEFAULT_HSN_DESC: Record<string, string> = {
  "996331": "Restaurant services",
  "996332": "Restaurant services with bar",
  "996334": "Canteen services",
  "996337": "Contract food services",
};

/**
 * GSTN document-summary ranges: documents grouped by series ("INV-2026-"), each reported as
 * from / to / count / cancelled. `others` are numbers of the same series that are not reported
 * here (e.g. plain BILLs), so they don't count as gaps in the warning.
 */
export function docRanges(docs: { number: string; cancelled: boolean }[], others: string[], label: string, warnings: string[]): DocRange[] {
  const otherSeqs = new Map<string, Set<number>>();
  for (const n of others) {
    const { series: s, seq } = splitInvoiceNumber(n);
    otherSeqs.set(s, (otherSeqs.get(s) ?? new Set()).add(seq));
  }
  const series = new Map<string, { seqs: { seq: number; inv: string }[]; cancel: number }>();
  for (const d of docs) {
    const { series: s, seq } = splitInvoiceNumber(d.number);
    const e = series.get(s) ?? { seqs: [], cancel: 0 };
    e.seqs.push({ seq, inv: d.number });
    if (d.cancelled) e.cancel++;
    series.set(s, e);
  }
  return [...series.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([s, e], i) => {
      e.seqs.sort((a, b) => a.seq - b.seq);
      const first = e.seqs[0];
      const last = e.seqs[e.seqs.length - 1];
      const span = last.seq - first.seq + 1;
      const between = [...(otherSeqs.get(s) ?? [])].filter((n) => n > first.seq && n < last.seq).length;
      const missing = span - e.seqs.length - between;
      if (missing > 0) {
        warnings.push(`Series ${s}: ${missing} ${label} number(s) missing between ${first.inv} and ${last.inv} (issued in another period or not found).`);
      }
      return { num: i + 1, from: first.inv, to: last.inv, totnum: e.seqs.length, cancel: e.cancel, net_issue: e.seqs.length - e.cancel };
    });
}

/** GSTN date format dd-mm-yyyy, in IST. */
export function gstDate(d: Date | string | undefined): string {
  if (!d) return "";
  const p = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", day: "2-digit", month: "2-digit", year: "numeric" }).format(new Date(d));
  return p.replace(/\//g, "-");
}

/** Item details of one document, one row per GST rate. `sign` -1 turns credit-note lines (negative) positive. */
function itemDetails(lines: Gstr1Line[], interState: boolean, sign: 1 | -1, intraFields: boolean): ItemDetail[] {
  const byRate = new Map<number, { txval: number; iamt: number; camt: number; samt: number; csamt: number }>();
  for (const l of lines) {
    const rt = lineRate(l, interState);
    const r = byRate.get(rt) ?? { txval: 0, iamt: 0, camt: 0, samt: 0, csamt: 0 };
    r.txval += sign * lineTxval(l);
    r.iamt += sign * l.igst;
    r.camt += sign * l.cgst;
    r.samt += sign * l.sgst;
    r.csamt += sign * (l.cess ?? 0);
    byRate.set(rt, r);
  }
  return [...byRate.entries()]
    .sort(([a], [b]) => a - b)
    .map(([rt, r], i) => ({
      num: i + 1,
      itm_det: intraFields
        ? { rt, txval: rupees(r.txval), iamt: rupees(r.iamt), camt: rupees(r.camt), samt: rupees(r.samt), csamt: rupees(r.csamt) }
        : { rt, txval: rupees(r.txval), iamt: rupees(r.iamt), csamt: rupees(r.csamt) },
    }));
}

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
  const b2cs = new Map<string, { sply_ty: "INTRA" | "INTER"; pos: string; rt: number; txval: number; iamt: number; camt: number; samt: number; csamt: number }>();
  const hsn = new Map<string, { hsn: string; rt: number; qty: number; txval: number; iamt: number; camt: number; samt: number; csamt: number }>();
  const tot = { taxable: 0, cgst: 0, sgst: 0, igst: 0, cess: 0 };
  const interInvoices: string[] = [];
  const credits = (input.creditNotes ?? []).filter((c) => c.documentType === "TAX_INVOICE");
  const posOf = (d: { placeOfSupply?: string | null }) => d.placeOfSupply ?? input.stateCode;
  const b2b = new Map<string, B2bInvoice[]>();
  const b2cl = new Map<string, B2clEntry["inv"]>();
  const cdnr = new Map<string, CdnrNote[]>();
  const cdnur: CdnurEntry[] = [];
  const docs: { invoiceNumber: string; interState: boolean; items: Gstr1Line[]; kind: SupplyKind; credit: boolean; placeOfSupply?: string | null }[] = [];
  for (const o of supplies) {
    const kind = supplyKind({ buyerGstin: o.buyerGstin, interState: o.interState, total: o.grandTotal });
    docs.push({ ...o, kind, credit: false });
    const pos = posOf(o);
    if (kind === "B2B") {
      const list = b2b.get(o.buyerGstin!) ?? [];
      list.push({ inum: o.invoiceNumber, idt: gstDate(o.createdAt), val: rupees(o.grandTotal ?? 0), pos, rchrg: "N", inv_typ: "R", itms: itemDetails(o.items, o.interState, 1, true) });
      b2b.set(o.buyerGstin!, list);
    } else if (kind === "B2CL") {
      const list = b2cl.get(pos) ?? [];
      list.push({ inum: o.invoiceNumber, idt: gstDate(o.createdAt), val: rupees(o.grandTotal ?? 0), itms: itemDetails(o.items, true, 1, false) });
      b2cl.set(pos, list);
    }
  }
  for (const c of credits) {
    const kind = supplyKind({ buyerGstin: c.buyerGstin, interState: c.interState, total: c.invoiceTotal });
    docs.push({ ...c, invoiceNumber: c.number, kind, credit: true });
    const pos = posOf(c);
    if (kind === "B2B") {
      const list = cdnr.get(c.buyerGstin!) ?? [];
      list.push({ ntty: "C", nt_num: c.number, nt_dt: gstDate(c.createdAt), val: rupees(c.amount ?? 0), pos, rchrg: "N", inv_typ: "R", itms: itemDetails(c.items, c.interState, -1, true) });
      cdnr.set(c.buyerGstin!, list);
    } else if (kind === "B2CL") {
      cdnur.push({ typ: "B2CL", ntty: "C", nt_num: c.number, nt_dt: gstDate(c.createdAt), val: rupees(c.amount ?? 0), pos, itms: itemDetails(c.items, true, -1, false) });
    }
  }
  const count = (k: SupplyKind, credit: boolean) => docs.filter((d) => d.kind === k && d.credit === credit).length;
  if (count("B2CS", true)) notes.push(`${count("B2CS", true)} credit note(s) issued this month reduce B2CS and HSN.`);
  if (count("B2B", false)) notes.push(`${count("B2B", false)} B2B invoice(s) to registered buyers reported in table 4 (B2B).`);
  if (count("B2CL", false)) notes.push(`${count("B2CL", false)} inter-state B2C invoice(s) above ₹1,00,000 reported in table 5 (B2CL).`);
  if (count("B2B", true) + count("B2CL", true)) notes.push(`${count("B2B", true) + count("B2CL", true)} credit note(s) on B2B / B2CL invoices reported in table 9B (CDNR / CDNUR).`);
  for (const o of docs) {
    if (o.interState && !o.credit && !o.placeOfSupply) interInvoices.push(o.invoiceNumber);
    for (const l of o.items) {
      const sply_ty = o.interState ? "INTER" : "INTRA";
      const txval = lineTxval(l);
      const rt = lineRate(l, o.interState);
      const cess = l.cess ?? 0;
      if (o.kind === "B2CS") {
        const pos = posOf(o);
        const bk = `${sply_ty}|${pos}|${rt}`;
        const b = b2cs.get(bk) ?? { sply_ty, pos, rt, txval: 0, iamt: 0, camt: 0, samt: 0, csamt: 0 };
        b.txval += txval;
        b.iamt += l.igst;
        b.camt += l.cgst;
        b.samt += l.sgst;
        b.csamt += cess;
        b2cs.set(bk, b);
      }

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
    warnings.push(`${interInvoices.length} inter-state (IGST) bill(s) reported with POS ${input.stateCode} (no place of supply captured on the bill): ${interInvoices.slice(0, 10).join(", ")}${interInvoices.length > 10 ? "…" : ""}`);
  }

  const b2csOut: B2csEntry[] = [...b2cs.values()]
    .filter((b) => b.txval !== 0 || b.iamt + b.camt + b.samt + b.csamt !== 0)
    .sort((a, b) => a.sply_ty.localeCompare(b.sply_ty) || a.pos.localeCompare(b.pos) || a.rt - b.rt)
    .map((b) => ({
      sply_ty: b.sply_ty,
      pos: b.pos,
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

  // --- doc_issue: every tax invoice / credit note number issued in the period, per series ---
  // Plain BILLs / Bills of Supply share the invoice series; their numbers are not gaps.
  const invoiceDocs = docRanges(
    taxInvoices.map((o) => ({ number: o.invoiceNumber, cancelled: o.status === "CANCELLED" })),
    input.orders.filter((o) => o.documentType !== "TAX_INVOICE").map((o) => o.invoiceNumber),
    "invoice",
    warnings,
  );
  // Credit notes are never cancelled once issued; those on non-GST bills share the CN series.
  const creditDocs = docRanges(
    credits.map((c) => ({ number: c.number, cancelled: false })),
    (input.creditNotes ?? []).filter((c) => c.documentType !== "TAX_INVOICE").map((c) => c.number),
    "credit note",
    warnings,
  );
  const docDet: Gstr1Payload["doc_issue"]["doc_det"] = [];
  if (invoiceDocs.length) docDet.push({ doc_num: 1, doc_typ: "Invoices for outward supply", docs: invoiceDocs });
  if (creditDocs.length) docDet.push({ doc_num: 5, doc_typ: "Credit Note", docs: creditDocs });

  const payload: Gstr1Payload = {
    gstin: input.gstin ?? "",
    fp,
    ...(b2b.size && { b2b: [...b2b.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([ctin, inv]) => ({ ctin, inv })) }),
    ...(b2cl.size && { b2cl: [...b2cl.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([pos, inv]) => ({ pos, inv })) }),
    ...(cdnr.size && { cdnr: [...cdnr.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([ctin, nt]) => ({ ctin, nt })) }),
    ...(cdnur.length && { cdnur }),
    b2cs: b2csOut,
    hsn: { data: hsnOut },
    doc_issue: { doc_det: docDet },
  };
  notes.push(
    "Place of supply = the bill's place of supply when captured, else the outlet's state (restaurant service: IGST Act s.12(4)).",
    "Exports (EXP), advances (AT/TXP) and amendments are not generated; the HSN summary is one table (B2B + B2C).",
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
