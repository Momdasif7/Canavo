/** Phase 3.2 — cash shifts: float, sales, pay-ins/outs, refunds, close with variance, Z-report. */
import bcrypt from "bcryptjs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHotel, db, login, startServer, type Client, type Hotel } from "./helpers";

let srv: Awaited<ReturnType<typeof startServer>>;
let h: Hotel;
let cashier: Client, manager: Client;

beforeAll(async () => {
  srv = await startServer();
  h = await createHotel("Shifts");
  await db.user.update({ where: { id: h.users.manager.id }, data: { pinHash: await bcrypt.hash("1357", 4) } });
  cashier = await login(srv.base, h.users.cashier.email, h.outletId);
  manager = await login(srv.base, h.users.manager.email, h.outletId);
});
afterAll(() => srv.close());

async function cashBill(c: Client) {
  const o = await c.call("POST", "/orders", { orderType: "TAKEAWAY", items: [{ menuItemId: h.items.samosa, quantity: 2 }] });
  const pay = await c.call("POST", `/orders/${o.body.id}/payments`, { payments: [{ mode: "CASH", amount: o.body.grandTotal }] });
  return { id: o.body.id as string, total: o.body.grandTotal as number, status: pay.status, body: pay.body };
}

describe("cash shifts", () => {
  it("with REQUIRE_CASH_SHIFT, cash needs an open shift; UPI doesn't", async () => {
    await db.business.update({ where: { id: h.businessId }, data: { features: { REQUIRE_CASH_SHIFT: true } } });
    const blocked = await cashBill(cashier);
    expect(blocked.status).toBe(409);
    expect(blocked.body.details.code).toBe("CASH_SHIFT_CLOSED");
    const o = await cashier.call("POST", "/orders", { orderType: "TAKEAWAY", items: [{ menuItemId: h.items.chai, quantity: 1 }] });
    expect((await cashier.call("POST", `/orders/${o.body.id}/payments`, { payments: [{ mode: "UPI", amount: o.body.grandTotal }] })).status).toBe(200);
  });

  it("one open shift per outlet; expected cash adds sales and pay-ins, subtracts pay-outs and cash refunds", async () => {
    expect((await cashier.call("POST", "/cash-shifts/open", { openingFloat: 200000 })).status).toBe(201);
    expect((await manager.call("POST", "/cash-shifts/open", { openingFloat: 100 })).status).toBe(409);
    const a = await cashBill(cashier);
    const b = await cashBill(cashier);
    expect(a.status).toBe(200);
    await cashier.call("POST", "/cash-shifts/current/movements", { type: "PAY_IN", amount: 50000, reason: "Change from bank" });
    await cashier.call("POST", "/cash-shifts/current/movements", { type: "PAY_OUT", amount: 30000, reason: "Milk supplier" });
    const refund = await manager.call("POST", `/orders/${a.id}/refunds`, { reason: "QUALITY", refundMode: "CASH", amount: 1000 });
    expect(refund.status).toBe(201);
    const live = (await cashier.call("GET", "/cash-shifts/current")).body;
    expect(live.summary.expectedCash).toBe(200000 + a.total + b.total + 50000 - 30000 - 1000);
    expect(live.summary.bills.count).toBe(2);

    const closed = await cashier.call("POST", "/cash-shifts/current/close", { countedCash: live.summary.expectedCash - 500, denominations: { "500": 4 } });
    expect(closed.status).toBe(200);
    expect(closed.body.variance).toBe(-500);
    expect(closed.body.status).toBe("CLOSED");
    // Z-report frozen at close.
    const z = (await manager.call("GET", `/cash-shifts/${closed.body.id}`)).body;
    expect(z.summary.expectedCash).toBe(live.summary.expectedCash);
    expect(z.summary.cashRefunds).toBe(1000);
    expect((await cashier.call("GET", `/cash-shifts/${closed.body.id}`)).status).toBe(403);
  });

  it("with approvals on, a cashier's pay-out needs a manager PIN", async () => {
    await db.business.update({ where: { id: h.businessId }, data: { features: { APPROVAL_PINS: true } } });
    await cashier.call("POST", "/cash-shifts/open", { openingFloat: 0 });
    const r = await cashier.call("POST", "/cash-shifts/current/movements", { type: "PAY_OUT", amount: 10000, reason: "Gas cylinder" });
    expect(r.body.details.code).toBe("APPROVAL_REQUIRED");
    const ok = await cashier.call("POST", "/cash-shifts/current/movements", { type: "PAY_OUT", amount: 10000, reason: "Gas cylinder", approval: { approverId: h.users.manager.id, pin: "1357" } });
    expect(ok.status).toBe(201);
    expect(ok.body.approvedById).toBe(h.users.manager.id);
    expect((await cashier.call("POST", "/cash-shifts/current/movements", { type: "PAY_IN", amount: 500, reason: "Float top-up" })).status).toBe(201);
    await db.business.update({ where: { id: h.businessId }, data: { features: {} } });
  });
});
