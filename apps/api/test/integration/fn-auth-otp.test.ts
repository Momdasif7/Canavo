/**
 * QA Phase 5 — Group A functional tests: phone OTP login (request, throttle,
 * verify, expiry, single use, attempt limit). Separate file so its /auth/otp
 * calls get their own 50-per-15-min IP limiter budget.
 */
import { describe, expect, it } from "vitest";
import { createTenant, db } from "./helpers";
import { agentFromToken, raw } from "./fx-a";

const request = (phone: string) => raw().post("/auth/otp/request").send({ phone });
const verify = (phone: string, code: string, deviceId?: string) => raw().post("/auth/otp/verify").send({ phone, code, deviceId });
const phoneOf = async (id: string) => (await db.user.findUniqueOrThrow({ where: { id } })).phone;
const unregistered = () => `6${String(Math.floor(Math.random() * 1e9)).padStart(9, "0")}`;
const wrongCode = (c: string) => String((Number(c) + 1) % 1_000_000).padStart(6, "0");

describe("OTP request", () => {
  it("IT-AUTH-060 registered phone → {ok, expiresIn:300} + 6-digit devCode (test env), hash stored not the code @regression @critical", async () => {
    const t = await createTenant();
    const phone = await phoneOf(t.users.CASHIER.id);
    const res = await request(phone);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, expiresIn: 300 });
    expect(res.body.devCode).toMatch(/^\d{6}$/);
    const row = await db.otpCode.findFirstOrThrow({ where: { phone }, orderBy: { createdAt: "desc" } });
    expect(row.codeHash).not.toContain(res.body.devCode);
    expect(row.expiresAt.getTime() - row.createdAt.getTime()).toBeGreaterThanOrEqual(299_000);
  });

  it("IT-AUTH-061 unregistered phone → identical 200 {ok:true, expiresIn:300}, nothing stored @regression @critical", async () => {
    const phone = unregistered();
    const res = await request(phone);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, expiresIn: 300 });
    expect(await db.otpCode.count({ where: { phone } })).toBe(0);
  });

  it("IT-AUTH-062 inactive user → same generic response, no OTP issued @regression", async () => {
    const t = await createTenant();
    await db.user.update({ where: { id: t.users.KITCHEN.id }, data: { status: "INACTIVE" } });
    const phone = await phoneOf(t.users.KITCHEN.id);
    const res = await request(phone);
    expect(res.body).toEqual({ ok: true, expiresIn: 300 });
    expect(await db.otpCode.count({ where: { phone } })).toBe(0);
  });

  it("IT-AUTH-063 invalid phone formats → 400 (BVA: 9/11 digits, leading 5, letters) @regression", async () => {
    for (const p of ["987650000", "98765000001", "5876500000", "98765abcde", ""]) {
      expect((await request(p)).status, p).toBe(400);
    }
  });

  it("IT-AUTH-064 second request within 30 s → 429; after 30 s → new OTP @regression @critical", async () => {
    const t = await createTenant();
    const phone = await phoneOf(t.users.DELIVERY.id);
    expect((await request(phone)).status).toBe(200);
    const again = await request(phone);
    expect(again.status).toBe(429);
    expect(again.body.error).toMatch(/30 seconds/);
    // age the OTP past the throttle window
    await db.otpCode.updateMany({ where: { phone }, data: { createdAt: new Date(Date.now() - 31_000) } });
    const third = await request(phone);
    expect(third.status).toBe(200);
    expect(third.body.devCode).toMatch(/^\d{6}$/);
  });

  // BUG-CANDIDATE-A3: the 30 s throttle only applies to registered numbers, so
  // asking twice reveals whether a phone has an account (429 vs 200) — the
  // enumeration the "same response" logic tries to prevent (RTM AUTH-004).
  // Expected: both numbers answer the 2nd request identically. Actual: registered → 429, unregistered → 200.
  it.fails("IT-AUTH-065 repeat requests answer the same for registered and unregistered phones (BUG-CANDIDATE-A3) @regression", async () => {
    const t = await createTenant();
    const reg = await phoneOf(t.users.INVENTORY_MANAGER.id);
    const unreg = unregistered();
    await request(reg);
    await request(unreg);
    const r1 = await request(reg);
    const r2 = await request(unreg);
    expect(r1.status).toBe(r2.status);
  });

  it("IT-AUTH-066 OTP request for a locked user → 423 @regression", async () => {
    const t = await createTenant();
    await db.user.update({ where: { id: t.users.CASHIER.id }, data: { lockedUntil: new Date(Date.now() + 5 * 60_000) } });
    expect((await request(await phoneOf(t.users.CASHIER.id))).status).toBe(423);
  });
});

describe("OTP verify", () => {
  it("IT-AUTH-070 correct code → session tokens, OTP consumed, deviceId stored on refresh token @regression @critical", async () => {
    const t = await createTenant();
    const phone = await phoneOf(t.users.CASHIER.id);
    const { devCode } = (await request(phone)).body;
    const res = await verify(phone, devCode, "device-abc");
    expect(res.status).toBe(200);
    expect(res.body.expiresIn).toBe(900);
    const me = await agentFromToken(res.body.accessToken).get("/auth/me");
    expect(me.body.id).toBe(t.users.CASHIER.id);
    expect((await db.otpCode.findFirstOrThrow({ where: { phone } })).consumed).toBe(true);
    const rt = await db.refreshToken.findFirstOrThrow({ where: { userId: t.users.CASHIER.id } });
    expect(rt.deviceId).toBe("device-abc");
  });

  it("IT-AUTH-071 a consumed OTP cannot be reused → 401 @regression @critical", async () => {
    const t = await createTenant();
    const phone = await phoneOf(t.users.KITCHEN.id);
    const { devCode } = (await request(phone)).body;
    expect((await verify(phone, devCode)).status).toBe(200);
    const again = await verify(phone, devCode);
    expect(again.status).toBe(401);
    expect(again.body.error).toBe("Invalid OTP");
  });

  it("IT-AUTH-072 wrong code → 401 and attempts incremented; right code still works afterwards @regression", async () => {
    const t = await createTenant();
    const phone = await phoneOf(t.users.DELIVERY.id);
    const { devCode } = (await request(phone)).body;
    expect((await verify(phone, wrongCode(devCode))).status).toBe(401);
    expect((await db.otpCode.findFirstOrThrow({ where: { phone } })).attempts).toBe(1);
    expect((await verify(phone, devCode)).status).toBe(200);
  });

  it("IT-AUTH-073 expired OTP (expiresAt in the past) → 401 @regression @critical", async () => {
    const t = await createTenant();
    const phone = await phoneOf(t.users.INVENTORY_MANAGER.id);
    const { devCode } = (await request(phone)).body;
    await db.otpCode.updateMany({ where: { phone }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await verify(phone, devCode)).status).toBe(401);
  });

  it("IT-AUTH-074 5 wrong attempts consume the OTP — the correct code is then refused @regression @critical", async () => {
    const t = await createTenant();
    const phone = await phoneOf(t.users.OUTLET_MANAGER.id);
    const { devCode } = (await request(phone)).body;
    for (let i = 0; i < 5; i++) expect((await verify(phone, wrongCode(devCode))).status).toBe(401);
    const row = await db.otpCode.findFirstOrThrow({ where: { phone } });
    expect(row.consumed).toBe(true);
    expect(row.attempts).toBe(5);
    const final = await verify(phone, devCode);
    expect([401, 423]).toContain(final.status); // account also locked after 5 failures
    expect(final.body.accessToken).toBeUndefined();
  });

  it("IT-AUTH-075 verify for an unregistered phone → 401 Invalid OTP @regression", async () => {
    const res = await verify(unregistered(), "123456");
    expect(res.status).toBe(401);
    expect(res.body.error).toBe("Invalid OTP");
  });

  it("IT-AUTH-076 malformed code (5/7 digits, letters) → 400 @regression", async () => {
    const t = await createTenant();
    const phone = await phoneOf(t.users.CASHIER.id);
    for (const c of ["12345", "1234567", "12a456"]) expect((await verify(phone, c)).status, c).toBe(400);
  });

  it("IT-AUTH-077 a user of a suspended business cannot log in by OTP → 403 @regression @critical", async () => {
    const t = await createTenant();
    const phone = await phoneOf(t.users.CASHIER.id);
    const { devCode } = (await request(phone)).body;
    await db.business.update({ where: { id: t.business.id }, data: { status: "SUSPENDED" } });
    const res = await verify(phone, devCode);
    expect(res.status).toBe(403);
  });

  it("IT-AUTH-078 only the newest OTP is valid — an older code is refused after re-request @regression", async () => {
    const t = await createTenant();
    const phone = await phoneOf(t.users.BUSINESS_OWNER.id);
    const first = (await request(phone)).body.devCode;
    await db.otpCode.updateMany({ where: { phone }, data: { createdAt: new Date(Date.now() - 31_000) } });
    const second = (await request(phone)).body.devCode;
    if (first === second) return; // 1-in-a-million collision
    expect((await verify(phone, first)).status).toBe(401);
    expect((await verify(phone, second)).status).toBe(200);
  });
});
