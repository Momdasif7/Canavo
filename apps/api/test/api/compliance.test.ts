/**
 * QA Phase 14 — compliance & domain correctness through the API:
 *  - GST: tax invoice / bill of supply / plain bill receipts carry the Rule 46 / 49 fields
 *    (supplier GSTIN, FSSAI, number ≤ 16, place of supply, HSN/SAC, rate-wise tax),
 *    GSTIN checksum + state match on the outlet, credit-note numbering, GSTR-1 totals that
 *    reconcile with the bills (credit notes netted, cancelled invoices in the document summary);
 *  - India: +91 mobile normalisation, IST business day (run this file with TZ=America/New_York too);
 *  - DPDP: customer consent, data export and erasure (invoices kept, PII masked), promotional
 *    messages only with consent, owner data export without secrets, no backup download.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runCrmDailyForBusiness } from "../../src/jobs-crm";
import { runForBusiness } from "../../src/lib/tenant";
import { zonedParts } from "../../src/lib/time";
import { startServer } from "../integration/helpers";
import { db, world, type World } from "./kit";

let srv: Awaited<ReturnType<typeof startServer>>;
let w: World;
const owner = () => w.as.BUSINESS_OWNER;
const GSTIN = "33AAAAA0000A1Z9"; // valid checksum, Tamil Nadu (test hotels are state 33)
const FSSAI = "12345678901234";
let seq = 0;
const mobile = () => `9${String(Date.now() % 1e5).padStart(5, "0")}${String(seq++ % 1e4).padStart(4, "0")}`;

async function bill(c = owner(), body: Record<string, unknown> = {}) {
  const o = await c.call("POST", "/orders", { orderType: "TAKEAWAY", items: [{ menuItemId: w.h.items.biryani, quantity: 2 }], ...body });
  expect(o.status, JSON.stringify(o.body)).toBe(201);
  const p = await c.call("POST", `/orders/${o.body.id}/payments`, { payments: [{ mode: "CASH", amount: o.body.grandTotal }] });
  expect(p.status, JSON.stringify(p.body)).toBe(200);
  return o.body as { id: string; invoiceNumber: string; grandTotal: number; documentType: string };
}
const receiptText = async (id: string, c = owner()) => (await c.call("GET", `/orders/${id}/receipt?format=text&paper=80`)).body as string;

beforeAll(async () => {
  srv = await startServer();
  w = await world(srv.base, "Compliance API");
  await db.outlet.update({ where: { id: w.h.outletId }, data: { gstEnabled: true, gstin: GSTIN, fssai: FSSAI, legalName: "Compliance Foods Pvt Ltd", address: "1 Anna Salai, Chennai" } });
}, 60_000);
afterAll(() => srv.close());

describe("Outlet GST identity", () => {
  it("GSTIN checksum, state code and FSSAI format are validated; missing FSSAI warns", async () => {
    const patch = (b: object) => owner().call("PATCH", "/outlets/current", b);
    expect((await patch({ gstin: "33AAAAA0000A1Z5" })).status).toBe(400); // wrong check character
    const wrongState = await patch({ gstin: "27AAPFU0939F1ZV" }); // valid Maharashtra GSTIN on a Tamil Nadu outlet
    expect(wrongState.status).toBe(400);
    expect(JSON.stringify(wrongState.body)).toMatch(/registered in state 27/);
    expect((await patch({ stateCode: "00" })).status).toBe(400);
    expect((await patch({ fssai: "1234567890123" })).status).toBe(400);
    const noFssai = await patch({ fssai: "" });
    expect(noFssai.status).toBe(200);
    expect(noFssai.body.warnings.join(" ")).toMatch(/FSSAI/);
    const ok = await patch({ gstin: GSTIN.toLowerCase(), fssai: FSSAI });
    expect(ok.status).toBe(200);
    expect(ok.body.gstin).toBe(GSTIN);
  });
});

describe("Receipts: mandatory fields per document type", () => {
  it("tax invoice: supplier, GSTIN, FSSAI, number ≤ 16, place of supply, HSN/SAC, CGST/SGST", async () => {
    const o = await bill();
    expect(o.documentType).toBe("TAX_INVOICE");
    expect(o.invoiceNumber.length).toBeLessThanOrEqual(16);
    const t = await receiptText(o.id);
    for (const s of ["TAX INVOICE", "Compliance Foods Pvt Ltd", "Anna Salai", `GSTIN: ${GSTIN}`, `FSSAI: ${FSSAI}`, o.invoiceNumber, "Place of supply: 33-Tamil Nadu", "HSN/SAC:", "CGST @", "SGST @"]) {
      expect(t, s).toContain(s);
    }
    const pdf = await owner().call("GET", `/orders/${o.id}/receipt.pdf`);
    expect(pdf.status).toBe(200);
  });

  it("inter-state bill: IGST, and the place of supply is not claimed to be the outlet's state", async () => {
    const o = await bill(owner(), { interState: true });
    const t = await receiptText(o.id);
    expect(t).toContain("IGST @");
    expect(t).not.toMatch(/CGST|SGST/);
    expect(t.replace(/\s+/g, " ")).toContain("Place of supply: Outside 33-Tamil Nadu (inter-state)");
  });

  it("composition scheme: BILL OF SUPPLY with the Rule 49 declaration and no tax lines", async () => {
    await db.outlet.update({ where: { id: w.h.outletId }, data: { compositionScheme: true } });
    try {
      const o = await bill();
      expect(o.documentType).toBe("BILL_OF_SUPPLY");
      const t = await receiptText(o.id);
      expect(t).toContain("BILL OF SUPPLY");
      expect(t).toContain("Composition taxable person");
      expect(t).not.toMatch(/CGST|SGST|IGST/);
    } finally {
      await db.outlet.update({ where: { id: w.h.outletId }, data: { compositionScheme: false } });
    }
  });

  it("GST off: plain BILL without GSTIN, HSN, place of supply or tax", async () => {
    await db.outlet.update({ where: { id: w.h.outletId }, data: { gstEnabled: false } });
    try {
      const o = await bill();
      expect(o.documentType).toBe("BILL");
      const t = await receiptText(o.id);
      expect(t).not.toMatch(/GSTIN|HSN|Place of supply|CGST|SGST|IGST|TAX INVOICE/);
      expect(t).toContain(`FSSAI: ${FSSAI}`);
    } finally {
      await db.outlet.update({ where: { id: w.h.outletId }, data: { gstEnabled: true } });
    }
  });
});

describe("Credit notes and GSTR-1 reconciliation", () => {
  it("cmp-1: refunds work for a 4–5 character invoice prefix (credit-note number ≤ 16 characters)", async () => {
    await db.outlet.update({ where: { id: w.h.outletId }, data: { invoicePrefix: "CANTN" } });
    try {
      const o = await bill();
      const r = await owner().call("POST", `/orders/${o.id}/refunds`, { reason: "QUALITY", refundMode: "CASH", amount: 1000 });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      expect(r.body.number).toMatch(/^CNCAN-\d{4}-\d{5}$/);
      expect(r.body.number.length).toBeLessThanOrEqual(16);
    } finally {
      await db.outlet.update({ where: { id: w.h.outletId }, data: { invoicePrefix: "INV" } });
    }
  });

  it("B2CS, HSN and paise totals reconcile with this month's bills net of credit notes; cancelled invoices are in the document summary", async () => {
    // A fresh outlet so only this test's documents are in the month.
    const c = w.owner2;
    await db.outlet.update({ where: { id: w.h.outlet2Id }, data: { gstEnabled: true, gstin: GSTIN, fssai: FSSAI } });
    const paid = [await bill(c), await bill(c, { items: [{ menuItemId: w.h.items.chai, quantity: 3 }] })];
    const cancelled = (await c.call("POST", "/orders", { orderType: "TAKEAWAY", items: [{ menuItemId: w.h.items.samosa, quantity: 1 }] })).body;
    expect((await c.call("POST", `/orders/${cancelled.id}/cancel`, { reason: "Customer left" })).status).toBe(200);
    const cn = await c.call("POST", `/orders/${paid[0]!.id}/refunds`, { reason: "QUALITY", refundMode: "CASH", amount: 5000 });
    expect(cn.status, JSON.stringify(cn.body)).toBe(201);

    const month = zonedParts(new Date(), "Asia/Kolkata").date.slice(0, 7);
    const g = await c.call("GET", `/reports/gstr1?month=${month}`);
    expect(g.status, JSON.stringify(g.body)).toBe(200);
    const orders = await db.order.findMany({ where: { id: { in: paid.map((p) => p.id) } } });
    const credit = await db.creditNote.findUniqueOrThrow({ where: { id: cn.body.id } });
    const sum = (k: "cgst" | "sgst" | "igst") => orders.reduce((s, o) => s + o[k], 0) - credit[k];
    const taxable = orders.reduce((s, o) => s + o.grandTotal - o.roundOff - o.cgst - o.sgst - o.igst - o.cess - o.otherTaxes, 0) - (credit.amount - credit.cgst - credit.sgst - credit.igst - credit.cess - credit.otherTaxes);
    const t = g.body.totals.paise;
    expect(t.cgst).toBe(sum("cgst"));
    expect(t.sgst).toBe(sum("sgst"));
    expect(t.igst).toBe(0);
    expect(Math.abs(t.taxable - taxable)).toBeLessThanOrEqual(1); // value-only credit spread over lines may round by a paisa
    const p = g.body.gstr1;
    const r2 = (n: number) => Math.round(n * 100);
    const b2cs = p.b2cs.reduce((s: number, b: { txval: number }) => s + r2(b.txval), 0);
    const hsn = p.hsn.data.reduce((s: number, h: { txval: number }) => s + r2(h.txval), 0);
    expect(b2cs).toBe(hsn);
    expect(p.b2cs.reduce((s: number, b: { camt: number }) => s + r2(b.camt), 0)).toBe(t.cgst);
    expect(p.hsn.data.every((h: { hsn_sc: string }) => /^\d{4,8}$/.test(h.hsn_sc))).toBe(true);
    const inv = p.doc_issue.doc_det.find((d: { doc_num: number }) => d.doc_num === 1).docs[0];
    expect(inv).toMatchObject({ totnum: 3, cancel: 1, net_issue: 2 });
    const cns = p.doc_issue.doc_det.find((d: { doc_num: number }) => d.doc_num === 5).docs[0];
    expect(cns).toMatchObject({ totnum: 1, from: cn.body.number });
  });
});

describe("Indian mobile numbers", () => {
  it("+91 / 0 prefixed numbers are stored as 10 digits and found again", async () => {
    const m = mobile();
    const r = await owner().call("POST", "/customers", { phone: `+91 ${m.slice(0, 5)} ${m.slice(5)}`, name: "Prefixed" });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.phone).toBe(m);
    expect((await owner().call("GET", `/customers/lookup?phone=0${m}`)).body.found).toBe(true);
    expect((await owner().call("POST", "/customers", { phone: "5123456789" })).status).toBe(400);
  });
});

describe("DPDP: consent, export, erasure", () => {
  it("consent is off by default and stamped when the customer opts in", async () => {
    const r = await owner().call("POST", "/customers", { phone: mobile(), name: "Consent" });
    expect(r.body).toMatchObject({ marketingOptIn: false, whatsappOptIn: false, consentAt: null });
    const u = await w.as.OUTLET_MANAGER.call("PATCH", `/customers/${r.body.id}`, { marketingOptIn: true, whatsappOptIn: true });
    expect(u.body).toMatchObject({ marketingOptIn: true, whatsappOptIn: true, consentSource: "STAFF" });
    expect(u.body.consentAt).toBeTruthy();
  });

  it("birthday / anniversary promotions go only to customers who opted in", async () => {
    const today = zonedParts(new Date(), "Asia/Kolkata").date.slice(5);
    const no = await db.customer.create({ data: { businessId: w.h.businessId, phone: mobile(), name: "No consent", birthday: today } });
    const yes = await db.customer.create({ data: { businessId: w.h.businessId, phone: mobile(), name: "Consented", birthday: today, marketingOptIn: true, whatsappOptIn: true } });
    const run = await runForBusiness(w.h.businessId, () => runCrmDailyForBusiness(new Date(), { force: true }));
    const ids = (run as { celebrations: { customerId: string }[] }).celebrations.map((c) => c.customerId);
    expect(ids).toContain(yes.id);
    expect(ids).not.toContain(no.id);
  });

  it("owner-only data export and erasure; erasure keeps the invoices with masked details", async () => {
    const m = mobile();
    const c = (await owner().call("POST", "/customers", { phone: m, name: "Ravi Kumar", email: "ravi@example.in", birthday: "05-17" })).body;
    const o = await bill(owner(), { customerPhone: m, customerName: "Ravi Kumar" });
    expect((await db.order.findUniqueOrThrow({ where: { id: o.id } })).customerId).toBe(c.id);

    expect((await w.as.OUTLET_MANAGER.call("GET", `/customers/${c.id}/data-export`)).status).toBe(403);
    expect((await w.as.OUTLET_MANAGER.call("POST", `/customers/${c.id}/anonymise`, { confirm: "ANONYMISE" })).status).toBe(403);
    const ex = await owner().call("GET", `/customers/${c.id}/data-export`);
    expect(ex.status).toBe(200);
    expect(ex.body.customer.phone).toBe(m);
    expect(ex.body.orders.map((x: { invoiceNumber: string }) => x.invoiceNumber)).toContain(o.invoiceNumber);
    expect(ex.body.consent).toMatchObject({ marketingOptIn: false });

    // Money owed blocks erasure (the business keeps what it needs for the claim).
    await db.customer.update({ where: { id: c.id }, data: { khataBalance: 500 } });
    expect((await owner().call("POST", `/customers/${c.id}/anonymise`, { confirm: "ANONYMISE" })).status).toBe(409);
    await db.customer.update({ where: { id: c.id }, data: { khataBalance: 0 } });
    expect((await owner().call("POST", `/customers/${c.id}/anonymise`, {})).status).toBe(400);

    const er = await owner().call("POST", `/customers/${c.id}/anonymise`, { confirm: "ANONYMISE" });
    expect(er.status, JSON.stringify(er.body)).toBe(200);
    expect(er.body.orders).toBeGreaterThanOrEqual(1);
    const after = await db.customer.findUniqueOrThrow({ where: { id: c.id } });
    expect(after).toMatchObject({ name: null, email: null, birthday: null, marketingOptIn: false });
    expect(after.phone).toMatch(/^ANON-/);
    expect(after.anonymizedAt).toBeTruthy();
    const kept = await db.order.findUniqueOrThrow({ where: { id: o.id } });
    expect(kept).toMatchObject({ invoiceNumber: o.invoiceNumber, grandTotal: o.grandTotal, customerName: null, customerPhone: null });
    expect(await receiptText(o.id)).not.toContain("Ravi");
    expect((await owner().call("GET", `/customers/lookup?phone=${m}`)).body.found).toBe(false);
    expect((await owner().call("PATCH", `/customers/${c.id}`, { name: "Back" })).status).toBe(409);
    // Repeating the request is harmless.
    expect((await owner().call("POST", `/customers/${c.id}/anonymise`, { confirm: "ANONYMISE" })).body.alreadyDone).toBe(true);
  });

  it("owner data export leaves out passwords, PIN hashes, Aadhaar ciphertext and integration secrets", async () => {
    await db.user.update({ where: { id: w.h.users.cashier.id }, data: { aadhaarEnc: "v1:AADHAAR-CIPHERTEXT", aadhaarLast4: "1234", pinHash: "PIN-HASH-VALUE" } });
    await db.channelConnection.create({
      data: { outletId: w.h.outletId, baseUrl: "https://hub.example", externalStoreId: "S1", apiKeyEnc: "v1:HUB-API-KEY", webhookSecretEnc: "v1:HUB-WEBHOOK-SECRET" },
    });
    await db.deviceToken.create({ data: { userId: w.h.users.cashier.id, token: "PUSH-TOKEN-SECRET", platform: "android" } });
    const r = await owner().call("GET", "/admin/export?format=json");
    expect(r.status).toBe(200);
    const text = typeof r.body === "string" ? r.body : JSON.stringify(r.body);
    expect(text).toContain("ChannelConnection");
    for (const s of ["passwordHash", "pinHash", "PIN-HASH-VALUE", "AADHAAR-CIPHERTEXT", "aadhaarEnc", "totpSecretEnc", "HUB-API-KEY", "HUB-WEBHOOK-SECRET", "PUSH-TOKEN-SECRET", "tokenHash"]) {
      expect(text, s).not.toContain(s);
    }
    expect((await w.as.OUTLET_MANAGER.call("GET", "/admin/export")).status).toBe(403);
  });

  it("platform backups cannot be downloaded through the API (Super Admin can create / restore only)", async () => {
    for (const path of ["/admin/backups/x.json.gz", "/admin/backups/x.json.gz/download", "/admin/backups/download?file=x"]) {
      const r = await w.admin.call("GET", path);
      expect([403, 404], path).toContain(r.status);
    }
    expect((await owner().call("GET", "/admin/backups")).status).toBe(403);
  });
});

describe(`IST business day (server TZ=${process.env.TZ ?? "unset"})`, () => {
  it("a bill at 00:15 IST belongs to that IST day in the daily report, whatever the server timezone", async () => {
    const o = await bill(w.owner2, { items: [{ menuItemId: w.h.items.samosa, quantity: 1 }] });
    const at = new Date("2026-10-14T18:45:00Z"); // 15 Oct 00:15 IST, still 14 Oct in UTC and New York
    await db.order.update({ where: { id: o.id }, data: { createdAt: at, paidAt: at } });
    await db.payment.updateMany({ where: { orderId: o.id }, data: { createdAt: at } });
    const day15 = await w.owner2.call("GET", "/reports/daily?date=2026-10-15");
    const day14 = await w.owner2.call("GET", "/reports/daily?date=2026-10-14");
    expect(day15.status, JSON.stringify(day15.body)).toBe(200);
    // The hourly bucket is the IST hour 0, and the bill counts on the 15th only.
    expect(day15.body.hourly[0]).toMatchObject({ orders: 1, amount: o.grandTotal });
    expect(day15.body.grossSales).toBe(o.grandTotal);
    expect(day14.body.grossSales).toBe(0);
  });
});
