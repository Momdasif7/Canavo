/**
 * QA Phase 6 — /attendance: self service, manager views (register, manual marks, edits,
 * export, salary), calendar and leave. Contract, rbac loop, module gating, cross-tenant /
 * cross-outlet, date validation (real calendar dates, IST), money as integers.
 * (Clock-in anti-spoofing flows are in integration/clock-in, leave flows in integration/leave.)
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHotel, startServer, type Hotel } from "../integration/helpers";
import { addUser, allowedRoles, cast, createPlatformAdmin, db, expectAuthz, HUGE, NASTY, signIn, type Cast, type Session } from "./kit-auth";

let srv: Awaited<ReturnType<typeof startServer>>;
let h: Hotel, other: Hotel;
let c: Cast;
let owner: Session, manager: Session, cashier: Session, otherOwner: Session;

const istToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
const daysAgo = (n: number) => new Date(Date.parse(`${istToday()}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);
const month = () => istToday().slice(0, 7);

beforeAll(async () => {
  srv = await startServer();
  [h, other] = [await createHotel("Attendance API"), await createHotel("Attendance Other")];
  c = await cast(srv.base, h);
  ({ BUSINESS_OWNER: owner, OUTLET_MANAGER: manager, CASHIER: cashier } = c.clients);
  otherOwner = await signIn(srv.base, other.users.owner.email, other.outletId);
});
afterAll(() => srv.close());

describe("authorization", () => {
  it.each([
    ["GET", "/attendance?from=2026-01-01&to=2026-01-31", ["attendance:manage"]],
    ["GET", "/attendance/export?from=2026-01-01&to=2026-01-31&format=csv", ["attendance:manage"]],
    ["GET", "/attendance/salary?month=2026-01", ["attendance:manage"]],
    ["GET", "/attendance/register", ["attendance:manage"]],
    ["POST", "/attendance/register", ["attendance:manage"]],
    ["POST", "/attendance/manual", ["attendance:manage"]],
    ["PATCH", "/attendance/leaves/cl0000000000000000000000", ["attendance:manage"]],
    ["PATCH", "/attendance/cl0000000000000000000000", ["attendance:manage"]],
    ["DELETE", "/attendance/cl0000000000000000000000", ["attendance:manage"]],
    ["POST", "/attendance/clock-in", ["attendance:self"]],
    ["POST", "/attendance/clock-out", ["attendance:self"]],
    ["POST", "/attendance/leaves", ["attendance:self"]],
    ["GET", "/attendance/me/status", []],
    ["GET", "/attendance/leaves", []],
    ["GET", `/attendance/calendar?month=2026-01`, []],
  ] as const)("%s %s", async (method, path, perms) => {
    await expectAuthz(c, method, path, allowedRoles([...perms], method), method === "GET" || method === "DELETE" ? undefined : {});
  });

  it("module ATTENDANCE off → every attendance route refused (403)", async () => {
    const off = await createHotel("No attendance", { modules: ["BILLING"] });
    const o = await signIn(srv.base, off.users.owner.email, off.outletId);
    for (const [m, p] of [["GET", "/attendance/me/status"], ["GET", "/attendance/register"], ["POST", "/attendance/leaves"], ["GET", `/attendance/calendar?month=${month()}`]] as const)
      expect((await o.call(m, p, m === "POST" ? {} : undefined)).status, p).toBe(403);
  });

  it("the platform admin can't open any outlet's register", async () => {
    const admin = await signIn(srv.base, (await createPlatformAdmin()).email);
    expect((await admin.call("GET", "/attendance/register", undefined, { "x-outlet-id": h.outletId })).status).toBe(403);
  });

  it("cross-outlet / cross-tenant headers → 403", async () => {
    expect((await manager.call("GET", "/attendance/register", undefined, { "x-outlet-id": h.outlet2Id })).status).toBe(403);
    expect((await otherOwner.call("GET", "/attendance/register", undefined, { "x-outlet-id": h.outletId })).status).toBe(403);
  });
});

describe("manual marks, edits and deletes", () => {
  let recId: string;

  it("POST /manual: 201 contract; integer minute fields; marked-by recorded", async () => {
    const r = await manager.call("POST", "/attendance/manual", { userId: c.ids.CASHIER, date: daysAgo(2), status: "PRESENT", clockIn: "09:00", clockOut: "18:00", note: NASTY.tamil });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body).toMatchObject({ userId: c.ids.CASHIER, outletId: h.outletId, workDate: daysAgo(2), status: "PRESENT", source: "MANUAL", markedById: c.ids.OUTLET_MANAGER, note: NASTY.tamil, workedMinutes: 540 });
    for (const k of ["workedMinutes", "lateByMinutes", "earlyByMinutes", "overtimeMinutes"]) expect(Number.isInteger(r.body[k]), k).toBe(true);
    // 09:00 IST is 03:30 UTC
    expect(r.body.clockInAt).toBe(`${daysAgo(2)}T03:30:00.000Z`);
    recId = r.body.id;
  });

  it.each([
    ["missing userId", { userId: undefined, status: "ABSENT" }],
    ["bad status", { status: "HOLIDAY" }],
    ["present without clock-in", { status: "PRESENT" }],
    ["bad time", { status: "PRESENT", clockIn: "24:00" }],
    ["10k note", { status: "ABSENT", note: HUGE }],
    ["bad date format", { status: "ABSENT", date: "03/11/2026" }],
    ["impossible month", { status: "ABSENT", date: "2025-13-01" }],
    ["impossible day", { status: "ABSENT", date: "2025-02-30" }],
    ["future date", { status: "ABSENT", date: "2099-01-01" }],
  ])("POST /manual 400 on %s (nothing written)", async (_n, over) => {
    const before = await db.staffAttendance.count({ where: { userId: c.ids.KITCHEN } });
    const r = await manager.call("POST", "/attendance/manual", { userId: c.ids.KITCHEN, date: daysAgo(3), ...over });
    expect(r.status, JSON.stringify(r.body)).toBe(400);
    expect(await db.staffAttendance.count({ where: { userId: c.ids.KITCHEN } })).toBe(before);
  });

  it("POST /manual: 404 for another outlet's / hotel's staff; 403 for yourself or someone at your rank", async () => {
    const o2 = await addUser(h, "CASHIER", [h.outlet2Id]);
    expect((await manager.call("POST", "/attendance/manual", { userId: o2.id, date: daysAgo(1), status: "ABSENT" })).status).toBe(404);
    expect((await manager.call("POST", "/attendance/manual", { userId: other.users.cashier.id, date: daysAgo(1), status: "ABSENT" })).status).toBe(404);
    expect((await manager.call("POST", "/attendance/manual", { userId: c.ids.OUTLET_MANAGER, date: daysAgo(1), status: "PRESENT", clockIn: "09:00" })).status).toBe(403);
    const m2 = await addUser(h, "OUTLET_MANAGER");
    expect((await manager.call("POST", "/attendance/manual", { userId: m2.id, date: daysAgo(1), status: "ABSENT" })).status).toBe(403);
    expect((await owner.call("POST", "/attendance/manual", { userId: m2.id, date: daysAgo(1), status: "ABSENT" })).status).toBe(201);
  });

  it("POST /register: 200 with saved + skipped; 400 on bad dates or empty entries", async () => {
    const r = await manager.call("POST", "/attendance/register", {
      date: daysAgo(4),
      entries: [
        { userId: c.ids.CASHIER, status: "PRESENT", clockIn: "09:00", clockOut: "17:00" },
        { userId: other.users.cashier.id, status: "ABSENT" },
      ],
    });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ date: daysAgo(4), saved: 1, skipped: [{ userId: other.users.cashier.id }] });
    for (const body of [{ date: daysAgo(4), entries: [] }, { date: "2025-13-01", entries: [{ userId: c.ids.CASHIER, status: "ABSENT" }] }, { entries: [{ userId: c.ids.CASHIER, status: "ABSENT" }] }, { date: "2099-01-01", entries: [{ userId: c.ids.CASHIER, status: "ABSENT" }] }])
      expect((await manager.call("POST", "/attendance/register", body)).status, JSON.stringify(body)).toBe(400);
  });

  it("PATCH /:id: 200; 400 on bad input; 404 unknown / other hotel's record", async () => {
    const r = await manager.call("PATCH", `/attendance/${recId}`, { clockOut: "20:00", note: NASTY.xss });
    expect(r.status).toBe(200);
    expect(r.body.note).toBe(NASTY.xss);
    expect(r.body.workedMinutes).toBe(660);
    for (const body of [{ status: "X" }, { clockIn: "9am" }, { note: HUGE }]) expect((await manager.call("PATCH", `/attendance/${recId}`, body)).status).toBe(400);
    expect((await manager.call("PATCH", "/attendance/cl0000000000000000000000", { note: "x" })).status).toBe(404);
    expect((await otherOwner.call("PATCH", `/attendance/${recId}`, { note: "stolen" })).status).toBe(404);
    expect((await otherOwner.call("DELETE", `/attendance/${recId}`)).status).toBe(404);
  });

  it("GET / and /register: IST day boundaries, empty ranges, invalid dates → 400", async () => {
    const list = await manager.call("GET", `/attendance?from=${daysAgo(2)}&to=${daysAgo(2)}`);
    expect(list.status).toBe(200);
    expect(list.body.map((x: { id: string }) => x.id)).toContain(recId);
    expect(list.body[0].user).not.toHaveProperty("passwordHash");
    expect((await manager.call("GET", `/attendance?from=${daysAgo(1)}&to=${daysAgo(1)}`)).body.map((x: { id: string }) => x.id)).not.toContain(recId);
    expect((await manager.call("GET", "/attendance?from=2000-01-01&to=2000-01-31")).body).toEqual([]);
    for (const q of ["", "?from=2026-01-01", "?from=bad&to=2026-01-01", "?from=2025-13-01&to=2025-13-31", "?from=2025-02-30&to=2025-03-01"])
      expect((await manager.call("GET", `/attendance${q}`)).status, q).toBe(400);
    const reg = await manager.call("GET", `/attendance/register?date=${daysAgo(2)}`);
    expect(reg.status).toBe(200);
    expect(reg.body).toMatchObject({ date: daysAgo(2), timezone: "Asia/Kolkata" });
    expect(reg.body.staff.find((s: { user: { id: string } }) => s.user.id === c.ids.CASHIER).status).toBe("PRESENT");
    for (const d of ["2025-13-01", "bad", "2025-02-30"]) expect((await manager.call("GET", `/attendance/register?date=${d}`)).status, d).toBe(400);
  });

  it("export: csv / xlsx attachments with safe filenames; 400 on bad ranges", async () => {
    const csv = await manager.call("GET", `/attendance/export?from=${daysAgo(5)}&to=${istToday()}&format=csv`);
    expect(csv.status).toBe(200);
    expect(csv.headers.get("content-type")).toMatch(/text\/csv/);
    expect(csv.headers.get("content-disposition")).toBe(`attachment; filename="attendance_${daysAgo(5)}_${istToday()}.csv"`);
    expect(csv.body).toContain("Clock in");
    const xlsx = await manager.call("GET", `/attendance/export?from=${daysAgo(5)}&to=${istToday()}`);
    expect(xlsx.headers.get("content-type")).toMatch(/spreadsheetml/);
    expect((await manager.call("GET", '/attendance/export?from=2026-01-01"%0d%0aX:y&to=2026-01-02')).status).toBe(400);
  });

  it("salary: integer paise everywhere; 400 on bad months", async () => {
    await db.user.update({ where: { id: c.ids.CASHIER }, data: { salaryType: "MONTHLY", salaryAmount: 1_000_001 } });
    const r = await manager.call("GET", `/attendance/salary?month=${daysAgo(2).slice(0, 7)}`);
    expect(r.status).toBe(200);
    const row = r.body.rows.find((x: { userId: string }) => x.userId === c.ids.CASHIER);
    for (const k of ["salaryAmount", "dailyRate", "grossPay", "presentDays", "overtimeMinutes"]) expect(Number.isInteger(row[k]), k).toBe(true);
    expect(row.presentDays).toBeGreaterThanOrEqual(1);
    for (const m of ["", "2026-13", "2026-1", "abc"]) expect((await manager.call("GET", `/attendance/salary?month=${m}`)).status, m).toBe(400);
  });

  it("DELETE /:id: 204, then 404", async () => {
    expect((await manager.call("DELETE", `/attendance/${recId}`)).status).toBe(204);
    expect((await manager.call("DELETE", `/attendance/${recId}`)).status).toBe(404);
  });
});

describe("calendar", () => {
  it("own calendar: one entry per day of the month; 400 on bad months", async () => {
    const r = await cashier.call("GET", `/attendance/calendar?month=2026-02`);
    expect(r.status).toBe(200);
    expect(r.body.days).toHaveLength(28);
    expect(r.body.userId).toBe(c.ids.CASHIER);
    for (const m of ["", "2026-00", "2026-2", "26-02"]) expect((await cashier.call("GET", `/attendance/calendar?month=${m}`)).status, m).toBe(400);
  });

  it("someone else's calendar: staff → 403; a manager only for staff of their own outlets; other hotels' → nothing", async () => {
    expect((await cashier.call("GET", `/attendance/calendar?month=${month()}&userId=${c.ids.KITCHEN}`)).status).toBe(403);
    expect((await manager.call("GET", `/attendance/calendar?month=${month()}&userId=${c.ids.KITCHEN}`)).status).toBe(200);
    const o2 = await addUser(h, "CASHIER", [h.outlet2Id]);
    await db.staffAttendance.create({ data: { userId: o2.id, outletId: h.outlet2Id, workDate: daysAgo(1), clockInAt: new Date(), clockInDistance: 0, note: "outlet-2 secret", source: "MANUAL", status: "ABSENT" } });
    const r = await manager.call("GET", `/attendance/calendar?month=${daysAgo(1).slice(0, 7)}&userId=${o2.id}`);
    expect([403, 404]).toContain(r.status);
    // the owner sees everyone in the business
    expect((await owner.call("GET", `/attendance/calendar?month=${daysAgo(1).slice(0, 7)}&userId=${o2.id}`)).status).toBe(200);
    const foreign = await otherOwner.call("GET", `/attendance/calendar?month=${month()}&userId=${c.ids.CASHIER}`);
    expect(JSON.stringify(foreign.body)).not.toMatch(/records":\[\{/);
  });
});

describe("leave", () => {
  it("POST: 201 contract; userId / status smuggled in the body are ignored", async () => {
    const r = await c.clients.KITCHEN.call("POST", "/attendance/leaves", { fromDate: "2026-12-01", toDate: "2026-12-02", type: "CASUAL", reason: NASTY.emoji, userId: c.ids.OUTLET_MANAGER, status: "APPROVED" });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ userId: c.ids.KITCHEN, status: "PENDING", reason: NASTY.emoji });
  });

  it.each([
    ["to before from", { fromDate: "2026-12-05", toDate: "2026-12-01", type: "CASUAL" }],
    ["bad type", { fromDate: "2026-12-01", toDate: "2026-12-01", type: "HOLIDAY" }],
    ["10k reason", { fromDate: "2026-12-01", toDate: "2026-12-01", type: "SICK", reason: HUGE }],
    ["impossible date", { fromDate: "2026-02-30", toDate: "2026-03-01", type: "SICK" }],
    ["impossible month", { fromDate: "2026-13-01", toDate: "2026-13-02", type: "SICK" }],
    ["missing dates", { type: "SICK" }],
  ])("POST 400 on %s", async (_n, body) => {
    expect((await c.clients.KITCHEN.call("POST", "/attendance/leaves", body)).status).toBe(400);
  });

  it("PATCH: approve once (then 400), own leave 403, other hotel 404, bad status 400", async () => {
    const mine = await manager.call("POST", "/attendance/leaves", { fromDate: "2026-12-10", toDate: "2026-12-10", type: "SICK" });
    expect((await manager.call("PATCH", `/attendance/leaves/${mine.body.id}`, { status: "APPROVED" })).status).toBe(403);
    const l = await c.clients.KITCHEN.call("POST", "/attendance/leaves", { fromDate: "2026-12-11", toDate: "2026-12-11", type: "SICK" });
    expect((await otherOwner.call("PATCH", `/attendance/leaves/${l.body.id}`, { status: "APPROVED" })).status).toBe(404);
    expect((await manager.call("PATCH", `/attendance/leaves/${l.body.id}`, { status: "PENDING" })).status).toBe(400);
    const ok = await manager.call("PATCH", `/attendance/leaves/${l.body.id}`, { status: "APPROVED" });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ status: "APPROVED", reviewerId: c.ids.OUTLET_MANAGER });
    expect((await manager.call("PATCH", `/attendance/leaves/${l.body.id}`, { status: "REJECTED" })).status).toBe(400);
  });

  it("GET ?scope=outlet: managers see their outlets' requests; staff only their own", async () => {
    const mgr = await manager.call("GET", "/attendance/leaves?scope=outlet");
    expect(mgr.body.some((x: { userId: string }) => x.userId === c.ids.KITCHEN)).toBe(true);
    const staff = await cashier.call("GET", "/attendance/leaves?scope=outlet");
    expect(staff.body.every((x: { userId: string }) => x.userId === c.ids.CASHIER)).toBe(true);
    expect((await otherOwner.call("GET", "/attendance/leaves?scope=outlet")).body.some((x: { userId: string }) => x.userId === c.ids.KITCHEN)).toBe(false);
  });
});

describe("self service", () => {
  it("clock-in / clock-out: 400 on missing or out-of-range coordinates", async () => {
    for (const body of [{}, { latitude: 91, longitude: 80 }, { latitude: "13", longitude: 80 }, { latitude: 13, longitude: 80, pin: "12" }, { latitude: 13, longitude: 80, selfieUrl: "javascript:alert(1)" }])
      for (const p of ["/attendance/clock-in", "/attendance/clock-out"]) expect((await c.clients.WAITER.call("POST", p, body)).status, `${p} ${JSON.stringify(body)}`).toBe(400);
  });

  it("GET /me/status: shape", async () => {
    const r = await cashier.call("GET", "/attendance/me/status");
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ clockedIn: expect.any(Boolean), recent: expect.any(Array) });
    expect(r.body).toHaveProperty("current");
  });
});
