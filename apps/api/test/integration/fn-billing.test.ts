/**
 * QA Phase 5 — group C — Billing / POS functional API tests.
 * Defects are kept as `it.fails(... BUG-CANDIDATE-Cn ...)` so the suite stays green.
 */
import { beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { computeBill, taxFromRate } from "@canavo/shared";
import { app, db } from "./helpers";
import { agentFor, auditCount, demo, line, menuTenant, phone, type Agent, type MenuTenant } from "./fx-c";

let T: MenuTenant;
let cashier: Agent;
let manager: Agent;
let owner: Agent;

beforeAll(async () => {
  T = await menuTenant();
  cashier = await T.as("CASHIER");
  manager = await T.as("OUTLET_MANAGER");
  owner = await T.as("BUSINESS_OWNER");
});

const takeaway = (items: object[], extra: object = {}) => ({ orderType: "TAKEAWAY", items, ...extra });
async function newBill(body: object = takeaway([line(T.items.samosa.id, 2)])) {
  const r = await cashier.post("/orders", body);
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body;
}

describe("Billing — order types & server-side totals @regression", () => {
  it("IT-BIL-001 @critical TAKEAWAY bill: 201, OPEN, FY invoice number, packaging charge applied", async () => {
    const b = await newBill();
    expect(b.status).toBe("OPEN");
    expect(b.invoiceNumber).toMatch(/^INV-\d{4}-\d{5}$/);
    expect(b.invoiceNumber.length).toBeLessThanOrEqual(16);
    expect(b.chargesBreakup).toEqual([{ label: "Packaging", amount: 500 }]);
    // ₹35 × 2 inclusive of 5% + ₹5 packaging (+5%) = ₹75.25 → ₹75
    expect(b.grandTotal).toBe(7500);
  });

  it("IT-BIL-002 @critical mixed-rate cart with variant + add-ons equals computeBill from @canavo/shared", async () => {
    const { chai, sandwich, biryani } = T.items;
    const large = chai.variants.find((v) => v.name === "Large")!;
    const cheese = sandwich.addons.find((a) => a.name === "Cheese")!;
    const b = await newBill(
      takeaway([
        line(chai.id, 2, { variantId: large.id }),
        line(sandwich.id, 1, { addonIds: [cheese.id] }),
        line(biryani.id, 1),
      ]),
    );
    const t5 = taxFromRate(T.gst5);
    const t18 = taxFromRate(T.gst18);
    const expected = computeBill(
      [
        { unitPrice: 2500, quantity: 2, tax: t5 },
        { unitPrice: 7000, quantity: 1, tax: t5 },
        { unitPrice: 16000, quantity: 1, tax: t18 },
      ],
      {
        pricesIncludeTax: true, interState: false, compositionScheme: false, taxEnabled: true,
        serviceChargeEnabled: false, serviceChargePercent: 0, roundOff: true,
        extraCharges: [{ label: "Packaging", amount: 500 }],
      },
    );
    for (const k of ["subtotal", "discount", "taxableValue", "cgst", "sgst", "igst", "roundOff", "grandTotal", "extraCharges"] as const) {
      expect(b[k], k).toBe(expected[k]);
    }
    expect(b.items.map((i: { unitPrice: number }) => i.unitPrice)).toEqual([2500, 7000, 16000]);
    expect(b.items[0].name).toBe("Chai (Large)");
    expect(b.items[2].gstRate).toBe(18);
    expect(b.grandTotal % 100).toBe(0);
  });

  it("IT-BIL-003 @critical client-sent totals, status and invoice number are ignored (server recomputes)", async () => {
    const b = await newBill({
      ...takeaway([line(T.items.samosa.id, 2)]),
      grandTotal: 1, subtotal: 1, cgst: 0, status: "PAID", invoiceNumber: "HACK-1", cashierId: "x", items: [{ menuItemId: T.items.samosa.id, quantity: 2, unitPrice: 1, total: 1 }],
    });
    expect(b.grandTotal).toBe(7500);
    expect(b.status).toBe("OPEN");
    expect(b.invoiceNumber).not.toBe("HACK-1");
    expect(b.items[0].unitPrice).toBe(3500);
  });

  it("IT-BIL-004 DINE_IN bill carries no packaging charge", async () => {
    const b = await newBill({ orderType: "DINE_IN", tableLabel: "T9", items: [line(T.items.samosa.id, 2)] });
    expect(b.extraCharges).toBe(0);
    expect(b.grandTotal).toBe(7000);
    expect(b.tableLabel).toBe("T9");
  });

  it("IT-BIL-005 interState bill uses IGST instead of CGST/SGST", async () => {
    const b = await newBill(takeaway([line(T.items.biryani.id, 1)], { interState: true }));
    expect(b.igst).toBeGreaterThan(0);
    expect(b.cgst).toBe(0);
    expect(b.sgst).toBe(0);
  });

  it("IT-BIL-006 DELIVERY without an address block → 400; without customer name/phone → 400", async () => {
    const r1 = await cashier.post("/orders", { orderType: "DELIVERY", customerName: "A", customerPhone: phone(), items: [line(T.items.samosa.id)] });
    expect(r1.status).toBe(400);
    const r2 = await cashier.post("/orders", { orderType: "DELIVERY", delivery: { address: "12 Main Road" }, items: [line(T.items.samosa.id)] });
    expect(r2.status).toBe(400);
  });

  it("IT-BIL-007 DELIVERY with zone required once zones exist; zone fee + COD recorded", async () => {
    const Z = await menuTenant();
    await db.outlet.update({ where: { id: Z.outletId }, data: { latitude: 12.9, longitude: 77.6 } });
    const zone = await db.deliveryZone.create({ data: { outletId: Z.outletId, name: "Near", radiusKm: 5, fee: 2000 } });
    const c = await Z.as("CASHIER");
    const base = { orderType: "DELIVERY", customerName: "Ravi", customerPhone: phone(), items: [line(Z.items.samosa.id, 2)] };
    const noZone = await c.post("/orders", { ...base, delivery: { address: "12 Main Road" } });
    expect(noZone.status).toBe(400);
    expect(noZone.body.error).toMatch(/coordinates|zone/i);
    const ok = await c.post("/orders", { ...base, delivery: { address: "12 Main Road", zoneId: zone.id, cod: true } });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(ok.body.delivery.cod).toBe(true);
    expect(ok.body.chargesBreakup).toEqual([{ label: "Packaging", amount: 500 }, { label: "Delivery fee", amount: 2000 }]);
    const far = await c.post("/orders", { ...base, delivery: { address: "12 Main Road", latitude: 13.5, longitude: 77.6 } });
    expect(far.status).toBe(400);
  });

  it("IT-BIL-008 PRE_ORDER validation: scheduledFor missing / past / > 30 days → 400; valid → 201", async () => {
    const items = [line(T.items.samosa.id)];
    expect((await cashier.post("/orders", { orderType: "PRE_ORDER", items })).status).toBe(400);
    expect((await cashier.post("/orders", { orderType: "PRE_ORDER", items, scheduledFor: new Date(Date.now() - 60_000).toISOString() })).status).toBe(400);
    expect((await cashier.post("/orders", { orderType: "PRE_ORDER", items, scheduledFor: new Date(Date.now() + 31 * 86_400_000).toISOString() })).status).toBe(400);
    const at = new Date(Date.now() + 2 * 3_600_000).toISOString();
    const ok = await cashier.post("/orders", { orderType: "PRE_ORDER", items, scheduledFor: at });
    expect(ok.status).toBe(201);
    expect(ok.body.scheduledFor).toBe(at);
  });

  it("IT-BIL-009 unknown orderType / empty items / bad phone → 400", async () => {
    expect((await cashier.post("/orders", { orderType: "PARCEL", items: [line(T.items.samosa.id)] })).status).toBe(400);
    expect((await cashier.post("/orders", takeaway([]))).status).toBe(400);
    expect((await cashier.post("/orders", takeaway([line(T.items.samosa.id)], { customerPhone: "12345" }))).status).toBe(400);
    expect((await cashier.post("/orders", takeaway([line(T.items.samosa.id)], { customerPhone: "5876543210" }))).status).toBe(400);
  });
});

describe("Billing — quantity boundaries & menu validation @regression", () => {
  it.each([
    [0, 400],
    [-1, 400],
    [1.5, 400],
    [1000, 400],
  ])("IT-BIL-010 quantity %s → %s", async (q, code) => {
    const r = await cashier.post("/orders", takeaway([line(T.items.samosa.id, q as number)]));
    expect(r.status).toBe(code);
  });

  it("IT-BIL-011 quantity 1 and 999 (upper bound) accepted, total scales", async () => {
    const one = await newBill(takeaway([line(T.items.samosa.id, 1)]));
    const max = await newBill(takeaway([line(T.items.samosa.id, 999)]));
    expect(max.items[0].quantity).toBe(999);
    expect(max.subtotal).toBeGreaterThan(one.subtotal * 900);
  });

  it("IT-BIL-012 HIDDEN, OUT_OF_STOCK and out-of-time-slot items are refused (400)", async () => {
    for (const it of [T.items.hidden, T.items.oos, T.items.offSlot]) {
      const r = await cashier.post("/orders", takeaway([line(it.id)]));
      expect(r.status, it.name).toBe(400);
      expect(r.body.error).toMatch(/not available|only served/);
    }
  });

  it("IT-BIL-013 @critical menuItemId of another business is refused (400, no bill)", async () => {
    const d = await demo();
    const foreign = await db.menuItem.findFirstOrThrow({ where: { businessId: d.businessId } });
    const before = await db.order.count({ where: { outletId: T.outletId } });
    const r = await cashier.post("/orders", takeaway([line(foreign.id)]));
    expect(r.status).toBe(400);
    expect(await db.order.count({ where: { outletId: T.outletId } })).toBe(before);
  });

  it("IT-BIL-014 variant / add-on belonging to another item → 400", async () => {
    const chaiVariant = T.items.chai.variants[0].id;
    const cheese = T.items.sandwich.addons[0].id;
    expect((await cashier.post("/orders", takeaway([line(T.items.samosa.id, 1, { variantId: chaiVariant })]))).status).toBe(400);
    expect((await cashier.post("/orders", takeaway([line(T.items.samosa.id, 1, { addonIds: [cheese] })]))).status).toBe(400);
  });
});

describe("Billing — discounts & loyalty @regression", () => {
  it("IT-BIL-015 manual FLAT discount reduces taxable value", async () => {
    const plain = await newBill({ orderType: "DINE_IN", items: [line(T.items.samosa.id, 4)] });
    const b = await newBill({ orderType: "DINE_IN", items: [line(T.items.samosa.id, 4)], discount: { type: "FLAT", value: 2000 } });
    expect(b.discount).toBeGreaterThan(0);
    expect(b.taxableValue).toBeLessThan(plain.taxableValue);
    expect(b.grandTotal).toBeLessThan(plain.grandTotal);
  });

  it("IT-BIL-016 manual PERCENT discount 10% ≈ 10% off; PERCENT 101 and FLAT -1 → 400", async () => {
    const b = await newBill({ orderType: "DINE_IN", items: [line(T.items.samosa.id, 10)], discount: { type: "PERCENT", value: 10 } });
    expect(b.grandTotal).toBe(31500);
    expect((await cashier.post("/orders", { orderType: "DINE_IN", items: [line(T.items.samosa.id)], discount: { type: "PERCENT", value: 101 } })).status).toBe(400);
    expect((await cashier.post("/orders", { orderType: "DINE_IN", items: [line(T.items.samosa.id)], discount: { type: "FLAT", value: -1 } })).status).toBe(400);
  });

  it("IT-BIL-017 @critical loyalty points redeemed on top of a manual discount; balance debited; reversal on cancel", async () => {
    const ph = phone();
    const first = await newBill(takeaway([line(T.items.samosa.id)], { customerPhone: ph, customerName: "Loyal" }));
    await db.customer.update({ where: { id: first.customerId }, data: { points: 400 } });
    const b = await newBill({
      orderType: "DINE_IN", customerPhone: ph, items: [line(T.items.biryani.id, 2)],
      discount: { type: "PERCENT", value: 10 }, redeemPoints: 100,
    });
    expect(b.pointsRedeemed).toBe(100);
    expect(b.appliedOffers.some((a: { kind: string }) => a.kind === "POINTS")).toBe(true);
    expect((await db.customer.findUniqueOrThrow({ where: { id: first.customerId } })).points).toBe(300);
    const cancel = await manager.post(`/orders/${b.id}/cancel`, { reason: "customer left" });
    expect(cancel.status).toBe(200);
    expect((await db.customer.findUniqueOrThrow({ where: { id: first.customerId } })).points).toBe(400);
  });

  it("IT-BIL-018 redeeming points without a phone or above the balance → 400", async () => {
    expect((await cashier.post("/orders", { orderType: "DINE_IN", items: [line(T.items.biryani.id)], redeemPoints: 100 })).status).toBe(400);
    const r = await cashier.post("/orders", { orderType: "DINE_IN", items: [line(T.items.biryani.id)], redeemPoints: 999999, customerPhone: phone() });
    expect(r.status).toBe(400);
  });

  it.fails("IT-BIL-019 @critical (BUG-CANDIDATE-C1) a 100%-discount bill (grand total ₹0) can be settled — it must not stay OPEN forever", async () => {
    const b = await newBill({ orderType: "DINE_IN", items: [line(T.items.samosa.id)], discount: { type: "PERCENT", value: 100 } });
    expect(b.grandTotal).toBe(0);
    // Expected: zero bill auto-settled (PAID) at creation, or some way to settle it.
    // Actual: status OPEN; any payment → 400 "exceeds balance ₹0.00" (amount must be > 0), so it is stuck OPEN.
    const pay = await cashier.post(`/orders/${b.id}/payments`, { payments: [{ mode: "CASH", amount: 1 }] });
    const after = await cashier.get(`/orders/${b.id}`);
    expect(pay.status === 200 || after.body.status === "PAID").toBe(true);
    expect(after.body.status).toBe("PAID");
  });
});

describe("Billing — payments @regression @critical", () => {
  it("IT-BIL-020 @critical CASH + UPI + CARD summing to the total → PAID", async () => {
    const b = await newBill(takeaway([line(T.items.biryani.id, 1)]));
    const third = Math.floor(b.grandTotal / 3);
    const r = await cashier.post(`/orders/${b.id}/payments`, {
      payments: [
        { mode: "CASH", amount: third },
        { mode: "UPI", amount: third, reference: "UTR1" },
        { mode: "CARD", amount: b.grandTotal - 2 * third },
      ],
    });
    expect(r.status).toBe(200);
    expect(r.body.paid).toBe(true);
    expect(r.body.balance).toBe(0);
    expect(r.body.order.status).toBe("PAID");
    expect(r.body.order.paidAt).toBeTruthy();
    expect(await auditCount(b.id, "payment.collect")).toBe(1);
  });

  it("IT-BIL-021 @critical partial payment leaves the bill OPEN with the right balance", async () => {
    const b = await newBill();
    const r = await cashier.post(`/orders/${b.id}/payments`, { payments: [{ mode: "CASH", amount: 2500 }] });
    expect(r.body.paid).toBe(false);
    expect(r.body.balance).toBe(b.grandTotal - 2500);
    const g = await cashier.get(`/orders/${b.id}`);
    expect(g.body.status).toBe("OPEN");
    expect(g.body.amountPaid).toBe(2500);
    expect(g.body.balance).toBe(b.grandTotal - 2500);
    const ps = await cashier.get(`/orders/${b.id}/payment-status`);
    expect(ps.body.balance).toBe(b.grandTotal - 2500);
  });

  it("IT-BIL-022 @critical overpayment → 400 (total and after a partial payment), nothing recorded", async () => {
    const b = await newBill();
    expect((await cashier.post(`/orders/${b.id}/payments`, { payments: [{ mode: "CASH", amount: b.grandTotal + 1 }] })).status).toBe(400);
    await cashier.post(`/orders/${b.id}/payments`, { payments: [{ mode: "CASH", amount: 1000 }] });
    const r = await cashier.post(`/orders/${b.id}/payments`, { payments: [{ mode: "UPI", amount: b.grandTotal - 1000 + 1 }] });
    expect(r.status).toBe(400);
    expect(await db.payment.count({ where: { orderId: b.id } })).toBe(1);
  });

  it.each([
    ["zero", [{ mode: "CASH", amount: 0 }]],
    ["negative", [{ mode: "CASH", amount: -100 }]],
    ["fractional paise", [{ mode: "CASH", amount: 10.5 }]],
    ["unknown mode", [{ mode: "CHEQUE", amount: 100 }]],
    ["empty list", []],
  ])("IT-BIL-023 payment with %s amount/mode → 400", async (_n, payments) => {
    const b = await newBill();
    const r = await cashier.post(`/orders/${b.id}/payments`, { payments });
    expect(r.status).toBe(400);
  });

  it("IT-BIL-024 cash tendered < cash part → 400; otherwise change = tendered − cash", async () => {
    const b = await newBill();
    expect((await cashier.post(`/orders/${b.id}/payments`, { payments: [{ mode: "CASH", amount: b.grandTotal }], tendered: b.grandTotal - 1 })).status).toBe(400);
    const r = await cashier.post(`/orders/${b.id}/payments`, { payments: [{ mode: "CASH", amount: b.grandTotal }], tendered: 10000 });
    expect(r.status).toBe(200);
    expect(r.body.change).toBe(10000 - b.grandTotal);
  });

  it("IT-BIL-025 @critical KHATA needs a customer phone; with phone it debits the customer's khata", async () => {
    const b = await newBill();
    const r = await cashier.post(`/orders/${b.id}/payments`, { payments: [{ mode: "KHATA", amount: b.grandTotal }] });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/phone/i);
    const k = await newBill(takeaway([line(T.items.samosa.id, 2)], { customerPhone: phone(), customerName: "Credit" }));
    const ok = await cashier.post(`/orders/${k.id}/payments`, { payments: [{ mode: "KHATA", amount: k.grandTotal }] });
    expect(ok.status).toBe(200);
    expect(ok.body.paid).toBe(true);
    const c = await db.customer.findUniqueOrThrow({ where: { id: ok.body.order.customerId ?? k.customerId } });
    expect(c.khataBalance).toBe(k.grandTotal);
  });

  it("IT-BIL-026 @critical UPI QR (mock) for the balance + dev-simulate → PAID", async () => {
    const b = await newBill();
    const qr = await cashier.post(`/orders/${b.id}/upi-qr`, {});
    expect(qr.status).toBe(201);
    expect(qr.body.mock).toBe(true);
    expect(qr.body.amount).toBe(b.grandTotal);
    expect(qr.body.qrPayload).toMatch(/^upi:\/\/pay\?/);
    expect(qr.body.qrPayload).toMatch(/itc(@|%40)okaxis/);
    const sim = await cashier.post(`/orders/${b.id}/payments/${qr.body.paymentId}/dev-simulate`, {});
    expect(sim.status).toBe(200);
    expect(sim.body.paid).toBe(true);
    expect((await cashier.get(`/orders/${b.id}`)).body.status).toBe("PAID");
  });

  it("IT-BIL-027 a second UPI QR invalidates the first; QR amount 0 or > balance → 400", async () => {
    const b = await newBill();
    const q1 = await cashier.post(`/orders/${b.id}/upi-qr`, { amount: 1000 });
    const q2 = await cashier.post(`/orders/${b.id}/upi-qr`, {});
    expect(q2.status).toBe(201);
    expect((await db.payment.findUniqueOrThrow({ where: { id: q1.body.paymentId } })).status).toBe("FAILED");
    expect((await cashier.post(`/orders/${b.id}/upi-qr`, { amount: 0 })).status).toBe(400);
    expect((await cashier.post(`/orders/${b.id}/upi-qr`, { amount: b.grandTotal + 1 })).status).toBe(400);
    expect((await cashier.post(`/orders/${b.id}/payments/${q1.body.paymentId}/dev-simulate`, {})).status).toBe(404);
  });

  it("IT-BIL-028 @critical paying / QR on a PAID or CANCELLED bill → 409", async () => {
    const paid = await newBill();
    await cashier.post(`/orders/${paid.id}/payments`, { payments: [{ mode: "CASH", amount: paid.grandTotal }] });
    expect((await cashier.post(`/orders/${paid.id}/payments`, { payments: [{ mode: "CASH", amount: 100 }] })).status).toBe(409);
    expect((await cashier.post(`/orders/${paid.id}/upi-qr`, {})).status).toBe(409);
    const cancelled = await newBill();
    await manager.post(`/orders/${cancelled.id}/cancel`, { reason: "wrong order" });
    expect((await cashier.post(`/orders/${cancelled.id}/payments`, { payments: [{ mode: "CASH", amount: 100 }] })).status).toBe(409);
  });

  it.fails("IT-BIL-029 @critical (BUG-CANDIDATE-C2) a pending UPI QR cannot be confirmed after the bill was fully paid in cash (no double collection)", async () => {
    const b = await newBill();
    const qr = await cashier.post(`/orders/${b.id}/upi-qr`, {});
    const cash = await cashier.post(`/orders/${b.id}/payments`, { payments: [{ mode: "CASH", amount: b.grandTotal }] });
    expect(cash.body.paid).toBe(true);
    // Expected: settling the bill voids the pending QR, or confirm → 409.
    // Actual: QR stays PENDING; confirm → 200 and amountPaid = 2 × grandTotal.
    const confirm = await cashier.post(`/orders/${b.id}/payments/${qr.body.paymentId}/confirm`, { reference: "UTR" });
    expect(confirm.status).toBe(409);
    const st = await cashier.get(`/orders/${b.id}/payment-status`);
    expect(st.body.amountPaid).toBe(b.grandTotal);
  });

  it.fails("IT-BIL-030 @critical (BUG-CANDIDATE-C2) a pending UPI QR on a CANCELLED bill cannot be confirmed", async () => {
    const b = await newBill();
    const qr = await cashier.post(`/orders/${b.id}/upi-qr`, {});
    await manager.post(`/orders/${b.id}/cancel`, { reason: "customer left" });
    // Actual: 200 {paid:false} and a SUCCESS payment is recorded on a cancelled bill.
    const confirm = await cashier.post(`/orders/${b.id}/payments/${qr.body.paymentId}/confirm`, {});
    expect(confirm.status).toBe(409);
  });

  it("IT-BIL-031 COD toggle on a non-delivery bill → 400", async () => {
    const b = await newBill();
    expect((await cashier.post(`/orders/${b.id}/cod`, { cod: true })).status).toBe(400);
  });
});

describe("Billing — cancellation @regression", () => {
  it("IT-BIL-032 cashier lacks order:cancel → 403; reason < 3 chars → 400", async () => {
    const b = await newBill();
    expect((await cashier.post(`/orders/${b.id}/cancel`, { reason: "mistake" })).status).toBe(403);
    expect((await manager.post(`/orders/${b.id}/cancel`, { reason: "no" })).status).toBe(400);
    expect((await manager.post(`/orders/${b.id}/cancel`, {})).status).toBe(400);
  });

  it("IT-BIL-033 manager cancels: CANCELLED with reason, audit written, second cancel → 409", async () => {
    const b = await newBill();
    const r = await manager.post(`/orders/${b.id}/cancel`, { reason: "duplicate bill" });
    expect(r.status).toBe(200);
    expect(r.body.status).toBe("CANCELLED");
    expect(r.body.cancelReason).toBe("duplicate bill");
    expect(r.body.cancelledAt).toBeTruthy();
    expect(await auditCount(b.id, "order.cancel")).toBe(1);
    expect((await manager.post(`/orders/${b.id}/cancel`, { reason: "again please" })).status).toBe(409);
  });

  it("IT-BIL-034 @critical cancelling a PAID bill: allowed, audit records wasPaid, earned points reversed; payments are left as SUCCESS (no refund record)", async () => {
    const ph = phone();
    const b = await newBill(takeaway([line(T.items.biryani.id, 3)], { customerPhone: ph }));
    await cashier.post(`/orders/${b.id}/payments`, { payments: [{ mode: "CASH", amount: b.grandTotal }] });
    const cust = await db.customer.findUniqueOrThrow({ where: { id: b.customerId } });
    expect(cust.points).toBeGreaterThan(0);
    const r = await owner.post(`/orders/${b.id}/cancel`, { reason: "food quality" });
    expect(r.status).toBe(200);
    const log = await db.auditLog.findFirstOrThrow({ where: { entityId: b.id, action: "order.cancel" } });
    expect((log.meta as { wasPaid: boolean }).wasPaid).toBe(true);
    expect((await db.customer.findUniqueOrThrow({ where: { id: cust.id } })).points).toBe(0);
    const txns = await db.loyaltyTransaction.findMany({ where: { orderId: b.id, type: "REVERSE" } });
    expect(txns.length).toBe(1);
    // Observation (documented behaviour): payments stay SUCCESS; there is no refund entity.
    const pays = await db.payment.findMany({ where: { orderId: b.id } });
    expect(pays.every((p) => p.status === "SUCCESS")).toBe(true);
  });

  it("IT-BIL-035 @critical cancelling a bill returns coupon usage and khata debit", async () => {
    const coupon = await db.coupon.create({ data: { businessId: T.businessId, code: `ITC${Date.now() % 100000}`, discountType: "FLAT", value: 1000 } });
    const ph = phone();
    const b = await newBill({ orderType: "DINE_IN", items: [line(T.items.biryani.id)], couponCode: coupon.code, customerPhone: ph });
    expect(b.couponCode).toBe(coupon.code);
    expect((await db.coupon.findUniqueOrThrow({ where: { id: coupon.id } })).usedCount).toBe(1);
    await cashier.post(`/orders/${b.id}/payments`, { payments: [{ mode: "KHATA", amount: b.grandTotal }] });
    await manager.post(`/orders/${b.id}/cancel`, { reason: "billing error" });
    expect((await db.coupon.findUniqueOrThrow({ where: { id: coupon.id } })).usedCount).toBe(0);
    expect(await db.couponRedemption.count({ where: { orderId: b.id } })).toBe(0);
    expect((await db.customer.findUniqueOrThrow({ where: { id: b.customerId } })).khataBalance).toBe(0);
  });

  it("IT-BIL-036 @critical cancelling a bill restores recipe stock (demo item with a recipe)", async () => {
    const d = await demo();
    const recipe = await db.recipe.findFirst({ where: { menuItem: { businessId: d.businessId, status: "AVAILABLE", availableFrom: null }, variantId: null } });
    if (!recipe) return expect.fail("demo seed has no recipe");
    const c = await d.as("cashier");
    const m = await d.as("manager");
    const b = await c.post("/orders", { orderType: "DINE_IN", items: [{ menuItemId: recipe.menuItemId, quantity: 2 }] });
    expect(b.status, JSON.stringify(b.body)).toBe(201);
    const sale = await db.inventoryTransaction.findMany({ where: { refId: b.body.id, type: "SALE" } });
    expect(sale.length).toBeGreaterThan(0);
    await m.post(`/orders/${b.body.id}/cancel`, { reason: "test reversal" });
    const rev = await db.inventoryTransaction.findMany({ where: { refId: b.body.id, type: "SALE_REVERSAL" } });
    const sum = (xs: { quantity: number }[]) => xs.reduce((s, x) => s + x.quantity, 0);
    expect(Math.abs(sum(sale) + sum(rev))).toBeLessThan(1e-6);
  });
});

describe("Billing — bill history @regression", () => {
  let H: MenuTenant;
  let hc: Agent;
  const ph = phone();
  beforeAll(async () => {
    H = await menuTenant();
    hc = await H.as("CASHIER");
    const a = await hc.post("/orders", { orderType: "TAKEAWAY", items: [line(H.items.samosa.id)], customerPhone: ph, customerName: "Zubin Mehta" });
    await hc.post("/orders", { orderType: "TAKEAWAY", items: [line(H.items.samosa.id)] });
    const c = await hc.post("/orders", { orderType: "TAKEAWAY", items: [line(H.items.samosa.id)] });
    await hc.post(`/orders/${a.body.id}/payments`, { payments: [{ mode: "CASH", amount: a.body.grandTotal }] });
    await (await H.as("OUTLET_MANAGER")).post(`/orders/${c.body.id}/cancel`, { reason: "test cancel" });
  });

  it("IT-BIL-037 status filter returns only that status", async () => {
    for (const [s, n] of [["PAID", 1], ["OPEN", 1], ["CANCELLED", 1]] as const) {
      const r = await hc.get(`/orders?status=${s}`);
      expect(r.status).toBe(200);
      expect(r.body.length).toBe(n);
      expect(r.body.every((o: { status: string }) => o.status === s)).toBe(true);
    }
    expect((await hc.get("/orders?status=VOID")).status).toBe(400);
  });

  it("IT-BIL-038 search by invoice number, phone and (case-insensitive) customer name", async () => {
    const all = (await hc.get("/orders")).body;
    expect(all.length).toBe(3);
    const inv = all[0].invoiceNumber;
    expect((await hc.get(`/orders?search=${inv}`)).body.map((o: { invoiceNumber: string }) => o.invoiceNumber)).toEqual([inv]);
    expect((await hc.get(`/orders?search=${ph}`)).body.length).toBe(1);
    expect((await hc.get(`/orders?search=zubin`)).body.length).toBe(1);
    expect((await hc.get(`/orders?search=nomatch-xyz`)).body.length).toBe(0);
  });

  it("IT-BIL-039 date filter uses the IST day; bad date format → 400", async () => {
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
    expect((await hc.get(`/orders?date=${today}`)).body.length).toBe(3);
    expect((await hc.get(`/orders?date=2001-01-01`)).body.length).toBe(0);
    expect((await hc.get(`/orders?date=02-11-2026`)).status).toBe(400);
  });

  it.each([
    ["0", 400],
    ["1", 200],
    ["200", 200],
    ["201", 400],
    ["abc", 400],
  ])("IT-BIL-040 limit=%s → %s", async (limit, code) => {
    const r = await hc.get(`/orders?limit=${limit}`);
    expect(r.status).toBe(code);
    if (limit === "1") expect(r.body.length).toBe(1);
  });

  it("IT-BIL-041 @critical GET /orders/:id of another tenant's bill → 404; unknown id → 404", async () => {
    const other = await newBill();
    expect((await hc.get(`/orders/${other.id}`)).status).toBe(404);
    expect((await hc.get(`/orders/${other.id}/receipt`)).status).toBe(404);
    expect((await hc.get(`/orders/does-not-exist`)).status).toBe(404);
    const list = (await hc.get("/orders?limit=200")).body;
    expect(list.some((o: { id: string }) => o.id === other.id)).toBe(false);
  });

  it("IT-BIL-042 kitchen role cannot view bills history (403)", async () => {
    expect((await (await H.as("KITCHEN")).get("/orders")).status).toBe(403);
  });
});

describe("Billing — receipts @regression", () => {
  let bill: { id: string; invoiceNumber: string; grandTotal: number };
  beforeAll(async () => {
    bill = await newBill(takeaway([line(T.items.samosa.id, 2)], { customerName: "Rcpt" }));
  });

  it("IT-BIL-043 receipt JSON has outlet, items, totals and a public link", async () => {
    const r = await cashier.get(`/orders/${bill.id}/receipt`);
    expect(r.status).toBe(200);
    expect(r.body.invoiceNumber).toBe(bill.invoiceNumber);
    expect(r.body.grandTotal).toBe(bill.grandTotal);
    expect(r.body.items[0].quantity).toBe(2);
    expect(r.body.publicUrl).toMatch(/\/public\/receipts\/[\w-]+\.[\w-]+\.[\w-]+$/);
  });

  it("IT-BIL-044 receipt text (58/80 mm) contains invoice number", async () => {
    const t58 = await cashier.get(`/orders/${bill.id}/receipt?format=text`);
    expect(t58.headers["content-type"]).toMatch(/text\/plain/);
    expect(t58.text).toContain(bill.invoiceNumber);
    const t80 = await cashier.get(`/orders/${bill.id}/receipt?format=text&paper=80`);
    expect(Math.max(...t80.text.split("\n").map((l) => l.length))).toBeGreaterThan(Math.max(...t58.text.split("\n").map((l) => l.length)));
  });

  it("IT-BIL-045 receipt.pdf is application/pdf", async () => {
    const r = await cashier.get(`/orders/${bill.id}/receipt.pdf`).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () => cb(null, Buffer.concat(chunks)));
    });
    expect(r.status).toBe(200);
    expect(r.headers["content-type"]).toMatch(/application\/pdf/);
    expect((r.body as Buffer).subarray(0, 4).toString()).toBe("%PDF");
  });

  it("IT-BIL-046 WhatsApp share returns a wa.me link, stores phone, audits; bad phone → 400", async () => {
    const ph = phone();
    const r = await cashier.post(`/orders/${bill.id}/share/whatsapp`, { phone: ph });
    expect(r.status).toBe(200);
    expect(r.body.method).toBe("link");
    expect(r.body.waLink).toMatch(new RegExp(`^https://wa\\.me/91${ph}\\?text=`));
    expect(decodeURIComponent(r.body.waLink)).toContain(bill.invoiceNumber);
    expect(await auditCount(bill.id, "receipt.share")).toBeGreaterThanOrEqual(1);
    expect((await cashier.post(`/orders/${bill.id}/share/whatsapp`, { phone: "123" })).status).toBe(400);
  });

  it("IT-BIL-047 @critical public signed receipt link works without login; tampered / garbage token → 404", async () => {
    const url: string = (await cashier.get(`/orders/${bill.id}/receipt`)).body.publicUrl;
    const token = url.split("/public/receipts/")[1];
    const ok = await request(app).get(`/public/receipts/${token}`);
    expect(ok.status).toBe(200);
    expect(ok.headers["content-type"]).toMatch(/application\/pdf/);
    const [h, p, s] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ oid: "someone-else", iat: 1 })).toString("base64url");
    expect((await request(app).get(`/public/receipts/${h}.${forged}.${s}`)).status).toBe(404);
    expect((await request(app).get(`/public/receipts/${h}.${p}.${s.slice(0, -2)}xx`)).status).toBe(404);
    expect((await request(app).get(`/public/receipts/not-a-token`)).status).toBe(404);
  });
});

describe("Billing — invoice numbering, idempotency & sync @regression", () => {
  it("IT-BIL-048 @critical 20 bills on a fresh outlet get consecutive invoice numbers 1..20 (no gaps / duplicates)", async () => {
    const N = await menuTenant();
    const c = await N.as("CASHIER");
    const nums: number[] = [];
    for (let i = 0; i < 20; i++) {
      const r = await c.post("/orders", { orderType: "DINE_IN", items: [line(N.items.samosa.id)] });
      expect(r.status).toBe(201);
      nums.push(Number(r.body.invoiceNumber.split("-")[2]));
    }
    expect(nums).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    // Cancelling keeps the number (no reuse)
    await (await N.as("OUTLET_MANAGER")).post(`/orders/${(await c.get("/orders?limit=1")).body[0].id}/cancel`, { reason: "gap check" });
    const next = await c.post("/orders", { orderType: "DINE_IN", items: [line(N.items.samosa.id)] });
    expect(Number(next.body.invoiceNumber.split("-")[2])).toBe(21);
  });

  it("IT-BIL-049 @critical same clientOrderId twice → 200 with the same bill (no second invoice)", async () => {
    const id = randomUUID();
    const body = takeaway([line(T.items.samosa.id)], { clientOrderId: id });
    const a = await cashier.post("/orders", body);
    const b = await cashier.post("/orders", body);
    expect(a.status).toBe(201);
    expect(b.status).toBe(200);
    expect(b.body.id).toBe(a.body.id);
    expect(await db.order.count({ where: { clientOrderId: id } })).toBe(1);
  });

  it("IT-BIL-050 same clientOrderId with a DIFFERENT body → 200 returning the ORIGINAL bill unchanged (body silently ignored)", async () => {
    const id = randomUUID();
    const a = await cashier.post("/orders", takeaway([line(T.items.samosa.id)], { clientOrderId: id }));
    const b = await cashier.post("/orders", takeaway([line(T.items.biryani.id, 5)], { clientOrderId: id }));
    expect(b.status).toBe(200);
    expect(b.body.id).toBe(a.body.id);
    expect(b.body.grandTotal).toBe(a.body.grandTotal);
  });

  it("IT-BIL-051 clientOrderId already used by another business → 400 (no leak of the other bill)", async () => {
    const id = randomUUID();
    await cashier.post("/orders", takeaway([line(T.items.samosa.id)], { clientOrderId: id }));
    const N = await menuTenant();
    const r = await (await N.as("CASHIER")).post("/orders", { orderType: "TAKEAWAY", clientOrderId: id, items: [line(N.items.samosa.id)] });
    expect(r.status).toBe(400);
    expect(r.body.id).toBeUndefined();
  });

  it("IT-BIL-052 /orders/sync accepts 200 entries and rejects 201 (400)", async () => {
    const bad = (k: number) => Array.from({ length: k }, () => ({ orderType: "TAKEAWAY", items: [] }));
    const ok = await cashier.post("/orders/sync", { orders: bad(200) });
    expect(ok.status).toBe(200);
    expect(ok.body.results).toHaveLength(200);
    expect(ok.body.results.every((r: { ok: boolean }) => !r.ok)).toBe(true);
    expect((await cashier.post("/orders/sync", { orders: bad(201) })).status).toBe(400);
  });

  it("IT-BIL-053 @critical /orders/sync mixed batch: per-item results; retry reports duplicates", async () => {
    const good1 = randomUUID();
    const good2 = randomUUID();
    const orders = [
      takeaway([line(T.items.samosa.id)], { clientOrderId: good1, createdAt: new Date(Date.now() - 600_000).toISOString() }),
      takeaway([line(T.items.samosa.id)]), // missing clientOrderId
      takeaway([line("nope")], { clientOrderId: randomUUID() }), // unknown item
      { orderType: "TAKEAWAY", clientOrderId: "not-a-uuid", items: [line(T.items.samosa.id)] },
      takeaway([line(T.items.oos.id)], { clientOrderId: good2, createdAt: new Date(Date.now() - 600_000).toISOString() }), // offline: availability not re-checked
    ];
    const r = await cashier.post("/orders/sync", { orders });
    expect(r.status).toBe(200);
    expect(r.body.results.map((x: { ok: boolean }) => x.ok)).toEqual([true, false, false, false, true]);
    expect(r.body.results[2].error).toMatch(/Unknown menu item/);
    const again = await cashier.post("/orders/sync", { orders: [orders[0]] });
    expect(again.body.results[0]).toMatchObject({ ok: true, duplicate: true, orderId: r.body.results[0].orderId });
    expect((await db.order.findUniqueOrThrow({ where: { id: r.body.results[0].orderId } })).syncedOffline).toBe(true);
  });

  it("IT-BIL-054 sync without orders array → 400", async () => {
    expect((await cashier.post("/orders/sync", {})).status).toBe(400);
  });
});

describe("Billing — module & permission gates @regression", () => {
  it("IT-BIL-055 business without BILLING module → /orders 403", async () => {
    const t = await menuTenant({ modules: ["ATTENDANCE"] });
    const c = await agentFor(t.users.BUSINESS_OWNER.email, t.outletId);
    expect((await c.post("/orders", takeaway([line(t.items.samosa.id)]))).status).toBe(403);
  });

  it("IT-BIL-056 PRE_ORDER refused when RESERVATIONS module is off; DELIVERY refused when DELIVERY is off", async () => {
    const t = await menuTenant({ modules: ["BILLING"] });
    const c = await t.as("CASHIER");
    const pre = await c.post("/orders", { orderType: "PRE_ORDER", scheduledFor: new Date(Date.now() + 7_200_000).toISOString(), items: [line(t.items.samosa.id)] });
    expect(pre.status).toBe(400);
    const del = await c.post("/orders", { orderType: "DELIVERY", customerName: "A", customerPhone: phone(), delivery: { address: "12 Main road" }, items: [line(t.items.samosa.id)] });
    expect(del.status).toBe(400);
    expect((await c.post("/orders", takeaway([line(t.items.samosa.id)]))).status).toBe(201);
  });
});
