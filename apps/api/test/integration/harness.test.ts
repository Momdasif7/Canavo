import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHotel, login, startServer, type Hotel } from "./helpers";

let srv: Awaited<ReturnType<typeof startServer>>;
let a: Hotel, b: Hotel;
beforeAll(async () => {
  srv = await startServer();
  [a, b] = [await createHotel("Alpha"), await createHotel("Beta")];
});
afterAll(() => srv.close());

describe("integration harness", () => {
  it("logs in, bills, and keeps hotels apart", async () => {
    const cashier = await login(srv.base, a.users.cashier.email, a.outletId);
    const order = await cashier.call("POST", "/orders", { orderType: "TAKEAWAY", items: [{ menuItemId: a.items.chai, quantity: 2 }] });
    expect(order.status).toBe(201);
    expect(order.body.grandTotal).toBe(3000);
    const other = await login(srv.base, b.users.manager.email, b.outletId);
    expect((await other.call("GET", `/orders/${order.body.id}`)).status).toBe(404);
  });
});
