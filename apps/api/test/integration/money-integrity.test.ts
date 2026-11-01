/** Phase 3.1 + 3.3 — credit notes (refunds) and manager approval PINs, exceptions report, GSTR-1 netting. */
import bcrypt from "bcryptjs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHotel, db, login, startServer, type Client, type Hotel } from "./helpers";

let srv: Awaited<ReturnType<typeof startServer>>;
let h: Hotel;
let cashier: Client, manager: Client;

beforeAll(async () => {
  srv = await startServer();
  h = await createHotel("Money", { gst: true });
  await db.user.update({ where: { id: h.users.manager.id }, data: { pinHash: await bcrypt.hash("2468", 4) } });
  // Real 5% GST on the food, so tax reversal is actually exercised.
  const gst5 = await db.taxRate.findFirstOrThrow({ where: { businessId: h.businessId, cgst: 2.5, sgst: 2.5 } });
  await db.menuItem.updateMany({ where: { id: { in: Object.values(h.items) } }, data: { taxRateId: gst5.id } });
  cashier = await login(srv.base, h.users.cashier.email, h.outletId);
  manager = await login(srv.base, h.users.manager.email, h.outletId);
});
afterAll(() => srv.close());
beforeEach(async () => {
  await db.business.update({ where: { id: h.businessId }, data: { features: {} } });
  await db.user.update({ where: { id: h.users.manager.id }, data: { pinFailedAttempts: 0, pinLockedUntil: null } });
});

async function paidBill(c: Client, items: { menuItemId: string; quantity: number }[], extra: Record<string, unknown> = {}) {
  const o = await c.call("POST", "/orders", { orderType: "TAKEAWAY", items, ...extra });
  expect(o.status, JSON.stringify(o.body)).toBe(201);
  const pay = await c.call("POST", `/orders/${o.body.id}/payments`, { payments: [{ mode: "CASH", amount: o.body.grandTotal }] });
  expect(pay.status).toBe(200);
  return o.body as { id: string; grandTotal: number; items: { id: string; quantity: number; total: number; cgst: number; sgst: number }[] };
}

describe("credit notes (refunds)", () => {
  it("refunds some items with tax reversed proportionally, numbered in its own series", async () => {
    const bill = await paidBill(manager, [{ menuItemId: h.items.samosa, quantity: 4 }, { menuItemId: h.items.chai, quantity: 2 }]);
    const samosa = bill.items.find((i) => i.quantity === 4)!;
    const r = await manager.call("POST", `/orders/${bill.id}/refunds`, { reason: "QUALITY", refundMode: "CASH", items: [{ orderItemId: samosa.id, quantity: 1 }] });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.number).toMatch(/^CNINV-\d{4}-00001$/);
    expect(r.body.amount).toBe(Math.round(samosa.total / 4));
    expect(samosa.cgst).toBeGreaterThan(0);
    expect(r.body.cgst).toBe(Math.round(samosa.cgst / 4));
    // Can't refund more than was sold.
    expect((await manager.call("POST", `/orders/${bill.id}/refunds`, { reason: "QUALITY", refundMode: "CASH", items: [{ orderItemId: samosa.id, quantity: 4 }] })).status).toBe(400);
  });

  it("refunding everything left returns exactly the bill total (no paise lost to rounding) and blocks a later void", async () => {
    const bill = await paidBill(manager, [{ menuItemId: h.items.samosa, quantity: 3 }]);
    const line = bill.items[0]!;
    for (let i = 0; i < 3; i++) {
      expect((await manager.call("POST", `/orders/${bill.id}/refunds`, { reason: "WRONG_ITEM", refundMode: "UPI", items: [{ orderItemId: line.id, quantity: 1 }] })).status).toBe(201);
    }
    const notes = (await manager.call("GET", `/orders/${bill.id}/credit-notes`)).body as { amount: number }[];
    expect(notes.reduce((s, n) => s + n.amount, 0)).toBe(bill.grandTotal);
    expect((await manager.call("POST", `/orders/${bill.id}/refunds`, { reason: "OVERCHARGED", refundMode: "CASH", amount: 100 })).status).toBe(409);
    expect((await manager.call("POST", `/orders/${bill.id}/cancel`, { reason: "test void" })).status).toBe(409);
  });

  it("a value-only credit can't exceed what's left; unpaid bills can't be refunded", async () => {
    const bill = await paidBill(manager, [{ menuItemId: h.items.biryani, quantity: 1 }]);
    expect((await manager.call("POST", `/orders/${bill.id}/refunds`, { reason: "OVERCHARGED", refundMode: "CASH", amount: bill.grandTotal + 1 })).status).toBe(400);
    const v = await manager.call("POST", `/orders/${bill.id}/refunds`, { reason: "OVERCHARGED", refundMode: "CASH", amount: 2000 });
    expect(v.body.amount).toBe(2000);
    expect(v.body.cgst).toBeGreaterThan(0);
    expect(v.body.taxableValue + v.body.cgst + v.body.sgst + v.body.igst).toBe(2000);
    const open = await manager.call("POST", "/orders", { orderType: "TAKEAWAY", items: [{ menuItemId: h.items.chai, quantity: 1 }] });
    expect((await manager.call("POST", `/orders/${open.body.id}/refunds`, { reason: "OTHER", note: "test", refundMode: "CASH", amount: 100 })).status).toBe(409);
  });

  it("without approvals, a cashier can't refund or void (unchanged)", async () => {
    const bill = await paidBill(cashier, [{ menuItemId: h.items.chai, quantity: 1 }]);
    expect((await cashier.call("POST", `/orders/${bill.id}/refunds`, { reason: "QUALITY", refundMode: "CASH", amount: 100 })).status).toBe(403);
  });
});

describe("manager approval PINs (APPROVAL_PINS)", () => {
  beforeEach(async () => {
    await db.business.update({ where: { id: h.businessId }, data: { features: { APPROVAL_PINS: true } } });
  });

  it("lists approvers with a PIN", async () => {
    const r = (await cashier.call("GET", "/orders/approvers")).body;
    expect(r.enabled).toBe(true);
    expect(r.discountLimitPercent).toBe(10);
    expect(r.approvers.map((a: { id: string }) => a.id)).toContain(h.users.manager.id);
  });

  it("a big discount needs a manager PIN; a small one doesn't", async () => {
    const items = [{ menuItemId: h.items.biryani, quantity: 1 }];
    expect((await cashier.call("POST", "/orders", { orderType: "TAKEAWAY", items, discount: { type: "PERCENT", value: 5 } })).status).toBe(201);
    const blocked = await cashier.call("POST", "/orders", { orderType: "TAKEAWAY", items, discount: { type: "PERCENT", value: 30 } });
    expect(blocked.status).toBe(403);
    expect(blocked.body.details.code).toBe("APPROVAL_REQUIRED");
    const wrong = await cashier.call("POST", "/orders", { orderType: "TAKEAWAY", items, discount: { type: "PERCENT", value: 30 }, approval: { approverId: h.users.manager.id, pin: "1111" } });
    expect(wrong.status).toBe(403);
    const ok = await cashier.call("POST", "/orders", { orderType: "TAKEAWAY", items, discount: { type: "PERCENT", value: 30 }, approval: { approverId: h.users.manager.id, pin: "2468" } });
    expect(ok.status).toBe(201);
    const log = await db.approvalLog.findFirstOrThrow({ where: { orderId: ok.body.id } });
    expect(log).toMatchObject({ action: "DISCOUNT", requestedById: h.users.cashier.id, approvedById: h.users.manager.id });
  });

  it("a cashier can void or refund with a manager's PIN; a cashier can't approve", async () => {
    const bill = await paidBill(cashier, [{ menuItemId: h.items.samosa, quantity: 2 }]);
    expect((await cashier.call("POST", `/orders/${bill.id}/refunds`, { reason: "QUALITY", refundMode: "CASH", amount: 500 })).body.details.code).toBe("APPROVAL_REQUIRED");
    const asCashierApprover = await cashier.call("POST", `/orders/${bill.id}/refunds`, { reason: "QUALITY", refundMode: "CASH", amount: 500, approval: { approverId: h.users.cashier.id, pin: "2468" } });
    expect(asCashierApprover.body.details.code).toBe("APPROVER_INVALID");
    const r = await cashier.call("POST", `/orders/${bill.id}/refunds`, { reason: "QUALITY", refundMode: "CASH", amount: 500, approval: { approverId: h.users.manager.id, pin: "2468" } });
    expect(r.status).toBe(201);
    expect(r.body.approvedById).toBe(h.users.manager.id);

    const open = await cashier.call("POST", "/orders", { orderType: "TAKEAWAY", items: [{ menuItemId: h.items.chai, quantity: 1 }] });
    expect((await cashier.call("POST", `/orders/${open.body.id}/cancel`, { reason: "customer left" })).status).toBe(403);
    expect((await cashier.call("POST", `/orders/${open.body.id}/cancel`, { reason: "customer left", approval: { approverId: h.users.manager.id, pin: "2468" } })).status).toBe(200);
  });

  it("5 wrong approval PINs lock the manager's PIN", async () => {
    const items = [{ menuItemId: h.items.biryani, quantity: 1 }];
    for (let i = 0; i < 5; i++) await cashier.call("POST", "/orders", { orderType: "TAKEAWAY", items, discount: { type: "PERCENT", value: 50 }, approval: { approverId: h.users.manager.id, pin: "0000" } });
    const r = await cashier.call("POST", "/orders", { orderType: "TAKEAWAY", items, discount: { type: "PERCENT", value: 50 }, approval: { approverId: h.users.manager.id, pin: "2468" } });
    expect(r.status).toBe(423);
  });

  it("an offline bill with a big discount is accepted but flagged unapproved", async () => {
    const r = await cashier.call("POST", "/orders", {
      orderType: "TAKEAWAY", items: [{ menuItemId: h.items.biryani, quantity: 1 }], discount: { type: "PERCENT", value: 40 },
      clientOrderId: crypto.randomUUID(), createdAt: new Date(Date.now() - 60_000).toISOString(),
    });
    expect(r.status).toBe(201);
    expect(await db.approvalLog.findFirst({ where: { orderId: r.body.id, approvedById: null } })).toBeTruthy();
  });
});

describe("reports", () => {
  it("the exceptions report lists voids, refunds, big discounts and approvals", async () => {
    const r = (await manager.call("GET", "/reports/exceptions")).body;
    expect(r.totals.refunds.count).toBeGreaterThanOrEqual(5);
    expect(r.totals.voids.count).toBeGreaterThanOrEqual(1);
    expect(r.totals.bigDiscounts.count).toBeGreaterThanOrEqual(1);
    expect(r.totals.unapproved).toBeGreaterThanOrEqual(1);
    expect(r.approvals.some((a: { approvedBy: string }) => a.approvedBy.includes("manager"))).toBe(true);
  });

  it("the daily report shows refunds and sales after refunds", async () => {
    const d = (await manager.call("GET", "/reports/daily")).body;
    expect(d.refunds.amount).toBeGreaterThan(0);
    expect(d.salesAfterRefunds).toBe(d.grossSales - d.refunds.amount);
  });

  it("GSTR-1 B2CS is net of this month's credit notes", async () => {
    const month = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "2-digit" }).format(new Date());
    const g = (await manager.call("GET", `/reports/gstr1?month=${month}`)).body;
    const paid = await db.order.aggregate({ where: { outletId: h.outletId, status: "PAID" }, _sum: { cgst: true } });
    const cn = await db.creditNote.aggregate({ where: { outletId: h.outletId }, _sum: { cgst: true } });
    const reported = Math.round(g.gstr1.b2cs.reduce((s: number, b: { camt: number }) => s + b.camt, 0) * 100);
    expect(Math.abs(reported - ((paid._sum.cgst ?? 0) - (cn._sum.cgst ?? 0)))).toBeLessThanOrEqual(g.gstr1.b2cs.length);
    expect(g.notes.join(" ")).toMatch(/credit note/);
  });
});
