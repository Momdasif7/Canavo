import type { Outlet, Receipt } from "../lib/types";
import type { CartLine } from "./CartContext";
import { isNonGst, type LocalBill } from "./localBill";

/**
 * Provisional receipt for a bill raised offline. The invoice number is only
 * assigned by the server on sync, so this is clearly marked as such.
 * Non-GST outlets get a plain "BILL" with no GSTIN and no tax lines.
 */
export function buildProvisionalReceipt(opts: {
  clientOrderId: string;
  /** Final number from this phone's offline series (Phase 3.4); otherwise a provisional OFF-… one */
  invoiceNumber?: string | null;
  lines: CartLine[];
  bill: LocalBill;
  outlet: Outlet;
  orderType: string;
  tableLabel?: string;
  cashierName: string;
  paymentMode: string;
  createdAt: string;
}): Receipt {
  const { bill, outlet } = opts;
  const nonGst = isNonGst(outlet);
  return {
    documentType: bill.documentType,
    invoiceNumber: opts.invoiceNumber ?? `OFF-${opts.clientOrderId.slice(0, 8).toUpperCase()}`,
    issuedAt: opts.createdAt,
    outlet: {
      name: outlet.name,
      legalName: outlet.legalName ?? null,
      address: outlet.address,
      gstin: nonGst ? null : outlet.gstin,
      fssai: outlet.fssai,
      phone: outlet.phone,
    },
    legalName: outlet.legalName ?? null,
    gstEnabled: !nonGst,
    orderType: opts.orderType,
    tableLabel: opts.tableLabel || null,
    cashierName: opts.cashierName,
    items: opts.lines.map((l, i) => {
      const r = bill.lines[i];
      const amount = r.taxableValue + r.discount;
      const name = [l.item.name, l.variant && `(${l.variant.name})`].filter(Boolean).join(" ");
      return {
        name,
        quantity: l.quantity,
        unitPrice: Math.round(amount / l.quantity),
        amount,
        gstRate: nonGst ? 0 : l.item.gstRate,
        hsnCode: l.item.hsnCode,
      };
    }),
    subtotal: bill.subtotal,
    discount: bill.discount,
    serviceCharge: bill.serviceCharge,
    cgst: bill.cgst,
    sgst: bill.sgst,
    igst: bill.igst,
    cess: bill.cess,
    otherTaxes: bill.otherTaxes,
    taxDetails: bill.taxDetails,
    roundOff: bill.roundOff,
    grandTotal: bill.grandTotal,
    taxBreakup: nonGst ? [] : bill.taxBreakup,
    payments: [{ mode: opts.paymentMode, amount: bill.grandTotal }],
    footer: "PROVISIONAL - bill no. on sync",
  };
}

/** Hand-off of the last offline receipt to the "saved offline" screen. */
let lastOffline: Receipt | null = null;
export const setLastOfflineReceipt = (r: Receipt) => {
  lastOffline = r;
};
export const getLastOfflineReceipt = () => lastOffline;
