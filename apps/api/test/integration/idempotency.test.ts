/** Phase 1.4 — Idempotency-Key on mutations (payments first). */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHotel, db, login, startServer, type Hotel } from "./helpers";

let srv: Awaited<ReturnType<typeof startServer>>;
let h: Hotel;
beforeAll(async () => {
  srv = await startServer();
  h = await createHotel("Idem");
});
afterAll(() => srv.close());

const key = () => `test-${Date.now()}-${Math.random().toString(36).slice(2)}`;

async function openBill() {
  const cashier = await login(srv.base, h.users.cashier.email, h.outletId);
  const order = await cashier.call("POST", "/orders", { orderType: "TAKEAWAY", items: [{ menuItemId: h.items.samosa, quantity: 1 }] });
  expect(order.status).toBe(201);
  return { cashier, order: order.body as { id: string; grandTotal: number } };
}

describe("Idempotency-Key", () => {
  it("a retried payment with the same key is replayed, not recorded twice", async () => {
    const { cashier, order } = await openBill();
    const k = key();
    const body = { payments: [{ mode: "CASH", amount: order.grandTotal }] };
    const first = await cashier.call("POST", `/orders/${order.id}/payments`, body, { "Idempotency-Key": k });
    expect(first.status).toBe(200);
    await new Promise((r) => setTimeout(r, 100));
    const retry = await cashier.call("POST", `/orders/${order.id}/payments`, body, { "Idempotency-Key": k });
    expect(retry.status).toBe(200);
    expect(retry.headers.get("idempotent-replayed")).toBe("true");
    expect(retry.body).toEqual(first.body);
    expect(await db.payment.count({ where: { orderId: order.id } })).toBe(1);
  });

  it("without the header the same retry is rejected by business rules (order already paid)", async () => {
    const { cashier, order } = await openBill();
    const body = { payments: [{ mode: "CASH", amount: order.grandTotal }] };
    expect((await cashier.call("POST", `/orders/${order.id}/payments`, body)).status).toBe(200);
    expect((await cashier.call("POST", `/orders/${order.id}/payments`, body)).status).toBe(409);
  });

  it("the same key with a different request is refused (422)", async () => {
    const { cashier, order } = await openBill();
    const k = key();
    await cashier.call("POST", `/orders/${order.id}/payments`, { payments: [{ mode: "CASH", amount: 1000 }] }, { "Idempotency-Key": k });
    await new Promise((r) => setTimeout(r, 100));
    const other = await cashier.call("POST", `/orders/${order.id}/payments`, { payments: [{ mode: "UPI", amount: 1000 }] }, { "Idempotency-Key": k });
    expect(other.status).toBe(422);
  });

  it("two simultaneous requests with one key: exactly one runs", async () => {
    const { cashier, order } = await openBill();
    const k = key();
    const body = { payments: [{ mode: "CASH", amount: order.grandTotal }] };
    const [a, b] = await Promise.all([
      cashier.call("POST", `/orders/${order.id}/payments`, body, { "Idempotency-Key": k }),
      cashier.call("POST", `/orders/${order.id}/payments`, body, { "Idempotency-Key": k }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(await db.payment.count({ where: { orderId: order.id } })).toBe(1);
  });

  it("keys are per user: another user's identical key runs independently", async () => {
    const { order } = await openBill();
    const k = key();
    const manager = await login(srv.base, h.users.manager.email, h.outletId);
    const cashier = await login(srv.base, h.users.cashier.email, h.outletId);
    const half = Math.floor(order.grandTotal / 2);
    expect((await cashier.call("POST", `/orders/${order.id}/payments`, { payments: [{ mode: "CASH", amount: half }] }, { "Idempotency-Key": k })).status).toBe(200);
    expect((await manager.call("POST", `/orders/${order.id}/payments`, { payments: [{ mode: "CASH", amount: half }] }, { "Idempotency-Key": k })).status).toBe(200);
    expect(await db.payment.count({ where: { orderId: order.id } })).toBe(2);
  });

  it("4xx responses are stored too; malformed keys are rejected", async () => {
    const { cashier, order } = await openBill();
    const k = key();
    const tooMuch = { payments: [{ mode: "CASH", amount: order.grandTotal + 100 }] };
    const r1 = await cashier.call("POST", `/orders/${order.id}/payments`, tooMuch, { "Idempotency-Key": k });
    expect(r1.status).toBe(400);
    await new Promise((r) => setTimeout(r, 100));
    const r2 = await cashier.call("POST", `/orders/${order.id}/payments`, tooMuch, { "Idempotency-Key": k });
    expect(r2.status).toBe(400);
    expect(r2.headers.get("idempotent-replayed")).toBe("true");
    expect((await cashier.call("POST", `/orders/${order.id}/payments`, tooMuch, { "Idempotency-Key": "bad key!" })).status).toBe(400);
  });
});
