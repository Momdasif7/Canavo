/**
 * Cinema seat ordering (THEATRE): /theatre (screens, seats, showtimes, settings, runner board),
 * /reports/theatre and the guest routes (/public/t/:token for a seat, /public/s/:screenToken).
 * Roles, module gating, tenant / outlet isolation, validation, the show window and timing rules,
 * mandatory UPI prepay, interval KOT release, pickup tokens under parallel orders, board stages,
 * report sums, screen QR rotation, and that restaurant tables are unaffected.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startServer, type Client } from "../integration/helpers";
import { expireUnpaidSeatOrders } from "../../src/services/theatre";
import { db, GHOST, isolation, rbacMatrix, raw, world, type World } from "./kit";

const MODULES = ["BILLING", "KOT", "TABLES", "CHANNELS", "REPORTS", "CUSTOMERS", "THEATRE"];
const MIN = 60_000;

let srv: Awaited<ReturnType<typeof startServer>>;
let w: World;
let owner: Client, manager: Client, cashier: Client, kitchen: Client, waiter: Client;

type Seat = { id: string; label: string; seatNumber: number; qrToken: string; active: boolean };
type Screen = { id: string; name: string; code: string; qrToken: string; seatCount: number; rows: { row: string; seats: Seat[] }[]; currentShow: unknown; nextShow: unknown };
const screens: Record<string, Screen> = {};

let ipSeq = 0;
const nextIp = () => `10.88.${Math.floor(++ipSeq / 250) % 250}.${(ipSeq % 250) + 1}`;
async function pub<T = any>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const r = await fetch(`${srv.base}${path}`, {
    method,
    headers: { "x-forwarded-for": nextIp(), ...(body !== undefined && { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  return { status: r.status, body: (text ? JSON.parse(text) : null) as T };
}

const at = (offsetMin: number) => new Date(Date.now() + offsetMin * MIN).toISOString();
const mkScreen = async (name: string) => {
  const r = await manager.call("POST", "/theatre/screens", { name });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body as Screen;
};
const addSeats = async (id: string, rows: string[], from: number, to: number, skip: string[] = []) => {
  const r = await manager.call("POST", `/theatre/screens/${id}/seats`, { rows, from, to, skip });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body as { created: number; skipped: number; total: number };
};
const mkShow = async (screenId: string, start: number, end: number, interval: number | null = null, orderCutoffMin = 15, title = "Movie") => {
  const r = await manager.call("POST", "/theatre/showtimes", { screenId, title, startsAt: at(start), endsAt: at(end), intervalAt: interval === null ? null : at(interval), orderCutoffMin });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return r.body as { id: string; intervalAt: string | null; closesAt: string; status: string };
};
const reload = async (key: string) => (screens[key] = (await manager.call("GET", "/theatre/screens")).body.find((s: Screen) => s.id === screens[key].id));
const seat = (key: string, label: string) => screens[key].rows.flatMap((r) => r.seats).find((s) => s.label === `${screens[key].code}-${label}`)!;
const cart = () => ({ items: [{ menuItemId: w.h.items.chai, quantity: 2 }] });
const order = (key: string, label: string, timing: string, extra: object = {}) => pub("POST", `/public/t/${seat(key, label).qrToken}/orders`, { ...cart(), timing, ...extra });
const pay = async (orderId: string) => {
  const p = await db.payment.findFirstOrThrow({ where: { orderId, mode: "UPI", status: "PENDING" } });
  const r = await cashier.call("POST", `/orders/${orderId}/payments/${p.id}/dev-simulate`);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  expect(r.body.paid).toBe(true);
};
const setTheatre = (patch: object) => owner.call("PATCH", "/theatre/settings", patch);

let showMain: { id: string; intervalAt: string | null };

beforeAll(async () => {
  srv = await startServer();
  w = await world(srv.base, "QA Theatre", MODULES);
  ({ BUSINESS_OWNER: owner, OUTLET_MANAGER: manager, CASHIER: cashier, KITCHEN: kitchen, WAITER: waiter } = w.as);
  // Dine-in QR ordering stays OFF: seats follow the theatre's own switch.
  expect((await owner.call("PUT", "/storefront/settings", { qrOrdering: false, qrNeedsConfirmation: false, onlineOrdering: false })).status).toBe(200);
  expect((await setTheatre({ seatOrdering: true, intervalLeadMin: 10 })).status).toBe(200);
  screens.main = await mkScreen("Audi 1");
  screens.closed = await mkScreen("Audi 2");
  screens.later = await mkScreen("Audi 3");
  screens.empty = await mkScreen("Audi 4");
  screens.noint = await mkScreen("Audi 5");
  screens.soon = await mkScreen("Audi 6");
  screens.plan = await mkScreen("Audi 7");
  await addSeats(screens.main.id, ["A", "B", "C"], 1, 10, ["B5"]);
  for (const k of ["closed", "later", "empty", "noint", "soon"]) await addSeats(screens[k].id, ["A"], 1, 3);
  showMain = await mkShow(screens.main.id, -10, 120, 40);
  await mkShow(screens.closed.id, -100, 10);
  await mkShow(screens.later.id, 40, 160);
  await mkShow(screens.noint.id, -10, 120);
  await mkShow(screens.soon.id, -60, 60, 5);
  for (const k of Object.keys(screens)) await reload(k);
});
afterAll(() => srv.close());

// =====================================================================
describe("roles, module gating, isolation", () => {
  const eps = () => [
    { method: "GET" as const, path: "/theatre/screens", perms: ["table:serve" as const] },
    { method: "POST" as const, path: "/theatre/screens", perms: ["table:manage" as const], body: { name: "" } },
    { method: "PATCH" as const, path: `/theatre/screens/${GHOST}`, perms: ["table:manage" as const] },
    { method: "DELETE" as const, path: `/theatre/screens/${GHOST}`, perms: ["table:manage" as const] },
    { method: "POST" as const, path: `/theatre/screens/${GHOST}/seats`, perms: ["table:manage" as const] },
    { method: "POST" as const, path: `/theatre/screens/${GHOST}/qr/rotate`, perms: ["table:manage" as const] },
    { method: "DELETE" as const, path: `/theatre/seats/${GHOST}`, perms: ["table:manage" as const] },
    { method: "GET" as const, path: "/theatre/showtimes", perms: ["table:serve" as const] },
    { method: "POST" as const, path: "/theatre/showtimes", perms: ["table:manage" as const] },
    { method: "PATCH" as const, path: `/theatre/showtimes/${GHOST}`, perms: ["table:manage" as const] },
    { method: "DELETE" as const, path: `/theatre/showtimes/${GHOST}`, perms: ["table:manage" as const] },
    { method: "GET" as const, path: "/theatre/settings", perms: ["table:serve" as const] },
    { method: "PATCH" as const, path: "/theatre/settings", perms: ["table:manage" as const], body: { intervalLeadMin: -1 } },
    { method: "GET" as const, path: "/theatre/board", perms: ["table:serve" as const] },
    { method: "POST" as const, path: `/theatre/orders/${GHOST}/ready`, perms: ["table:serve" as const] },
    { method: "POST" as const, path: `/theatre/orders/${GHOST}/delivered`, perms: ["table:serve" as const] },
    { method: "GET" as const, path: "/reports/theatre", perms: ["report:view" as const] },
  ];

  it("every route × every business role follows the permission table", async () => {
    await rbacMatrix(w, eps());
  });

  it("a business without THEATRE gets 403 everywhere (its public seat / screen QR is not found)", async () => {
    for (const ep of eps()) {
      const r = await w.other.owner.call(ep.method, ep.path, ep.body ?? (ep.method === "GET" || ep.method === "DELETE" ? undefined : {}));
      expect(r.status, `${ep.method} ${ep.path}`).toBe(403);
    }
    const token = seat("main", "A1").qrToken;
    expect((await pub("GET", `/public/t/${token}`)).status).toBe(200);
    await db.business.update({ where: { id: w.h.businessId }, data: { modules: MODULES.filter((m) => m !== "THEATRE") } });
    try {
      expect((await pub("GET", `/public/t/${token}`)).status).toBe(404);
      expect((await pub("GET", `/public/s/${screens.main.qrToken}`)).status).toBe(404);
      expect((await order("main", "A1", "NOW")).status).toBe(404);
      expect((await manager.call("GET", "/theatre/screens")).status).toBe(403);
    } finally {
      await db.business.update({ where: { id: w.h.businessId }, data: { modules: MODULES } });
    }
  });

  it("other tenants, an unassigned outlet and the super admin can't reach this outlet's screens, seats, shows or orders", async () => {
    const r = await order("main", "C10", "NOW");
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const s = screens.plan.id;
    await isolation(w, [
      { method: "GET", path: "/theatre/screens" },
      { method: "PATCH", path: `/theatre/screens/${s}`, body: { name: "Hijack" } },
      { method: "DELETE", path: `/theatre/screens/${s}` },
      { method: "POST", path: `/theatre/screens/${s}/seats`, body: { rows: ["Z"], from: 1, to: 2 } },
      { method: "POST", path: `/theatre/screens/${s}/qr/rotate` },
      { method: "DELETE", path: `/theatre/seats/${seat("main", "A2").id}` },
      { method: "PATCH", path: `/theatre/showtimes/${showMain.id}`, body: { title: "Hijack" } },
      { method: "DELETE", path: `/theatre/showtimes/${showMain.id}` },
      { method: "POST", path: `/theatre/orders/${r.body.id}/ready` },
      { method: "POST", path: `/theatre/orders/${r.body.id}/delivered` },
      { method: "PATCH", path: "/theatre/settings", body: { seatOrdering: false } },
    ]);
    // Outlet 2 of the same business sees none of outlet 1's screens or orders.
    expect((await w.owner2.call("GET", "/theatre/screens")).body).toEqual([]);
    expect((await w.owner2.call("GET", "/theatre/board")).body.counter).toEqual([]);
    expect((await w.owner2.call("POST", `/theatre/orders/${r.body.id}/ready`)).status).toBe(404);
    expect((await w.owner2.call("PATCH", `/theatre/screens/${s}`, { name: "x" })).status).toBe(404);
    expect((await db.diningArea.findUniqueOrThrow({ where: { id: s } })).name).toBe("Audi 7");
    expect((await manager.call("GET", "/theatre/settings")).body.seatOrdering).toBe(true);
  });
});

// =====================================================================
describe("screens and seats", () => {
  it("screens get codes S1, S2 … and a screen QR; seats are labelled <code>-<row><n> with their own QR", async () => {
    expect(screens.main).toMatchObject({ code: "S1", name: "Audi 1", seatCount: 29 });
    expect(screens.closed.code).toBe("S2");
    expect(screens.main.qrToken).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    expect(screens.main.rows.map((r) => r.row)).toEqual(["A", "B", "C"]);
    expect(screens.main.rows[1].seats.map((s) => s.label)).not.toContain("S1-B5");
    expect(screens.main.rows[0].seats.map((s) => s.seatNumber)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const tokens = screens.main.rows.flatMap((r) => r.seats.map((s) => s.qrToken));
    expect(new Set(tokens).size).toBe(29);
    const t = await db.diningTable.findUniqueOrThrow({ where: { id: seat("main", "C3").id } });
    expect(t).toMatchObject({ capacity: 1, shape: "SQUARE", seatRow: "C", seatNumber: 3, label: "S1-C3", outletId: w.h.outletId });
    expect(screens.main.currentShow).toMatchObject({ id: showMain.id, status: "RUNNING" });
    expect(screens.later.nextShow).toBeTruthy();
  });

  it("bulk add is idempotent, honours the skip list and brings deactivated seats back", async () => {
    const s = await mkScreen("Bulk");
    expect(await addSeats(s.id, ["a", "B"], 1, 5, ["a3", "B1"])).toEqual({ created: 8, skipped: 2, total: 8 });
    expect(await addSeats(s.id, ["A", "B"], 1, 5)).toEqual({ created: 2, skipped: 8, total: 10 });
    expect(await addSeats(s.id, ["A", "B"], 1, 5)).toEqual({ created: 0, skipped: 10, total: 10 });
    const v = (await manager.call("GET", "/theatre/screens")).body.find((x: Screen) => x.id === s.id) as Screen;
    const a1 = v.rows[0].seats[0];
    // A seat with history is deactivated, not deleted; adding the row again revives it.
    await db.channelRequest.create({ data: { outletId: w.h.outletId, channel: "QR", tableId: a1.id, status: "REJECTED", items: [], publicToken: `hist-${Date.now()}` } });
    expect((await manager.call("DELETE", `/theatre/seats/${a1.id}`)).status).toBe(204);
    expect(await db.diningTable.findUnique({ where: { id: a1.id } })).toMatchObject({ active: false });
    const a2 = v.rows[0].seats[1];
    expect((await manager.call("DELETE", `/theatre/seats/${a2.id}`)).status).toBe(204);
    expect(await db.diningTable.findUnique({ where: { id: a2.id } })).toBeNull();
    expect(await addSeats(s.id, ["A"], 1, 2)).toEqual({ created: 2, skipped: 0, total: 10 });
    expect(await db.diningTable.findUnique({ where: { id: a1.id } })).toMatchObject({ active: true });
    // A screen with seat orders in its history can't be deleted; an empty one can.
    expect((await manager.call("DELETE", `/theatre/screens/${s.id}`)).status).toBe(409);
    const e = await mkScreen("Temp");
    await addSeats(e.id, ["A"], 1, 2);
    expect((await manager.call("DELETE", `/theatre/screens/${e.id}`)).status).toBe(204);
    expect(await db.diningTable.count({ where: { areaId: e.id } })).toBe(0);
    expect((await manager.call("DELETE", `/theatre/seats/${GHOST}`)).status).toBe(404);
  });

  it("limits and bad bodies → 400, nothing written", async () => {
    const s = await mkScreen("Limits");
    const bad = [
      {},
      { rows: [], from: 1, to: 2 },
      { rows: ["1"], from: 1, to: 2 },
      { rows: ["AAA"], from: 1, to: 2 },
      { rows: ["A"], from: 0, to: 2 },
      { rows: ["A"], from: 5, to: 2 },
      { rows: ["A"], from: 1, to: 201 },
      { rows: Array.from({ length: 61 }, (_, i) => String.fromCharCode(65 + (i % 26)) + (i >= 26 ? "A" : "")), from: 1, to: 1 },
      { rows: Array.from({ length: 16 }, (_, i) => String.fromCharCode(65 + i)), from: 1, to: 100 }, // 1,600 > 1,500
      { rows: ["A"], from: 1, to: 2, skip: ["A-1"] },
      { rows: ["A"], from: 1.5, to: 2 },
    ];
    for (const b of bad) expect((await manager.call("POST", `/theatre/screens/${s.id}/seats`, b)).status, JSON.stringify(b).slice(0, 80)).toBe(400);
    expect(await db.diningTable.count({ where: { areaId: s.id } })).toBe(0);
    for (const b of [{}, { name: "" }, { name: "x".repeat(41) }, { name: "A", sortOrder: -1 }]) expect((await manager.call("POST", "/theatre/screens", b)).status).toBe(400);
    // At most 3,000 seats on a screen.
    const rows15 = Array.from({ length: 15 }, (_, i) => String.fromCharCode(65 + i));
    expect(await addSeats(s.id, rows15, 1, 100)).toMatchObject({ created: 1500, total: 1500 });
    expect(await addSeats(s.id, rows15, 101, 200)).toMatchObject({ created: 1500, total: 3000 });
    expect((await manager.call("POST", `/theatre/screens/${s.id}/seats`, { rows: ["P"], from: 1, to: 1 })).status).toBe(400);
    await db.diningTable.deleteMany({ where: { areaId: s.id } });
  });

  it("rotating the screen QR kills the old poster; the screen page lists active seats by row", async () => {
    const old = screens.main.qrToken;
    const page = await pub("GET", `/public/s/${old}`);
    expect(page.status).toBe(200);
    expect(page.body.screen).toEqual({ name: "Audi 1", code: "S1" });
    expect(page.body.show).toMatchObject({ id: showMain.id });
    expect(page.body.rows[0].seats[0]).toEqual({ label: "S1-A1", seatNumber: 1, token: seat("main", "A1").qrToken });
    expect(JSON.stringify(page.body)).not.toContain(w.h.outletId);
    const r = await manager.call("POST", `/theatre/screens/${screens.main.id}/qr/rotate`);
    expect(r.status).toBe(200);
    expect(r.body.qrToken).not.toBe(old);
    expect((await pub("GET", `/public/s/${old}`)).status).toBe(404);
    expect((await pub("GET", `/public/s/${r.body.qrToken}`)).status).toBe(200);
    expect((await pub("GET", "/public/s/short")).status).toBe(404);
    screens.main = r.body;
  });
});

// =====================================================================
describe("showtimes", () => {
  const day = (d: number, hh: number, mm = 0) => {
    const x = new Date(Date.now() + d * 86_400_000);
    x.setUTCHours(hh, mm, 0, 0);
    return x.toISOString();
  };
  const body = (extra: object = {}) => ({ screenId: screens.plan.id, title: "Interstellar", startsAt: day(3, 10), intervalAt: day(3, 11, 30), endsAt: day(3, 13), ...extra });

  it("create / list by day / edit / delete; overlap → 409; back-to-back is fine", async () => {
    const a = await manager.call("POST", "/theatre/showtimes", body());
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    expect(a.body).toMatchObject({ screenId: screens.plan.id, screenName: "Audi 7", title: "Interstellar", orderCutoffMin: 15, status: "UPCOMING" });
    expect(Date.parse(a.body.closesAt)).toBe(Date.parse(day(3, 13)) - 15 * MIN);
    expect((await manager.call("POST", "/theatre/showtimes", body({ startsAt: day(3, 12), endsAt: day(3, 14), intervalAt: null }))).status).toBe(409);
    expect((await manager.call("POST", "/theatre/showtimes", body({ startsAt: day(3, 9), endsAt: day(3, 10, 1), intervalAt: null }))).status).toBe(409);
    const b = await manager.call("POST", "/theatre/showtimes", body({ title: "Next", startsAt: day(3, 13), endsAt: day(3, 15), intervalAt: null }));
    expect(b.status).toBe(201);
    // Another screen may show at the same time.
    expect((await manager.call("POST", "/theatre/showtimes", body({ screenId: screens.empty.id, startsAt: day(3, 10), endsAt: day(3, 12), intervalAt: null }))).status).toBe(201);
    const dateIst = new Date(Date.parse(day(3, 12))).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
    const list = await waiter.call("GET", `/theatre/showtimes?date=${dateIst}&screenId=${screens.plan.id}`);
    expect(list.status).toBe(200);
    expect(list.body.map((s: { id: string }) => s.id)).toEqual(expect.arrayContaining([a.body.id, b.body.id]));
    expect(list.body.every((s: { screenId: string }) => s.screenId === screens.plan.id)).toBe(true);
    expect((await manager.call("PATCH", `/theatre/showtimes/${b.body.id}`, { startsAt: day(3, 12, 59) })).status).toBe(409);
    expect((await manager.call("PATCH", `/theatre/showtimes/${b.body.id}`, { intervalAt: day(3, 16) })).status).toBe(400);
    const p = await manager.call("PATCH", `/theatre/showtimes/${b.body.id}`, { title: "Next (3D)", intervalAt: day(3, 14), orderCutoffMin: 30 });
    expect(p.status).toBe(200);
    expect(p.body).toMatchObject({ title: "Next (3D)", orderCutoffMin: 30 });
    expect(Date.parse(p.body.intervalAt)).toBe(Date.parse(day(3, 14)));
    expect((await manager.call("DELETE", `/theatre/showtimes/${b.body.id}`)).status).toBe(204);
    expect((await manager.call("DELETE", `/theatre/showtimes/${b.body.id}`)).status).toBe(404);
  });

  it("validation → 400; unknown / foreign screen → 404", async () => {
    for (const b of [
      body({ endsAt: day(3, 9) }),
      body({ intervalAt: day(3, 9) }),
      body({ intervalAt: day(3, 13) }),
      body({ endsAt: day(3, 19), intervalAt: null }),
      body({ title: "" }),
      body({ startsAt: "tomorrow" }),
      body({ orderCutoffMin: 121 }),
      body({ orderCutoffMin: -1 }),
      { title: "x" },
    ]) {
      expect((await manager.call("POST", "/theatre/showtimes", b)).status, JSON.stringify(b).slice(0, 100)).toBe(400);
    }
    expect((await manager.call("POST", "/theatre/showtimes", body({ screenId: GHOST, startsAt: day(5, 10), endsAt: day(5, 11), intervalAt: null }))).status).toBe(404);
    // A restaurant area is not a screen.
    const area = await manager.call("POST", "/tables/areas", { name: "Terrace" });
    expect((await manager.call("POST", "/theatre/showtimes", body({ screenId: area.body.id, startsAt: day(5, 10), endsAt: day(5, 11), intervalAt: null }))).status).toBe(404);
    for (const q of ["date=2026-13-01", "date=tomorrow"]) expect((await manager.call("GET", `/theatre/showtimes?${q}`)).status).toBe(400);
    expect((await manager.call("GET", `/theatre/showtimes?screenId=${GHOST}`)).status).toBe(404);
  });

  it("parallel overlapping shows on one screen: exactly one is saved", async () => {
    const rs = await Promise.all(
      Array.from({ length: 5 }, (_, i) => manager.call("POST", "/theatre/showtimes", body({ title: `Race ${i}`, startsAt: day(6, 10, i), endsAt: day(6, 12), intervalAt: null }))),
    );
    expect(rs.map((r) => r.status).sort()).toEqual([201, 409, 409, 409, 409]);
  });
});

// =====================================================================
describe("guest seat page", () => {
  it("open: show, closing time, options, seat banner; menu included; nothing internal leaks", async () => {
    const r = await pub("GET", `/public/t/${seat("main", "A3").qrToken}`);
    expect(r.status).toBe(200);
    expect(r.body.ordering).toBe(true);
    expect(r.body.table).toEqual({ label: "S1-A3" });
    expect(r.body.theatre.seat).toEqual({ label: "S1-A3", screenName: "Audi 1", screenCode: "S1", row: "A", seatNumber: 3 });
    expect(r.body.theatre.show).toMatchObject({ id: showMain.id, status: "RUNNING", orderingOpen: true, title: "Movie" });
    expect(r.body.theatre.show.reason).toBeUndefined();
    expect(r.body.theatre.options).toEqual({ now: true, interval: true, counter: true });
    expect(r.body.theatre.settings).toEqual({ intervalLeadMin: 10 });
    expect(r.body.items.length).toBeGreaterThan(0);
    const s = JSON.stringify(r.body);
    for (const leak of [w.h.outletId, w.h.businessId, seat("main", "A3").id, "storefront"]) expect(s).not.toContain(leak);
  });

  it("not yet / closed / no show / no interval ahead", async () => {
    const later = (await pub("GET", `/public/t/${seat("later", "A1").qrToken}`)).body;
    expect(later.ordering).toBe(false);
    expect(later.theatre.options).toEqual({ now: false, interval: false, counter: false });
    const startIst = new Date(Date.now() + 40 * MIN).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
    const todayIst = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
    if (startIst === todayIst) {
      expect(later.theatre.show).toMatchObject({ status: "UPCOMING", orderingOpen: false });
      expect(later.theatre.show.reason).toMatch(/^Ordering opens at \d\d:\d\d$/);
    } else expect(later.theatre.show).toBeNull();

    const closed = (await pub("GET", `/public/t/${seat("closed", "A1").qrToken}`)).body;
    expect(closed.ordering).toBe(false);
    expect(closed.theatre.show).toMatchObject({ status: "RUNNING", orderingOpen: false, reason: "Ordering has closed for this show" });
    expect(closed.notice).toBe("Ordering has closed for this show");

    const none = (await pub("GET", `/public/t/${seat("empty", "A1").qrToken}`)).body;
    expect(none).toMatchObject({ ordering: false, notice: "No show on this screen now" });
    expect(none.theatre.show).toBeNull();

    expect((await pub("GET", `/public/t/${seat("noint", "A1").qrToken}`)).body.theatre.options).toEqual({ now: true, interval: false, counter: true });
    // Interval in 5 minutes with a 10-minute lead: too late for an interval order.
    expect((await pub("GET", `/public/t/${seat("soon", "A1").qrToken}`)).body.theatre.options).toEqual({ now: true, interval: false, counter: true });
  });
});

// =====================================================================
describe("placing seat orders", () => {
  it("prepay is mandatory: a UPI QR comes back, the bill waits, nothing reaches the kitchen until paid", async () => {
    const r = await order("main", "A1", "NOW", { payment: "COUNTER", customerName: "Ravi" });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body).toMatchObject({ status: "ACCEPTED", timing: "NOW", pickupToken: null });
    expect(r.body.token).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    expect(r.body.upi).toMatchObject({ mock: true, amount: r.body.total });
    expect(r.body.upi.qrPayload).toMatch(/^upi:\/\/pay\?/);
    expect(Number.isInteger(r.body.total) && r.body.total >= 3000).toBe(true);
    const req = await db.channelRequest.findUniqueOrThrow({ where: { id: r.body.id } });
    expect(req).toMatchObject({ channel: "QR", seatTiming: "NOW", showTimeId: showMain.id, payment: "UPI", tableId: seat("main", "A1").id, kotIds: [] });
    const bill = await db.order.findUniqueOrThrow({ where: { id: req.orderId! } });
    expect(bill).toMatchObject({ status: "OPEN", channel: "QR", orderType: "DINE_IN", tableLabel: "S1-A1" });
    expect(bill.notes).toContain("SCREEN S1 · A1 · NOW");
    expect(await db.kotTicket.count({ where: { orderId: bill.id } })).toBe(0);
    // Tracking before payment: waiting, with the QR to pay.
    const track = (await pub("GET", `/public/t/${seat("main", "A1").qrToken}/orders`)).body;
    expect(track[0]).toMatchObject({ id: r.body.id, stage: "WAITING", paid: false, timing: "NOW" });
    expect(track[0].upi.qrPayload).toMatch(/^upi:/);
    // A fresh QR replaces the old one.
    const again = await pub("POST", `/public/t/${seat("main", "A1").qrToken}/orders/${r.body.token}/upi`);
    expect(again.status).toBe(201);
    expect(await db.payment.count({ where: { orderId: bill.id, status: "PENDING" } })).toBe(1);
    expect((await pub("POST", `/public/t/${seat("main", "A2").qrToken}/orders/${r.body.token}/upi`)).status).toBe(404);

    await pay(bill.id);
    const kots = await db.kotTicket.findMany({ where: { orderId: bill.id } });
    expect(kots).toHaveLength(1);
    expect(kots[0]).toMatchObject({ header: "SCREEN S1 · A1 · NOW", releaseAt: null });
    expect((await db.channelRequest.findUniqueOrThrow({ where: { id: r.body.id } })).kotIds).toEqual([kots[0].id]);
    // On the kitchen display at once, with the seat header; the printed KOT carries it too.
    const kds = (await kitchen.call("GET", "/kot")).body as { id: string; header: string | null }[];
    expect(kds.find((k) => k.id === kots[0].id)?.header).toBe("SCREEN S1 · A1 · NOW");
    expect((await kitchen.call("POST", `/kot/${kots[0].id}/print`)).body.lines[1]).toBe("SCREEN S1 · A1 · NOW");
    const paidTrack = (await pub("GET", `/public/t/${seat("main", "A1").qrToken}/orders`)).body;
    expect(paidTrack[0]).toMatchObject({ stage: "PREPARING", paid: true, upi: null });
    expect((await pub("POST", `/public/t/${seat("main", "A1").qrToken}/orders/${r.body.token}/upi`)).status).toBe(409);
  });

  it("interval orders: KOT held until intervalAt − lead (hidden from the kitchen), board WAITING with releaseAt", async () => {
    const r = await order("main", "A4", "INTERVAL");
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const req = await db.channelRequest.findUniqueOrThrow({ where: { id: r.body.id } });
    await pay(req.orderId!);
    const [kot] = await db.kotTicket.findMany({ where: { orderId: req.orderId! } });
    expect(kot.header).toBe("SCREEN S1 · A4 · INTERVAL");
    expect(kot.releaseAt!.getTime()).toBe(Date.parse(showMain.intervalAt!) - 10 * MIN);
    expect(((await kitchen.call("GET", "/kot")).body as { id: string }[]).map((k) => k.id)).not.toContain(kot.id);
    const board = (await waiter.call("GET", `/theatre/board?screenId=${screens.main.id}`)).body;
    const o = board.screens[0].rows.find((x: { row: string }) => x.row === "A").orders.find((x: { requestId: string }) => x.requestId === r.body.id);
    expect(o).toMatchObject({ stage: "WAITING", timing: "INTERVAL", paid: true, seatLabel: "S1-A4", row: "A", seatNumber: 4, screenName: "Audi 1" });
    expect(Date.parse(o.releaseAt)).toBe(kot.releaseAt!.getTime());
    const ready = await waiter.call("POST", `/theatre/orders/${r.body.id}/ready`);
    expect(ready.status).toBe(409);
    expect(ready.body.error).toMatch(/^Held for the interval/);
    // Once the release time passes it is an ordinary kitchen order.
    await db.kotTicket.update({ where: { id: kot.id }, data: { releaseAt: new Date(Date.now() - 1000) } });
    expect(((await kitchen.call("GET", "/kot")).body as { id: string }[]).map((k) => k.id)).toContain(kot.id);
    expect((await waiter.call("POST", `/theatre/orders/${r.body.id}/ready`)).body.stage).toBe("READY");
  });

  it("refusals: closed, no show, timing switched off, no interval ahead, seat ordering off, inactive seat, bad bodies", async () => {
    const expect409 = async (p: Promise<{ status: number; body: { error: string } }>, msg: RegExp) => {
      const r = await p;
      expect(r.status, JSON.stringify(r.body)).toBe(409);
      expect(r.body.error).toMatch(msg);
    };
    await expect409(order("closed", "A1", "NOW"), /closed for this show/);
    await expect409(order("empty", "A1", "NOW"), /No show on this screen/);
    await expect409(order("later", "A1", "NOW"), /Ordering opens at|No show/);
    await expect409(order("noint", "A1", "INTERVAL"), /no interval ahead/);
    await expect409(order("soon", "A1", "INTERVAL"), /no interval ahead/);
    await setTheatre({ deliverDuringShow: false, counterPickup: false });
    try {
      await expect409(order("noint", "A2", "NOW"), /during the show is off/);
      await expect409(order("noint", "A2", "COUNTER"), /Counter pickup is off/);
      expect((await pub("GET", `/public/t/${seat("noint", "A2").qrToken}`)).body.theatre.options).toEqual({ now: false, interval: false, counter: false });
    } finally {
      await setTheatre({ deliverDuringShow: true, counterPickup: true });
    }
    await setTheatre({ seatOrdering: false });
    try {
      await expect409(order("main", "B1", "NOW"), /Seat ordering is switched off/);
      // Menu view still shows the page, without ordering.
      const page = (await pub("GET", `/public/t/${seat("main", "B1").qrToken}`)).body;
      expect(page.ordering).toBe(false);
      expect(page.theatre.show.reason).toBe("Seat ordering is off right now");
    } finally {
      await setTheatre({ seatOrdering: true });
    }
    await db.diningTable.update({ where: { id: seat("noint", "A3").id }, data: { active: false } });
    await expect409(order("noint", "A3", "NOW"), /isn't taking orders/);
    for (const b of [cart(), { ...cart(), timing: "LATER" }, { items: [], timing: "NOW" }, { items: [{ menuItemId: w.h.items.chai, quantity: 0 }], timing: "NOW" }]) {
      expect((await pub("POST", `/public/t/${seat("main", "B2").qrToken}/orders`, b)).status).toBe(400);
    }
    expect((await pub("POST", `/public/t/${seat("main", "B2").qrToken}/orders`, { items: [{ menuItemId: w.other.h.items.chai, quantity: 1 }], timing: "NOW" })).status).toBe(400);
    expect(await db.channelRequest.count({ where: { tableId: { in: [seat("closed", "A1").id, seat("empty", "A1").id, seat("main", "B2").id] } } })).toBe(0);
  });

  it("pickup tokens are unique and consecutive under parallel counter orders (per outlet per day)", async () => {
    const labels = ["B6", "B7", "B8", "B9", "B10", "C1", "C2", "C4"];
    const before = await db.channelRequest.aggregate({ where: { outletId: w.h.outletId, pickupToken: { not: null } }, _max: { pickupToken: true } });
    const rs = await Promise.all(labels.map((l) => order("main", l, "COUNTER")));
    for (const r of rs) expect(r.status, JSON.stringify(r.body)).toBe(201);
    const tokens = rs.map((r) => r.body.pickupToken as number).sort((a, b) => a - b);
    const first = (before._max.pickupToken ?? 0) + 1;
    expect(tokens).toEqual(labels.map((_, i) => first + i));
    const req = await db.channelRequest.findUniqueOrThrow({ where: { id: rs[0].body.id } });
    expect((await db.order.findUniqueOrThrow({ where: { id: req.orderId! } })).notes).toContain(`COUNTER #${rs[0].body.pickupToken}`);
    // Outlet 2 numbers its own day from 1 (no screens there, so straight in the table).
    expect(await db.channelRequest.count({ where: { outletId: w.h.outlet2Id, pickupToken: { not: null } } })).toBe(0);
  });

  it("outlets that confirm QR orders: paid first, KOT only after accept (and the other way round)", async () => {
    await owner.call("PUT", "/storefront/settings", { qrNeedsConfirmation: true });
    try {
      const r = await order("main", "C5", "NOW");
      expect(r.body.status).toBe("PENDING");
      const req = await db.channelRequest.findUniqueOrThrow({ where: { id: r.body.id } });
      await pay(req.orderId!);
      expect(await db.kotTicket.count({ where: { orderId: req.orderId! } })).toBe(0);
      expect((await waiter.call("POST", `/theatre/orders/${r.body.id}/ready`)).status).toBe(409);
      expect((await waiter.call("POST", `/storefront/requests/${r.body.id}/accept`)).status).toBe(200);
      expect((await db.kotTicket.findMany({ where: { orderId: req.orderId! } })).map((k) => k.header)).toEqual(["SCREEN S1 · C5 · NOW"]);
      // Accepted first, paid later.
      const r2 = await order("main", "C6", "NOW");
      expect((await waiter.call("POST", `/storefront/requests/${r2.body.id}/accept`)).status).toBe(200);
      const req2 = await db.channelRequest.findUniqueOrThrow({ where: { id: r2.body.id } });
      expect(await db.kotTicket.count({ where: { orderId: req2.orderId! } })).toBe(0);
      await pay(req2.orderId!);
      expect(await db.kotTicket.count({ where: { orderId: req2.orderId! } })).toBe(1);
      // Rejected: the unpaid bill is cancelled.
      const r3 = await order("main", "C7", "NOW");
      expect((await waiter.call("POST", `/storefront/requests/${r3.body.id}/reject`, { reason: "Kitchen closed" })).status).toBe(200);
      const req3 = await db.channelRequest.findUniqueOrThrow({ where: { id: r3.body.id } });
      expect((await db.order.findUniqueOrThrow({ where: { id: req3.orderId! } })).status).toBe("CANCELLED");
      expect((await pub("GET", `/public/t/${seat("main", "C7").qrToken}/orders`)).body[0]).toMatchObject({ stage: "CANCELLED", rejectReason: "Kitchen closed" });
    } finally {
      await owner.call("PUT", "/storefront/settings", { qrNeedsConfirmation: false });
    }
  });

  it("unpaid seat orders expire after 30 minutes (bill cancelled, request rejected)", async () => {
    const r = await order("main", "C8", "NOW");
    const req = await db.channelRequest.update({ where: { id: r.body.id }, data: { createdAt: new Date(Date.now() - 31 * MIN) } });
    expect(await expireUnpaidSeatOrders()).toBeGreaterThanOrEqual(1);
    expect(await db.channelRequest.findUniqueOrThrow({ where: { id: req.id } })).toMatchObject({ status: "REJECTED", rejectReason: "Not paid in time" });
    expect((await db.order.findUniqueOrThrow({ where: { id: req.orderId! } })).status).toBe("CANCELLED");
    expect(await db.payment.count({ where: { orderId: req.orderId!, status: "PENDING" } })).toBe(0);
  });
});

// =====================================================================
describe("runner board, report, settings", () => {
  it("board groups by screen and row, counter by token; ready → delivered moves the KOTs and emits theatre:updated", async () => {
    const r = await order("main", "C9", "NOW");
    const req = await db.channelRequest.findUniqueOrThrow({ where: { id: r.body.id } });
    // Unpaid: on the board (so a cashier can confirm UPI by hand) but can't be marked ready.
    let board = (await cashier.call("GET", "/theatre/board")).body;
    const find = (b: typeof board, id: string) => [...b.screens.flatMap((s: { rows: { orders: unknown[] }[] }) => s.rows.flatMap((x) => x.orders)), ...b.counter].find((o: { requestId: string }) => o.requestId === id);
    expect(find(board, r.body.id)).toMatchObject({ stage: "WAITING", paid: false, orderId: req.orderId, publicToken: r.body.token });
    expect((await waiter.call("POST", `/theatre/orders/${r.body.id}/ready`)).status).toBe(409);
    await pay(req.orderId!);
    board = (await cashier.call("GET", "/theatre/board")).body;
    expect(board.screens.map((s: { code: string }) => s.code)).toContain("S1");
    const main = board.screens.find((s: { id: string }) => s.id === screens.main.id);
    expect(main.currentShow).toMatchObject({ id: showMain.id });
    expect(main.rows.map((x: { row: string }) => x.row)).toEqual([...main.rows.map((x: { row: string }) => x.row)].sort());
    for (const row of main.rows) for (const o of row.orders) expect(o).toMatchObject({ row: row.row, screenId: screens.main.id });
    expect(main.rows.flatMap((x: { orders: { timing: string }[] }) => x.orders).some((o: { timing: string }) => o.timing === "COUNTER")).toBe(false);
    const tokens = board.counter.map((o: { pickupToken: number }) => o.pickupToken);
    expect(tokens).toEqual([...tokens].sort((a: number, b: number) => a - b));
    expect(find(board, r.body.id)).toMatchObject({ stage: "PREPARING", paid: true, items: [{ name: "Chai", quantity: 2 }] });

    const since = new Date(Date.now() - 1000);
    const ready = await waiter.call("POST", `/theatre/orders/${r.body.id}/ready`);
    expect(ready.status).toBe(200);
    expect(ready.body.stage).toBe("READY");
    expect((await db.kotTicket.findMany({ where: { orderId: req.orderId! } })).every((k) => k.status === "READY" && k.readyAt)).toBe(true);
    expect((await waiter.call("POST", `/theatre/orders/${r.body.id}/ready`)).body.stage).toBe("READY");
    const done = await waiter.call("POST", `/theatre/orders/${r.body.id}/delivered`);
    expect(done.body.stage).toBe("DELIVERED");
    expect((await db.kotTicket.findMany({ where: { orderId: req.orderId! } })).every((k) => k.status === "SERVED" && k.servedAt)).toBe(true);
    expect((await waiter.call("POST", `/theatre/orders/${r.body.id}/delivered`)).status).toBe(409);
    expect((await waiter.call("POST", `/theatre/orders/${r.body.id}/ready`)).status).toBe(409);
    const events = await db.outboxEvent.findMany({ where: { name: "theatre:updated", target: w.h.outletId, createdAt: { gte: since } } });
    expect(events.map((e) => (e.payload as { action: string }).action)).toEqual(expect.arrayContaining(["ready", "delivered"]));
    expect((await pub("GET", `/public/t/${seat("main", "C9").qrToken}/orders`)).body[0].stage).toBe("DELIVERED");
    // The kitchen marking a seat order ready shows on the board too.
    const r2 = await order("main", "A5", "NOW");
    const req2 = await db.channelRequest.findUniqueOrThrow({ where: { id: r2.body.id } });
    await pay(req2.orderId!);
    const [k2] = await db.kotTicket.findMany({ where: { orderId: req2.orderId! } });
    expect((await kitchen.call("PATCH", `/kot/${k2.id}`, { status: "READY" })).status).toBe(200);
    expect(find((await cashier.call("GET", "/theatre/board")).body, r2.body.id).stage).toBe("READY");
    expect((await waiter.call("POST", `/theatre/orders/${GHOST}/ready`)).status).toBe(404);
    expect((await waiter.call("GET", `/theatre/board?screenId=${GHOST}`)).status).toBe(404);
  });

  it("report: totals, by screen, by show and by timing add up to the paid seat orders; Excel export", async () => {
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
    const r = await owner.call("GET", `/reports/theatre?from=${today}&to=${today}`);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const paid = await db.channelRequest.findMany({ where: { outletId: w.h.outletId, seatTiming: { not: null }, status: "ACCEPTED" } });
    const orders = await db.order.findMany({ where: { id: { in: paid.map((p) => p.orderId!) }, status: "PAID" } });
    const sales = orders.reduce((s, o) => s + o.grandTotal - o.refundedAmount, 0);
    expect(orders.length).toBeGreaterThan(5);
    expect(r.body.totals).toEqual({ orders: orders.length, sales, avgOrder: Math.round(sales / orders.length) });
    const sum = (rows: { orders: number; sales: number }[]) => rows.reduce((a, x) => ({ orders: a.orders + x.orders, sales: a.sales + x.sales }), { orders: 0, sales: 0 });
    expect(sum(r.body.byScreen)).toEqual({ orders: orders.length, sales });
    expect(sum(r.body.byShow)).toEqual({ orders: orders.length, sales });
    expect(sum(r.body.byTiming)).toEqual({ orders: orders.length, sales });
    expect(r.body.byTiming.map((t: { timing: string }) => t.timing)).toEqual(["NOW", "INTERVAL", "COUNTER"]);
    expect(r.body.byScreen[0]).toMatchObject({ screenId: screens.main.id, name: "Audi 1" });
    expect(r.body.byShow[0]).toMatchObject({ showTimeId: showMain.id, title: "Movie", screenName: "Audi 1" });
    const x = await raw(srv.base, owner, `/reports/theatre?from=${today}&to=${today}&format=xlsx`, w.h.outletId);
    expect(x.status).toBe(200);
    expect(x.headers.get("content-type")).toContain("spreadsheetml");
    for (const q of ["from=2026-02-30", "from=2026-05-02&to=2026-05-01", "format=csv"]) expect((await owner.call("GET", `/reports/theatre?${q}`)).status).toBe(400);
    // A show with orders can't be deleted (reports group by show).
    expect((await manager.call("DELETE", `/theatre/showtimes/${showMain.id}`)).status).toBe(409);
  });

  it("settings: defaults, partial updates, validation; storefront saves keep them", async () => {
    const got = (await waiter.call("GET", "/theatre/settings")).body;
    expect(got).toEqual({ seatOrdering: true, intervalLeadMin: 10, counterPickup: true, deliverDuringShow: true });
    expect((await w.owner2.call("GET", "/theatre/settings")).body).toEqual({ seatOrdering: false, intervalLeadMin: 10, counterPickup: true, deliverDuringShow: true });
    for (const b of [{ intervalLeadMin: 61 }, { intervalLeadMin: -1 }, { seatOrdering: "yes" }, { other: 1 }]) expect((await owner.call("PATCH", "/theatre/settings", b)).status).toBe(400);
    expect((await owner.call("PATCH", "/theatre/settings", { intervalLeadMin: 12 })).body).toMatchObject({ intervalLeadMin: 12, seatOrdering: true });
    expect((await owner.call("PUT", "/storefront/settings", { minOrder: 0 })).status).toBe(200);
    expect((await owner.call("GET", "/theatre/settings")).body.intervalLeadMin).toBe(12);
    await setTheatre({ intervalLeadMin: 10 });
  });
});

// =====================================================================
describe("restaurant tables are unaffected", () => {
  it("floor plan, table list, areas and table QR list leave screens and seats out (unless asked); normal table QR still works", async () => {
    const t = await manager.call("POST", "/tables", { label: "T1", capacity: 4 });
    expect(t.status).toBe(201);
    const floor = (await waiter.call("GET", "/tables/floor")).body;
    expect(floor.areas.map((a: { id: string | null }) => a.id)).not.toContain(screens.main.id);
    const floorTables = floor.areas.flatMap((a: { tables: { label: string }[] }) => a.tables.map((x) => x.label));
    expect(floorTables).toContain("T1");
    expect(floorTables.some((l: string) => /^S\d+-/.test(l))).toBe(false);
    expect(floor.stats.tables).toBe(floorTables.length);
    const list = (await waiter.call("GET", "/tables")).body.map((x: { label: string }) => x.label);
    expect(list).toContain("T1");
    expect(list.some((l: string) => /^S\d+-/.test(l))).toBe(false);
    expect((await waiter.call("GET", "/tables?includeScreens=1")).body.map((x: { label: string }) => x.label)).toContain("S1-A1");
    expect((await waiter.call("GET", "/tables/areas")).body.map((a: { id: string }) => a.id)).not.toContain(screens.main.id);
    expect((await waiter.call("GET", "/tables/areas?includeScreens=1")).body.map((a: { id: string }) => a.id)).toContain(screens.main.id);
    const qrs = (await manager.call("GET", "/storefront/tables")).body.map((x: { label: string }) => x.label);
    expect(qrs).toContain("T1");
    expect(qrs.some((l: string) => /^S\d+-/.test(l))).toBe(false);
    // Screens can't be edited or filled with normal tables through /tables.
    expect((await manager.call("POST", "/tables", { label: "T2", areaId: screens.main.id })).status).toBe(404);
    expect((await manager.call("PATCH", `/tables/areas/${screens.main.id}`, { name: "x" })).status).toBe(404);
    expect((await manager.call("DELETE", `/tables/areas/${screens.main.id}`)).status).toBe(404);
    // Dine-in QR ordering keeps its own switch and its own flow (running tab, no prepay).
    await owner.call("PUT", "/storefront/settings", { qrOrdering: true });
    const token = (await manager.call("GET", "/storefront/tables")).body.find((x: { label: string }) => x.label === "T1").qrToken;
    const page = (await pub("GET", `/public/t/${token}`)).body;
    expect(page.ordering).toBe(true);
    expect(page.theatre).toBeUndefined();
    const o = await pub("POST", `/public/t/${token}/orders`, cart());
    expect(o.status, JSON.stringify(o.body)).toBe(201);
    expect(Object.keys(o.body).sort()).toEqual(["id", "status"]);
    expect(Array.isArray((await pub("GET", `/public/t/${token}/orders`)).body)).toBe(true);
    await owner.call("PUT", "/storefront/settings", { qrOrdering: false });
    expect((await pub("GET", `/public/t/${token}`)).body.ordering).toBe(false);
  });
});
