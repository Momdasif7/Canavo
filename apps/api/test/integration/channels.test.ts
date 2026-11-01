/** Phase 6.1 — aggregators through a partner hub (fake hub server; no real credentials). */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startFakeHub, type FakeHub } from "../../src/services/channels/fake-hub";
import { encryptSecret } from "../../src/services/whatsapp";
import { createHotel, db, login, startServer, type Client, type Hotel } from "./helpers";

const MODULES = ["BILLING", "KOT", "TABLES", "DELIVERY", "RESERVATIONS", "INVENTORY", "CUSTOMERS", "OFFERS", "ATTENDANCE", "REPORTS", "CHANNELS"];
const SECRET = "hub-webhook-secret-123";

let srv: Awaited<ReturnType<typeof startServer>>;
let hub: FakeHub;
let h: Hotel;
let manager: Client, cashier: Client, kitchen: Client;
let connectionId: string;
const hookUrl = () => `${srv.base}/channels/hub/${connectionId}/webhook`;

/** Poll until `fn` returns truthy (outbox delivery is asynchronous). */
async function eventually<T>(fn: () => Promise<T> | T, ms = 12_000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 150));
  }
}

const statusCalls = (orderId: string) => hub.calls.filter((c) => c.path === `/v1/orders/${orderId}/status`);

const newOrder = (id: string, items: object[], extra: object = {}) => ({
  event: "order.new",
  order: {
    id,
    channel: "zomato",
    customer: { name: "Asha", phone: "+91 98400 12345" },
    items,
    totals: { total: 6300 },
    charges: { packaging: 500 },
    payment: { prepaid: true, mode: "online" },
    fulfilment: "channel",
    notes: "Extra spicy",
    ...extra,
  },
});

beforeAll(async () => {
  srv = await startServer();
  hub = await startFakeHub({ apiKey: "hub-key-1" });
  h = await createHotel("Channels", { modules: MODULES, gst: true });
  manager = await login(srv.base, h.users.manager.email, h.outletId);
  cashier = await login(srv.base, h.users.cashier.email, h.outletId);
  kitchen = await login(srv.base, h.users.kitchen.email, h.outletId);
});
afterAll(async () => {
  await srv.close();
  await hub.close();
});

describe("connection settings", () => {
  it("saves the hub connection with masked secrets, tests it, and opens the store on the hub", async () => {
    expect((await manager.call("PUT", "/channels/connection", { baseUrl: hub.baseUrl, externalStoreId: "S-1" })).status).toBe(400);
    const r = await manager.call("PUT", "/channels/connection", {
      enabled: true,
      baseUrl: hub.baseUrl,
      externalStoreId: "S-1",
      apiKey: "hub-key-1",
      webhookSecret: SECRET,
      commission: { ZOMATO: 25, SWIGGY: 20 },
    });
    expect(r.status).toBe(200);
    connectionId = r.body.connection.id;
    expect(r.body.connection.apiKey).toBe("••••ey-1");
    expect(JSON.stringify(r.body)).not.toContain(SECRET);
    expect((await manager.call("POST", "/channels/connection/test")).body).toEqual({ ok: true });

    hub.reset();
    const open = await manager.call("POST", "/channels/connection/store", { open: true });
    expect(open.status).toBe(200);
    expect(open.body.connection.storeOpen).toBe(true);
    expect(hub.calls).toMatchObject([{ method: "PUT", path: "/v1/stores/S-1/status", body: { open: true }, apiKey: "hub-key-1" }]);

    // Cashiers don't manage channels.
    expect((await cashier.call("GET", "/channels/connection")).status).toBe(403);
  });

  it("a hub error on store toggle is shown, and the toggle doesn't flip", async () => {
    hub.failNext(1);
    const r = await manager.call("POST", "/channels/connection/store", { open: false });
    expect(r.status).toBe(502);
    const c = (await manager.call("GET", "/channels/connection")).body.connection;
    expect(c.storeOpen).toBe(true);
    expect(c.lastError).toMatch(/close the store/);
  });
});

describe("menu sync", () => {
  it("pushes the menu with out-of-stock items (manual and AUTO_STOCK_OUT) marked unavailable", async () => {
    await db.business.update({ where: { id: h.businessId }, data: { features: { AUTO_STOCK_OUT: true } } });
    await db.outletItemOverride.create({ data: { outletId: h.outletId, menuItemId: h.items.biryani, stockOut: true, stockOutReason: "Rice" } });
    await db.outletItemOverride.create({ data: { outletId: h.outletId, menuItemId: h.items.samosa, status: "OUT_OF_STOCK" } });
    await manager.call("PUT", `/channels/items/${h.items.samosa}`, { externalId: "SAM-1" });
    hub.reset();
    const r = await manager.call("POST", "/channels/connection/menu-sync");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, items: 3, unavailable: 2 });
    const pushed = hub.calls.find((c) => c.path === "/v1/stores/S-1/menu")!.body as { items: { externalId: string; available: boolean; price: number }[] };
    const by = Object.fromEntries(pushed.items.map((i) => [i.externalId, i]));
    expect(by[h.items.chai]).toMatchObject({ available: true, price: 1500 });
    expect(by[h.items.biryani].available).toBe(false);
    expect(by["SAM-1"].available).toBe(false);
    expect((await manager.call("GET", "/channels/connection")).body.connection.lastMenuSyncAt).toBeTruthy();

    const items = (await manager.call("GET", "/channels/items")).body as { menuItemId: string; externalId: string; custom: boolean; available: boolean }[];
    expect(items.find((i) => i.menuItemId === h.items.samosa)).toMatchObject({ externalId: "SAM-1", custom: true, available: false });

    // Back in stock for the order tests.
    await db.outletItemOverride.deleteMany({ where: { outletId: h.outletId } });
  });
});

describe("inbound orders", () => {
  let orderId: string;

  it("rejects a webhook with a bad signature and creates nothing", async () => {
    const r = await hub.sendWebhook(hookUrl(), newOrder("Z-BAD", [{ externalId: h.items.chai, quantity: 1 }]), "wrong-secret");
    expect(r.status).toBe(401);
    expect(r.body.error).toBe("BAD_SIGNATURE");
    expect(await db.order.count({ where: { channelOrderId: "Z-BAD" } })).toBe(0);
  });

  it("NEW_ORDER creates a bill at OUR prices with channel ZOMATO, paid ONLINE, KOTs fired and ACCEPTED pushed", async () => {
    hub.reset();
    const items = [
      { externalId: h.items.chai, quantity: 2, unitPrice: 1400 },
      { externalId: "SAM-1", quantity: 1, unitPrice: 3200 },
    ];
    const r = await hub.sendWebhook(hookUrl(), newOrder("Z-1001", items), SECRET);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, duplicate: false });
    orderId = r.body.orderId;

    const order = await db.order.findUniqueOrThrow({ where: { id: orderId }, include: { payments: true, items: true, kots: true, delivery: true } });
    // Same bill a cashier would raise for these items.
    const pos = (await cashier.call("POST", "/orders", { orderType: "TAKEAWAY", items: [{ menuItemId: h.items.chai, quantity: 2 }, { menuItemId: h.items.samosa, quantity: 1 }] })).body;
    expect(order).toMatchObject({ channel: "ZOMATO", channelOrderId: "Z-1001", orderType: "TAKEAWAY", status: "PAID", customerName: "Asha", customerPhone: "9840012345", grandTotal: pos.grandTotal, cgst: pos.cgst });
    expect(order.notes).toMatch(/Zomato #Z-1001 · Zomato rider pickup · Extra spicy/);
    expect(order.delivery).toBeNull();
    expect(order.kots.length).toBeGreaterThan(0);
    expect(order.payments).toMatchObject([{ mode: "ONLINE", amount: pos.grandTotal, status: "SUCCESS" }]);

    const row = await db.channelOrder.findFirstOrThrow({ where: { channelOrderId: "Z-1001" } });
    expect(row).toMatchObject({ status: "ACCEPTED", orderId, channelTotal: 6300, ourTotal: pos.grandTotal, mismatch: Math.abs(6300 - pos.grandTotal) > 100 });

    await eventually(() => statusCalls("Z-1001").some((c) => (c.body as { status: string }).status === "accepted"));
    await eventually(async () => (await db.channelOrder.findUniqueOrThrow({ where: { id: row.id } })).pushedStatus === "ACCEPTED");
  });

  it("a repeated webhook doesn't create a second bill", async () => {
    const r = await hub.sendWebhook(hookUrl(), newOrder("Z-1001", [{ externalId: h.items.chai, quantity: 2 }]), SECRET);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, duplicate: true, orderId });
    expect(await db.order.count({ where: { outletId: h.outletId, channelOrderId: "Z-1001" } })).toBe(1);
  });

  it("an unknown item is rejected with a clear error (and logged); so is our id for a remapped item", async () => {
    const r = await hub.sendWebhook(hookUrl(), newOrder("Z-1002", [{ externalId: "NOPE-9", name: "Pizza", quantity: 1 }, { externalId: h.items.samosa, quantity: 1 }]), SECRET);
    expect(r.status).toBe(422);
    expect(r.body.error).toBe("UNKNOWN_ITEM");
    expect(r.body.message).toMatch(/Pizza \(NOPE-9\)/);
    expect(r.body.unknown).toHaveLength(2);
    expect(await db.order.count({ where: { channelOrderId: "Z-1002" } })).toBe(0);
    const logged = (await manager.call("GET", "/channels/orders")).body as { channelOrderId: string; status: string; error: string }[];
    expect(logged.find((o) => o.channelOrderId === "Z-1002")).toMatchObject({ status: "REJECTED", error: expect.stringMatching(/Unknown item/) });
  });

  it("KOT ready → FOOD_READY is pushed through the outbox, retried after a hub failure", async () => {
    hub.failNext(1);
    const kots = await db.kotTicket.findMany({ where: { orderId } });
    for (const k of kots) expect((await kitchen.call("PATCH", `/kot/${k.id}`, { status: "READY" })).status).toBe(200);
    // First attempt fails and is recorded…
    await eventually(async () => (await db.channelOrder.findFirstOrThrow({ where: { orderId } })).pushError);
    // …then the outbox retries and it goes through.
    await eventually(async () => {
      const row = await db.channelOrder.findFirstOrThrow({ where: { orderId } });
      return row.pushedStatus === "FOOD_READY" && !row.pushError;
    });
    const ready = statusCalls("Z-1001").filter((c) => (c.body as { status: string }).status === "food_ready");
    expect(ready.length).toBe(2);
  });

  it("ORDER_CANCELLED voids our bill (system cancel with the channel's reason), idempotently, without pushing back", async () => {
    hub.reset();
    const body = { event: "order.cancelled", order: { id: "Z-1001", channel: "zomato" }, reason: "Customer unreachable" };
    const r = await hub.sendWebhook(hookUrl(), body, SECRET);
    expect(r.status).toBe(200);
    const order = await db.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(order).toMatchObject({ status: "CANCELLED", cancelReason: "Cancelled on Zomato: Customer unreachable" });
    expect((await db.channelOrder.findFirstOrThrow({ where: { orderId } })).status).toBe("CANCELLED");
    expect((await hub.sendWebhook(hookUrl(), body, SECRET)).body).toMatchObject({ ok: true, duplicate: true });
    await new Promise((r) => setTimeout(r, 300));
    expect(statusCalls("Z-1001")).toHaveLength(0);
  });

  it("rider updates are recorded", async () => {
    await hub.sendWebhook(hookUrl(), newOrder("S-5", [{ externalId: h.items.chai, quantity: 1 }], { channel: "swiggy", payment: { prepaid: true } }), SECRET);
    const r = await hub.sendWebhook(hookUrl(), { event: "rider.status", order: { id: "S-5", channel: "swiggy" }, status: "at_store", rider: { name: "Ravi" } }, SECRET);
    expect(r.status).toBe(200);
    expect(await db.channelOrder.findFirstOrThrow({ where: { channelOrderId: "S-5" } })).toMatchObject({ sourceChannel: "SWIGGY", riderStatus: "AT_STORE", rider: { name: "Ravi" } });
  });

  it("staff cancelling a channel order pushes CANCELLED to the hub; marking it handed over pushes DISPATCHED", async () => {
    const order = await db.order.findFirstOrThrow({ where: { outletId: h.outletId, channel: "SWIGGY", channelOrderId: "S-5" } });
    expect((await manager.call("POST", `/channels/orders/${order.id}/status`, { status: "DISPATCHED" })).status).toBe(200);
    await eventually(() => statusCalls("S-5").some((c) => (c.body as { status: string }).status === "dispatched"));
    expect((await manager.call("POST", `/orders/${order.id}/cancel`, { reason: "Kitchen closed early" })).status).toBe(200);
    await eventually(() => statusCalls("S-5").some((c) => (c.body as { status: string; reason?: string }).status === "cancelled" && (c.body as { reason?: string }).reason === "Kitchen closed early"));
  });

  it("a closed store rejects new orders", async () => {
    await db.channelConnection.update({ where: { id: connectionId }, data: { storeOpen: false } });
    const r = await hub.sendWebhook(hookUrl(), newOrder("Z-1003", [{ externalId: h.items.chai, quantity: 1 }]), SECRET);
    expect(r.status).toBe(409);
    expect(r.body.error).toBe("STORE_CLOSED");
    await db.channelConnection.update({ where: { id: connectionId }, data: { storeOpen: true } });
  });

  it("an item our billing refuses (out of stock) is rejected back to the hub", async () => {
    await db.outletItemOverride.create({ data: { outletId: h.outletId, menuItemId: h.items.biryani, status: "OUT_OF_STOCK" } });
    const r = await hub.sendWebhook(hookUrl(), newOrder("Z-1004", [{ externalId: h.items.biryani, quantity: 1 }]), SECRET);
    expect(r.status).toBe(422);
    expect(r.body).toMatchObject({ error: "REJECTED", message: expect.stringMatching(/not available/) });
    await db.outletItemOverride.deleteMany({ where: { outletId: h.outletId } });
  });
});

describe("bills, payments and reports", () => {
  it("bills filter by channel", async () => {
    const zomato = (await cashier.call("GET", "/orders?channel=ZOMATO")).body as { channel: string }[];
    expect(zomato.length).toBe(1);
    expect(zomato.every((o) => o.channel === "ZOMATO")).toBe(true);
    const pos = (await cashier.call("GET", "/orders?channel=POS")).body as { channel: string }[];
    expect(pos.length).toBeGreaterThan(0);
    expect(pos.every((o) => o.channel === "POS")).toBe(true);
    expect((await cashier.call("GET", "/orders?channel=FAX")).status).toBe(400);
    const sum = (await cashier.call("GET", "/orders/summary?channel=SWIGGY")).body;
    expect(sum.count).toBe(1);
  });

  it("counter staff can't record 'Paid online' on a counter bill", async () => {
    const o = (await cashier.call("POST", "/orders", { orderType: "TAKEAWAY", items: [{ menuItemId: h.items.chai, quantity: 1 }] })).body;
    const r = await cashier.call("POST", `/orders/${o.id}/payments`, { payments: [{ mode: "ONLINE", amount: o.grandTotal }] });
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/online channel/);
  });

  it("sales report shows sales by channel with the commission estimate", async () => {
    const t = new Date().toISOString().slice(0, 10);
    const d = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
    const t2 = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    // Pay one Zomato order that stays (the first one was cancelled).
    const r = await hub.sendWebhook(hookUrl(), newOrder("Z-2000", [{ externalId: h.items.chai, quantity: 4 }]), SECRET);
    expect(r.status).toBe(200);
    const rep = (await manager.call("GET", `/reports/sales?from=${d}&to=${t2 > t ? t2 : t}`)).body;
    const z = rep.byChannel.find((c: { channel: string }) => c.channel === "ZOMATO");
    const gross = (await db.order.findUniqueOrThrow({ where: { id: r.body.orderId } })).grandTotal;
    expect(z).toMatchObject({ label: "Zomato", orders: 1, gross, commissionPercent: 25, commission: Math.round(gross * 0.25), afterCommission: gross - Math.round(gross * 0.25) });
    // The cancelled Zomato order and unpaid counter bills aren't sales.
    expect(rep.byChannel.find((c: { channel: string }) => c.channel === "POS")).toBeUndefined();
  });
});

describe("module off", () => {
  it("hotels without CHANNELS get 403 on the staff routes and the webhook", async () => {
    const other = await createHotel("NoChannels");
    const owner = await login(srv.base, other.users.owner.email, other.outletId);
    expect((await owner.call("GET", "/channels/connection")).status).toBe(403);
    expect((await owner.call("GET", "/orders?channel=ZOMATO")).status).toBe(200);
    const conn = await db.channelConnection.create({
      data: { outletId: other.outletId, enabled: true, storeOpen: true, baseUrl: hub.baseUrl, externalStoreId: "X", apiKeyEnc: encryptSecret("k"), webhookSecretEnc: encryptSecret(SECRET) },
    });
    const r = await hub.sendWebhook(`${srv.base}/channels/hub/${conn.id}/webhook`, newOrder("Z-9", [{ externalId: other.items.chai, quantity: 1 }]), SECRET);
    expect(r.status).toBe(403);
    expect(await db.order.count({ where: { outletId: other.outletId } })).toBe(0);
    expect((await hub.sendWebhook(`${srv.base}/channels/hub/nope/webhook`, {}, SECRET)).status).toBe(404);
  });
});
