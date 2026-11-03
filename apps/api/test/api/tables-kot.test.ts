/**
 * QA Phase 6 — /tables (floor, areas, tables, running tabs: open, KOT rounds, void, transfer, merge,
 * split bills, close) and /kot (kitchen display, status, print). Contract, roles, module gating,
 * tenant / outlet isolation, validation, and races (two devices opening one table, billing twice).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHotel, login, startServer } from "../integration/helpers";
import { assertIntegerMoney, assertNoSecrets, db, LONG, makeWorld, roleMatrix, SQLI, UNICODE_NAME, type Client, type World } from "./service-fixtures";

let srv: Awaited<ReturnType<typeof startServer>>;
let w: World;
let manager: Client, cashier: Client, waiter: Client, kitchen: Client;
let seq = 0;

beforeAll(async () => {
  srv = await startServer();
  w = await makeWorld(srv.base, "Tables API");
  ({ manager, cashier, waiter, kitchen } = w.as);
});
afterAll(() => srv.close());

const mkTable = async (extra: Record<string, unknown> = {}) => {
  const r = await manager.call("POST", "/tables", { label: `T${++seq}`, capacity: 4, ...extra });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body as { id: string; label: string };
};
const openTab = async (tableId: string, c: Client = waiter) => {
  const r = await c.call("POST", `/tables/${tableId}/open`, { guests: 2 });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body as { id: string };
};
const addRound = (sessionId: string, items: object[], c: Client = waiter) => c.call("POST", `/tables/sessions/${sessionId}/items`, { items });
const item = (menuItemId: string, quantity = 1, extra: object = {}) => ({ menuItemId, quantity, ...extra });

// =====================================================================
describe("areas and tables", () => {
  it("create / list / patch / delete a table and an area; integer layout fields; unicode label", async () => {
    const area = await manager.call("POST", "/tables/areas", { name: "மாடி Terrace 🌴" });
    expect(area.status).toBe(201);
    expect(area.body.name).toBe("மாடி Terrace 🌴");
    const t = await mkTable({ label: "மேசை 1", areaId: area.body.id, outletId: w.h.outlet2Id, status: "OCCUPIED", qrToken: "hack" });
    const got = await waiter.call("GET", `/tables/${t.id}`);
    expect(got.status).toBe(200);
    expect(got.body).toMatchObject({ label: "மேசை 1", outletId: w.h.outletId, status: "AVAILABLE", session: null });
    expect(got.body.qrToken).not.toBe("hack");
    expect((await manager.call("PATCH", `/tables/${t.id}`, { capacity: 6, outletId: w.h.outlet2Id })).body).toMatchObject({ capacity: 6, outletId: w.h.outletId });
    expect((await waiter.call("GET", "/tables")).body.map((x: { id: string }) => x.id)).toContain(t.id);
    expect((await waiter.call("GET", "/tables/areas")).status).toBe(200);
    expect((await manager.call("PATCH", `/tables/areas/${area.body.id}`, { name: "Roof" })).body.name).toBe("Roof");
    expect((await manager.call("DELETE", `/tables/areas/${area.body.id}`)).status).toBe(204);
    expect((await manager.call("DELETE", `/tables/${t.id}`)).status).toBe(204);
    expect((await manager.call("GET", `/tables/${t.id}`)).status).toBe(404);
  });

  it("duplicate label → 409, not 500", async () => {
    const t = await mkTable();
    expect((await manager.call("POST", "/tables", { label: t.label })).status).toBe(409);
  });

  const badTables: [string, object][] = [
    ["no label", {}],
    ["empty label", { label: "" }],
    ["spaces label", { label: "   " }],
    ["label 10k", { label: LONG }],
    ["capacity 0", { label: "Z1", capacity: 0 }],
    ["capacity 51", { label: "Z1", capacity: 51 }],
    ["capacity float", { label: "Z1", capacity: 2.5 }],
    ["capacity string", { label: "Z1", capacity: "4" }],
    ["shape bad", { label: "Z1", shape: "STAR" }],
    ["posX 501", { label: "Z1", posX: 501 }],
    ["rotation 360", { label: "Z1", rotation: 360 }],
    ["label null", { label: null }],
  ];
  it.each(badTables)("POST /tables %s → 400, nothing written", async (_n, body) => {
    const before = await db.diningTable.count({ where: { outletId: w.h.outletId } });
    expect((await manager.call("POST", "/tables", body)).status).toBe(400);
    expect(await db.diningTable.count({ where: { outletId: w.h.outletId } })).toBe(before);
  });

  it("unknown area / foreign waiter / foreign table in a layout → 400 or 404", async () => {
    expect((await manager.call("POST", "/tables", { label: "ZZ1", areaId: "cl0000000000000000000000" })).status).toBe(404);
    expect((await manager.call("POST", "/tables", { label: "ZZ2", waiterId: w.other.users.cashier.id })).status).toBe(400);
    const t = await mkTable();
    const foreignTable = await db.diningTable.create({ data: { outletId: w.other.outletId, label: `F${seq}` } });
    const pos = { posX: 1, posY: 1, width: 2, height: 2, rotation: 0 };
    expect((await manager.call("PUT", "/tables/layout", { tables: [{ id: foreignTable.id, ...pos }] })).status).toBe(400);
    expect((await manager.call("PUT", "/tables/layout", { tables: [] })).status).toBe(400);
    const ok = await manager.call("PUT", "/tables/layout", { tables: [{ id: t.id, ...pos, posX: 7 }] });
    expect(ok.status).toBe(200);
    expect(ok.body.find((x: { id: string }) => x.id === t.id).posX).toBe(7);
    expect((await db.diningTable.findUniqueOrThrow({ where: { id: foreignTable.id } })).posX).toBe(0);
  });

  it("status: OCCUPIED without a tab → 400; AVAILABLE with a tab → 409; bad status → 400", async () => {
    const t = await mkTable();
    expect((await waiter.call("PATCH", `/tables/${t.id}/status`, { status: "OCCUPIED" })).status).toBe(400);
    expect((await waiter.call("PATCH", `/tables/${t.id}/status`, { status: "DIRTY" })).status).toBe(400);
    expect((await waiter.call("PATCH", `/tables/${t.id}/status`, { status: "NEEDS_ATTENTION" })).status).toBe(200);
    await openTab(t.id);
    expect((await waiter.call("PATCH", `/tables/${t.id}/status`, { status: "AVAILABLE" })).status).toBe(409);
    expect((await manager.call("DELETE", `/tables/${t.id}`)).status).toBe(409);
    expect((await manager.call("PATCH", `/tables/${t.id}`, { active: false })).status).toBe(409);
  });

  it("waiter assignment: someone of this outlet only", async () => {
    const t = await mkTable();
    expect((await waiter.call("PATCH", `/tables/${t.id}/waiter`, { waiterId: w.other.users.cashier.id })).status).toBe(400);
    expect((await waiter.call("PATCH", `/tables/${t.id}/waiter`, { waiterId: w.h.users.cashier.id })).body.waiterId).toBe(w.h.users.cashier.id);
    expect((await waiter.call("PATCH", `/tables/${t.id}/waiter`, { waiterId: null })).body.waiterId).toBeNull();
  });

  it("floor view: shape, stats, no secrets", async () => {
    const r = await waiter.call("GET", "/tables/floor");
    expect(r.status).toBe(200);
    expect(r.body.stats).toMatchObject({ tables: expect.any(Number), occupied: expect.any(Number) });
    assertNoSecrets(r.body);
    assertIntegerMoney(r.body);
  });

  it("roles: table:serve (owner, manager, cashier, waiter) reads; table:manage (owner, manager) writes", async () => {
    expect(await roleMatrix(w, ["owner", "manager", "cashier", "waiter"], (c) => c.call("GET", "/tables/floor"), 200)).toEqual([]);
    expect(await roleMatrix(w, ["owner", "manager"], (c, role) => c.call("POST", "/tables", { label: `R-${role}-${seq++}` }), 201)).toEqual([]);
    expect(await roleMatrix(w, ["owner", "manager"], (c, role) => c.call("POST", "/tables/areas", { name: `Area ${role}` }), 201)).toEqual([]);
  });

  it("isolation: another hotel / an unassigned outlet / super admin / TABLES module off", async () => {
    const t = await mkTable();
    expect((await w.otherOwner.call("GET", `/tables/${t.id}`)).status).toBe(404);
    expect((await w.otherOwner.call("PATCH", `/tables/${t.id}`, { label: "pwned" })).status).toBe(404);
    expect((await w.otherOwner.call("DELETE", `/tables/${t.id}`)).status).toBe(404);
    expect((await w.otherOwner.call("POST", `/tables/${t.id}/open`, {})).status).toBe(404);
    expect((await w.otherOwner.call("GET", "/tables/floor", undefined, { "x-outlet-id": w.h.outletId })).status).toBe(403);
    expect((await w.managerOutlet2.call("GET", "/tables/floor")).status).toBe(403);
    expect((await w.admin.call("GET", "/tables/floor")).status).toBe(403);
    const off = await createHotel("No tables", { modules: ["BILLING"] });
    const offOwner = await login(srv.base, off.users.owner.email, off.outletId);
    expect((await offOwner.call("GET", "/tables/floor")).status).toBe(403);
    expect((await offOwner.call("GET", "/kot")).status).toBe(403);
    expect((await db.diningTable.findUniqueOrThrow({ where: { id: t.id } })).label).toBe(t.label);
  });
});

// =====================================================================
describe("running tabs: open, rounds, void, transfer, merge", () => {
  it("open → 201 with an empty tab; a second open → 409; guests validated", async () => {
    const t = await mkTable();
    for (const body of [{ guests: 0 }, { guests: 101 }, { guests: 1.5 }, { guests: "2" }, { customerPhone: "1" }, { customerName: LONG }]) {
      expect((await waiter.call("POST", `/tables/${t.id}/open`, body)).status, JSON.stringify(body).slice(0, 40)).toBe(400);
    }
    const s = await openTab(t.id);
    expect(s).toMatchObject({ status: "OPEN", tableId: t.id, unbilledCount: 0, waiterId: expect.any(String) });
    expect((await waiter.call("POST", `/tables/${t.id}/open`, {})).status).toBe(409);
  });

  it("two devices opening the same table at the same moment → one tab", async () => {
    const t = await mkTable();
    const rs = await Promise.all([waiter.call("POST", `/tables/${t.id}/open`, {}), cashier.call("POST", `/tables/${t.id}/open`, {}), manager.call("POST", `/tables/${t.id}/open`, {})]);
    expect(rs.filter((r) => r.status === 201)).toHaveLength(1);
    expect(rs.filter((r) => r.status === 409)).toHaveLength(2);
    expect(await db.tableSession.count({ where: { tableId: t.id, status: "OPEN" } })).toBe(1);
  });

  it("each round fires its own KOT; items validated; server prices", async () => {
    const t = await mkTable();
    const s = await openTab(t.id);
    const r1 = await addRound(s.id, [item(w.h.items.chai, 2, { seat: 1, unitPrice: 1 }), item(w.h.items.biryani, 1, { seat: 2, notes: UNICODE_NAME })]);
    expect(r1.status).toBe(201);
    expect(r1.body.kots.length).toBeGreaterThanOrEqual(1);
    const r2 = await addRound(s.id, [item(w.h.items.samosa)]);
    expect(r2.body.kots[0].kotNumber).toBeGreaterThan(Math.max(...r1.body.kots.map((k: { kotNumber: number }) => k.kotNumber)));
    const detail = r2.body.session;
    expect(detail.items).toHaveLength(3);
    expect(detail.items.find((i: { menuItemId: string }) => i.menuItemId === w.h.items.chai).unitPrice).toBe(1500);
    expect(detail.items.find((i: { menuItemId: string }) => i.menuItemId === w.h.items.biryani).notes).toBe(UNICODE_NAME);
    assertIntegerMoney(detail);

    const bad: object[][] = [
      [],
      [item(w.h.items.chai, 0)],
      [item(w.h.items.chai, -1)],
      [item(w.h.items.chai, 1.5)],
      [item(w.h.items.chai, 1000)],
      [item(w.h.items.chai, 1, { seat: 0 })],
      [item(w.h.items.chai, 1, { notes: LONG })],
      [item("cl0000000000000000000000")],
      [item(w.other.items.chai)],
      Array.from({ length: 101 }, () => item(w.h.items.chai)),
    ];
    const before = await db.tableSessionItem.count({ where: { sessionId: s.id } });
    for (const items of bad) expect((await addRound(s.id, items)).status, JSON.stringify(items).slice(0, 60)).toBe(400);
    expect((await waiter.call("POST", `/tables/sessions/${s.id}/items`, {})).status).toBe(400);
    expect(await db.tableSessionItem.count({ where: { sessionId: s.id } })).toBe(before);
  });

  it("void an item: order:cancel only (owner, manager); marks it VOID on the KOT; billed item → 409", async () => {
    const t = await mkTable();
    const s = await openTab(t.id);
    const round = (await addRound(s.id, [item(w.h.items.chai), item(w.h.items.samosa), item(w.h.items.biryani)])).body.session;
    const [a, b] = round.items;
    expect((await waiter.call("DELETE", `/tables/sessions/${s.id}/items/${a.id}`, { reason: "wrong dish" })).status).toBe(403);
    expect((await cashier.call("DELETE", `/tables/sessions/${s.id}/items/${a.id}`, { reason: "wrong dish" })).status).toBe(403);
    const v = await manager.call("DELETE", `/tables/sessions/${s.id}/items/${a.id}`, { reason: "wrong dish" });
    expect(v.status).toBe(200);
    const kot = await db.kotTicket.findUniqueOrThrow({ where: { id: a.kotId } });
    expect((kot.items as { sessionItemId: string; voided?: boolean }[]).find((e) => e.sessionItemId === a.id)?.voided).toBe(true);
    expect((await manager.call("DELETE", `/tables/sessions/${s.id}/items/${a.id}`, {})).status).toBe(404);
    expect((await manager.call("DELETE", `/tables/sessions/${s.id}/items/${b.id}`, { reason: "x".repeat(201) })).status).toBe(400);
    const bill = await cashier.call("POST", `/tables/sessions/${s.id}/bill`, { mode: "BY_ITEMS", itemIds: [b.id] });
    expect(bill.status).toBe(201);
    expect((await manager.call("DELETE", `/tables/sessions/${s.id}/items/${b.id}`, { reason: "too late" })).status).toBe(409);
  });

  it("transfer: to an occupied table → 409; to itself → 400; unknown → 404; ok → old table free", async () => {
    const [t1, t2, t3] = [await mkTable(), await mkTable(), await mkTable()];
    const s = await openTab(t1.id);
    await openTab(t2.id);
    expect((await waiter.call("POST", `/tables/sessions/${s.id}/transfer`, { toTableId: t2.id })).status).toBe(409);
    expect((await waiter.call("POST", `/tables/sessions/${s.id}/transfer`, { toTableId: t1.id })).status).toBe(400);
    expect((await waiter.call("POST", `/tables/sessions/${s.id}/transfer`, { toTableId: "cl0000000000000000000000" })).status).toBe(404);
    expect((await waiter.call("POST", `/tables/sessions/${s.id}/transfer`, {})).status).toBe(400);
    const ok = await waiter.call("POST", `/tables/sessions/${s.id}/transfer`, { toTableId: t3.id });
    expect(ok.status).toBe(200);
    expect(ok.body.tableId).toBe(t3.id);
    expect((await db.diningTable.findUniqueOrThrow({ where: { id: t1.id } })).status).toBe("AVAILABLE");
  });

  it("merge: pulls in another tab's items and guests; empty / unknown table list refused", async () => {
    const [t1, t2, t3] = [await mkTable(), await mkTable(), await mkTable()];
    const s1 = await openTab(t1.id);
    const s2 = await openTab(t2.id);
    await addRound(s2.id, [item(w.h.items.chai)]);
    expect((await waiter.call("POST", `/tables/sessions/${s1.id}/merge`, { tableIds: [] })).status).toBe(400);
    expect((await waiter.call("POST", `/tables/sessions/${s1.id}/merge`, { tableIds: ["cl0000000000000000000000"] })).status).toBe(404);
    const m = await waiter.call("POST", `/tables/sessions/${s1.id}/merge`, { tableIds: [t2.id, t3.id] });
    expect(m.status).toBe(200);
    expect(m.body.mergedTableIds.sort()).toEqual([t2.id, t3.id].sort());
    expect(m.body.guests).toBe(4);
    expect(m.body.items).toHaveLength(1);
    expect((await db.tableSession.findUniqueOrThrow({ where: { id: s2.id } })).status).toBe("CLOSED");
    expect((await waiter.call("POST", `/tables/sessions/${s2.id}/items`, { items: [item(w.h.items.chai)] })).status).toBe(409);
  });

  it("session patch validates; sessions list filters; cross-tenant session ids → 404", async () => {
    const t = await mkTable();
    const s = await openTab(t.id);
    expect((await waiter.call("PATCH", `/tables/sessions/${s.id}`, { guests: 0 })).status).toBe(400);
    expect((await waiter.call("PATCH", `/tables/sessions/${s.id}`, { customerName: UNICODE_NAME, status: "CLOSED" })).body).toMatchObject({ customerName: UNICODE_NAME, status: "OPEN" });
    expect((await waiter.call("GET", "/tables/sessions")).body.map((x: { id: string }) => x.id)).toContain(s.id);
    expect((await waiter.call("GET", "/tables/sessions?status=CLOSED")).body.map((x: { id: string }) => x.id)).not.toContain(s.id);
    for (const [m, p, b] of [["GET", `/tables/sessions/${s.id}`, undefined], ["PATCH", `/tables/sessions/${s.id}`, { guests: 3 }], ["POST", `/tables/sessions/${s.id}/items`, { items: [item(w.other.items.chai)] }], ["POST", `/tables/sessions/${s.id}/bill`, {}], ["POST", `/tables/sessions/${s.id}/close`, {}]] as const) {
      expect((await w.otherOwner.call(m, p, b)).status, `${m} ${p}`).toBe(404);
    }
  });
});

// =====================================================================
describe("tab bills (split) and close", () => {
  it("billing roles: owner, manager, cashier (waiters serve, don't bill)", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 9; i++) {
      const s = await openTab((await mkTable()).id);
      await addRound(s.id, [item(w.h.items.chai)]);
      ids.push(s.id);
    }
    let i = 0;
    expect(await roleMatrix(w, ["owner", "manager", "cashier"], (c) => c.call("POST", `/tables/sessions/${ids[i++]}/bill`, {}), 201)).toEqual([]);
  });

  it("FULL → one bill at server prices, KOTs linked; nothing left → 400; closing needs it paid", async () => {
    const t = await mkTable();
    const s = await openTab(t.id);
    await addRound(s.id, [item(w.h.items.biryani, 2)]);
    expect((await waiter.call("POST", `/tables/sessions/${s.id}/close`, {})).status).toBe(409);
    const b = await cashier.call("POST", `/tables/sessions/${s.id}/bill`, { mode: "FULL", grandTotal: 1, items: [{ menuItemId: w.h.items.chai, quantity: 1 }] });
    expect(b.status).toBe(201);
    const order = b.body.orders[0].order;
    expect(order.subtotal).toBe(32000);
    expect(order.orderType).toBe("DINE_IN");
    expect(order.tableSessionId).toBe(s.id);
    assertIntegerMoney(b.body);
    expect((await cashier.call("POST", `/tables/sessions/${s.id}/bill`, {})).status).toBe(400);
    expect((await waiter.call("POST", `/tables/sessions/${s.id}/close`, {})).status).toBe(409);
    expect((await cashier.call("POST", `/orders/${order.id}/payments`, { payments: [{ mode: "CASH", amount: order.grandTotal }] })).status).toBe(200);
    const c = await waiter.call("POST", `/tables/sessions/${s.id}/close`, {});
    expect([200, 409]).toContain(c.status); // paying the last bill may already auto-close the tab
    expect((await db.tableSession.findUniqueOrThrow({ where: { id: s.id } })).status).toBe("CLOSED");
    expect((await waiter.call("POST", `/tables/sessions/${s.id}/close`, {})).status).toBe(409);
    expect((await db.diningTable.findUniqueOrThrow({ where: { id: t.id } })).status).toBe("AVAILABLE");
  });

  it("two cashiers billing the same tab at once → billed once", async () => {
    const s = await openTab((await mkTable()).id);
    await addRound(s.id, [item(w.h.items.chai), item(w.h.items.samosa)]);
    const rs = await Promise.all([cashier.call("POST", `/tables/sessions/${s.id}/bill`, {}), manager.call("POST", `/tables/sessions/${s.id}/bill`, {})]);
    expect(rs.filter((r) => r.status === 201)).toHaveLength(1);
    expect(rs.every((r) => r.status < 500)).toBe(true);
    expect(await db.order.count({ where: { tableSessionId: s.id } })).toBe(1);
  });

  it("EQUAL split parts sum exactly to the bill; BY_SEAT one bill per seat; bad split input → 400", async () => {
    const s = await openTab((await mkTable()).id);
    await addRound(s.id, [item(w.h.items.chai, 1, { seat: 1 }), item(w.h.items.samosa, 1, { seat: 2 }), item(w.h.items.biryani, 1, { seat: 3 })]);
    const items = (await waiter.call("GET", `/tables/sessions/${s.id}`)).body.items as { id: string }[];
    for (const body of [
      { mode: "EQUAL" },
      { mode: "EQUAL", parts: 1 },
      { mode: "EQUAL", parts: 51 },
      { mode: "EQUAL", parts: 2.5 },
      { mode: "BY_ITEMS" },
      { mode: "BY_ITEMS", itemIds: ["cl0000000000000000000000"] },
      { mode: "BY_ITEMS", groups: [[items[0].id], [items[0].id]] },
      { mode: "BY_SEAT", seats: [99] },
      { mode: "SPLIT_ALL" },
      { mode: "BY_ITEMS", groups: [[items[0].id], [items[1].id]], discount: { type: "FLAT", value: 100 } },
      { discount: { type: "PERCENT", value: 150 } },
    ]) {
      expect((await cashier.call("POST", `/tables/sessions/${s.id}/bill`, body)).status, JSON.stringify(body)).toBe(400);
    }
    expect(await db.order.count({ where: { tableSessionId: s.id } })).toBe(0);
    const seat = await cashier.call("POST", `/tables/sessions/${s.id}/bill`, { mode: "BY_SEAT", seats: [1, 2] });
    expect(seat.status).toBe(201);
    expect(seat.body.orders).toHaveLength(2);
    const eq = await cashier.call("POST", `/tables/sessions/${s.id}/bill`, { mode: "EQUAL", parts: 3 });
    expect(eq.status).toBe(201);
    const parts = eq.body.equalSplit as number[];
    expect(parts).toHaveLength(3);
    expect(parts.every(Number.isInteger)).toBe(true);
    expect(parts.reduce((a, b) => a + b, 0)).toBe(eq.body.orders[0].order.grandTotal);
  });

  it("cancelling a tab bill puts its items back on the tab", async () => {
    const s = await openTab((await mkTable()).id);
    await addRound(s.id, [item(w.h.items.chai)]);
    const b = await cashier.call("POST", `/tables/sessions/${s.id}/bill`, {});
    expect((await manager.call("POST", `/orders/${b.body.orders[0].order.id}/cancel`, { reason: "re-bill" })).status).toBe(200);
    expect((await waiter.call("GET", `/tables/sessions/${s.id}`)).body.unbilledCount).toBe(1);
  });
});

// =====================================================================
describe("/kot", () => {
  let kotId: string;
  beforeAll(async () => {
    const s = await openTab((await mkTable()).id);
    kotId = (await addRound(s.id, [item(w.h.items.chai, 1, { notes: SQLI })])).body.kots[0].id;
  });

  it("GET /kot lists active tickets with the table label; station filter; ?all=1", async () => {
    const r = await kitchen.call("GET", "/kot");
    expect(r.status).toBe(200);
    const k = r.body.find((x: { id: string }) => x.id === kotId);
    expect(k.session.tableLabel).toEqual(expect.any(String));
    expect((await kitchen.call("GET", "/kot?station=NOPE")).body).toEqual([]);
    expect((await kitchen.call("GET", "/kot?all=1")).status).toBe(200);
    assertNoSecrets(r.body);
  });

  it("PATCH status: stages, validation, 404s", async () => {
    for (const body of [{}, { status: "DONE" }, { status: null }, { status: 1 }]) expect((await kitchen.call("PATCH", `/kot/${kotId}`, body)).status).toBe(400);
    expect((await kitchen.call("PATCH", "/kot/cl0000000000000000000000", { status: "READY" })).status).toBe(404);
    const r = await kitchen.call("PATCH", `/kot/${kotId}`, { status: "READY", outletId: w.h.outlet2Id, kotNumber: 999 });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ id: kotId, status: "READY", outletId: w.h.outletId });
    expect(r.body.kotNumber).not.toBe(999);
    expect(r.body.preparingAt).toEqual(expect.any(String));
  });

  it("print: first print then REPRINT; notes stay inert text", async () => {
    const p1 = await kitchen.call("POST", `/kot/${kotId}/print`);
    expect(p1.status).toBe(200);
    expect(p1.body.text).toContain(SQLI);
    expect(p1.body.text).not.toContain("REPRINT");
    expect((await kitchen.call("POST", `/kot/${kotId}/print`)).body.text).toContain("REPRINT");
    expect((await kitchen.call("POST", "/kot/cl0000000000000000000000/print")).status).toBe(404);
  });

  it("roles: kot:view (owner, manager, cashier, kitchen, waiter); kot:update (owner, manager, kitchen)", async () => {
    expect(await roleMatrix(w, ["owner", "manager", "cashier", "kitchen", "waiter"], (c) => c.call("GET", "/kot"), 200)).toEqual([]);
    expect(await roleMatrix(w, ["owner", "manager", "kitchen"], (c) => c.call("PATCH", `/kot/${kotId}`, { status: "PREPARING" }), 200)).toEqual([]);
    expect(await roleMatrix(w, ["owner", "manager", "cashier", "kitchen", "waiter"], (c) => c.call("POST", `/kot/${kotId}/print`), 200)).toEqual([]);
  });

  it("isolation: another hotel can't see, move or print this KOT", async () => {
    expect((await w.otherOwner.call("GET", "/kot")).body.map((k: { id: string }) => k.id)).not.toContain(kotId);
    expect((await w.otherOwner.call("PATCH", `/kot/${kotId}`, { status: "SERVED" })).status).toBe(404);
    expect((await w.otherOwner.call("POST", `/kot/${kotId}/print`)).status).toBe(404);
    expect((await w.managerOutlet2.call("GET", "/kot")).status).toBe(403);
    expect((await db.kotTicket.findUniqueOrThrow({ where: { id: kotId } })).status).not.toBe("SERVED");
  });
});
