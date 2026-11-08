import { formatINR, Paise } from "./money";

/** Per-composition tax summary. Fields other than rate/taxableValue/cgst/sgst/igst are absent on older orders. */
export interface ReceiptTaxBreakup {
  name?: string;
  /** Applicable GST %: IGST for inter-state, else CGST + SGST */
  rate: number;
  cgstRate?: number;
  sgstRate?: number;
  igstRate?: number;
  cessRate?: number;
  taxableValue: Paise;
  cgst: Paise;
  sgst: Paise;
  igst: Paise;
  cess?: Paise;
  otherTaxes?: Paise;
  extras?: { label: string; percent: number; amount: Paise }[];
}

/** Receipt payload returned by GET /orders/:id/receipt — shared by PDF, thermal and UI renderers. */
export interface ReceiptData {
  documentType: "TAX_INVOICE" | "BILL_OF_SUPPLY" | "BILL";
  invoiceNumber: string;
  issuedAt: string;
  outlet: {
    name: string;
    /** Registered legal name (printed on tax invoices when set) */
    legalName?: string | null;
    address: string;
    gstin?: string | null;
    fssai?: string | null;
    phone?: string | null;
  };
  orderType: string;
  tableLabel?: string | null;
  cashierName: string;
  customerName?: string | null;
  /** B2B tax invoice: the registered buyer (Rule 46(e): name, address and GSTIN of the recipient) */
  buyer?: { name: string | null; gstin: string; address?: string | null } | null;
  items: {
    name: string;
    quantity: number;
    unitPrice: Paise;
    amount: Paise;
    gstRate: number;
    hsnCode: string;
  }[];
  subtotal: Paise;
  discount: Paise;
  serviceCharge: Paise;
  /** Delivery fee, packaging etc. */
  charges?: { label: string; amount: Paise }[];
  cgst: Paise;
  sgst: Paise;
  igst: Paise;
  cess?: Paise;
  /** Extra taxes (e.g. VAT), paise */
  otherTaxes?: Paise;
  /** Extra taxes by label */
  taxDetails?: { label: string; percent: number; amount: Paise }[];
  roundOff: Paise;
  grandTotal: Paise;
  taxBreakup: ReceiptTaxBreakup[];
  interState?: boolean;
  /** Rule 46(n) / 49: place of supply with the state name, e.g. "29-Karnataka" (tax documents only) */
  placeOfSupply?: string | null;
  /** false = the outlet is not GST registered (plain BILL) */
  gstEnabled?: boolean;
  legalName?: string | null;
  payments: { mode: string; amount: Paise }[];
  /** Cash on Delivery bill: amount the customer pays the delivery partner (0 / absent once paid) */
  codDue?: Paise;
  footer?: string;
}

/** 58mm paper ≈ 32 chars, 80mm ≈ 48 chars in Font A. */
export type PaperWidth = 58 | 80;
export const charsPerLine = (w: PaperWidth) => (w === 58 ? 32 : 48);

const money = (p: Paise) => formatINR(p, { symbol: false });

function center(text: string, width: number): string {
  if (text.length >= width) return text.slice(0, width);
  const pad = Math.floor((width - text.length) / 2);
  return " ".repeat(pad) + text;
}

function leftRight(left: string, right: string, width: number): string {
  const space = width - right.length;
  const l = left.length > space - 1 ? left.slice(0, space - 1) : left;
  return l + " ".repeat(width - l.length - right.length) + right;
}

function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/)) {
    if ((line + " " + word).trim().length > width) {
      if (line) out.push(line);
      line = word;
    } else line = (line + " " + word).trim();
  }
  if (line) out.push(line);
  return out;
}

/** Plain-text receipt lines for thermal printers (ESC/POS) and previews. */
const pct = (n: number) => `${Math.round(n * 1000) / 1000}%`;

export const documentTitle = (t: ReceiptData["documentType"]) =>
  t === "TAX_INVOICE" ? "TAX INVOICE" : t === "BILL_OF_SUPPLY" ? "BILL OF SUPPLY" : "BILL";

/**
 * Tax lines of a receipt: CGST x% / SGST y% (or IGST), cess and each extra tax
 * by label, per tax composition. Works with breakups from older orders too.
 */
export function receiptTaxLines(r: ReceiptData): { label: string; amount: Paise }[] {
  if (r.documentType !== "TAX_INVOICE") return [];
  const out: { label: string; amount: Paise }[] = [];
  for (const b of r.taxBreakup ?? []) {
    const inter = r.interState ?? (b.igst > 0 && b.cgst + b.sgst === 0);
    if (inter) out.push({ label: `IGST @${pct(b.igstRate ?? b.rate)}`, amount: b.igst });
    else {
      out.push({ label: `CGST @${pct(b.cgstRate ?? b.rate / 2)}`, amount: b.cgst });
      out.push({ label: `SGST @${pct(b.sgstRate ?? b.rate / 2)}`, amount: b.sgst });
    }
    if (b.cess) out.push({ label: `Cess @${pct(b.cessRate ?? 0)}`, amount: b.cess });
    for (const e of b.extras ?? []) out.push({ label: `${e.label} @${pct(e.percent)}`, amount: e.amount });
  }
  return out;
}

/** Distinct HSN / SAC codes on a GST document (none on a plain BILL). */
export function hsnCodesOf(r: ReceiptData): string[] {
  if (r.documentType === "BILL") return [];
  return [...new Set(r.items.map((i) => i.hsnCode).filter(Boolean))].sort();
}

export function formatReceiptText(r: ReceiptData, paper: PaperWidth = 58): string[] {
  const w = charsPerLine(paper);
  const rule = "-".repeat(w);
  const lines: string[] = [];
  const plainBill = r.documentType === "BILL";
  const legalName = r.legalName ?? r.outlet.legalName;
  lines.push(center(r.outlet.name.toUpperCase(), w));
  if (legalName && legalName !== r.outlet.name) wrap(legalName, w).forEach((l) => lines.push(center(l, w)));
  wrap(r.outlet.address, w).forEach((l) => lines.push(center(l, w)));
  if (r.outlet.phone) lines.push(center(`Ph: ${r.outlet.phone}`, w));
  if (r.outlet.gstin && !plainBill) lines.push(center(`GSTIN: ${r.outlet.gstin}`, w));
  if (r.outlet.fssai) lines.push(center(`FSSAI: ${r.outlet.fssai}`, w));
  lines.push(rule);
  lines.push(center(documentTitle(r.documentType), w));
  lines.push(leftRight(`No: ${r.invoiceNumber}`, r.orderType.replace("_", "-"), w));
  const d = new Date(r.issuedAt);
  lines.push(
    leftRight(
      d.toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata" }),
      d.toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" }),
      w,
    ),
  );
  if (r.tableLabel) lines.push(`Table: ${r.tableLabel}`);
  lines.push(`Cashier: ${r.cashierName}`);
  if (r.customerName) lines.push(`Customer: ${r.customerName}`);
  if (r.buyer && !plainBill) {
    if (r.buyer.name) wrap(`Bill to: ${r.buyer.name}`, w).forEach((l) => lines.push(l));
    if (r.buyer.address) wrap(r.buyer.address, w).forEach((l) => lines.push(l));
    lines.push(`Buyer GSTIN: ${r.buyer.gstin}`);
  }
  if (r.placeOfSupply && !plainBill) wrap(`Place of supply: ${r.placeOfSupply}`, w).forEach((l) => lines.push(l));
  lines.push(rule);
  lines.push(leftRight("Item", "Qty    Amount", w));
  lines.push(rule);
  for (const it of r.items) {
    const right = `${String(it.quantity).padStart(3)} ${money(it.amount).padStart(9)}`;
    if (it.name.length > w - right.length - 1) {
      // Long names get their own wrapped lines; qty/amount go on the last one.
      const wrapped = wrap(it.name, w);
      wrapped.slice(0, -1).forEach((l) => lines.push(l));
      const last = wrapped[wrapped.length - 1];
      if (last.length > w - right.length - 1) lines.push(last, leftRight("", right, w));
      else lines.push(leftRight(last, right, w));
    } else lines.push(leftRight(it.name, right, w));
  }
  // Rule 46(g) / 49: HSN / SAC on GST documents (one code per line would not fit 58 mm paper).
  const hsn = hsnCodesOf(r);
  if (hsn.length) wrap(`HSN/SAC: ${hsn.join(", ")}`, w).forEach((l) => lines.push(l));
  lines.push(rule);
  lines.push(leftRight("Subtotal", money(r.subtotal), w));
  if (r.discount) lines.push(leftRight("Discount", `-${money(r.discount)}`, w));
  if (r.serviceCharge) lines.push(leftRight("Service charge", money(r.serviceCharge), w));
  for (const c of r.charges ?? []) lines.push(leftRight(c.label, money(c.amount), w));
  for (const t of receiptTaxLines(r)) lines.push(leftRight(t.label, money(t.amount), w));
  if (r.roundOff) lines.push(leftRight("Round off", money(r.roundOff), w));
  lines.push(rule);
  lines.push(leftRight("TOTAL", `Rs ${money(r.grandTotal)}`, w));
  lines.push(rule);
  for (const p of r.payments) lines.push(leftRight(`Paid (${p.mode})`, money(p.amount), w));
  if (r.codDue && r.codDue > 0) {
    lines.push(center("** CASH ON DELIVERY **", w));
    lines.push(leftRight("Amount to pay", `Rs ${money(r.codDue)}`, w));
  }
  if (r.documentType === "BILL_OF_SUPPLY") {
    lines.push("Composition taxable person,");
    lines.push("not eligible to collect tax.");
  }
  if (!plainBill) lines.push(center("Computer-generated document", w));
  lines.push("");
  lines.push(center(r.footer ?? "Thank you! Visit again.", w));
  lines.push(center("Powered by CANAVO", w));
  return lines;
}

/** Wrap text lines in raw ESC/POS commands (init, bold header, feed + partial cut). */
export function toEscPos(lines: string[]): Uint8Array {
  const ESC = 0x1b;
  const GS = 0x1d;
  const enc = new TextEncoder();
  const chunks: number[] = [ESC, 0x40]; // initialise
  lines.forEach((line, i) => {
    if (i === 0) chunks.push(ESC, 0x45, 1); // bold on
    chunks.push(...enc.encode(line.replace(/₹/g, "Rs") + "\n"));
    if (i === 0) chunks.push(ESC, 0x45, 0); // bold off
  });
  chunks.push(ESC, 0x64, 4); // feed 4 lines
  chunks.push(GS, 0x56, 1); // partial cut
  return Uint8Array.from(chunks);
}
