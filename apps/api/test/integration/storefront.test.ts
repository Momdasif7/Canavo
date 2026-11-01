/** Phase 6.3 / 6.4 — QR table ordering and the online ordering page (CHANNELS). */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHotel, db, login, startServer, type Client, type Hotel } from "./helpers";

const ALL = ["BILLING", "KOT", "TABLES", "DELIVERY", "INVENTORY", "CUSTOMERS", "OFFERS", "REPORTS", "CHANNELS"];

let srv: Awaited<ReturnType<typeof startServer>>;
let h: Hotel, off: Hotel;
let owner: Client, cashier: Client;
let slug: string;

/** Anonymous call (a customer's phone). */
async function pub<T = any>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const r = await fetch(`${srv.base}${path}`, { method, headers: body !== undefined ? { "content-type": "application/json" } : {}, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : null };
}

async function table(label: string) {
  const r = await owner.call("POST", "/tables", { label, capacity: 4 });
  expect(r.status).toBe(201);
  const qr = (await owner.call("GET", "/storefront/tables")).body as { id: string; label: string; qrToken: string }[];
  return qr.find((t) => t.label === label)!;
}

const settings = (patch: object) => owner.call("PUT", "/storefront/settings", patch);

beforeAll(async () => {
  srv = await startServer();
  h = await createHotel("Storefront", { modules: ALL });
  off = await createHotel("NoChannels");
  owner = await login(srv.base, h.users.owner.email, h.outletId);
  cashier = await login(srv.base, h.users.cashier.email, h.outletId);
  slug = `sf-${Date.now().toString(36)}`;
  expect((await settings({ slug, qrOrdering: true, onlineOrdering: true })).status).toBe(200);
});
afterAll(() => srv.close());

describe("public menu", () => {
  it("lists available items, greys out out-of-stock ones and leaves hidden ones out", async () => {
    await db.menuItem.update({ where: { id: h.items.samosa }, data: { status: "OUT_OF_STOCK" } });
    const hidden = await db.menuItem.create({ data: { businessId: h.businessId, categoryId: (await db.menuItem.findUniqueOrThrow({ where: { id: h.items.chai } })).categoryId, name: "Secret", price: 100, status: "HIDDEN" } });
    const r = await pub("GET", `/public/o/${slug}`);
    expect(r.status).toBe(200);
    const items = r.body.items as { id: string; available: boolean; price: number }[];
    expect(items.find((i) => i.id === h.items.chai)).toMatchObject({ available: true, price: 1500 });
    expect(items.find((i) => i.id === h.items.samosa)).toMatchObject({ available: false });
    expect(items.find((i) => i.id === hidden.id)).toBeUndefined();
    // …and an out-of-stock item can't be ordered.
    const t = await table("SF-M1");
    expect((await pub("POST", `/public/t/${t.qrToken}/orders`, { items: [{ menuItemId: h.items.samosa, quantity: 1 }] })).status).toBe(400);
    await db.menuItem.update({ where: { id: h.items.samosa }, data: { status: "AVAILABLE" } });
  });

  it("refuses when the business has no CHANNELS module", async () => {
    await db.outlet.update({ where: { id: off.outletId }, data: { publicSlug: `${slug}-off`, storefront: { onlineOrdering: true, qrOrdering: true } } });
    expect((await pub("GET", `/public/o/${slug}-off`)).status).toBe(404);
    const o = await login(srv.base, off.users.owner.email, off.outletId);
    expect((await o.call("GET", "/storefront/settings")).status).toBe(403);
  });

  it("is view-only when online ordering is off, and gone when the menu is off too", async () => {
    await settings({ onlineOrdering: false });
    const r = await pub("GET", `/public/o/${slug}`);
    expect(r.status).toBe(200);
    expect(r.body.ordering).toBe(false);
    const order = { orderType: "TAKEAWAY", customerName: "Ravi", customerPhone: "9876543210", payment: "COUNTER", items: [{ menuItemId: h.items.chai, quantity: 1 }] };
    expect((await pub("POST", `/public/o/${slug}/orders`, order)).status).toBe(409);
    await settings({ menuView: false });
    expect((await pub("GET", `/public/o/${slug}`)).status).toBe(404);
    await settings({ onlineOrdering: true, menuView: true });
  });
});

describe("QR table ordering", () => {
  it("with confirmation on, an order waits; accepting it opens the tab and fires the KOT", async () => {
    const t = await table("SF-1");
    const page = await pub("GET", `/public/t/${t.qrToken}`);
    expect(page.status).toBe(200);
    expect(page.body).toMatchObject({ table: { label: "SF-1" }, ordering: true, needsConfirmation: true });

    const r = await pub("POST", `/public/t/${t.qrToken}/orders`, { items: [{ menuItemId: h.items.chai, quantity: 2, notes: "less sugar" }], customerName: "Asha" });
    expect(r.status).toBe(201);
    expect(r.body.status).toBe("PENDING");
    expect(await db.kotTicket.count({ where: { outletId: h.outletId, session: { tableId: t.id } } })).toBe(0);
    expect((await pub("GET", `/public/t/${t.qrToken}/orders`)).body[0]).toMatchObject({ stage: "waiting" });

    const queue = (await cashier.call("GET", "/storefront/requests")).body as { id: string; tableLabel: string }[];
    expect(queue.find((q) => q.id === r.body.id)?.tableLabel).toBe("SF-1");
    const acc = await cashier.call("POST", `/storefront/requests/${r.body.id}/accept`);
    expect(acc.status).toBe(200);
    expect(acc.body.status).toBe("ACCEPTED");
    const session = await db.tableSession.findFirstOrThrow({ where: { tableId: t.id, status: "OPEN" }, include: { items: true, kots: true } });
    expect(session.items).toHaveLength(1);
    expect(session.items[0]).toMatchObject({ menuItemId: h.items.chai, quantity: 2 });
    expect(session.kots).toHaveLength(1);
    expect(session.customerName).toBe("Asha");
    expect((await pub("GET", `/public/t/${t.qrToken}/orders`)).body[0]).toMatchObject({ stage: "received" });
    // Accepting twice is refused.
    expect((await cashier.call("POST", `/storefront/requests/${r.body.id}/accept`)).status).toBe(409);

    // A rejected order never reaches the kitchen.
    const r2 = await pub("POST", `/public/t/${t.qrToken}/orders`, { items: [{ menuItemId: h.items.biryani, quantity: 1 }] });
    expect((await cashier.call("POST", `/storefront/requests/${r2.body.id}/reject`, { reason: "Kitchen closed" })).status).toBe(200);
    expect(await db.tableSessionItem.count({ where: { sessionId: session.id } })).toBe(1);
    expect((await pub("GET", `/public/t/${t.qrToken}/orders`)).body[0]).toMatchObject({ stage: "cancelled", rejectReason: "Kitchen closed" });
  });

  it("with confirmation off, the order goes straight to the kitchen on the table's tab", async () => {
    await settings({ qrNeedsConfirmation: false });
    const t = await table("SF-2");
    const r = await pub("POST", `/public/t/${t.qrToken}/orders`, { items: [{ menuItemId: h.items.biryani, quantity: 1 }] });
    expect(r.status).toBe(201);
    expect(r.body.status).toBe("ACCEPTED");
    const session = await db.tableSession.findFirstOrThrow({ where: { tableId: t.id, status: "OPEN" }, include: { items: true, kots: true } });
    expect(session.items).toHaveLength(1);
    expect(session.kots).toHaveLength(1);
    await settings({ qrNeedsConfirmation: true });
  });

  it("rotating the token kills the old QR code", async () => {
    const t = await table("SF-3");
    expect((await pub("GET", `/public/t/${t.qrToken}`)).status).toBe(200);
    const rot = await owner.call("POST", `/storefront/tables/${t.id}/rotate`);
    expect(rot.status).toBe(200);
    expect(rot.body.qrToken).not.toBe(t.qrToken);
    expect((await pub("GET", `/public/t/${t.qrToken}`)).status).toBe(404);
    expect((await pub("GET", `/public/t/${rot.body.qrToken}`)).status).toBe(200);
  });

  it("call waiter notifies the outlet's staff", async () => {
    const t = await table("SF-4");
    expect((await pub("POST", `/public/t/${t.qrToken}/call`, { kind: "WAITER" })).status).toBe(201);
    expect((await pub("POST", `/public/t/${t.qrToken}/call`, { kind: "BILL" })).status).toBe(201);
    const notes = await db.notification.findMany({ where: { userId: h.users.cashier.id, kind: { in: ["table.call", "table.bill"] } } });
    expect(notes.map((n) => n.title).sort()).toEqual(["Table SF-4: bill please", "Table SF-4: guest is calling"]);
  });

  it("limits orders per table and phone", async () => {
    const t = await table("SF-5");
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) statuses.push((await pub("POST", `/public/t/${t.qrToken}/orders`, { items: [{ menuItemId: h.items.chai, quantity: 1 }] })).status);
    expect(statuses.slice(0, 6).every((s) => s === 201)).toBe(true);
    expect(statuses[6]).toBe(429);
    // Too many items in one order.
    const t2 = await table("SF-6");
    expect((await pub("POST", `/public/t/${t2.qrToken}/orders`, { items: [{ menuItemId: h.items.chai, quantity: 21 }] })).status).toBe(400);
  });

  it("refuses orders when QR ordering is off or outside accepting hours", async () => {
    const t = await table("SF-7");
    await settings({ qrOrdering: false });
    expect((await pub("GET", `/public/t/${t.qrToken}`)).body.ordering).toBe(false);
    expect((await pub("POST", `/public/t/${t.qrToken}/orders`, { items: [{ menuItemId: h.items.chai, quantity: 1 }] })).status).toBe(409);
    // Closed window: 1 minute long, 12 hours from now (outlet time).
    const hh = (new Date().getUTCHours() + 5 + 12) % 24;
    await settings({ qrOrdering: true, acceptFrom: `${String(hh).padStart(2, "0")}:00`, acceptTo: `${String(hh).padStart(2, "0")}:01` });
    expect((await pub("POST", `/public/t/${t.qrToken}/orders`, { items: [{ menuItemId: h.items.chai, quantity: 1 }] })).status).toBe(409);
    await settings({ acceptFrom: null, acceptTo: null });
  });
});

describe("online ordering", () => {
  it("prices takeaway orders on the server (client prices ignored), channel ONLINE, KOT after accept", async () => {
    const r = await pub("POST", `/public/o/${slug}/orders`, {
      orderType: "TAKEAWAY",
      customerName: "Ravi",
      customerPhone: "9876543210",
      payment: "COUNTER",
      items: [{ menuItemId: h.items.biryani, quantity: 2, unitPrice: 1, price: 1 }],
      grandTotal: 1,
    });
    expect(r.status).toBe(201);
    const req = await db.channelRequest.findUniqueOrThrow({ where: { publicToken: r.body.token } });
    const order = await db.order.findUniqueOrThrow({ where: { id: req.orderId! }, include: { items: true, kots: true } });
    expect(order).toMatchObject({ channel: "ONLINE", orderType: "TAKEAWAY", customerPhone: "9876543210", subtotal: 32000 });
    expect(order.items[0].unitPrice).toBe(16000);
    expect(order.kots).toHaveLength(0);
    expect(req.status).toBe("PENDING");

    const view = await pub("GET", `/public/o/${slug}/orders/${r.body.token}`);
    expect(view.body).toMatchObject({ stage: "waiting", grandTotal: order.grandTotal, receiptUrl: null });

    expect((await cashier.call("POST", `/storefront/requests/${req.id}/accept`)).status).toBe(200);
    expect(await db.kotTicket.count({ where: { orderId: order.id } })).toBe(1);
    expect((await pub("GET", `/public/o/${slug}/orders/${r.body.token}`)).body.stage).toBe("received");

    // Paid → the confirmation page links the receipt.
    await cashier.call("POST", `/orders/${order.id}/payments`, { payments: [{ mode: "CASH", amount: order.grandTotal }] });
    expect((await pub("GET", `/public/o/${slug}/orders/${r.body.token}`)).body.receiptUrl).toMatch(/\/public\/receipts\//);
  });

  it("rejecting an online order cancels its bill with the reason", async () => {
    const r = await pub("POST", `/public/o/${slug}/orders`, { orderType: "TAKEAWAY", customerName: "Meena", customerPhone: "9876543211", payment: "COUNTER", items: [{ menuItemId: h.items.chai, quantity: 1 }] });
    const req = await db.channelRequest.findUniqueOrThrow({ where: { publicToken: r.body.token } });
    expect((await cashier.call("POST", `/storefront/requests/${req.id}/reject`, { reason: "Out of milk" })).status).toBe(200);
    const order = await db.order.findUniqueOrThrow({ where: { id: req.orderId! } });
    expect(order.status).toBe("CANCELLED");
    expect(order.cancelReason).toContain("Out of milk");
    expect((await pub("GET", `/public/o/${slug}/orders/${r.body.token}`)).body.stage).toBe("cancelled");
  });

  it("UPI prepaid creates a UPI QR for the bill; confirmation off fires the KOT at once", async () => {
    await settings({ upiPrepaid: true, onlineNeedsConfirmation: false });
    const r = await pub("POST", `/public/o/${slug}/orders`, { orderType: "TAKEAWAY", customerName: "Kiran", customerPhone: "9876543212", payment: "UPI", items: [{ menuItemId: h.items.chai, quantity: 1 }] });
    expect(r.status).toBe(201);
    const view = await pub("GET", `/public/o/${slug}/orders/${r.body.token}`);
    expect(view.body.upi.qrPayload).toMatch(/^upi:\/\/pay/);
    const req = await db.channelRequest.findUniqueOrThrow({ where: { publicToken: r.body.token } });
    expect(req.status).toBe("ACCEPTED");
    expect(await db.kotTicket.count({ where: { orderId: req.orderId! } })).toBe(1);
    // Pay at counter isn't offered for delivery, COD isn't for takeaway.
    expect((await pub("POST", `/public/o/${slug}/orders`, { orderType: "TAKEAWAY", customerName: "Kiran", customerPhone: "9876543212", payment: "COD", items: [{ menuItemId: h.items.chai, quantity: 1 }] })).status).toBe(400);
    await settings({ upiPrepaid: false, onlineNeedsConfirmation: true });
  });

  it("enforces the minimum order", async () => {
    await settings({ minOrder: 50000 });
    const r = await pub("POST", `/public/o/${slug}/orders`, { orderType: "TAKEAWAY", customerName: "Kiran", customerPhone: "9876543212", payment: "COUNTER", items: [{ menuItemId: h.items.chai, quantity: 1 }] });
    expect(r.status).toBe(400);
    await settings({ minOrder: 0 });
  });

  it("slugs are unique across hotels", async () => {
    const o = await login(srv.base, off.users.owner.email, off.outletId);
    expect(o).toBeTruthy();
    const other = await createHotel("SlugClash", { modules: ALL });
    const oc = await login(srv.base, other.users.owner.email, other.outletId);
    expect((await oc.call("PUT", "/storefront/settings", { slug })).status).toBe(409);
  });
});
