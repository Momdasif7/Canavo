import { mockFetch } from "./helpers";

export const bill = (id: string, outletId = "o1") => ({
  clientOrderId: id,
  outletId,
  payload: { clientOrderId: id, orderType: "TAKEAWAY", items: [{ menuItemId: "m1", addonIds: [], quantity: 1 }], interState: false } as never,
  paymentMode: "CASH" as const,
  grandTotal: 10500,
  createdAt: new Date().toISOString(),
});

/** Server keeping orders by clientOrderId like POST /orders/sync does. */
export function fakeServer() {
  const orders = new Map<string, { id: string; paid: boolean }>();
  let mode: "up" | "down" | "500" | "dropResponse" = "up";
  let reject: string | null = null;
  const calls = mockFetch((c) => {
    if (mode === "down") return "network";
    if (mode === "500") return { status: 500, body: { error: "Internal error" } };
    if (c.path === "/orders/sync") {
      const results = (c.body as { orders: { clientOrderId: string }[] }).orders.map((o) => {
        if (reject === o.clientOrderId) return { clientOrderId: o.clientOrderId, ok: false, error: "Item not found" };
        const existing = orders.get(o.clientOrderId);
        const order = existing ?? { id: `ord-${orders.size + 1}`, paid: false };
        orders.set(o.clientOrderId, order);
        return { clientOrderId: o.clientOrderId, ok: true, duplicate: !!existing, orderId: order.id, invoiceNumber: `INV${order.id}`, grandTotal: 10500 };
      });
      if (mode === "dropResponse") {
        mode = "up";
        return "network"; // server committed, phone never heard back
      }
      return { status: 200, body: { results } };
    }
    const pay = c.path.match(/^\/orders\/(.+)\/payments$/);
    if (pay) {
      const o = [...orders.values()].find((x) => x.id === pay[1]);
      if (!o) return { status: 404, body: { error: "Not found" } };
      if (o.paid) return { status: 409, body: { error: "Order is paid" } };
      o.paid = true;
      return { status: 200, body: { status: "PAID" } };
    }
    return { status: 404, body: { error: "no route" } };
  });
  return {
    orders,
    calls,
    set: (m: typeof mode) => (mode = m),
    rejectId: (id: string | null) => (reject = id),
  };
}
