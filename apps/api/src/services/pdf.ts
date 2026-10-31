import PDFDocument from "pdfkit";
import { documentTitle, formatINR, ReceiptData, receiptTaxLines } from "@canavo/shared";

// Standard PDF fonts have no ₹ glyph, so use "Rs." in PDFs.
const rs = (p: number) => `Rs. ${formatINR(p, { symbol: false })}`;

/** Render an A5 GST receipt PDF and resolve with its bytes. */
export function renderReceiptPdf(r: ReceiptData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A5", margin: 32 });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const left = doc.page.margins.left;
    const width = doc.page.width - left - doc.page.margins.right;
    const saffron = "#FF6B35";

    const plainBill = r.documentType === "BILL";
    const legalName = r.legalName ?? r.outlet.legalName;
    doc.fillColor(saffron).font("Helvetica-Bold").fontSize(16).text(r.outlet.name, { align: "center" });
    doc.fillColor("#333").font("Helvetica").fontSize(8);
    if (legalName && legalName !== r.outlet.name) doc.text(legalName, { align: "center" });
    if (r.outlet.address) doc.text(r.outlet.address, { align: "center" });
    // Plain bills (not GST registered) never show a GSTIN.
    const ids = [!plainBill && r.outlet.gstin && `GSTIN: ${r.outlet.gstin}`, r.outlet.fssai && `FSSAI: ${r.outlet.fssai}`]
      .filter(Boolean)
      .join("   ");
    if (ids) doc.text(ids, { align: "center" });
    if (r.outlet.phone) doc.text(`Ph: ${r.outlet.phone}`, { align: "center" });
    doc.moveDown(0.6);
    doc.font("Helvetica-Bold").fontSize(11).fillColor("#000")
      .text(documentTitle(r.documentType), { align: "center" });
    doc.moveDown(0.4);

    const issued = new Date(r.issuedAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
    doc.font("Helvetica").fontSize(8.5);
    doc.text(`${plainBill ? "Bill" : "Invoice"}: ${r.invoiceNumber}`, left, doc.y, { continued: true });
    doc.text(issued, { align: "right" });
    doc.text(
      `Type: ${r.orderType.replace("_", "-")}${r.tableLabel ? `   Table: ${r.tableLabel}` : ""}`,
      left, doc.y, { continued: true },
    );
    doc.text(`Cashier: ${r.cashierName}`, { align: "right" });
    if (r.customerName) doc.text(`Customer: ${r.customerName}`, left);
    doc.moveDown(0.5);

    // HSN codes are a GST requirement — plain bills (GST off) don't show them and give the item name the room.
    const showHsn = r.documentType !== "BILL";
    const cols = { item: left, hsn: left + width * 0.46, qty: left + width * 0.6, rate: left + width * 0.7, amt: left + width * 0.82 };
    const itemWidth = (showHsn ? cols.hsn : cols.qty) - cols.item - 4;
    const rule = () => {
      doc.moveTo(left, doc.y).lineTo(left + width, doc.y).strokeColor("#ccc").lineWidth(0.5).stroke();
      doc.moveDown(0.3);
    };
    rule();
    const header = doc.y;
    doc.font("Helvetica-Bold");
    doc.text("Item", cols.item, header);
    if (showHsn) doc.text("HSN", cols.hsn, header);
    doc.text("Qty", cols.qty, header);
    doc.text("Rate", cols.rate, header);
    doc.text("Amount", cols.amt, header, { width: left + width - cols.amt, align: "right" });
    doc.moveDown(0.3);
    rule();
    doc.font("Helvetica");
    for (const it of r.items) {
      const y = doc.y;
      const label = r.documentType === "TAX_INVOICE" ? `${it.name} (${Math.round(it.gstRate * 1000) / 1000}%)` : it.name;
      doc.text(label, cols.item, y, { width: itemWidth });
      const after = doc.y;
      if (showHsn) doc.text(it.hsnCode, cols.hsn, y);
      doc.text(String(it.quantity), cols.qty, y);
      doc.text(formatINR(it.unitPrice, { symbol: false }), cols.rate, y);
      doc.text(formatINR(it.amount, { symbol: false }), cols.amt, y, { width: left + width - cols.amt, align: "right" });
      doc.y = Math.max(after, doc.y);
      doc.moveDown(0.2);
    }
    rule();

    const row = (label: string, value: string, bold = false) => {
      const y = doc.y;
      doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(bold ? 11 : 8.5);
      doc.text(label, left + width * 0.45, y);
      doc.text(value, left, y, { width, align: "right" });
      doc.moveDown(0.15);
    };
    row("Subtotal", rs(r.subtotal));
    if (r.discount) row("Discount", `- ${rs(r.discount)}`);
    if (r.serviceCharge) row("Service charge", rs(r.serviceCharge));
    for (const c of r.charges ?? []) row(c.label, rs(c.amount));
    for (const t of receiptTaxLines(r)) row(t.label.replace("@", "@ "), rs(t.amount));
    if (r.roundOff) row("Round off", rs(r.roundOff));
    doc.moveDown(0.2);
    rule();
    row("TOTAL", rs(r.grandTotal), true);
    doc.moveDown(0.3);
    doc.font("Helvetica").fontSize(8.5);
    for (const p of r.payments) row(`Paid via ${p.mode}`, rs(p.amount));
    if (r.codDue && r.codDue > 0) {
      doc.moveDown(0.3);
      row("CASH ON DELIVERY — amount to pay", rs(r.codDue), true);
    }

    doc.moveDown(1);
    if (r.documentType === "BILL_OF_SUPPLY") {
      doc.fontSize(7.5).fillColor("#666")
        .text("Composition taxable person, not eligible to collect tax on supplies.", left, doc.y, { width, align: "center" });
    }
    doc.fontSize(9).fillColor("#333").text(r.footer ?? "Thank you! Visit again.", left, doc.y, { width, align: "center" });
    doc.fontSize(7).fillColor(saffron).text("Powered by CANAVO", { width, align: "center" });
    doc.end();
  });
}
