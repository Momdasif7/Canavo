import { describe, expect, it } from "vitest";
import { computeBill, type TaxConfig } from "@canavo/shared";
import { B2CL_LIMIT_PAISE, buildGstr1, fpOf, gstDate, lineTxval, splitInvoiceNumber, supplyKind, type Gstr1Order } from "./gstr1";

const base: TaxConfig = {
  pricesIncludeTax: true, interState: false, compositionScheme: false,
  serviceChargeEnabled: false, serviceChargePercent: 0, roundOff: true,
};

/** Build a fixture order the same way billing.ts does. */
function order(
  invoiceNumber: string,
  lines: { price: number; qty: number; rate: number; hsn?: string }[],
  opts: Partial<TaxConfig> & { status?: Gstr1Order["status"] } = {},
): Gstr1Order {
  const cfg = { ...base, ...opts };
  const bill = computeBill(lines.map((l) => ({ unitPrice: l.price, quantity: l.qty, gstRate: l.rate })), cfg);
  return {
    invoiceNumber,
    status: opts.status ?? "PAID",
    documentType: bill.documentType,
    interState: cfg.interState,
    items: lines.map((l, i) => ({
      hsnCode: l.hsn ?? "996331", gstRate: l.rate, quantity: l.qty,
      taxableValue: bill.lines[i].taxableValue, serviceCharge: bill.lines[i].serviceCharge,
      cgst: bill.lines[i].cgst, sgst: bill.lines[i].sgst, igst: bill.lines[i].igst, total: bill.lines[i].total,
    })),
  };
}

const fixture: Gstr1Order[] = [
  order("INV-2026-00001", [{ price: 10500, qty: 2, rate: 5 }, { price: 11800, qty: 1, rate: 18, hsn: "210690" }]),
  order("INV-2026-00002", [{ price: 2500, qty: 3, rate: 5 }], { serviceChargeEnabled: true, serviceChargePercent: 5, extraCharges: [{ label: "Packaging", amount: 1000 }] }),
  order("INV-2026-00003", [{ price: 5000, qty: 1, rate: 5 }], { status: "CANCELLED" }),
  order("INV-2026-00004", [{ price: 21000, qty: 1, rate: 5 }], { interState: true }),
  order("INV-2026-00005", [{ price: 4000, qty: 1, rate: 5 }], { status: "OPEN" }),
];

describe("GSTR-1 builder", () => {
  it("helpers", () => {
    expect(fpOf("2026-09")).toBe("092026");
    expect(splitInvoiceNumber("INV-2026-00012")).toEqual({ series: "INV-2026-", seq: 12 });
  });

  const res = buildGstr1({ gstin: "29ABCDE1234F1ZW", stateCode: "29", month: "2026-09", compositionScheme: false, orders: fixture });

  it("has GSTN top-level fields", () => {
    expect(res.excluded).toBe(false);
    expect(res.payload.gstin).toBe("29ABCDE1234F1ZW");
    expect(res.payload.fp).toBe("092026");
  });

  it("groups b2cs by supply type + rate with POS = outlet state", () => {
    const b = res.payload.b2cs;
    expect(b.map((x) => [x.sply_ty, x.rt])).toEqual([["INTER", 5], ["INTRA", 5], ["INTRA", 18]]);
    for (const x of b) {
      expect(x.pos).toBe("29");
      expect(x.typ).toBe("OE");
      expect(x.csamt).toBe(0);
    }
    const inter = b.find((x) => x.sply_ty === "INTER")!;
    expect(inter).toMatchObject({ txval: 200, iamt: 10, camt: 0, samt: 0 });
    const intra18 = b.find((x) => x.rt === 18)!;
    expect(intra18).toMatchObject({ txval: 100, camt: 9, samt: 9, iamt: 0 });
  });

  it("includes service charge and extra charges in the taxable value", () => {
    const o2 = fixture[1];
    const txval = o2.items.reduce((s, l) => s + lineTxval(l), 0);
    // 3 × ₹25 incl. 5% = ₹71.43 + 5% SC + ₹10 packaging
    expect(txval).toBe(7143 + 357 + 1000);
  });

  it("excludes cancelled and open invoices from supplies but counts them in doc_issue", () => {
    expect(res.totals.invoices).toBe(3);
    const docs = res.payload.doc_issue.doc_det[0].docs;
    expect(docs).toEqual([{ num: 1, from: "INV-2026-00001", to: "INV-2026-00005", totnum: 5, cancel: 1, net_issue: 4 }]);
    expect(res.warnings.some((w) => w.includes("OPEN"))).toBe(true);
    expect(res.warnings.some((w) => w.includes("inter-state"))).toBe(true);
  });

  it("HSN summary reconciles with b2cs", () => {
    const hsn = res.payload.hsn.data;
    expect(hsn.map((h) => [h.hsn_sc, h.rt, h.qty, h.uqc])).toEqual([["210690", 18, 1, "NOS"], ["996331", 5, 6, "NOS"]]);
    const sum = (xs: { txval: number; camt: number; samt: number; iamt: number }[]) =>
      xs.reduce((s, x) => ({ t: s.t + x.txval * 100, c: s.c + x.camt * 100, s: s.s + x.samt * 100, i: s.i + x.iamt * 100 }), { t: 0, c: 0, s: 0, i: 0 });
    const a = sum(res.payload.b2cs);
    const b = sum(hsn);
    expect(Math.round(a.t)).toBe(Math.round(b.t));
    expect(Math.round(a.c + a.s + a.i)).toBe(Math.round(b.c + b.s + b.i));
    expect(Math.round(a.t)).toBe(res.totals.paise.taxable);
  });

  it("excludes composition-scheme outlets with a note", () => {
    const c = buildGstr1({ gstin: "29X", stateCode: "29", month: "2026-09", compositionScheme: true, orders: fixture });
    expect(c.excluded).toBe(true);
    expect(c.payload.b2cs).toEqual([]);
    expect(c.notes[0]).toMatch(/CMP-08/);
  });

  it("drops bills of supply and warns about missing GSTIN / gaps", () => {
    const bos = order("BOS-2026-00009", [{ price: 1000, qty: 1, rate: 5 }], { compositionScheme: true });
    const r = buildGstr1({ gstin: null, stateCode: "29", month: "2026-09", compositionScheme: false, orders: [fixture[0], fixture[3], bos] });
    expect(r.payload.doc_issue.doc_det[0].docs).toHaveLength(1);
    expect(r.notes.some((n) => n.includes("Bill(s) of Supply"))).toBe(true);
    expect(r.warnings.some((w) => w.includes("GSTIN"))).toBe(true);
    expect(r.warnings.some((w) => w.includes("missing"))).toBe(true);
  });

  it("reports cess as csamt, excludes other taxes from txval, and drops plain BILLs", () => {
    const tax = { name: "GST 28% + Cess 12%", cgst: 14, sgst: 14, igst: 28, cess: 12, extras: [{ label: "VAT", percent: 2 }] };
    const bill = computeBill([{ unitPrice: 10000, quantity: 1, tax }], { ...base, pricesIncludeTax: false });
    const cessOrder: Gstr1Order = {
      invoiceNumber: "INV-2026-00010", status: "PAID", documentType: "TAX_INVOICE", interState: false,
      items: [{
        hsnCode: "220210", gstRate: 28, quantity: 1, taxableValue: bill.lines[0].taxableValue, serviceCharge: 0,
        cgst: bill.lines[0].cgst, sgst: bill.lines[0].sgst, igst: 0, cess: bill.lines[0].cess, otherTaxes: bill.lines[0].otherTaxes,
        taxRates: tax, total: bill.lines[0].total,
      }],
    };
    const plain = order("INV-2026-00011", [{ price: 5000, qty: 1, rate: 5 }], { taxEnabled: false });
    expect(plain.documentType).toBe("BILL");
    const r = buildGstr1({ gstin: "29ABCDE1234F1ZW", stateCode: "29", month: "2026-09", compositionScheme: false, orders: [cessOrder, plain] });
    expect(r.payload.b2cs).toEqual([{ sply_ty: "INTRA", pos: "29", typ: "OE", rt: 28, txval: 100, iamt: 0, camt: 14, samt: 14, csamt: 12 }]);
    expect(r.payload.hsn.data[0].csamt).toBe(12);
    expect(r.totals.paise.cess).toBe(1200);
    expect(r.totals.invoices).toBe(1);
    expect(r.payload.doc_issue.doc_det[0].docs).toHaveLength(1);
    expect(r.notes.some((n) => n.includes("1 plain BILL(s) excluded"))).toBe(true);
  });

  it("uses the IGST rate from the snapshot for inter-state lines", () => {
    const tax = { cgst: 2.5, sgst: 2.5, igst: 5, cess: 1 };
    const bill = computeBill([{ unitPrice: 10000, quantity: 1, tax }], { ...base, pricesIncludeTax: false, interState: true });
    const o: Gstr1Order = {
      invoiceNumber: "INV-2026-00020", status: "PAID", documentType: "TAX_INVOICE", interState: true,
      items: [{ hsnCode: "996331", gstRate: 5, quantity: 1, taxableValue: 10000, serviceCharge: 0, cgst: 0, sgst: 0, igst: bill.igst, cess: bill.cess, taxRates: tax, total: bill.lines[0].total }],
    };
    const r = buildGstr1({ gstin: "29ABCDE1234F1ZW", stateCode: "29", month: "2026-09", compositionScheme: false, orders: [o] });
    expect(r.payload.b2cs[0]).toMatchObject({ sply_ty: "INTER", rt: 5, txval: 100, iamt: 5, csamt: 1 });
  });

  it("lists this month's credit notes as nature 5 in the document summary", () => {
    const neg = (o: Gstr1Order) => o.items.map((l) => ({ ...l, quantity: -l.quantity, taxableValue: -l.taxableValue, serviceCharge: -l.serviceCharge, cgst: -l.cgst, sgst: -l.sgst, igst: -l.igst, total: -l.total }));
    const cn = (number: string, o: Gstr1Order) => ({ number, documentType: o.documentType, interState: o.interState, items: neg(o) });
    const plain = order("INV-2026-00011", [{ price: 5000, qty: 1, rate: 5 }], { taxEnabled: false });
    const r = buildGstr1({
      gstin: "29ABCDE1234F1ZW", stateCode: "29", month: "2026-09", compositionScheme: false, orders: [...fixture, plain],
      // CNINV-2026-00002 credits a plain BILL: same CN series but not a GST document, so not a gap.
      creditNotes: [cn("CNINV-2026-00003", fixture[1]), cn("CNINV-2026-00001", fixture[0]), cn("CNINV-2026-00002", plain)],
    });
    expect(r.payload.doc_issue.doc_det.map((d) => [d.doc_num, d.doc_typ])).toEqual([[1, "Invoices for outward supply"], [5, "Credit Note"]]);
    expect(r.payload.doc_issue.doc_det[1].docs).toEqual([{ num: 1, from: "CNINV-2026-00001", to: "CNINV-2026-00003", totnum: 2, cancel: 0, net_issue: 2 }]);
    expect(r.warnings.some((w) => w.includes("credit note number(s) missing"))).toBe(false);

    // A real gap in the CN series is flagged like invoice gaps; no credit notes → no nature-5 entry.
    const gap = buildGstr1({ gstin: "29X", stateCode: "29", month: "2026-09", compositionScheme: false, orders: fixture, creditNotes: [cn("CNINV-2026-00001", fixture[0]), cn("CNINV-2026-00004", fixture[1])] });
    expect(gap.payload.doc_issue.doc_det[1].docs[0]).toMatchObject({ from: "CNINV-2026-00001", to: "CNINV-2026-00004", totnum: 2 });
    expect(gap.warnings.some((w) => w.includes("2 credit note number(s) missing"))).toBe(true);
    expect(res.payload.doc_issue.doc_det.map((d) => d.doc_num)).toEqual([1]);
  });

  it("QA 16b: B2CL threshold is > ₹1,00,000 (Notification 12/2024-CT), B2B wins over B2CL, dates are dd-mm-yyyy IST", () => {
    expect(B2CL_LIMIT_PAISE).toBe(10_000_000);
    expect(supplyKind({ interState: true, total: 10_000_000 })).toBe("B2CS");
    expect(supplyKind({ interState: true, total: 10_000_001 })).toBe("B2CL");
    expect(supplyKind({ interState: false, total: 50_000_000 })).toBe("B2CS");
    expect(supplyKind({ buyerGstin: "29AAAAA0000A1Z5", interState: true, total: 50_000_000 })).toBe("B2B");
    expect(gstDate("2026-10-31T19:00:00Z")).toBe("01-11-2026");
  });
});
