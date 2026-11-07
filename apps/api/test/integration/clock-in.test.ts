/** Phase 2.6 — clock-in anti-spoofing: PIN lockout, fake GPS, weak GPS, selfie, evidence for managers. */
import bcrypt from "bcryptjs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHotel, db, login, startServer, type Client, type Hotel } from "./helpers";

let srv: Awaited<ReturnType<typeof startServer>>;
let h: Hotel;
let cashier: Client;
const AT_OUTLET = { latitude: 13.0, longitude: 80.2 };
// ~40 m from the outlet: inside a 50 m fence only if the GPS error is added.
const NEAR = { latitude: 13.0, longitude: 80.20055 };

beforeAll(async () => {
  srv = await startServer();
  h = await createHotel("Clock");
  await db.outlet.update({ where: { id: h.outletId }, data: { geofenceMeters: 50 } });
  await db.user.update({ where: { id: h.users.cashier.id }, data: { pinHash: await bcrypt.hash("4321", 4) } });
  cashier = await login(srv.base, h.users.cashier.email, h.outletId);
});
afterAll(() => srv.close());
beforeEach(async () => {
  await db.staffAttendance.deleteMany({ where: { userId: h.users.cashier.id } });
  await db.user.update({ where: { id: h.users.cashier.id }, data: { pinFailedAttempts: 0, pinLockedUntil: null } });
  await db.business.update({ where: { id: h.businessId }, data: { features: {} } });
});

const clockIn = (body: Record<string, unknown>) => cashier.call("POST", "/attendance/clock-in", { outletId: h.outletId, pin: "4321", ...body });

describe("clock-in PIN lockout", () => {
  it("5 wrong PINs lock clock-in for 15 minutes, even with the right PIN afterwards", async () => {
    for (let i = 0; i < 4; i++) expect((await clockIn({ ...AT_OUTLET, accuracy: 10, pin: "0000" })).status).toBe(403);
    const fifth = await clockIn({ ...AT_OUTLET, accuracy: 10, pin: "0000" });
    expect(fifth.status).toBe(423);
    expect((await clockIn({ ...AT_OUTLET, accuracy: 10 })).status).toBe(423);
    const u = await db.user.findUniqueOrThrow({ where: { id: h.users.cashier.id } });
    expect(u.pinLockedUntil!.getTime()).toBeGreaterThan(Date.now() + 14 * 60_000);
  });
});

describe("without strict mode (existing hotels)", () => {
  it("still clocks in, but records fake GPS and weak accuracy for the manager", async () => {
    const r = await clockIn({ ...AT_OUTLET, accuracy: 150, mocked: true });
    expect(r.status).toBe(201);
    expect(r.body.clockInMocked).toBe(true);
    expect(r.body.clockInFlags.sort()).toEqual(["LOW_ACCURACY", "MOCK_LOCATION"]);
    expect(r.body.clockInAccuracy).toBe(150);
  });

  it("GPS error still widens the fence (old behaviour)", async () => {
    expect((await clockIn({ ...NEAR, accuracy: 30 })).status).toBe(201);
  });
});

describe("STRICT_CLOCK_IN", () => {
  beforeEach(async () => {
    await db.business.update({ where: { id: h.businessId }, data: { features: { STRICT_CLOCK_IN: true } } });
  });

  it("refuses a fake location", async () => {
    const r = await clockIn({ ...AT_OUTLET, accuracy: 10, mocked: true });
    expect(r.status).toBe(403);
    expect(r.body.details.code).toBe("MOCK_LOCATION");
  });

  it("refuses a weak or missing GPS fix", async () => {
    expect((await clockIn({ ...AT_OUTLET, accuracy: 80 })).body.details.code).toBe("LOW_ACCURACY");
    expect((await clockIn({ ...AT_OUTLET })).body.details.code).toBe("LOW_ACCURACY");
  });

  it("doesn't widen the fence by the GPS error", async () => {
    const r = await clockIn({ ...NEAR, accuracy: 30 });
    expect(r.status).toBe(403);
    expect(r.body.details.code).toBe("OUTSIDE_GEOFENCE");
    expect((await clockIn({ ...AT_OUTLET, accuracy: 10 })).status).toBe(201);
  });
});

describe("CLOCK_IN_SELFIE", () => {
  it("needs a selfie uploaded through CANAVO", async () => {
    await db.business.update({ where: { id: h.businessId }, data: { features: { CLOCK_IN_SELFIE: true } } });
    expect((await clockIn({ ...AT_OUTLET, accuracy: 10 })).body.details.code).toBe("SELFIE_REQUIRED");
    expect((await clockIn({ ...AT_OUTLET, accuracy: 10, selfieUrl: "https://evil.example/me.jpg" })).status).toBe(400);
    const ok = await clockIn({ ...AT_OUTLET, accuracy: 10, selfieUrl: `${srv.base}/uploads/files/abc-123.jpg` });
    expect(ok.status).toBe(201);
    expect(ok.body.clockInSelfieUrl).toMatch(/\/uploads\/files\/abc-123\.jpg$/);
  });
});
