/**
 * QA Phase 6 — /reservations: create / list (IST day filter) / get / patch / cancel / no-show /
 * seat, and pre-orders. Contract, roles, module gating, tenant isolation, validation, double booking
 * (including two bookings at the same moment) and state-machine abuse (cancel twice, seat a cancelled one).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHotel, login, startServer } from "../integration/helpers";
import { assertIntegerMoney, assertNoSecrets, db, LONG, makeWorld, roleMatrix, UNICODE_NAME, XSS, type Client, type World } from "./service-fixtures";

let srv: Awaited<ReturnType<typeof startServer>>;
let w: World;
let cashier: Client, waiter: Client;
let tableId: string, smallTable: string, freeTable: string;

const istDate = (offsetDays: number) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date(Date.now() + offsetDays * 86_400_000));
const DAY = istDate(5);
const at = (hhmm: string, day = DAY) => `${day}T${hhmm}:00+05:30`;
const phone = () => `9${String(Math.floor(Math.random() * 1e9)).padStart(9, "0")}`;
const book = (c: Client, extra: Record<string, unknown> = {}) =>
  c.call("POST", "/reservations", { customerName: "Asha", customerPhone: phone(), partySize: 2, reservedFor: at("19:00"), ...extra });

beforeAll(async () => {
  srv = await startServer();
  w = await makeWorld(srv.base, "Reservations API");
  ({ cashier, waiter } = w.as);
  const mk = async (label: string, capacity: number) => (await w.as.manager.call("POST", "/tables", { label, capacity })).body.id as string;
  tableId = await mk("R1", 4);
  smallTable = await mk("R2", 2);
  freeTable = await mk("R3", 6);
});
afterAll(() => srv.close());

describe("POST /reservations", () => {
  it("201 with integer advance; unicode name round-trips; mass-assigned status / outlet / session ignored", async () => {
    const r = await book(cashier, { tableId, customerName: UNICODE_NAME, notes: XSS, advancePaid: 50000, status: "SEATED", outletId: w.h.outlet2Id, sessionId: "x", createdById: w.h.users.owner.id });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body).toMatchObject({ status: "BOOKED", outletId: w.h.outletId, sessionId: null, customerName: UNICODE_NAME, notes: XSS, advancePaid: 50000, createdById: w.h.users.cashier.id, table: { id: tableId } });
    assertIntegerMoney(r.body);
    assertNoSecrets(r.body);
  });

  const bad: [string, Record<string, unknown>][] = [
    ["no name", { customerName: "" }],
    ["name 10k", { customerName: LONG }],
    ["bad phone", { customerPhone: "12345" }],
    ["party 0", { partySize: 0 }],
    ["party float", { partySize: 2.5 }],
    ["party 101", { partySize: 101 }],
    ["no time", { reservedFor: null }],
    ["time not ISO", { reservedFor: "tomorrow 7pm" }],
    ["time in the past", { reservedFor: new Date(Date.now() - 3_600_000).toISOString() }],
    ["duration 10", { durationMin: 10 }],
    ["duration 601", { durationMin: 601 }],
    ["advance negative", { advancePaid: -1 }],
    ["advance float", { advancePaid: 10.5 }],
    ["notes 10k", { notes: LONG }],
    ["party bigger than the table", { tableId: "SMALL", partySize: 3 }],
    ["pre-order qty 0", { preOrderItems: [{ menuItemId: "CHAI", quantity: 0 }] }],
    ["pre-order unknown item", { preOrderItems: [{ menuItemId: "cl0000000000000000000000", quantity: 1 }] }],
    ["pre-order other hotel's item", { preOrderItems: [{ menuItemId: "OTHER", quantity: 1 }] }],
  ];
  it.each(bad)("400 and nothing written: %s", async (_n, extra) => {
    const before = await db.reservation.count({ where: { outletId: w.h.outletId } });
    const body = JSON.parse(JSON.stringify(extra).replace('"CHAI"', JSON.stringify(w.h.items.chai)).replace('"OTHER"', JSON.stringify(w.other.items.chai)).replace('"SMALL"', JSON.stringify(smallTable)));
    const r = await book(cashier, body);
    expect(r.status, JSON.stringify(r.body)).toBe(400);
    expect(await db.reservation.count({ where: { outletId: w.h.outletId } })).toBe(before);
  });

  it("unknown / other hotel's table → 404", async () => {
    expect((await book(cashier, { tableId: "cl0000000000000000000000" })).status).toBe(404);
    const foreign = await db.diningTable.create({ data: { outletId: w.other.outletId, label: "FX" } });
    expect((await book(cashier, { tableId: foreign.id })).status).toBe(404);
  });

  it("overlapping booking on the same table → 409; back-to-back is fine", async () => {
    const a = await book(cashier, { tableId: smallTable, reservedFor: at("12:00"), durationMin: 60 });
    expect(a.status).toBe(201);
    expect((await book(cashier, { tableId: smallTable, reservedFor: at("12:30") })).status).toBe(409);
    expect((await book(cashier, { tableId: smallTable, reservedFor: at("11:30"), durationMin: 31 })).status).toBe(409);
    expect((await book(cashier, { tableId: smallTable, reservedFor: at("13:00") })).status).toBe(201);
  });

  it("two bookings for the same table and time at the same moment → one", async () => {
    const reservedFor = at("16:00");
    const rs = await Promise.all([book(cashier, { tableId: freeTable, reservedFor }), book(waiter, { tableId: freeTable, reservedFor }), book(w.as.manager, { tableId: freeTable, reservedFor })]);
    expect(rs.filter((r) => r.status === 201)).toHaveLength(1);
    expect(await db.reservation.count({ where: { tableId: freeTable, status: "BOOKED", reservedFor: new Date(reservedFor) } })).toBe(1);
  });
});

describe("GET /reservations — IST day filter, status, isolation", () => {
  let early: string, late: string;
  beforeAll(async () => {
    const next = istDate(6);
    early = (await book(cashier, { reservedFor: `${DAY}T23:59:59.999+05:30` })).body.id;
    late = (await book(cashier, { reservedFor: `${next}T00:00:00.000+05:30` })).body.id;
  });

  it("23:59:59.999 IST is on its own day, 00:00 on the next", async () => {
    const d = await cashier.call("GET", `/reservations?date=${DAY}`);
    expect(d.status).toBe(200);
    expect(d.body.map((r: { id: string }) => r.id)).toContain(early);
    expect(d.body.map((r: { id: string }) => r.id)).not.toContain(late);
    expect((await cashier.call("GET", `/reservations?date=${istDate(6)}`)).body.map((r: { id: string }) => r.id)).toContain(late);
    expect((await cashier.call("GET", "/reservations?date=2020-01-01")).body).toEqual([]);
  });

  it.each(["date=2026-13-45", "date=2026-02-30", "date=05-11-2026", "status=GONE"])("?%s → 400", async (q) => {
    expect((await cashier.call("GET", `/reservations?${q}`)).status).toBe(400);
  });

  it("GET /:id 200; unknown / other hotel → 404; other hotel's list never shows it", async () => {
    expect((await cashier.call("GET", `/reservations/${early}`)).body.id).toBe(early);
    expect((await cashier.call("GET", "/reservations/cl0000000000000000000000")).status).toBe(404);
    expect((await w.otherOwner.call("GET", `/reservations/${early}`)).status).toBe(404);
    expect((await w.otherOwner.call("PATCH", `/reservations/${early}`, { partySize: 3 })).status).toBe(404);
    expect((await w.otherOwner.call("POST", `/reservations/${early}/cancel`, {})).status).toBe(404);
    expect((await w.otherOwner.call("GET", `/reservations?date=${DAY}`)).body).toEqual([]);
    expect((await w.otherOwner.call("GET", "/reservations", undefined, { "x-outlet-id": w.h.outletId })).status).toBe(403);
    expect((await w.managerOutlet2.call("GET", "/reservations")).status).toBe(403);
    expect((await w.admin.call("GET", "/reservations")).status).toBe(403);
  });

  it("roles: reservation:manage → owner, manager, cashier, waiter", async () => {
    expect(await roleMatrix(w, ["owner", "manager", "cashier", "waiter"], (c) => c.call("GET", "/reservations"), 200)).toEqual([]);
    expect(await roleMatrix(w, ["owner", "manager", "cashier", "waiter"], (c) => c.call("GET", "/reservations/pre-orders"), 200)).toEqual([]);
    expect(await roleMatrix(w, ["owner", "manager", "cashier", "waiter"], (c) => book(c), 201)).toEqual([]);
  });

  it("RESERVATIONS module off → 403", async () => {
    const off = await createHotel("No reservations", { modules: ["BILLING", "TABLES"] });
    const o = await login(srv.base, off.users.owner.email, off.outletId);
    expect((await o.call("GET", "/reservations")).status).toBe(403);
    expect((await o.call("POST", "/reservations", {})).status).toBe(403);
  });
});

describe("PATCH / cancel / no-show / seat", () => {
  it("patch validates and re-checks capacity and overlap", async () => {
    const r = (await book(cashier, { tableId, reservedFor: at("09:00") })).body;
    const other = (await book(cashier, { tableId, reservedFor: at("10:30") })).body;
    expect((await cashier.call("PATCH", `/reservations/${r.id}`, { partySize: 0 })).status).toBe(400);
    expect((await cashier.call("PATCH", `/reservations/${r.id}`, { partySize: 5 })).status).toBe(400);
    expect((await cashier.call("PATCH", `/reservations/${r.id}`, { reservedFor: at("10:00") })).status).toBe(409);
    const ok = await cashier.call("PATCH", `/reservations/${r.id}`, { partySize: 3, status: "SEATED", outletId: w.h.outlet2Id });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ partySize: 3, status: "BOOKED", outletId: w.h.outletId });
    expect(other.id).toBeDefined();
  });

  it("cancel → 200; cancel again / no-show / patch / seat a cancelled booking → 409", async () => {
    const r = (await book(cashier)).body;
    expect((await cashier.call("POST", `/reservations/${r.id}/cancel`, { reason: LONG })).status).toBe(400);
    const c = await cashier.call("POST", `/reservations/${r.id}/cancel`, { reason: "plans changed" });
    expect(c.status).toBe(200);
    expect(c.body.status).toBe("CANCELLED");
    expect((await cashier.call("POST", `/reservations/${r.id}/cancel`, {})).status).toBe(409);
    expect((await cashier.call("POST", `/reservations/${r.id}/no-show`, {})).status).toBe(409);
    expect((await cashier.call("PATCH", `/reservations/${r.id}`, { partySize: 2 })).status).toBe(409);
    expect((await cashier.call("POST", `/reservations/${r.id}/seat`, { tableId })).status).toBe(409);
    const n = (await book(cashier)).body;
    expect((await cashier.call("POST", `/reservations/${n.id}/no-show`)).body.status).toBe("NO_SHOW");
  });

  it("seat: needs a table; opens the tab, fires pre-order KOTs, returns the advance; seating twice → 409", async () => {
    const t = (await w.as.manager.call("POST", "/tables", { label: "RS1", capacity: 4 })).body.id as string;
    const noTable = (await book(cashier, { reservedFor: at("20:00"), preOrderItems: [{ menuItemId: w.h.items.biryani, quantity: 2 }], advancePaid: 20000 })).body;
    expect((await waiter.call("POST", `/reservations/${noTable.id}/seat`, {})).status).toBe(400);
    expect((await waiter.call("POST", `/reservations/${noTable.id}/seat`, { tableId: "cl0000000000000000000000" })).status).toBe(404);
    const s = await waiter.call("POST", `/reservations/${noTable.id}/seat`, { tableId: t });
    expect(s.status, JSON.stringify(s.body)).toBe(201);
    expect(s.body.reservation.status).toBe("SEATED");
    expect(s.body.advancePaid).toBe(20000);
    expect(s.body.kots.length).toBeGreaterThan(0);
    expect((await waiter.call("POST", `/reservations/${noTable.id}/seat`, { tableId: t })).status).toBe(409);
    // The table now has a tab: seating another party there is refused.
    const second = (await book(cashier, { reservedFor: at("21:30") })).body;
    expect((await waiter.call("POST", `/reservations/${second.id}/seat`, { tableId: t })).status).toBe(409);
    expect((await db.reservation.findUniqueOrThrow({ where: { id: second.id } })).status).toBe("BOOKED");
  });

  it("pre-orders: invalid date → 400; lists PRE_ORDER bills", async () => {
    expect((await cashier.call("GET", "/reservations/pre-orders?date=2026-02-30")).status).toBe(400);
    expect((await cashier.call("GET", "/reservations/pre-orders?date=bad")).status).toBe(400);
    const scheduledFor = new Date(Date.now() + 2 * 3_600_000).toISOString();
    const o = await cashier.call("POST", "/orders", { orderType: "PRE_ORDER", scheduledFor, customerName: "Pre", customerPhone: phone(), items: [{ menuItemId: w.h.items.chai, quantity: 1 }] });
    expect(o.status, JSON.stringify(o.body)).toBe(201);
    const list = await cashier.call("GET", "/reservations/pre-orders");
    expect(list.body.map((x: { id: string }) => x.id)).toContain(o.body.id);
    assertIntegerMoney(list.body);
  });
});
