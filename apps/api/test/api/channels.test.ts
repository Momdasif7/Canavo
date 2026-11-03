/**
 * QA Phase 6 — /channels (hub connection, store, menu sync, item map, channel orders),
 * /channels/board (packing / handover board) and the public hub webhook
 * POST /channels/hub/:connectionId/webhook (signature, replay, unknown connection,
 * tampered payloads). Role × endpoint authorization, module gate, tenant / outlet isolation,
 * input validation.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signHubBody } from "../../src/services/channels/hub";
import { startFakeHub, type FakeHub } from "../../src/services/channels/fake-hub";
import { createHotel, db, login, startServer, type Client, type Hotel } from "../integration/helpers";
import { NASTY, checkAuthz, expectAll, expectNoSecrets, expectPaise, roleClients, superAdmin, type Endpoint, type RoleKey } from "./commerce-kit";

const MODULES = ["BILLING", "KOT", "TABLES", "DELIVERY", "CUSTOMERS", "REPORTS", "CHANNELS"];
const SECRET = "qa-hub-secret-0001";
const ID = "cl0000000000000000000000";

let srv: Awaited<ReturnType<typeof startServer>>;
let hub: FakeHub;
let h: Hotel, other: Hotel;
let c: Record<RoleKey, Client>;
let owner: Client, manager: Client, cashier: Client, otherOwner: Client;
let connectionId: string, otherConnectionId: string;
let boardOrderId: string, otherBoardOrderId: string;

const hookUrl = (id = connectionId) => `${srv.base}/channels/hub/${id}/webhook`;
let seq = 0;
const newOrder = (id: string, items: object[] = [{ externalId: "", quantity: 1 }], extra: object = {}) => ({
  event: "order.new",
  order: { id, channel: "zomato", customer: { name: "Asha", phone: "9840012345" }, items, totals: { total: 3000 }, payment: { prepaid: true }, ...extra },
});

beforeAll(async () => {
  srv = await startServer();
  hub = await startFakeHub({ apiKey: "qa-key" });
  h = await createHotel("QA Channels", { modules: MODULES });
  other = await createHotel("QA Channels B", { modules: MODULES });
  c = await roleClients(srv.base, h);
  ({ owner, manager, cashier } = c);
  otherOwner = await login(srv.base, other.users.owner.email, other.outletId);
  const conn = await manager.call("PUT", "/channels/connection", { enabled: true, baseUrl: hub.baseUrl, externalStoreId: "QA-1", apiKey: "qa-key", webhookSecret: SECRET });
  expect(conn.status).toBe(200);
  connectionId = conn.body.connection.id;
  expect((await manager.call("POST", "/channels/connection/store", { open: true })).status).toBe(200);
  const oc = await otherOwner.call("PUT", "/channels/connection", { enabled: true, baseUrl: hub.baseUrl, externalStoreId: "QA-B", apiKey: "qa-key", webhookSecret: "other-hub-secret-99" });
  otherConnectionId = oc.body.connection.id;
  await otherOwner.call("POST", "/channels/connection/store", { open: true });

  const r = await hub.sendWebhook(hookUrl(), newOrder("QA-Z-1", [{ externalId: h.items.chai, quantity: 2 }]), SECRET);
  expect(r.status).toBe(200);
  boardOrderId = r.body.orderId;
  const o = await hub.sendWebhook(hookUrl(otherConnectionId), newOrder("QA-B-1", [{ externalId: other.items.chai, quantity: 1 }]), "other-hub-secret-99");
  expect(o.status).toBe(200);
  otherBoardOrderId = o.body.orderId;
});
afterAll(async () => {
  await srv.close();
  await hub.close();
});

const MANAGE: RoleKey[] = ["owner", "manager"];
const BOARD: RoleKey[] = ["owner", "manager", "cashier", "kitchen", "waiter"];

const endpoints = (): Endpoint[] => [
  { method: "GET", path: "/channels/connection", allowed: MANAGE },
  { method: "PUT", path: "/channels/connection", body: {}, allowed: MANAGE },
  { method: "POST", path: "/channels/connection/test", allowed: MANAGE },
  { method: "POST", path: "/channels/connection/store", body: {}, allowed: MANAGE },
  { method: "POST", path: "/channels/connection/menu-sync", allowed: MANAGE },
  { method: "POST", path: "/channels/connection/retry-failed", allowed: MANAGE },
  { method: "GET", path: "/channels/items", allowed: MANAGE },
  { method: "PUT", path: `/channels/items/${h.items.chai}`, body: {}, allowed: MANAGE },
  { method: "GET", path: "/channels/orders", allowed: MANAGE },
  { method: "POST", path: `/channels/orders/${boardOrderId}/status`, body: {}, allowed: MANAGE },
  { method: "GET", path: "/channels/board", allowed: BOARD },
  { method: "GET", path: "/channels/board/settings", allowed: BOARD },
  { method: "PUT", path: "/channels/board/settings", body: {}, allowed: MANAGE },
  { method: "POST", path: `/channels/board/${ID}/packed`, allowed: BOARD },
  { method: "POST", path: `/channels/board/${ID}/handover`, body: {}, allowed: BOARD },
  { method: "GET", path: `/channels/board/${boardOrderId}/slip`, allowed: BOARD },
  { method: "GET", path: `/channels/board/${boardOrderId}/print`, allowed: BOARD },
];

describe("authorization", () => {
  it("every role × every /channels endpoint: allowed roles pass, the rest get 403", async () => {
    await checkAuthz(c, endpoints());
  });

  it("module off, foreign outlet, super admin: refused everywhere", async () => {
    const off = await createHotel("QA No Channels");
    await expectAll(await login(srv.base, off.users.owner.email, off.outletId), endpoints(), 403);
    await expectAll(await login(srv.base, h.users.manager.email, h.outlet2Id), endpoints(), 403);
    await expectAll(await superAdmin(srv.base, h.outletId), endpoints(), 403);
  });

  it("cross-tenant: another hotel can't see or act on this hotel's channel orders / items", async () => {
    for (const [m, p, b] of [
      ["POST", `/channels/orders/${boardOrderId}/status`, { status: "DISPATCHED" }],
      ["POST", `/channels/board/${boardOrderId}/packed`],
      ["POST", `/channels/board/${boardOrderId}/handover`, { riderName: "x" }],
      ["GET", `/channels/board/${boardOrderId}/slip`],
      ["GET", `/channels/board/${boardOrderId}/print`],
      ["PUT", `/channels/items/${h.items.chai}`, { externalId: "STEAL" }],
    ] as const) {
      expect((await otherOwner.call(m, p, b)).status, `${m} ${p}`).toBe(404);
    }
    const orders = (await otherOwner.call("GET", "/channels/orders")).body as { orderId: string }[];
    expect(orders.map((o) => o.orderId)).not.toContain(boardOrderId);
    const board = (await otherOwner.call("GET", "/channels/board")).body.orders as { orderId: string }[];
    expect(board.map((o) => o.orderId)).not.toContain(boardOrderId);
    const conn = (await otherOwner.call("GET", "/channels/connection")).body.connection;
    expect(conn.id).toBe(otherConnectionId);
    // …and this hotel can't touch the other's.
    expect((await manager.call("GET", `/channels/board/${otherBoardOrderId}/slip`)).status).toBe(404);
    expect((await manager.call("POST", `/channels/orders/${otherBoardOrderId}/status`, { status: "DISPATCHED" })).status).toBe(404);
    expect(await db.channelItemMap.count({ where: { externalId: "STEAL" } })).toBe(0);
  });
});

describe("connection", () => {
  it("GET masks secrets; PUT validation → 400 with nothing changed; smuggled outletId ignored", async () => {
    const g = await manager.call("GET", "/channels/connection");
    expect(g.status).toBe(200);
    expect(g.body.connection).toMatchObject({ id: connectionId, outletId: h.outletId, enabled: true, storeOpen: true, apiKey: "••••-key" });
    expect(JSON.stringify(g.body)).not.toContain(SECRET);
    expectNoSecrets(g.body);
    const before = await db.channelConnection.findUniqueOrThrow({ where: { id: connectionId } });
    const base = { baseUrl: hub.baseUrl, externalStoreId: "QA-1" };
    const bad = [
      {},
      { externalStoreId: "QA-1" },
      { ...base, baseUrl: "not a url" },
      { ...base, baseUrl: `${hub.baseUrl}/${"x".repeat(300)}` },
      { ...base, externalStoreId: "" },
      { ...base, provider: "SWIGGY_DIRECT" },
      { ...base, webhookSecret: "short" },
      { ...base, apiKey: "" },
      { ...base, enabled: "yes" },
      { ...base, commission: { ZOMATO: 101 } },
      { ...base, commission: { ZOMATO: -1 } },
      { ...base, commission: { UBER: 10 } },
    ];
    for (const b of bad) expect((await manager.call("PUT", "/channels/connection", b)).status, JSON.stringify(b)).toBe(400);
    expect(await db.channelConnection.findUniqueOrThrow({ where: { id: connectionId } })).toEqual(before);
    const ok = await manager.call("PUT", "/channels/connection", { ...base, enabled: true, outletId: h.outlet2Id, id: "x", storeOpen: false, commission: { ZOMATO: 22.5 } });
    expect(ok.status).toBe(200);
    expect(ok.body.connection).toMatchObject({ id: connectionId, outletId: h.outletId, storeOpen: true });
    // Secrets kept when not sent.
    expect((await db.channelConnection.findUniqueOrThrow({ where: { id: connectionId } })).webhookSecretEnc).toBe(before.webhookSecretEnc);
  });

  it("a new connection needs both secrets; outlet 2 gets its own connection", async () => {
    const r = await owner.call("PUT", "/channels/connection", { baseUrl: hub.baseUrl, externalStoreId: "QA-2" }, { "x-outlet-id": h.outlet2Id });
    expect(r.status).toBe(400);
    expect(await db.channelConnection.count({ where: { outletId: h.outlet2Id } })).toBe(0);
  });

  it("store toggle: bad body → 400; test → ok; menu-sync / retry-failed answer with counts", async () => {
    for (const b of [{}, { open: "true" }, { open: null }]) expect((await manager.call("POST", "/channels/connection/store", b)).status).toBe(400);
    expect((await manager.call("POST", "/channels/connection/test")).body).toEqual({ ok: true });
    const sync = await manager.call("POST", "/channels/connection/menu-sync");
    expect(sync.status).toBe(200);
    expect(sync.body.ok).toBe(true);
    expect(Number.isInteger(sync.body.items)).toBe(true);
    const retry = await manager.call("POST", "/channels/connection/retry-failed");
    expect(retry.status).toBe(200);
    expect(Number.isInteger(retry.body.retried)).toBe(true);
  });

  it("without a connection: GET answers null; actions → 404", async () => {
    const o2 = (k: string, p: string, b?: unknown) => owner.call(k, p, b, { "x-outlet-id": h.outlet2Id });
    expect((await o2("GET", "/channels/connection")).body).toEqual({ connection: null, failed: [] });
    for (const [m, p, b] of [["POST", "/channels/connection/test"], ["POST", "/channels/connection/store", { open: true }], ["POST", "/channels/connection/menu-sync"], ["POST", "/channels/connection/retry-failed"]] as const) {
      expect((await o2(m, p, b)).status, p).toBe(404);
    }
  });

  // QA finding (not fixed: needs a product decision — allowed hub hosts): the hub base URL can point at
  // any host, including loopback / link-local / private addresses, and the hub's error text is shown
  // back to the manager (test connection), so the API can be used to probe internal services.
  it.skip("refuses hub URLs on loopback / private / link-local addresses (SSRF)", async () => {
    for (const baseUrl of ["http://169.254.169.254/latest", "http://127.0.0.1:5432", "http://10.0.0.1", "http://localhost:3100"]) {
      expect((await manager.call("PUT", "/channels/connection", { baseUrl, externalStoreId: "QA-1" })).status).toBe(400);
    }
  });
});

describe("item map and channel orders", () => {
  it("items list shape; map / clear an external id; conflicts 409; bad bodies 400; unknown item 404", async () => {
    const items = await manager.call("GET", "/channels/items");
    expect(items.status).toBe(200);
    const chai = (items.body as { menuItemId: string; externalId: string; price: number | null }[]).find((i) => i.menuItemId === h.items.chai)!;
    expect(chai).toMatchObject({ externalId: h.items.chai, custom: false });
    expect((items.body as { menuItemId: string }[]).map((i) => i.menuItemId)).not.toContain(other.items.chai);

    const m = await manager.call("PUT", `/channels/items/${h.items.samosa}`, { externalId: NASTY.tamil });
    expect(m.status).toBe(200);
    expect(m.body).toEqual({ menuItemId: h.items.samosa, externalId: NASTY.tamil });
    expect((await manager.call("PUT", `/channels/items/${h.items.biryani}`, { externalId: NASTY.tamil })).status).toBe(409);
    for (const b of [{}, { externalId: "" }, { externalId: 5 }, { externalId: "x".repeat(101) }]) expect((await manager.call("PUT", `/channels/items/${h.items.biryani}`, b)).status).toBe(400);
    expect((await manager.call("PUT", `/channels/items/${ID}`, { externalId: "X" })).status).toBe(404);
    expect((await manager.call("PUT", `/channels/items/${other.items.chai}`, { externalId: "X" })).status).toBe(404);
    expect((await manager.call("PUT", `/channels/items/${h.items.samosa}`, { externalId: null })).body).toEqual({ menuItemId: h.items.samosa, externalId: h.items.samosa });
  });

  it("orders list: limit cap and shape (no payload); status push validation", async () => {
    const l = await manager.call("GET", "/channels/orders?limit=1");
    expect(l.status).toBe(200);
    expect(l.body).toHaveLength(1);
    expect(l.body[0]).not.toHaveProperty("payload");
    for (const q of ["limit=0", "limit=201", "limit=x"]) expect((await manager.call("GET", `/channels/orders?${q}`)).status, q).toBe(400);
    const row = ((await manager.call("GET", "/channels/orders")).body as { orderId: string; order: { grandTotal: number } }[]).find((r) => r.orderId === boardOrderId)!;
    expectPaise(row.order.grandTotal);
    for (const b of [{}, { status: "CANCELLED" }, { status: "BOGUS" }, { status: "DISPATCHED", reason: "x".repeat(201) }]) {
      expect((await manager.call("POST", `/channels/orders/${boardOrderId}/status`, b)).status, JSON.stringify(b)).toBe(400);
    }
    expect((await manager.call("POST", `/channels/orders/${ID}/status`, { status: "DISPATCHED" })).status).toBe(404);
    const counter = (await cashier.call("POST", "/orders", { orderType: "TAKEAWAY", items: [{ menuItemId: h.items.chai, quantity: 1 }] })).body.id;
    expect((await manager.call("POST", `/channels/orders/${counter}/status`, { status: "DISPATCHED" })).status).toBe(400);
  });
});

describe("packing board", () => {
  it("board / settings / slip / print shapes; slip shows the first name only", async () => {
    const b = await cashier.call("GET", "/channels/board");
    expect(b.status).toBe(200);
    const row = (b.body.orders as { orderId: string }[]).find((o) => o.orderId === boardOrderId);
    expect(row).toBeTruthy();
    expect((await c.kitchen.call("GET", "/channels/board/settings")).body).toEqual({ autoPrint: expect.any(Boolean) });
    for (const body of [{}, { autoPrint: "yes" }, { autoPrint: null }]) expect((await manager.call("PUT", "/channels/board/settings", body)).status).toBe(400);
    expect((await manager.call("PUT", "/channels/board/settings", { autoPrint: true, outletId: h.outlet2Id })).body).toEqual({ autoPrint: true });
    expect((await owner.call("GET", "/channels/board/settings", undefined, { "x-outlet-id": h.outlet2Id })).body.autoPrint).toBe(false);
    const slip = await cashier.call("GET", `/channels/board/${boardOrderId}/slip`);
    expect(slip.status).toBe(200);
    expect(slip.body).toMatchObject({ customerName: "Asha", amountDue: 0 });
    expectPaise(slip.body.amountDue);
    expectNoSecrets(slip.body);
    const print = await cashier.call("GET", `/channels/board/${boardOrderId}/print?paper=80`);
    expect(print.status).toBe(200);
    expect(typeof print.body.text).toBe("string");
    // A counter bill is not a board order.
    const counter = (await cashier.call("POST", "/orders", { orderType: "TAKEAWAY", items: [{ menuItemId: h.items.chai, quantity: 1 }] })).body.id;
    for (const [m, p] of [["GET", `/channels/board/${counter}/slip`], ["GET", `/channels/board/${counter}/print`], ["POST", `/channels/board/${counter}/packed`]] as const) {
      expect((await cashier.call(m, p)).status, p).toBe(404);
    }
  });

  it("packed → handover; packing twice is a no-op, handing over twice → 409; rider name validated", async () => {
    expect((await cashier.call("POST", `/channels/board/${boardOrderId}/packed`)).status).toBe(200);
    expect((await cashier.call("POST", `/channels/board/${boardOrderId}/packed`)).status).toBe(200);
    expect((await cashier.call("POST", `/channels/board/${boardOrderId}/handover`, { riderName: "x".repeat(101) })).status).toBe(400);
    expect((await cashier.call("POST", `/channels/board/${boardOrderId}/handover`, { riderName: 42 })).status).toBe(400);
    const r = await cashier.call("POST", `/channels/board/${boardOrderId}/handover`, { riderName: NASTY.hindi });
    expect(r.status).toBe(200);
    expect((await db.orderHandover.findUniqueOrThrow({ where: { orderId: boardOrderId } })).riderName).toBe(NASTY.hindi);
    expect((await cashier.call("POST", `/channels/board/${boardOrderId}/handover`, {})).status).toBe(409);
    expect((await cashier.call("POST", `/channels/board/${boardOrderId}/packed`)).status).toBe(409);
  });
});

describe("hub webhook (public)", () => {
  const post = (url: string, body: string, headers: Record<string, string> = {}) =>
    fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
  const signed = (raw: string, secret = SECRET) => ({ "x-hub-signature": signHubBody(raw, secret) });

  it("unknown / malformed connection id → 404 UNKNOWN_CONNECTION", async () => {
    const raw = JSON.stringify(newOrder("QA-U-1"));
    for (const id of [ID, "x", "%27%20OR%201%3D1--"]) {
      const r = await post(hookUrl(id), raw, signed(raw));
      expect(r.status).toBe(404);
      expect(r.body.error).toBe("UNKNOWN_CONNECTION");
    }
  });

  it("missing / wrong / other connection's / body-swapped signatures → 401, nothing created", async () => {
    const raw = JSON.stringify(newOrder(`QA-S-${++seq}`, [{ externalId: h.items.chai, quantity: 1 }]));
    const tampered = raw.replace('"quantity":1', '"quantity":9');
    const cases: Record<string, string>[] = [
      {},
      { "x-hub-signature": "" },
      { "x-hub-signature": "sha256=deadbeef" },
      signed(raw, "wrong-secret-123"),
      signed(raw, "other-hub-secret-99"),
      { "x-hub-signature": signHubBody(raw, SECRET).replace("sha256=", "sha1=") },
      { "x-hub-signature": signHubBody(raw, SECRET).toUpperCase() },
    ];
    for (const hd of cases) {
      const r = await post(hookUrl(), raw, hd);
      expect(r.status, JSON.stringify(hd)).toBe(401);
      expect(r.body.error).toBe("BAD_SIGNATURE");
    }
    // A valid signature for one body doesn't cover another.
    expect((await post(hookUrl(), tampered, signed(raw))).status).toBe(401);
    expect(await db.order.count({ where: { channelOrderId: `QA-S-${seq}` } })).toBe(0);
  });

  it("signed but malformed bodies → 400 BAD_PAYLOAD, never 500, nothing created", async () => {
    const id = `QA-P-${++seq}`;
    const bodies = [
      "not json",
      "",
      "null",
      "[]",
      JSON.stringify({ event: "order.new" }),
      JSON.stringify(newOrder(id, [])),
      JSON.stringify(newOrder(id, [{ externalId: h.items.chai, quantity: 0 }])),
      JSON.stringify(newOrder(id, [{ externalId: h.items.chai, quantity: -3 }])),
      JSON.stringify(newOrder(id, [{ externalId: h.items.chai, quantity: 1.5 }])),
      JSON.stringify(newOrder(id, [{ externalId: h.items.chai, quantity: 1e9 }])),
      JSON.stringify(newOrder(id, [{ externalId: h.items.chai, quantity: "2" }])),
      JSON.stringify(newOrder(id, [{ externalId: h.items.chai, quantity: 1, unitPrice: -100 }])),
      JSON.stringify(newOrder(id, [{ externalId: h.items.chai, quantity: 1 }], { totals: { total: -1 } })),
      JSON.stringify(newOrder("x".repeat(101), [{ externalId: h.items.chai, quantity: 1 }])),
      JSON.stringify({ event: "rider.status", order: { id, channel: "zomato" }, status: "teleported" }),
    ];
    for (const raw of bodies) {
      const r = await post(hookUrl(), raw, signed(raw));
      expect(r.status, raw.slice(0, 80)).toBe(400);
      expect(r.body.error).toBe("BAD_PAYLOAD");
    }
    expect(await db.order.count({ where: { channelOrderId: id } })).toBe(0);
    // An unknown event type is acknowledged and ignored.
    const ignored = JSON.stringify({ event: "store.ping" });
    expect((await post(hookUrl(), ignored, signed(ignored))).status).toBeLessThan(500);
  });

  it("prices come from our menu, never the payload; a replayed order makes no second bill", async () => {
    const id = `QA-R-${++seq}`;
    const raw = JSON.stringify(newOrder(id, [{ externalId: h.items.biryani, quantity: 1, unitPrice: 1 }], { totals: { total: 1 } }));
    const first = await post(hookUrl(), raw, signed(raw));
    expect(first.status).toBe(200);
    const order = await db.order.findUniqueOrThrow({ where: { id: first.body.orderId }, include: { payments: true } });
    expect(order.subtotal).toBeGreaterThanOrEqual(16000);
    expect(order.payments.reduce((s, p) => s + p.amount, 0)).toBe(order.grandTotal);
    expect(first.body.totalMismatch).toBe(true);
    // Replays: sequential and concurrent.
    expect((await post(hookUrl(), raw, signed(raw))).body).toMatchObject({ ok: true, duplicate: true, orderId: order.id });
    const burst = await Promise.all(Array.from({ length: 5 }, () => post(hookUrl(), raw, signed(raw))));
    expect(burst.every((r) => r.status === 200 && r.body.orderId === order.id)).toBe(true);
    expect(await db.order.count({ where: { outletId: h.outletId, channelOrderId: id } })).toBe(1);
  });

  it("concurrent first deliveries of the same order create exactly one bill", async () => {
    const id = `QA-C-${++seq}`;
    const raw = JSON.stringify(newOrder(id, [{ externalId: h.items.chai, quantity: 1 }]));
    const rs = await Promise.all(Array.from({ length: 6 }, () => post(hookUrl(), raw, signed(raw))));
    expect(rs.map((r) => r.status)).toEqual(rs.map(() => 200));
    expect(new Set(rs.map((r) => r.body.orderId)).size).toBe(1);
    expect(await db.order.count({ where: { outletId: h.outletId, channelOrderId: id } })).toBe(1);
    expect(await db.payment.count({ where: { orderId: rs[0].body.orderId } })).toBe(1);
  });

  it("an order for another hotel's item (or its connection id with our item) is refused", async () => {
    const raw = JSON.stringify(newOrder(`QA-X-${++seq}`, [{ externalId: other.items.chai, quantity: 1 }]));
    const r = await post(hookUrl(), raw, signed(raw));
    expect(r.status).toBe(422);
    expect(r.body.error).toBe("UNKNOWN_ITEM");
    const raw2 = JSON.stringify(newOrder(`QA-X-${++seq}`, [{ externalId: h.items.chai, quantity: 1 }]));
    expect((await post(hookUrl(otherConnectionId), raw2, signed(raw2, "other-hub-secret-99"))).status).toBe(422);
  });

  it("cancel / rider webhooks for unknown orders are acknowledged and change nothing; replayed cancel is idempotent", async () => {
    const unknown = JSON.stringify({ event: "order.cancelled", order: { id: "NOPE-1", channel: "zomato" } });
    expect((await post(hookUrl(), unknown, signed(unknown))).body).toMatchObject({ ok: true, ignored: "unknown order" });
    const id = `QA-K-${++seq}`;
    const raw = JSON.stringify(newOrder(id, [{ externalId: h.items.chai, quantity: 1 }], { payment: { prepaid: false } }));
    const orderId = (await post(hookUrl(), raw, signed(raw))).body.orderId;
    const cancel = JSON.stringify({ event: "order.cancelled", order: { id, channel: "zomato" }, reason: NASTY.xss });
    expect((await post(hookUrl(), cancel, signed(cancel))).status).toBe(200);
    expect((await db.order.findUniqueOrThrow({ where: { id: orderId } })).status).toBe("CANCELLED");
    expect((await post(hookUrl(), cancel, signed(cancel))).body).toMatchObject({ ok: true, duplicate: true });
    // Another hotel's connection can't cancel this hotel's order by its id.
    const id2 = `QA-K-${++seq}`;
    const raw2 = JSON.stringify(newOrder(id2, [{ externalId: h.items.chai, quantity: 1 }]));
    const order2 = (await post(hookUrl(), raw2, signed(raw2))).body.orderId;
    const cancel2 = JSON.stringify({ event: "order.cancelled", order: { id: id2, channel: "zomato" } });
    expect((await post(hookUrl(otherConnectionId), cancel2, signed(cancel2, "other-hub-secret-99"))).body).toMatchObject({ ignored: "unknown order" });
    expect((await db.order.findUniqueOrThrow({ where: { id: order2 } })).status).toBe("PAID");
  });

  it("a disabled connection / closed store refuses new orders; CHANNELS switched off → 403", async () => {
    await manager.call("POST", "/channels/connection/store", { open: false });
    const raw = JSON.stringify(newOrder(`QA-O-${++seq}`, [{ externalId: h.items.chai, quantity: 1 }]));
    expect((await post(hookUrl(), raw, signed(raw))).body.error).toBe("STORE_CLOSED");
    await manager.call("POST", "/channels/connection/store", { open: true });
    const b = await db.business.findUniqueOrThrow({ where: { id: other.businessId } });
    await db.business.update({ where: { id: other.businessId }, data: { modules: MODULES.filter((m) => m !== "CHANNELS") } });
    try {
      const raw2 = JSON.stringify(newOrder(`QA-O-${++seq}`, [{ externalId: other.items.chai, quantity: 1 }]));
      const r = await post(hookUrl(otherConnectionId), raw2, signed(raw2, "other-hub-secret-99"));
      expect(r.status).toBe(403);
      expect(r.body.error).toBe("CHANNELS_OFF");
    } finally {
      await db.business.update({ where: { id: other.businessId }, data: { modules: b.modules as string[] } });
    }
  });

  it("oversized bodies are refused (413), not a crash", async () => {
    const big = JSON.stringify({ event: "order.new", pad: "x".repeat(1_100_000) });
    const r = await post(hookUrl(), big, signed(big));
    expect(r.status).toBe(413);
  });
});
