/**
 * QA Phase 9 — concurrency, resilience, data integrity (gaps left after Phases 6–7).
 *  1. Two tills billing the last unit of a stock item (negative stock allowed): ledger = stock; an
 *     item 86'd mid-race: every bill is all-in (sold + deducted) or all-out (refused, nothing moved).
 *  2. Delivery partner at the dispatch limit, assigned at once by hand, by billing and by the sweep.
 *  3. Coupon at its usage limit (total and per customer) redeemed by several bills at once.
 *  4. Tab: two splits, split + new round, split + void, last payment + new round, close + new round.
 *  5. Two kitchen screens changing one KOT at once; two stations marking an aggregator order ready.
 *  6/7. Socket events only after commit (a round's kot:new goes through the outbox); a screen that
 *     missed events while disconnected recovers by refetching.
 *  8. A scheduled report job re-run while the first run is still going (pg-boss retry of a dead or
 *     hung runner): one email, and a failed send is given back for the next run.
 */
import { io as connect, type Socket } from "socket.io-client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createHotel, db, login, startServer, type Client, type Hotel } from "../integration/helpers";
import { runForOutlet } from "../../src/lib/tenant";
import { assignWaitingDeliveries } from "../../src/services/delivery-assign";
import { runDueSchedules } from "../../src/jobs-platform";

const mail = vi.hoisted(() => ({ sent: [] as string[], delayMs: 0, failNext: false }));
vi.mock("../../src/services/mailer", async (orig) => ({
  ...(await orig<typeof import("../../src/services/mailer")>()),
  sendMail: async (m: { to: string }) => {
    await new Promise((r) => setTimeout(r, mail.delayMs));
    if (mail.failNext) {
      mail.failNext = false;
      throw new Error("SMTP down");
    }
    mail.sent.push(m.to);
    return { delivered: true };
  },
}));

type R = { status: number; body: any }; // eslint-disable-line @typescript-eslint/no-explicit-any
const MODULES = ["BILLING", "KOT", "TABLES", "DELIVERY", "INVENTORY", "CUSTOMERS", "OFFERS", "REPORTS", "CHANNELS"];
let srv: Awaited<ReturnType<typeof startServer>>;
let h: Hotel;
let owner: Client, manager: Client, cashier: Client, kitchen: Client;

const ok = async (p: Promise<R>) => {
  const r = await p;
  if (r.status >= 300) throw new Error(`${r.status} ${JSON.stringify(r.body).slice(0, 300)}`);
  return r.body;
};
const no5xx = (rs: R[]) => expect(rs.filter((r) => r.status >= 500).map((r) => JSON.stringify(r.body).slice(0, 200))).toEqual([]);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const phone = () => `9${String(Math.floor(Math.random() * 1e9)).padStart(9, "0")}`;
const bill = (c: Client, extra: Record<string, unknown> = {}, items: unknown[] = [{ menuItemId: h.items.biryani, quantity: 1 }]): Promise<R> =>
  c.call("POST", "/orders", { orderType: "TAKEAWAY", items, ...extra });

beforeAll(async () => {
  srv = await startServer();
  h = await createHotel("Conc", { modules: MODULES });
  owner = await login(srv.base, h.users.owner.email, h.outletId);
  manager = await login(srv.base, h.users.manager.email, h.outletId);
  cashier = await login(srv.base, h.users.cashier.email, h.outletId);
  kitchen = await login(srv.base, h.users.kitchen.email, h.outletId);
}, 120_000);
afterAll(async () => {
  await srv.close();
});

// =====================================================================
describe("1. last unit of stock", () => {
  let paneer: string;
  const stock = async () => (await db.inventoryStock.findUniqueOrThrow({ where: { outletId_inventoryItemId: { outletId: h.outletId, inventoryItemId: paneer } } })).quantity;
  const ledger = () => db.inventoryTransaction.findMany({ where: { outletId: h.outletId, inventoryItemId: paneer }, orderBy: { createdAt: "asc" } });
  beforeAll(async () => {
    paneer = (await ok(owner.call("POST", "/inventory/items", { name: "Paneer", unit: "KG", openingStock: 1, costPerUnit: 1000 }))).id;
    await ok(owner.call("PUT", `/inventory/recipes/${h.items.samosa}`, { lines: [{ inventoryItemId: paneer, quantity: 1 }] }));
  });

  it("two cashiers sell the last unit at once: both bills stand, stock −1, every sale in the ledger", async () => {
    const samosa = [{ menuItemId: h.items.samosa, quantity: 1 }];
    const rs = await Promise.all([bill(cashier, {}, samosa), bill(manager, {}, samosa)]);
    no5xx(rs);
    expect(rs.map((r) => r.status)).toEqual([201, 201]);
    expect(await stock()).toBe(-1);
    const rows = await ledger();
    const sales = rows.filter((t) => t.type === "SALE");
    expect(sales.map((t) => t.refId).sort()).toEqual(rs.map((r) => r.body.id).sort());
    expect(sales.map((t) => t.balanceAfter).sort()).toEqual([-1, 0]); // serialised: no lost update
    expect(rows.reduce((s, t) => s + t.quantity, 0)).toBeCloseTo(await stock(), 6);
  });

  it("an item 86'd mid-race: each bill is sold+deducted or refused with nothing moved; afterwards refused", async () => {
    const samosa = [{ menuItemId: h.items.samosa, quantity: 1 }];
    const bills = Array.from({ length: 8 }, (_, i) => sleep(i * 15).then(() => bill(i % 2 ? manager : cashier, {}, samosa)));
    const eightySix = sleep(50).then(() => owner.call("PUT", `/menu/items/${h.items.samosa}/override`, { status: "OUT_OF_STOCK" }));
    const rs = await Promise.all(bills);
    expect((await eightySix).status).toBeLessThan(300);
    no5xx(rs);
    for (const r of rs) expect([201, 400]).toContain(r.status);
    const sold = rs.filter((r) => r.status === 201).map((r) => r.body.id as string);
    const sales = (await ledger()).filter((t) => t.type === "SALE" && sold.includes(t.refId!));
    expect(sales).toHaveLength(sold.length);
    expect((await ledger()).reduce((s, t) => s + t.quantity, 0)).toBeCloseTo(await stock(), 6);
    expect((await bill(cashier, {}, samosa)).status).toBe(400);
    await ok(owner.call("PUT", `/menu/items/${h.items.samosa}/override`, { status: null }));
  });
});

// =====================================================================
describe("2. delivery partner at the dispatch limit", () => {
  const delivery = (c: Client, extra: Record<string, unknown> = {}) =>
    c.call("POST", "/orders", {
      orderType: "DELIVERY",
      customerName: "Race",
      customerPhone: phone(),
      delivery: { address: "1 Race Street", latitude: 13.001, longitude: 80.2, ...extra },
      items: [{ menuItemId: h.items.biryani, quantity: 1 }],
    });
  const active = () => db.delivery.count({ where: { agentId: h.users.delivery.id, status: { in: ["PENDING", "ACCEPTED", "PREPARING", "OUT_FOR_DELIVERY"] } } });
  const autoAssign = (on: boolean) =>
    db.setting.upsert({ where: { scope_key: { scope: h.outletId, key: "delivery.autoAssign" } }, create: { scope: h.outletId, key: "delivery.autoAssign", value: on }, update: { value: on } });

  beforeAll(async () => {
    await db.staffAttendance.create({ data: { userId: h.users.delivery.id, outletId: h.outletId, workDate: new Date().toISOString().slice(0, 10), clockInAt: new Date(), clockInDistance: 0, status: "PRESENT" } });
  });

  it("manual assign ×2 + billing auto-assign + the waiting-orders sweep at once never exceed the limit (2)", async () => {
    for (let round = 0; round < 4; round++) {
      await db.delivery.updateMany({ where: { outletId: h.outletId, status: { not: "CANCELLED" } }, data: { status: "CANCELLED" } });
      await autoAssign(false);
      const ids = [];
      for (let i = 0; i < 4; i++) ids.push((await db.delivery.findFirstOrThrow({ where: { orderId: (await ok(delivery(cashier))).id } })).id);
      // The partner already holds one order: one slot left.
      await ok(cashier.call("PATCH", `/delivery/${ids[0]}/assign`, { agentId: h.users.delivery.id }));
      await autoAssign(true);
      const rs = await Promise.all([
        cashier.call("PATCH", `/delivery/${ids[1]}/assign`, { agentId: h.users.delivery.id }),
        cashier.call("PATCH", `/delivery/${ids[2]}/assign`, { agentId: h.users.delivery.id }),
        delivery(cashier),
        runForOutlet(h.outletId, () => assignWaitingDeliveries(h.outletId)).then(() => ({ status: 200, body: null })),
      ]);
      no5xx(rs);
      expect(await active()).toBe(2);
    }
  });
});

// =====================================================================
describe("3. coupon at its usage limit", () => {
  it("usage limit 1, five bills at once: exactly one gets it", async () => {
    await ok(owner.call("POST", "/offers/coupons", { code: "CCONE", discountType: "FLAT", value: 500, usageLimit: 1 }));
    const rs = await Promise.all(Array.from({ length: 5 }, (_, i) => bill(i % 2 ? manager : cashier, { couponCode: "CCONE", customerPhone: phone() })));
    no5xx(rs);
    expect(rs.filter((r) => r.status === 201)).toHaveLength(1);
    const c = await db.coupon.findFirstOrThrow({ where: { code: "CCONE" } });
    expect(c.usedCount).toBe(1);
    expect(await db.couponRedemption.count({ where: { couponId: c.id } })).toBe(1);
  });

  it("per-customer limit 1, the same customer billed five times at once: exactly one redemption", async () => {
    const p = phone();
    await ok(bill(cashier, { customerPhone: p })); // the customer exists
    await ok(owner.call("POST", "/offers/coupons", { code: "CCPER", discountType: "FLAT", value: 500, perCustomerLimit: 1 }));
    const rs = await Promise.all(Array.from({ length: 5 }, (_, i) => bill(i % 2 ? manager : cashier, { couponCode: "CCPER", customerPhone: p })));
    no5xx(rs);
    const c = await db.coupon.findFirstOrThrow({ where: { code: "CCPER" } });
    expect(await db.couponRedemption.count({ where: { couponId: c.id } })).toBe(1);
    expect(c.usedCount).toBe(1);
    expect(rs.filter((r) => r.status === 201)).toHaveLength(1);
  });
});

// =====================================================================
describe("4. running tab under concurrent changes", () => {
  let n = 0;
  async function openTab() {
    const table = await db.diningTable.create({ data: { outletId: h.outletId, label: `C${++n}` } });
    const s = await ok(cashier.call("POST", `/tables/${table.id}/open`, { guests: 2 }));
    const sessionId: string = s.id ?? s.session?.id;
    await ok(cashier.call("POST", `/tables/sessions/${sessionId}/items`, { items: [{ menuItemId: h.items.chai, quantity: 2, addonIds: [] }, { menuItemId: h.items.samosa, quantity: 1, addonIds: [] }] }));
    const items = await db.tableSessionItem.findMany({ where: { sessionId }, orderBy: { createdAt: "asc" } });
    return { sessionId, items };
  }
  const addRound = (sessionId: string) => manager.call("POST", `/tables/sessions/${sessionId}/items`, { items: [{ menuItemId: h.items.biryani, quantity: 1, addonIds: [] }] });
  /** Nothing billed twice, every bill's items marked with it, no unbilled food on a closed tab. */
  async function assertTab(sessionId: string) {
    const s = await db.tableSession.findUniqueOrThrow({ where: { id: sessionId } });
    const items = await db.tableSessionItem.findMany({ where: { sessionId } });
    const orders = await db.order.findMany({ where: { tableSessionId: sessionId }, include: { items: true } });
    expect(orders.reduce((k, o) => k + o.items.length, 0)).toBe(items.filter((i) => i.billedOrderId).length);
    if (s.status === "CLOSED") expect(items.filter((i) => !i.billedOrderId)).toEqual([]);
  }

  it("two cashiers split the same items at once: one split wins, the other is refused, nothing billed twice", async () => {
    const { sessionId, items } = await openTab();
    const split = { mode: "BY_ITEMS", groups: [[items[0].id], [items[1].id]] };
    const rs = await Promise.all([cashier.call("POST", `/tables/sessions/${sessionId}/bill`, split), manager.call("POST", `/tables/sessions/${sessionId}/bill`, split)]);
    no5xx(rs);
    expect(rs.map((r) => r.status).sort()).toEqual([201, 400]);
    expect(await db.order.count({ where: { tableSessionId: sessionId } })).toBe(2);
    await assertTab(sessionId);
  });

  it("split + a new round + a void at once: the round stays unbilled on the open tab, a billed item is never voided", async () => {
    for (let i = 0; i < 3; i++) {
      const { sessionId, items } = await openTab();
      const rs = await Promise.all([
        cashier.call("POST", `/tables/sessions/${sessionId}/bill`, { mode: "BY_ITEMS", groups: [[items[0].id], [items[1].id]] }),
        addRound(sessionId),
        owner.call("DELETE", `/tables/sessions/${sessionId}/items/${items[1].id}`, { reason: "race" }),
      ]);
      no5xx(rs);
      const [billed, round, voided] = rs;
      expect(round.status).toBe(201);
      // Either the void won (split refused, item gone) or the split won (void refused, item billed).
      expect([billed.status, voided.status].sort()).toEqual(billed.status === 201 ? [201, 409] : [200, 400]);
      const left = await db.tableSessionItem.findUnique({ where: { id: items[1].id } });
      if (billed.status === 201) expect(left?.billedOrderId).toBeTruthy();
      else expect(left).toBeNull();
      expect(await db.tableSessionItem.count({ where: { sessionId, billedOrderId: null, menuItemId: h.items.biryani } })).toBe(1);
      await assertTab(sessionId);
    }
  });

  it("paying the last bill while a waiter adds a round: the round is never lost on a closed tab", async () => {
    for (let i = 0; i < 4; i++) {
      const { sessionId } = await openTab();
      const b = await ok(cashier.call("POST", `/tables/sessions/${sessionId}/bill`, { mode: "FULL" }));
      const order = b.orders[0].order;
      const rs = await Promise.all([cashier.call("POST", `/orders/${order.id}/payments`, { payments: [{ mode: "CASH", amount: order.grandTotal }] }), addRound(sessionId)]);
      no5xx(rs);
      const s = await db.tableSession.findUniqueOrThrow({ where: { id: sessionId } });
      // Round first → tab stays open with it; payment first → tab closed and the round refused.
      if (rs[1].status === 201) expect(s.status).toBe("OPEN");
      else expect([rs[1].status, s.status]).toEqual([409, "CLOSED"]);
      await assertTab(sessionId);
    }
  });

  it("closing a fully paid tab while a round is added: never closed with unbilled food", async () => {
    for (let i = 0; i < 4; i++) {
      const { sessionId } = await openTab();
      const b = await ok(cashier.call("POST", `/tables/sessions/${sessionId}/bill`, { mode: "FULL" }));
      // Paid without closing (as if the tab was settled elsewhere) — then close and a new round race.
      await db.order.update({ where: { id: b.orders[0].order.id }, data: { status: "PAID", paidAt: new Date() } });
      const rs = await Promise.all([cashier.call("POST", `/tables/sessions/${sessionId}/close`), addRound(sessionId)]);
      no5xx(rs);
      expect(rs.map((r) => r.status).sort()).toEqual(rs[1].status === 201 ? [201, 409] : [200, 409]);
      await assertTab(sessionId);
    }
  });
});

// =====================================================================
describe("5. kitchen screens racing on one KOT", () => {
  const STAGE = { RECEIVED: 0, PREPARING: 1, READY: 2, SERVED: 3 } as const;
  const sane = (k: { status: keyof typeof STAGE; preparingAt: Date | null; readyAt: Date | null; servedAt: Date | null }) => {
    const at = STAGE[k.status];
    expect([k.preparingAt != null, k.readyAt != null, k.servedAt != null]).toEqual([at >= 1, at >= 2, at >= 3]);
    if (k.preparingAt && k.readyAt) expect(k.preparingAt.getTime()).toBeLessThanOrEqual(k.readyAt.getTime());
  };

  it("four taps on READY at once: READY, sane timestamps, one 'ready' alert per person", async () => {
    for (let i = 0; i < 3; i++) {
      const o = await ok(bill(cashier, {}, [{ menuItemId: h.items.chai, quantity: 1 }]));
      const kot = await db.kotTicket.findFirstOrThrow({ where: { orderId: o.id } });
      const rs = await Promise.all(Array.from({ length: 4 }, () => kitchen.call("PATCH", `/kot/${kot.id}`, { status: "READY" })));
      no5xx(rs);
      const k = await db.kotTicket.findUniqueOrThrow({ where: { id: kot.id } });
      expect(k.status).toBe("READY");
      sane(k);
      await sleep(400); // alerts are sent after the response
      const alerts = await db.notification.findMany({ where: { kind: "order.ready", body: { contains: o.invoiceNumber } } });
      expect(alerts.length).toBeGreaterThan(0);
      expect(new Set(alerts.map((a) => a.userId)).size).toBe(alerts.length);
    }
  });

  it("conflicting taps (PREPARING / READY / SERVED / back to RECEIVED) at once: timestamps match the final stage", async () => {
    for (let i = 0; i < 4; i++) {
      const o = await ok(bill(cashier, {}, [{ menuItemId: h.items.chai, quantity: 1 }]));
      const kot = await db.kotTicket.findFirstOrThrow({ where: { orderId: o.id } });
      const rs = await Promise.all((["PREPARING", "READY", "SERVED", "RECEIVED", "READY"] as const).map((status) => kitchen.call("PATCH", `/kot/${kot.id}`, { status })));
      no5xx(rs);
      sane(await db.kotTicket.findUniqueOrThrow({ where: { id: kot.id } }));
    }
  });

  it("two stations mark an aggregator order's KOTs ready at once: 'food ready' is queued for the channel", async () => {
    await db.menuItem.update({ where: { id: h.items.biryani }, data: { kitchenStation: "TANDOOR" } });
    const conn = await db.channelConnection.create({ data: { outletId: h.outletId, baseUrl: "http://127.0.0.1:9", externalStoreId: "conc", enabled: false } });
    for (let i = 0; i < 4; i++) {
      const o = await ok(bill(cashier, {}, [{ menuItemId: h.items.chai, quantity: 1 }, { menuItemId: h.items.biryani, quantity: 1 }]));
      const kots = await db.kotTicket.findMany({ where: { orderId: o.id } });
      expect(kots).toHaveLength(2);
      const row = await db.channelOrder.create({ data: { outletId: h.outletId, connectionId: conn.id, sourceChannel: "ZOMATO", channelOrderId: `Z${Date.now()}${i}`, orderId: o.id, status: "ACCEPTED", payload: {} } });
      const rs = await Promise.all(kots.map((k) => kitchen.call("PATCH", `/kot/${k.id}`, { status: "READY" })));
      no5xx(rs);
      expect((await db.channelOrder.findUniqueOrThrow({ where: { id: row.id } })).foodReadyQueuedAt).not.toBeNull();
    }
    await db.menuItem.update({ where: { id: h.items.biryani }, data: { kitchenStation: "MAIN" } });
  });
});

// =====================================================================
describe("6/7. socket events after commit; recovery after a dropped socket", () => {
  let sock: Socket;
  const got: { event: string; payload: any }[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any
  const waitFor = async (cond: () => boolean | Promise<boolean>, ms = 5000) => {
    const t0 = Date.now();
    while (!(await cond())) {
      if (Date.now() - t0 > ms) throw new Error("timed out");
      await sleep(50);
    }
  };
  beforeAll(async () => {
    sock = connect(srv.base, { auth: { token: kitchen.token, outletId: h.outletId }, transports: ["websocket"] });
    await new Promise<void>((resolve, reject) => {
      sock.once("connect", () => resolve());
      sock.once("connect_error", reject);
    });
    sock.onAny((event, payload) => got.push({ event, payload }));
  });
  afterAll(() => {
    sock?.disconnect();
  });

  it("a running-tab round's kot:new goes through the outbox (same transaction), and arrives", async () => {
    const table = await db.diningTable.create({ data: { outletId: h.outletId, label: "SOCK" } });
    const s = await ok(cashier.call("POST", `/tables/${table.id}/open`, { guests: 1 }));
    const sessionId: string = s.id ?? s.session?.id;
    const r = await ok(cashier.call("POST", `/tables/sessions/${sessionId}/items`, { items: [{ menuItemId: h.items.chai, quantity: 1, addonIds: [] }] }));
    const kotId = r.kots[0].id;
    const rows = await db.outboxEvent.findMany({ where: { name: "kot:new", target: h.outletId }, orderBy: { seq: "desc" }, take: 5 });
    expect(rows.some((e) => JSON.stringify(e.payload).includes(kotId))).toBe(true);
    await waitFor(() => got.some((g) => g.event === "kot:new" && JSON.stringify(g.payload).includes(kotId)));
  });

  it("a rolled-back round (tab closed meanwhile) emits nothing", async () => {
    const table = await db.diningTable.create({ data: { outletId: h.outletId, label: "SOCK2" } });
    const s = await ok(cashier.call("POST", `/tables/${table.id}/open`, { guests: 1 }));
    const sessionId: string = s.id ?? s.session?.id;
    const kotEvents = () => db.outboxEvent.count({ where: { name: { in: ["kot:new", "kitchen.alert"] } } });
    const before = await kotEvents();
    const seen = got.length;
    // The tab was closed meanwhile (another screen): the round is refused and leaves no event behind.
    await db.tableSession.update({ where: { id: sessionId }, data: { status: "CLOSED" } });
    expect((await addRoundRaw(sessionId)).status).toBe(409);
    await sleep(300);
    expect(await kotEvents()).toBe(before);
    expect(got.slice(seen).filter((g) => g.event === "kot:new")).toEqual([]);
  });
  const addRoundRaw = (sessionId: string) => cashier.call("POST", `/tables/sessions/${sessionId}/items`, { items: [{ menuItemId: h.items.chai, quantity: 1, addonIds: [] }] });

  it("a screen that was disconnected while a KOT was raised finds it on reconnect (refetch)", async () => {
    sock.disconnect();
    const seen = got.length;
    const o = await ok(bill(cashier, {}, [{ menuItemId: h.items.chai, quantity: 1 }]));
    const kot = await db.kotTicket.findFirstOrThrow({ where: { orderId: o.id } });
    await sleep(300);
    sock.connect();
    await waitFor(() => sock.connected);
    // The live event is gone for this socket (no replay) — the screen reloads on "connect" (web: kitchen,
    // tables, bills, delivery, POS menu) and the list has the ticket.
    expect(got.slice(seen).some((g) => g.event === "kot:new" && JSON.stringify(g.payload).includes(kot.id))).toBe(false);
    const list = await ok(kitchen.call("GET", "/kot"));
    expect(list.some((k: { id: string }) => k.id === kot.id)).toBe(true);
  });
});

// =====================================================================
describe("8. scheduled report job re-run while the first run is still going", () => {
  // 22:30 IST: a daily schedule is due.
  const due = new Date(`${new Date().toISOString().slice(0, 10)}T17:00:00.000Z`);
  it("two overlapping runs (pg-boss retry of a hung runner) send one email", async () => {
    const s = await db.reportSchedule.create({ data: { outletId: h.outletId, email: "owner@conc.test", frequency: "DAILY", reports: ["sales"] } });
    mail.sent.length = 0;
    mail.delayMs = 300;
    await Promise.all([runDueSchedules(due), runDueSchedules(due)]);
    expect(mail.sent.filter((t) => t === "owner@conc.test")).toHaveLength(1);
    expect((await db.reportSchedule.findUniqueOrThrow({ where: { id: s.id } })).lastSentAt).not.toBeNull();
    await db.reportSchedule.update({ where: { id: s.id }, data: { active: false } });
  });

  it("a run that dies on the send leaves the schedule due: the retry sends it once", async () => {
    const s = await db.reportSchedule.create({ data: { outletId: h.outletId, email: "retry@conc.test", frequency: "DAILY", reports: ["sales"] } });
    mail.sent.length = 0;
    mail.delayMs = 0;
    mail.failNext = true;
    await runDueSchedules(due);
    expect(mail.sent).toEqual([]);
    expect((await db.reportSchedule.findUniqueOrThrow({ where: { id: s.id } })).lastSentAt).toBeNull();
    await runDueSchedules(due);
    await runDueSchedules(due);
    expect(mail.sent.filter((t) => t === "retry@conc.test")).toHaveLength(1);
  });
});
