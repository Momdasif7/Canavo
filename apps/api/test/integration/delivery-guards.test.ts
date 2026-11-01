/** Phase 1 — delivery routes shared by managers and partners: route guard + "your delivery" check. */
import bcrypt from "bcryptjs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHotel, db, login, PASSWORD, startServer, type Hotel } from "./helpers";

let srv: Awaited<ReturnType<typeof startServer>>;
let h: Hotel;
let deliveryId: string;
let otherPartnerEmail: string;

beforeAll(async () => {
  srv = await startServer();
  h = await createHotel("DelGuard");
  otherPartnerEmail = `partner2.${Date.now()}@it.local`;
  await db.user.create({
    data: { businessId: h.businessId, role: "DELIVERY", name: "Partner Two", email: otherPartnerEmail, phone: `7${String(Date.now()).slice(-9)}`, passwordHash: await bcrypt.hash(PASSWORD, 4), outlets: { create: { outletId: h.outletId } } },
  });
  const cashier = await login(srv.base, h.users.cashier.email, h.outletId);
  const order = await cashier.call("POST", "/orders", {
    orderType: "DELIVERY",
    customerName: "Guard Test",
    customerPhone: "9811100099",
    delivery: { address: "1 Test Street", latitude: 13.01, longitude: 80.2 },
    items: [{ menuItemId: h.items.biryani, quantity: 1 }],
  });
  expect(order.status, JSON.stringify(order.body)).toBe(201);
  const d = await db.delivery.findFirstOrThrow({ where: { orderId: order.body.id } });
  deliveryId = d.id;
  const manager = await login(srv.base, h.users.manager.email, h.outletId);
  const assigned = await manager.call("PATCH", `/delivery/${deliveryId}/assign`, { agentId: h.users.delivery.id, force: true });
  expect(assigned.status, JSON.stringify(assigned.body)).toBe(200);
});
afterAll(() => srv.close());

describe("delivery route guards", () => {
  it("kitchen staff are refused at the route (no delivery permission)", async () => {
    const kitchen = await login(srv.base, h.users.kitchen.email, h.outletId);
    expect((await kitchen.call("PATCH", `/delivery/${deliveryId}/status`, { status: "ACCEPTED" })).status).toBe(403);
    expect((await kitchen.call("GET", `/delivery/${deliveryId}`)).status).toBe(403);
  });

  it("another delivery partner is refused by the 'your delivery' check", async () => {
    const other = await login(srv.base, otherPartnerEmail, h.outletId);
    expect((await other.call("PATCH", `/delivery/${deliveryId}/status`, { status: "ACCEPTED" })).status).toBe(403);
  });

  it("the assigned partner can update their delivery; a manager can too", async () => {
    const partner = await login(srv.base, h.users.delivery.email, h.outletId);
    expect((await partner.call("PATCH", `/delivery/${deliveryId}/status`, { status: "ACCEPTED" })).status).toBe(200);
    const manager = await login(srv.base, h.users.manager.email, h.outletId);
    expect((await manager.call("GET", `/delivery/${deliveryId}`)).status).toBe(200);
  });
});
