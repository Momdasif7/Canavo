/**
 * QA Phase 5 — group C — Tables: floor plan, running tabs, transfer/merge, split bills.
 * (Tab split atomicity across bills is a README known limitation / Phase 9 — not covered.)
 */
import { beforeAll, describe, expect, it } from "vitest";
import { computeBill, taxFromRate } from "@canavo/shared";
import { db } from "./helpers";
import { auditCount, line, menuTenant, phone, type Agent, type MenuTenant } from "./fx-c";

let T: MenuTenant;
let cashier: Agent;
let manager: Agent;
let kitchen: Agent;

beforeAll(async () => {
  T = await menuTenant();
  cashier = await T.as("CASHIER");
  manager = await T.as("OUTLET_MANAGER");
  kitchen = await T.as("KITCHEN");
});

let tn = 0;
const freshTable = (capacity = 4) => db.diningTable.create({ data: { outletId: T.outletId, label: `X${++tn}`, capacity } });

async function openTab(tableId?: string, body: object = { guests: 2 }) {
  const id = tableId ?? (await freshTable()).id;
  const r = await cashier.post(`/tables/${id}/open`, body);
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return { tableId: id, session: r.body };
}
async function addRound(sessionId: string, items: object[]) {
  const r = await cashier.post(`/tables/sessions/${sessionId}/items`, { items });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body as { kots: { id: string; station: string; items: { name: string }[] }[]; session: { items: { id: string; menuItemId: string }[] } };
}
const DINE_CFG = {
  pricesIncludeTax: true, interState: false, compositionScheme: false, taxEnabled: true,
  serviceChargeEnabled: false, serviceChargePercent: 0, roundOff: true,
};

describe("Tables — areas & tables CRUD @regression", () => {
  it("IT-TAB-001 manager creates / renames / deletes an area; tables survive area deletion", async () => {
    const a = await manager.post("/tables/areas", { name: "Rooftop", sortOrder: 2 });
    expect(a.status).toBe(201);
    const t = await manager.post("/tables", { label: "R1", areaId: a.body.id, capacity: 4 });
    expect(t.status).toBe(201);
    expect((await manager.patch(`/tables/areas/${a.body.id}`, { name: "Roof" })).body.name).toBe("Roof");
    expect((await cashier.get("/tables/areas")).body.some((x: { id: string }) => x.id === a.body.id)).toBe(true);
    expect((await manager.delete(`/tables/areas/${a.body.id}`)).status).toBe(204);
    expect((await db.diningTable.findUniqueOrThrow({ where: { id: t.body.id } })).areaId).toBeNull();
    expect(await auditCount(a.body.id, "table.area.delete")).toBe(1);
  });

  it("IT-TAB-002 area validation: blank name → 400; cashier (no table:manage) → 403", async () => {
    expect((await manager.post("/tables/areas", { name: "  " })).status).toBe(400);
    expect((await cashier.post("/tables/areas", { name: "Bar" })).status).toBe(403);
  });

  it.each([
    [{ label: "", capacity: 4 }, 400],
    [{ label: "C0", capacity: 0 }, 400],
    [{ label: "C51", capacity: 51 }, 400],
    [{ label: "C50", capacity: 50 }, 201],
    [{ label: "C1", capacity: 1 }, 201],
    [{ label: "TOO-LONG-LABEL-123456", capacity: 4 }, 400],
  ])("IT-TAB-003 create table %j → %s", async (body, code) => {
    expect((await manager.post("/tables", body)).status).toBe(code);
  });

  it("IT-TAB-004 duplicate table label in the same outlet → 409; foreign area → 404; cashier → 403", async () => {
    expect((await manager.post("/tables", { label: "T1" })).status).toBe(409);
    const B = await menuTenant();
    expect((await manager.post("/tables", { label: "Z9", areaId: B.area.id })).status).toBe(404);
    expect((await cashier.post("/tables", { label: "Z8" })).status).toBe(403);
  });

  it("IT-TAB-005 PATCH table; delete unused table removes it, a used one is deactivated", async () => {
    const unused = await freshTable();
    expect((await manager.patch(`/tables/${unused.id}`, { capacity: 8, shape: "ROUND" })).body).toMatchObject({ capacity: 8, shape: "ROUND" });
    expect((await manager.delete(`/tables/${unused.id}`)).status).toBe(204);
    expect(await db.diningTable.findUnique({ where: { id: unused.id } })).toBeNull();
    const { tableId, session } = await openTab();
    expect((await manager.delete(`/tables/${tableId}`)).status).toBe(409);
    await cashier.post(`/tables/sessions/${session.id}/close`, {});
    expect((await manager.delete(`/tables/${tableId}`)).status).toBe(204);
    expect((await db.diningTable.findUniqueOrThrow({ where: { id: tableId } })).active).toBe(false);
  });

  it("IT-TAB-006 layout save persists positions; unknown / foreign table, out-of-range position → 400", async () => {
    const a = await freshTable();
    const b = await freshTable();
    const r = await manager.put("/tables/layout", { tables: [{ id: a.id, posX: 10, posY: 20, width: 3, height: 3, rotation: 45 }, { id: b.id, posX: 500, posY: 0, width: 50, height: 1, rotation: 359, shape: "ROUND" }] });
    expect(r.status).toBe(200);
    expect(await db.diningTable.findUniqueOrThrow({ where: { id: a.id } })).toMatchObject({ posX: 10, posY: 20, rotation: 45 });
    expect((await db.diningTable.findUniqueOrThrow({ where: { id: b.id } })).shape).toBe("ROUND");
    const B = await menuTenant();
    const pos = { posX: 1, posY: 1, width: 2, height: 2, rotation: 0 };
    expect((await manager.put("/tables/layout", { tables: [{ id: B.tables.T1.id, ...pos }] })).status).toBe(400);
    expect((await manager.put("/tables/layout", { tables: [{ id: "nope", ...pos }] })).status).toBe(400);
    expect((await manager.put("/tables/layout", { tables: [{ id: a.id, ...pos, posX: 501 }] })).status).toBe(400);
    expect((await manager.put("/tables/layout", { tables: [{ id: a.id, ...pos, rotation: 360 }] })).status).toBe(400);
    expect((await manager.put("/tables/layout", { tables: [] })).status).toBe(400);
    expect((await manager.put("/tables/layout", { tables: [{ id: a.id, ...pos, areaId: B.area.id }] })).status).toBe(400);
    expect((await cashier.put("/tables/layout", { tables: [{ id: a.id, ...pos }] })).status).toBe(403);
  });
});

describe("Tables — status & waiter @regression", () => {
  it("IT-TAB-007 status transitions: OCCUPIED without a tab → 400; NEEDS_ATTENTION / RESERVED / AVAILABLE ok; audited", async () => {
    const t = await freshTable();
    expect((await cashier.patch(`/tables/${t.id}/status`, { status: "OCCUPIED" })).status).toBe(400);
    for (const s of ["NEEDS_ATTENTION", "RESERVED", "AVAILABLE"]) {
      const r = await cashier.patch(`/tables/${t.id}/status`, { status: s });
      expect(r.status).toBe(200);
      expect(r.body.status).toBe(s);
    }
    expect((await cashier.patch(`/tables/${t.id}/status`, { status: "BROKEN" })).status).toBe(400);
    expect(await auditCount(t.id, "table.status")).toBe(3);
  });

  it("IT-TAB-008 table with an open tab cannot be set AVAILABLE/RESERVED (409) or deactivated (409)", async () => {
    const { tableId } = await openTab();
    expect((await cashier.patch(`/tables/${tableId}/status`, { status: "AVAILABLE" })).status).toBe(409);
    expect((await cashier.patch(`/tables/${tableId}/status`, { status: "RESERVED" })).status).toBe(409);
    expect((await cashier.patch(`/tables/${tableId}/status`, { status: "NEEDS_ATTENTION" })).status).toBe(200);
    expect((await manager.patch(`/tables/${tableId}`, { active: false })).status).toBe(409);
  });

  it("IT-TAB-009 waiter assignment updates table and open tab; foreign staff → 400; null clears", async () => {
    const { tableId, session } = await openTab();
    const waiter = T.users.CASHIER.id;
    const r = await cashier.patch(`/tables/${tableId}/waiter`, { waiterId: waiter });
    expect(r.status).toBe(200);
    expect(r.body.waiterId).toBe(waiter);
    expect((await db.tableSession.findUniqueOrThrow({ where: { id: session.id } })).waiterId).toBe(waiter);
    const B = await menuTenant();
    expect((await cashier.patch(`/tables/${tableId}/waiter`, { waiterId: B.users.CASHIER.id })).status).toBe(400);
    expect((await cashier.patch(`/tables/${tableId}/waiter`, { waiterId: null })).body.waiterId).toBeNull();
  });
});

describe("Tables — running tabs @regression", () => {
  it("IT-TAB-010 open tab: 201, table OCCUPIED, audited; second open → 409; guests 0/101 → 400; inactive table → 404", async () => {
    const t = await freshTable();
    expect((await cashier.post(`/tables/${t.id}/open`, { guests: 0 })).status).toBe(400);
    expect((await cashier.post(`/tables/${t.id}/open`, { guests: 101 })).status).toBe(400);
    const { session } = await openTab(t.id, { guests: 3, customerName: "Anil", customerPhone: phone() });
    expect(session.status).toBe("OPEN");
    expect(session.guests).toBe(3);
    expect((await db.diningTable.findUniqueOrThrow({ where: { id: t.id } })).status).toBe("OCCUPIED");
    expect(await auditCount(session.id, "table.session.open")).toBe(1);
    expect((await cashier.post(`/tables/${t.id}/open`, {})).status).toBe(409);
    const inactive = await db.diningTable.create({ data: { outletId: T.outletId, label: `IN${Date.now() % 1e6}`, active: false } });
    expect((await cashier.post(`/tables/${inactive.id}/open`, {})).status).toBe(404);
  });

  it("IT-TAB-011 each round fires KOTs immediately (per station) and they show on the KDS as running-tab tickets", async () => {
    const { tableId, session } = await openTab();
    const label = (await db.diningTable.findUniqueOrThrow({ where: { id: tableId } })).label;
    const r1 = await addRound(session.id, [line(T.items.chai.id, 2), line(T.items.samosa.id, 1, { seat: 1 })]);
    expect(r1.kots.map((k) => k.station).sort()).toEqual(["BEVERAGE", "MAIN"]);
    const r2 = await addRound(session.id, [line(T.items.biryani.id)]);
    expect(r2.kots).toHaveLength(1);
    const board = (await kitchen.get("/kot")).body as { id: string; orderId: string | null; session: { tableLabel: string } | null }[];
    const mine = board.filter((k) => [...r1.kots, ...r2.kots].some((x) => x.id === k.id));
    expect(mine).toHaveLength(3);
    expect(mine.every((k) => k.orderId === null && k.session?.tableLabel === label)).toBe(true);
    const detail = (await cashier.get(`/tables/sessions/${session.id}`)).body;
    expect(detail.items).toHaveLength(3);
    expect(detail.unbilledCount).toBe(3);
    expect(detail.estimate.grandTotal).toBeGreaterThan(0);
  });

  it("IT-TAB-012 unavailable (HIDDEN / OUT_OF_STOCK) and foreign items cannot be added to a tab (400); empty round → 400", async () => {
    const { session } = await openTab();
    for (const id of [T.items.hidden.id, T.items.oos.id]) {
      expect((await cashier.post(`/tables/sessions/${session.id}/items`, { items: [line(id)] })).status).toBe(400);
    }
    const B = await menuTenant();
    expect((await cashier.post(`/tables/sessions/${session.id}/items`, { items: [line(B.items.samosa.id)] })).status).toBe(400);
    expect((await cashier.post(`/tables/sessions/${session.id}/items`, { items: [] })).status).toBe(400);
    expect((await cashier.post(`/tables/sessions/${session.id}/items`, { items: [line(T.items.samosa.id, 0)] })).status).toBe(400);
  });

  it.fails("IT-TAB-013 (BUG-CANDIDATE-C4) an item outside its serving hours cannot be added to a dine-in tab (as on POST /orders)", async () => {
    const { session } = await openTab();
    // POST /orders refuses it (IT-BIL-012). Expected the same 400 here.
    // Actual: 201 — priceLine() checks status only, and the tab bill later uses skipAvailability.
    const r = await cashier.post(`/tables/sessions/${session.id}/items`, { items: [line(T.items.offSlot.id)] });
    expect(r.status).toBe(400);
  });

  it("IT-TAB-014 void an item: cashier 403; manager voids → item removed, KOT line marked VOID (and printed), audited", async () => {
    const { session } = await openTab();
    const r = await addRound(session.id, [line(T.items.samosa.id, 2), line(T.items.sandwich.id)]);
    const item = r.session.items.find((i) => i.menuItemId === T.items.samosa.id)!;
    expect((await cashier.delete(`/tables/sessions/${session.id}/items/${item.id}`)).status).toBe(403);
    const v = await manager.delete(`/tables/sessions/${session.id}/items/${item.id}?reason=wrong%20item`);
    expect(v.status).toBe(200);
    expect(v.body.items.some((i: { id: string }) => i.id === item.id)).toBe(false);
    const kot = await db.kotTicket.findUniqueOrThrow({ where: { id: r.kots[0].id } });
    expect((kot.items as { sessionItemId: string; voided?: boolean }[]).find((e) => e.sessionItemId === item.id)?.voided).toBe(true);
    const printed = await kitchen.post(`/kot/${kot.id}/print`, {});
    expect(printed.body.text).toMatch(/2 x Samosa\s+\*\* VOID \*\*/);
    const log = await db.auditLog.findFirstOrThrow({ where: { entityId: item.id, action: "table.item.void" } });
    expect((log.meta as { reason: string }).reason).toBe("wrong item");
    expect((await manager.delete(`/tables/sessions/${session.id}/items/unknown`)).status).toBe(404);
  });

  it("IT-TAB-015 transfer: same table → 400, occupied target → 409, success frees the old table", async () => {
    const a = await openTab();
    const b = await openTab();
    const free = await freshTable();
    expect((await cashier.post(`/tables/sessions/${a.session.id}/transfer`, { toTableId: a.tableId })).status).toBe(400);
    expect((await cashier.post(`/tables/sessions/${a.session.id}/transfer`, { toTableId: b.tableId })).status).toBe(409);
    expect((await cashier.post(`/tables/sessions/${a.session.id}/transfer`, { toTableId: "nope" })).status).toBe(404);
    const r = await cashier.post(`/tables/sessions/${a.session.id}/transfer`, { toTableId: free.id });
    expect(r.status).toBe(200);
    expect(r.body.tableId).toBe(free.id);
    expect((await db.diningTable.findUniqueOrThrow({ where: { id: a.tableId } })).status).toBe("AVAILABLE");
    expect((await db.diningTable.findUniqueOrThrow({ where: { id: free.id } })).status).toBe("OCCUPIED");
  });

  it("IT-TAB-016 merge: another tab's items/KOTs/guests move in, other tab closes; an empty table joins", async () => {
    const a = await openTab(undefined, { guests: 2 });
    const b = await openTab(undefined, { guests: 3 });
    const empty = await freshTable();
    await addRound(a.session.id, [line(T.items.samosa.id)]);
    const rb = await addRound(b.session.id, [line(T.items.chai.id)]);
    const m = await cashier.post(`/tables/sessions/${a.session.id}/merge`, { tableIds: [b.tableId, empty.id] });
    expect(m.status).toBe(200);
    expect(m.body.guests).toBe(5);
    expect(m.body.items).toHaveLength(2);
    expect(m.body.mergedTableIds.sort()).toEqual([b.tableId, empty.id].sort());
    expect(m.body.label.split("+")).toHaveLength(3);
    expect((await db.tableSession.findUniqueOrThrow({ where: { id: b.session.id } })).status).toBe("CLOSED");
    expect((await db.kotTicket.findUniqueOrThrow({ where: { id: rb.kots[0].id } })).sessionId).toBe(a.session.id);
    expect((await db.diningTable.findUniqueOrThrow({ where: { id: empty.id } })).status).toBe("OCCUPIED");
    expect((await cashier.post(`/tables/sessions/${a.session.id}/merge`, { tableIds: ["nope"] })).status).toBe(404);
    expect((await cashier.post(`/tables/sessions/${a.session.id}/merge`, { tableIds: [] })).status).toBe(400);
    // the merged-in table can't get its own tab now
    expect((await cashier.post(`/tables/${empty.id}/open`, {})).status).toBe(409);
  });

  it("IT-TAB-017 adding items to a closed tab → 409; unknown session → 404", async () => {
    const { session } = await openTab();
    await cashier.post(`/tables/sessions/${session.id}/close`, {});
    expect((await cashier.post(`/tables/sessions/${session.id}/items`, { items: [line(T.items.samosa.id)] })).status).toBe(409);
    expect((await cashier.post(`/tables/sessions/nope/items`, { items: [line(T.items.samosa.id)] })).status).toBe(404);
  });
});

describe("Tables — billing a tab @regression @critical", () => {
  it("IT-TAB-018 @critical FULL bill = computeBill of the tab items; KOTs linked; paying it closes the tab, frees the table and clears its KOTs from the KDS", async () => {
    const { tableId, session } = await openTab();
    const r1 = await addRound(session.id, [line(T.items.chai.id, 2, { variantId: T.items.chai.variants[1].id }), line(T.items.biryani.id)]);
    const bill = await cashier.post(`/tables/sessions/${session.id}/bill`, { mode: "FULL" });
    expect(bill.status, JSON.stringify(bill.body)).toBe(201);
    const order = bill.body.orders[0].order;
    const expected = computeBill(
      [{ unitPrice: 2500, quantity: 2, tax: taxFromRate(T.gst5) }, { unitPrice: 16000, quantity: 1, tax: taxFromRate(T.gst18) }],
      DINE_CFG,
    );
    expect(order.orderType).toBe("DINE_IN");
    expect(order.grandTotal).toBe(expected.grandTotal);
    expect(order.grandTotal).toBe(bill.body.session.estimate.grandTotal);
    expect(order.extraCharges).toBe(0);
    expect(order.kots).toHaveLength(0); // no new KOT fired at billing
    const linked = await db.kotTicket.findMany({ where: { id: { in: r1.kots.map((k) => k.id) } } });
    expect(linked.every((k) => k.orderId === order.id)).toBe(true);
    expect(bill.body.session.unbilledCount).toBe(0);

    const pay = await cashier.post(`/orders/${order.id}/payments`, { payments: [{ mode: "CARD", amount: order.grandTotal }] });
    expect(pay.body.paid).toBe(true);
    expect((await db.tableSession.findUniqueOrThrow({ where: { id: session.id } })).status).toBe("CLOSED");
    expect((await db.diningTable.findUniqueOrThrow({ where: { id: tableId } })).status).toBe("AVAILABLE");
    const board = (await kitchen.get("/kot")).body as { id: string }[];
    expect(board.some((k) => r1.kots.some((x) => x.id === k.id))).toBe(false);
  });

  it("IT-TAB-019 @critical BY_ITEMS groups: one bill per group, items partitioned; tab closes only after the last bill is paid", async () => {
    const { tableId, session } = await openTab();
    const r = await addRound(session.id, [line(T.items.samosa.id, 2), line(T.items.sandwich.id), line(T.items.biryani.id)]);
    const [i1, i2, i3] = r.session.items.map((i) => i.id);
    const res = await cashier.post(`/tables/sessions/${session.id}/bill`, { mode: "BY_ITEMS", groups: [[i1, i2], [i3]] });
    expect(res.status).toBe(201);
    expect(res.body.orders).toHaveLength(2);
    const [o1, o2] = res.body.orders.map((o: { order: { id: string; grandTotal: number; subtotal: number; items: unknown[] } }) => o.order);
    expect(o1.items).toHaveLength(2);
    expect(o2.items).toHaveLength(1);
    expect(o1.subtotal + o2.subtotal).toBe(res.body.session.estimate.subtotal);
    expect(Math.abs(o1.grandTotal + o2.grandTotal - res.body.session.estimate.grandTotal)).toBeLessThanOrEqual(100);
    await cashier.post(`/orders/${o1.id}/payments`, { payments: [{ mode: "CASH", amount: o1.grandTotal }] });
    expect((await db.tableSession.findUniqueOrThrow({ where: { id: session.id } })).status).toBe("OPEN");
    await cashier.post(`/orders/${o2.id}/payments`, { payments: [{ mode: "UPI", amount: o2.grandTotal }] });
    expect((await db.tableSession.findUniqueOrThrow({ where: { id: session.id } })).status).toBe("CLOSED");
    expect((await db.diningTable.findUniqueOrThrow({ where: { id: tableId } })).status).toBe("AVAILABLE");
  });

  it("IT-TAB-020 @critical EQUAL split: amounts sum exactly to the bill and differ by ≤ 1 paisa; paying the parts closes the tab", async () => {
    const { session } = await openTab();
    await addRound(session.id, [line(T.items.biryani.id), line(T.items.chai.id)]);
    const res = await cashier.post(`/tables/sessions/${session.id}/bill`, { mode: "EQUAL", parts: 3 });
    expect(res.status).toBe(201);
    const order = res.body.orders[0].order;
    const parts: number[] = res.body.equalSplit;
    expect(parts).toHaveLength(3);
    expect(parts.reduce((s, x) => s + x, 0)).toBe(order.grandTotal);
    expect(Math.max(...parts) - Math.min(...parts)).toBeLessThanOrEqual(1);
    const pay = await cashier.post(`/orders/${order.id}/payments`, { payments: parts.map((amount, i) => ({ mode: (["CASH", "UPI", "CARD"] as const)[i], amount })) });
    expect(pay.body.paid).toBe(true);
    expect((await db.tableSession.findUniqueOrThrow({ where: { id: session.id } })).status).toBe("CLOSED");
  });

  it.each([
    [{ mode: "EQUAL" }, 400],
    [{ mode: "EQUAL", parts: 1 }, 400],
    [{ mode: "EQUAL", parts: 51 }, 400],
    [{ mode: "BY_ITEMS" }, 400],
    [{ mode: "SPLIT" }, 400],
  ])("IT-TAB-021 invalid bill request %j → %s", async (body, code) => {
    const { session } = await openTab();
    await addRound(session.id, [line(T.items.samosa.id)]);
    expect((await cashier.post(`/tables/sessions/${session.id}/bill`, body)).status).toBe(code);
  });

  it("IT-TAB-022 bill guards: empty tab → 400; foreign item id → 400; item in two groups → 400; groups + FLAT discount → 400", async () => {
    const empty = await openTab();
    expect((await cashier.post(`/tables/sessions/${empty.session.id}/bill`, { mode: "FULL" })).status).toBe(400);
    const a = await openTab();
    const b = await openTab();
    const ra = await addRound(a.session.id, [line(T.items.samosa.id), line(T.items.chai.id)]);
    const rb = await addRound(b.session.id, [line(T.items.samosa.id)]);
    const [x, y] = ra.session.items.map((i) => i.id);
    expect((await cashier.post(`/tables/sessions/${a.session.id}/bill`, { mode: "BY_ITEMS", itemIds: [rb.session.items[0].id] })).status).toBe(400);
    expect((await cashier.post(`/tables/sessions/${a.session.id}/bill`, { mode: "BY_ITEMS", groups: [[x], [x, y]] })).status).toBe(400);
    expect((await cashier.post(`/tables/sessions/${a.session.id}/bill`, { mode: "BY_ITEMS", groups: [[x], [y]], discount: { type: "FLAT", value: 100 } })).status).toBe(400);
    // nothing billed by the refused requests
    expect((await cashier.get(`/tables/sessions/${a.session.id}`)).body.unbilledCount).toBe(2);
  });

  it("IT-TAB-023 close guards: unbilled items → 409; unpaid bill → 409; billing everything twice → 400", async () => {
    const { session } = await openTab();
    await addRound(session.id, [line(T.items.samosa.id)]);
    expect((await cashier.post(`/tables/sessions/${session.id}/close`, {})).status).toBe(409);
    const bill = await cashier.post(`/tables/sessions/${session.id}/bill`, {});
    expect((await cashier.post(`/tables/sessions/${session.id}/close`, {})).status).toBe(409);
    expect((await cashier.post(`/tables/sessions/${session.id}/bill`, {})).status).toBe(400);
    const order = bill.body.orders[0].order;
    await cashier.post(`/orders/${order.id}/payments`, { payments: [{ mode: "CASH", amount: order.grandTotal }] });
    expect((await cashier.post(`/tables/sessions/${session.id}/close`, {})).status).toBe(409); // already auto-closed
  });

  it("IT-TAB-024 billed items cannot be voided (409); cancelling the tab bill un-bills the items so they can be re-billed", async () => {
    const { session } = await openTab();
    const r = await addRound(session.id, [line(T.items.samosa.id), line(T.items.sandwich.id)]);
    const bill = (await cashier.post(`/tables/sessions/${session.id}/bill`, {})).body.orders[0].order;
    expect((await manager.delete(`/tables/sessions/${session.id}/items/${r.session.items[0].id}`)).status).toBe(409);
    expect((await manager.post(`/orders/${bill.id}/cancel`, { reason: "rebill needed" })).status).toBe(200);
    const d = (await cashier.get(`/tables/sessions/${session.id}`)).body;
    expect(d.unbilledCount).toBe(2);
    expect((await db.kotTicket.findUniqueOrThrow({ where: { id: r.kots[0].id } })).orderId).toBeNull();
    const again = await cashier.post(`/tables/sessions/${session.id}/bill`, { mode: "FULL", discount: { type: "PERCENT", value: 10 } });
    expect(again.status).toBe(201);
    expect(again.body.orders[0].order.grandTotal).toBeLessThan(bill.grandTotal);
  });

  it("IT-TAB-025 tab bill carries the tab customer and table label", async () => {
    const ph = phone();
    const { tableId, session } = await openTab(undefined, { guests: 2, customerName: "Meera", customerPhone: ph });
    await addRound(session.id, [line(T.items.samosa.id)]);
    const o = (await cashier.post(`/tables/sessions/${session.id}/bill`, {})).body.orders[0].order;
    expect(o.customerPhone).toBe(ph);
    expect(o.customerName).toBe("Meera");
    expect(o.tableLabel).toBe((await db.diningTable.findUniqueOrThrow({ where: { id: tableId } })).label);
    expect(o.tableSessionId).toBe(session.id);
  });
});

describe("Tables — permissions, isolation, modules @regression", () => {
  it("IT-TAB-026 floor view: occupied/available stats and session summary", async () => {
    const { tableId, session } = await openTab();
    await addRound(session.id, [line(T.items.samosa.id, 2)]);
    const f = await cashier.get("/tables/floor");
    expect(f.status).toBe(200);
    const row = f.body.areas.flatMap((a: { tables: { id: string }[] }) => a.tables).find((t: { id: string }) => t.id === tableId);
    expect(row.session.id).toBe(session.id);
    expect(row.session.itemsCount).toBe(2);
    expect(f.body.stats.occupied).toBeGreaterThanOrEqual(1);
  });

  it("IT-TAB-027 kitchen role cannot open tabs or view the floor (403)", async () => {
    const t = await freshTable();
    expect((await kitchen.post(`/tables/${t.id}/open`, {})).status).toBe(403);
    expect((await kitchen.get("/tables/floor")).status).toBe(403);
  });

  it("IT-TAB-028 @critical another tenant's tables and sessions are invisible (404)", async () => {
    const B = await menuTenant();
    const bc = await B.as("CASHIER");
    const bs = (await bc.post(`/tables/${B.tables.T1.id}/open`, {})).body;
    expect((await cashier.get(`/tables/${B.tables.T1.id}`)).status).toBe(404);
    expect((await cashier.post(`/tables/${B.tables.T2.id}/open`, {})).status).toBe(404);
    expect((await cashier.get(`/tables/sessions/${bs.id}`)).status).toBe(404);
    expect((await cashier.post(`/tables/sessions/${bs.id}/items`, { items: [line(T.items.samosa.id)] })).status).toBe(404);
    expect((await cashier.post(`/tables/sessions/${bs.id}/bill`, {})).status).toBe(404);
    const mine = await openTab();
    expect((await cashier.post(`/tables/sessions/${mine.session.id}/transfer`, { toTableId: B.tables.T3.id })).status).toBe(404);
    expect((await cashier.post(`/tables/sessions/${mine.session.id}/merge`, { tableIds: [B.tables.T3.id] })).status).toBe(404);
  });

  it("IT-TAB-029 TABLES module disabled → /tables endpoints 403", async () => {
    const N = await menuTenant({ modules: ["BILLING", "KOT"] });
    const c = await N.as("CASHIER");
    expect((await c.get("/tables/floor")).status).toBe(403);
    expect((await c.post(`/tables/${N.tables.T1.id}/open`, {})).status).toBe(403);
    expect((await (await N.as("OUTLET_MANAGER")).post("/tables", { label: "Q1" })).status).toBe(403);
  });

  it("IT-TAB-030 sessions history lists OPEN by default and CLOSED on request", async () => {
    const { session } = await openTab();
    await cashier.post(`/tables/sessions/${session.id}/close`, {});
    const closed = (await cashier.get("/tables/sessions?status=CLOSED")).body as { id: string }[];
    const open = (await cashier.get("/tables/sessions")).body as { id: string; status: string }[];
    expect(closed.some((s) => s.id === session.id)).toBe(true);
    expect(open.every((s) => s.status === "OPEN")).toBe(true);
  });
});
