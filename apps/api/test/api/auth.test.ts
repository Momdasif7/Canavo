/**
 * QA Phase 6 — /auth: login, OTP, refresh rotation + reuse detection, logout, 2FA inputs,
 * password forgot/reset/change, signed-in devices, /auth/me and preferences, rate limits.
 * (Every endpoint's 401 without a token is in sweep-auth; cookie mode basics in
 * integration/cookie-session; 2FA flows in integration/two-factor.)
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { effectivePermissions, normalizeModules } from "@canavo/shared";
import { createHotel, startServer, type Hotel } from "../integration/helpers";
import { addUser, createPlatformAdmin, db, expectNoSecrets, freshIp, HOTEL_ROLES, HUGE, PASSWORD, req, signIn, uniqPhone } from "./kit";

const NASTY_XSS = "<script>alert(1)</script>";
let srv: Awaited<ReturnType<typeof startServer>>;
let h: Hotel;

beforeAll(async () => {
  srv = await startServer();
  h = await createHotel("Auth API");
});
afterAll(() => srv.close());

const post = (path: string, body?: unknown, opts: { ip?: string; headers?: Record<string, string> } = {}) => req(srv.base, "POST", path, { body, ...opts });

describe("POST /auth/login", () => {
  it("200 with an access + refresh token pair and nothing secret", async () => {
    const r = await post("/auth/login", { email: h.users.cashier.email, password: PASSWORD });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ accessToken: expect.any(String), refreshToken: expect.any(String), expiresIn: 900 });
    expect(r.body.accessToken.split(".")).toHaveLength(3);
    expect(r.body.refreshToken.length).toBeGreaterThanOrEqual(40);
  });

  it("is case-insensitive on the email and ignores smuggled fields (role, businessId)", async () => {
    const r = await post("/auth/login", { email: h.users.cashier.email.toUpperCase(), password: PASSWORD, role: "SUPER_ADMIN", businessId: "x", tv: 99 });
    expect(r.status).toBe(200);
    const claims = JSON.parse(Buffer.from(r.body.accessToken.split(".")[1], "base64url").toString());
    expect(claims.role).toBe("CASHIER");
    expect(claims.sub).toBe(h.users.cashier.id);
  });

  it.each([
    ["no body", undefined],
    ["empty object", {}],
    ["missing password", { email: "a@b.in" }],
    ["missing email", { password: "x" }],
    ["not an email", { email: "nope", password: "x" }],
    ["empty password", { email: "a@b.in", password: "" }],
    ["number email", { email: 5, password: "x" }],
    ["null password", { email: "a@b.in", password: null }],
    ["array body", [{ email: "a@b.in", password: "x" }]],
  ])("400 on %s", async (_n, body) => {
    const r = await post("/auth/login", body);
    expect(r.status).toBe(400);
    expect(r.body).toMatchObject({ error: "Validation failed" });
  });

  it("a 10k-character email is refused without a 500 (400 or 401)", async () => {
    expect([400, 401]).toContain((await post("/auth/login", { email: `${HUGE}@b.in`, password: "x" })).status);
  });

  it("400 (not 500) on malformed JSON", async () => {
    const r = await req(srv.base, "POST", "/auth/login", { raw: "{bad json", headers: { "content-type": "application/json" } });
    expect(r.status).toBe(400);
  });

  it("wrong password and unknown email give the same 401 (no account probing); a huge password is just wrong", async () => {
    const a = await post("/auth/login", { email: h.users.kitchen.email, password: "wrong-Pass-1" });
    const b = await post("/auth/login", { email: "nobody.here@it.local", password: "wrong-Pass-1" });
    const c = await post("/auth/login", { email: "nobody.here@it.local", password: HUGE });
    expect([a.status, b.status, c.status]).toEqual([401, 401, 401]);
    expect(a.body).toEqual(b.body);
    await db.user.update({ where: { id: h.users.kitchen.id }, data: { failedLogins: 0 } });
  });

  it("inactive accounts can't sign in", async () => {
    const u = await addUser(h, "CASHIER");
    await db.user.update({ where: { id: u.id }, data: { status: "INACTIVE" } });
    expect((await post("/auth/login", { email: u.email, password: PASSWORD })).status).toBe(401);
  });

  it("5 wrong passwords lock the account (423, even with the right password); unlocking resets the counter", async () => {
    const u = await addUser(h, "CASHIER");
    for (let i = 0; i < 5; i++) expect((await post("/auth/login", { email: u.email, password: `Wrong-${i}-pass` })).status).toBe(401);
    const locked = await post("/auth/login", { email: u.email, password: PASSWORD });
    expect(locked.status).toBe(423);
    expect(locked.body.error).toMatch(/Too many failed attempts/);
    const row = await db.user.findUniqueOrThrow({ where: { id: u.id } });
    expect(row.lockedUntil!.getTime()).toBeGreaterThan(Date.now() + 14 * 60_000);
    await db.user.update({ where: { id: u.id }, data: { lockedUntil: new Date(Date.now() - 1000), failedLogins: 3 } });
    expect((await post("/auth/login", { email: u.email, password: PASSWORD })).status).toBe(200);
    expect((await db.user.findUniqueOrThrow({ where: { id: u.id } })).failedLogins).toBe(0);
  });

  it("per-IP rate limit: the 51st attempt within 15 min from one IP is 429 with RateLimit headers; other IPs are unaffected", async () => {
    const ip = freshIp();
    let last = 0;
    for (let i = 0; i < 50; i++) last = (await post("/auth/login", {}, { ip })).status;
    expect(last).toBe(400);
    const r = await post("/auth/login", { email: h.users.cashier.email, password: PASSWORD }, { ip });
    expect(r.status).toBe(429);
    expect(r.headers.get("ratelimit-policy") ?? r.headers.get("ratelimit")).toBeTruthy();
    // OTP shares the same per-IP budget
    expect((await post("/auth/otp/request", { phone: "9000000000" }, { ip })).status).toBe(429);
    expect((await post("/auth/login", { email: h.users.cashier.email, password: PASSWORD })).status).toBe(200);
  });

  it("a suspended business's staff can't sign in", async () => {
    const other = await createHotel("Suspended");
    await db.business.update({ where: { id: other.businessId }, data: { status: "SUSPENDED" } });
    expect((await post("/auth/login", { email: other.users.cashier.email, password: PASSWORD })).status).toBe(403);
  });
});

describe("OTP login", () => {
  const phoneUser = async () => {
    const u = await addUser(h, "CASHIER");
    const row = await db.user.findUniqueOrThrow({ where: { id: u.id } });
    return { ...u, phone: row.phone };
  };

  it.each([["short", "12345"], ["starts with 5", "5123456789"], ["+91 prefix", "+919876543210"], ["letters", "98765abcde"], ["number type", 9876543210], ["missing", undefined]])(
    "request: 400 on phone %s",
    async (_n, phone) => {
      expect((await post("/auth/otp/request", { phone })).status).toBe(400);
    },
  );

  it("request: an unknown number gets the same 200 shape (no enumeration)", async () => {
    const r = await post("/auth/otp/request", { phone: uniqPhone() });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, expiresIn: 300 });
  });

  it("request twice within 30 s → 429; the code is stored hashed only", async () => {
    const u = await phoneUser();
    const first = await post("/auth/otp/request", { phone: u.phone });
    expect(first.status).toBe(200);
    expect(first.body.devCode).toMatch(/^\d{6}$/);
    const otp = await db.otpCode.findFirstOrThrow({ where: { phone: u.phone } });
    expect(otp.codeHash).not.toContain(first.body.devCode);
    expect((await post("/auth/otp/request", { phone: u.phone })).status).toBe(429);
  });

  it("verify: 400 on malformed codes, 401 on a wrong code, 200 once with the right code, then the code is spent", async () => {
    const u = await phoneUser();
    const { devCode } = (await post("/auth/otp/request", { phone: u.phone })).body;
    for (const code of ["12345", "1234567", "abcdef", 123456, ""]) expect((await post("/auth/otp/verify", { phone: u.phone, code })).status).toBe(400);
    const wrong = devCode === "000000" ? "111111" : "000000";
    expect((await post("/auth/otp/verify", { phone: u.phone, code: wrong })).status).toBe(401);
    const ok = await post("/auth/otp/verify", { phone: u.phone, code: devCode, deviceId: "dev-1" });
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ accessToken: expect.any(String), refreshToken: expect.any(String), expiresIn: 900 });
    expect((await post("/auth/otp/verify", { phone: u.phone, code: devCode })).status).toBe(401);
  });

  it("verify: 5 wrong codes lock the account (423) — the right code no longer works", async () => {
    const u = await phoneUser();
    const { devCode } = (await post("/auth/otp/request", { phone: u.phone })).body;
    const wrong = devCode === "000000" ? "111111" : "000000";
    for (let i = 0; i < 5; i++) expect((await post("/auth/otp/verify", { phone: u.phone, code: wrong })).status).toBe(401);
    expect((await post("/auth/otp/verify", { phone: u.phone, code: devCode })).status).toBe(423);
  });

  it("verify for an unknown number is 401 (not 404)", async () => {
    expect((await post("/auth/otp/verify", { phone: uniqPhone(), code: "123456" })).status).toBe(401);
  });
});

describe("POST /auth/refresh — rotation and reuse detection", () => {
  it("rotates: new pair, old refresh token dead; replaying it revokes the whole family (new token and its access token too)", async () => {
    const s = await signIn(srv.base, h.users.cashier.email, h.outletId);
    const r1 = await post("/auth/refresh", { refreshToken: s.refreshToken });
    expect(r1.status).toBe(200);
    expect(r1.body).toEqual({ accessToken: expect.any(String), refreshToken: expect.any(String), expiresIn: 900 });
    expect(r1.body.refreshToken).not.toBe(s.refreshToken);
    const access2 = r1.body.accessToken;
    expect((await req(srv.base, "GET", "/auth/me", { headers: { authorization: `Bearer ${access2}` } })).status).toBe(200);

    const replay = await post("/auth/refresh", { refreshToken: s.refreshToken });
    expect(replay.status).toBe(401);
    expect(replay.body.error).toMatch(/reuse/i);
    // The legitimate (rotated) token is gone too, and so is every access token of that session.
    expect((await post("/auth/refresh", { refreshToken: r1.body.refreshToken })).status).toBe(401);
    expect((await req(srv.base, "GET", "/auth/me", { headers: { authorization: `Bearer ${access2}` } })).status).toBe(401);
    expect((await s.call("GET", "/auth/me")).status).toBe(401);
  });

  it("the same refresh token sent twice at once is honoured only once (no double rotation)", async () => {
    const s = await signIn(srv.base, h.users.cashier.email, h.outletId);
    const [a, b] = await Promise.all([post("/auth/refresh", { refreshToken: s.refreshToken }), post("/auth/refresh", { refreshToken: s.refreshToken })]);
    expect([a.status, b.status].sort()).toEqual([200, 401]);
    // At most one live token left in the family
    const live = await db.refreshToken.count({ where: { userId: h.users.cashier.id, revokedAt: null, replacedBy: null, familyId: JSON.parse(Buffer.from(s.token.split(".")[1], "base64url").toString()).sid } });
    expect(live).toBeLessThanOrEqual(1);
  });

  it.each([
    ["short token", { refreshToken: "abc" }, 400],
    ["number", { refreshToken: 12345678901 }, 400],
    ["null", { refreshToken: null }, 400],
    ["unknown token", { refreshToken: "x".repeat(64) }, 401],
    ["no token, no cookie", {}, 401],
  ])("%s → %s", async (_n, body, status) => {
    expect((await post("/auth/refresh", body)).status).toBe(status);
  });

  it("a deactivated user's refresh token stops working", async () => {
    const u = await addUser(h, "CASHIER");
    const s = await signIn(srv.base, u.email, h.outletId);
    await db.user.update({ where: { id: u.id }, data: { status: "INACTIVE" } });
    expect((await post("/auth/refresh", { refreshToken: s.refreshToken })).status).toBe(401);
  });

  it("an expired refresh token is refused", async () => {
    const s = await signIn(srv.base, h.users.kitchen.email, h.outletId);
    await db.refreshToken.updateMany({ where: { userId: h.users.kitchen.id, revokedAt: null }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await post("/auth/refresh", { refreshToken: s.refreshToken })).status).toBe(401);
  });

  it("cookie mode: refresh through the cookie needs the double-submit CSRF header", async () => {
    const login = await req(srv.base, "POST", "/auth/login", { body: { email: h.users.cashier.email, password: PASSWORD }, headers: { "x-session-mode": "cookie" } });
    expect(login.status).toBe(200);
    expect(login.body.refreshToken).toBeUndefined();
    const cookies = login.headers.getSetCookie().map((c) => c.split(";")[0]);
    const csrf = cookies.find((c) => c.startsWith("canavo_csrf="))!.split("=")[1];
    const cookie = cookies.join("; ");
    expect((await post("/auth/refresh", undefined, { headers: { cookie } })).status).toBe(403);
    expect((await post("/auth/refresh", undefined, { headers: { cookie, "x-csrf-token": "x".repeat(csrf.length) } })).status).toBe(403);
    const ok = await post("/auth/refresh", undefined, { headers: { cookie, "x-csrf-token": csrf } });
    expect(ok.status).toBe(200);
    expect(ok.body.refreshToken).toBeUndefined();
  });
});

describe("POST /auth/logout", () => {
  it("204; the session's refresh and access tokens stop working", async () => {
    const s = await signIn(srv.base, h.users.cashier.email, h.outletId);
    const r = await post("/auth/logout", { refreshToken: s.refreshToken });
    expect(r.status).toBe(204);
    expect((await post("/auth/refresh", { refreshToken: s.refreshToken })).status).toBe(401);
    expect((await s.call("GET", "/auth/me")).status).toBe(401);
  });

  it("an unknown token is a quiet 204; a malformed one 400; no token at all 204 (cookie-less sign-out)", async () => {
    expect((await post("/auth/logout", { refreshToken: "y".repeat(64) })).status).toBe(204);
    expect((await post("/auth/logout", { refreshToken: "short" })).status).toBe(400);
    expect((await post("/auth/logout", {})).status).toBe(204);
  });

  it("logging out one session leaves the user's other sessions alive", async () => {
    const a = await signIn(srv.base, h.users.inventory.email, h.outletId);
    const b = await signIn(srv.base, h.users.inventory.email, h.outletId);
    await post("/auth/logout", { refreshToken: a.refreshToken });
    expect((await b.call("GET", "/auth/me")).status).toBe(200);
  });
});

describe("two-step login inputs", () => {
  it("POST /auth/2fa/verify: 400 on bad shapes, 401 on a forged/unknown ticket", async () => {
    for (const body of [{}, { mfaToken: "short", code: "123456" }, { mfaToken: "x".repeat(40) }, { mfaToken: "x".repeat(40), code: "1".repeat(11) }, { mfaToken: HUGE, code: "123456" }])
      expect((await post("/auth/2fa/verify", body)).status, JSON.stringify(body).slice(0, 80)).toBe(400);
    expect((await post("/auth/2fa/verify", { mfaToken: "x".repeat(40), code: "123456" })).status).toBe(401);
  });

  it("enable without setup → 400; disable/recovery-codes while off → 400; status for a fresh user is off", async () => {
    const u = await addUser(h, "CASHIER");
    const s = await signIn(srv.base, u.email, h.outletId);
    const st = await s.call("GET", "/auth/2fa");
    expect(st.status).toBe(200);
    expect(st.body.enabled).toBe(false);
    expect((await s.call("POST", "/auth/2fa/enable", { code: "123456" })).status).toBe(400);
    expect((await s.call("POST", "/auth/2fa/enable", {})).status).toBe(400);
    expect((await s.call("POST", "/auth/2fa/disable", { password: PASSWORD, code: "123456" })).status).toBe(400);
    expect((await s.call("POST", "/auth/2fa/recovery-codes", { code: "123456" })).status).toBe(400);
    expect((await s.call("POST", "/auth/2fa/recovery-codes", {})).status).toBe(400);
    // setup twice is fine until enabled (a new secret each time); the secret is never stored in clear
    const s1 = await s.call("POST", "/auth/2fa/setup");
    expect(s1.status).toBe(200);
    const row = await db.user.findUniqueOrThrow({ where: { id: u.id } });
    expect(JSON.stringify(row)).not.toContain(s1.body.secret);
  });
});

describe("password forgot / reset / change", () => {
  it("forgot: same 200 body for known, unknown and phone identifiers; 400 on bad shapes", async () => {
    const ip = freshIp();
    const known = await post("/auth/password/forgot", { identifier: h.users.manager.email }, { ip });
    const unknown = await post("/auth/password/forgot", { identifier: "nobody@it.local" }, { ip });
    const phone = await post("/auth/password/forgot", { identifier: "+91 90000 00000" }, { ip });
    expect([known.status, unknown.status, phone.status]).toEqual([200, 200, 200]);
    expect(known.body).toEqual(unknown.body);
    expect(JSON.stringify(known.body)).not.toMatch(/token|devLink|http/);
    for (const body of [{}, { identifier: "ab" }, { identifier: HUGE }, { identifier: 123456 }]) expect((await post("/auth/password/forgot", body, { ip })).status).toBe(400);
  });

  it("forgot/reset share a tight per-IP limit: the 11th request in 15 min is 429", async () => {
    const ip = freshIp();
    for (let i = 0; i < 10; i++) await post("/auth/password/forgot", { identifier: "nobody@it.local" }, { ip });
    expect((await post("/auth/password/forgot", { identifier: "nobody@it.local" }, { ip })).status).toBe(429);
    expect((await post("/auth/password/reset", { token: "t".repeat(40), password: "x" }, { ip })).status).toBe(429);
  });

  it("reset: 400 on malformed or unknown tokens (nothing changes)", async () => {
    for (const body of [{}, { token: "short", password: "Abcdef@12345" }, { token: "t".repeat(40) }, { token: "t".repeat(201), password: "x" }])
      expect((await post("/auth/password/reset", body)).status).toBe(400);
    expect((await post("/auth/password/reset", { token: "t".repeat(40), password: "Strong-Pass-2026!" })).status).toBe(400);
  });

  it("change: wrong current → 400, weak new → 400, success keeps this device and ends the others", async () => {
    const u = await addUser(h, "CASHIER");
    const here = await signIn(srv.base, u.email, h.outletId);
    const there = await signIn(srv.base, u.email, h.outletId);
    expect((await here.call("POST", "/auth/password/change", { currentPassword: "nope", newPassword: "Masala-Dosa-2026" })).status).toBe(400);
    expect((await here.call("POST", "/auth/password/change", { currentPassword: PASSWORD, newPassword: "123" })).status).toBe(400);
    expect((await here.call("POST", "/auth/password/change", { currentPassword: PASSWORD })).status).toBe(400);
    const ok = await here.call("POST", "/auth/password/change", { currentPassword: PASSWORD, newPassword: "Masala-Dosa-2026" });
    expect(ok.status).toBe(200);
    expect((await here.call("GET", "/auth/me")).status).toBe(200);
    expect((await there.call("GET", "/auth/me")).status).toBe(401);
    expect((await post("/auth/login", { email: u.email, password: PASSWORD })).status).toBe(401);
    expect((await post("/auth/login", { email: u.email, password: "Masala-Dosa-2026" })).status).toBe(200);
  });
});

describe("signed-in devices", () => {
  it("lists only this user's sessions (no token hashes); 404 for an unknown or someone else's session", async () => {
    const a = await signIn(srv.base, h.users.delivery.email, h.outletId);
    const other = await signIn(srv.base, h.users.inventory.email, h.outletId);
    const list = await a.call("GET", "/auth/sessions");
    expect(list.status).toBe(200);
    expect(list.body.length).toBeGreaterThan(0);
    expect(list.body.filter((s: { current: boolean }) => s.current)).toHaveLength(1);
    expectNoSecrets(list.body);
    for (const s of list.body) expect(Object.keys(s).sort()).toEqual(["current", "deviceId", "id", "ip", "lastActiveAt", "signedInAt", "userAgent"]);
    const otherSid = (await other.call("GET", "/auth/sessions")).body[0].id;
    expect((await a.call("DELETE", `/auth/sessions/${otherSid}`)).status).toBe(404);
    expect((await a.call("DELETE", "/auth/sessions/does-not-exist")).status).toBe(404);
    expect((await other.call("GET", "/auth/me")).status).toBe(200);
    const r = await a.call("POST", "/auth/sessions/revoke-others");
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ count: expect.any(Number) });
  });
});

describe("GET /auth/me", () => {
  it("every role: profile + effective permissions, never a secret, PIN or Aadhaar", async () => {
    const extra = { WAITER: await addUser(h, "WAITER"), ACCOUNTANT: await addUser(h, "ACCOUNTANT"), AUDITOR: await addUser(h, "AUDITOR") };
    const emails: Record<string, string> = {
      BUSINESS_OWNER: h.users.owner.email,
      OUTLET_MANAGER: h.users.manager.email,
      CASHIER: h.users.cashier.email,
      KITCHEN: h.users.kitchen.email,
      INVENTORY_MANAGER: h.users.inventory.email,
      DELIVERY: h.users.delivery.email,
      ...Object.fromEntries(Object.entries(extra).map(([k, v]) => [k, v.email])),
    };
    // Give the cashier a PIN and Aadhaar so a leak would show
    await db.user.update({ where: { id: h.users.cashier.id }, data: { pinHash: "$2a$04$abcdefghijklmnopqrstuuJ0123456789012345678901234567", aadhaarLast4: "1234" } });
    const business = await db.business.findUniqueOrThrow({ where: { id: h.businessId } });
    for (const role of HOTEL_ROLES) {
      const s = await signIn(srv.base, emails[role]!, h.outletId);
      const me = await s.call("GET", "/auth/me");
      expect(me.status, role).toBe(200);
      expectNoSecrets(me.body, role);
      expect(JSON.stringify(me.body)).not.toMatch(/aadhaar|pinHash|passwordHash/i);
      expect(me.body).toMatchObject({ role, platformAdmin: false, platformRole: null, business: { id: h.businessId }, twoFactorEnabled: false });
      expect([...me.body.permissions].sort()).toEqual([...effectivePermissions(role, normalizeModules(business.modules))].sort());
      const outletIds = me.body.outlets.map((o: { id: string }) => o.id).sort();
      expect(outletIds).toEqual(role === "BUSINESS_OWNER" ? [h.outletId, h.outlet2Id].sort() : [h.outletId]);
    }
  });

  it("the platform admin: no outlets, no business, platform permissions only", async () => {
    const admin = await signIn(srv.base, (await createPlatformAdmin()).email);
    const me = await admin.call("GET", "/auth/me");
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({ role: "SUPER_ADMIN", platformAdmin: true, platformRole: "SUPER_ADMIN", business: null, outlets: [], modules: null });
    // X-Outlet-Id / X-Business-Id of a hotel changes nothing
    const peek = await admin.call("GET", "/auth/me", undefined, { "x-outlet-id": h.outletId, "x-business-id": h.businessId });
    expect(peek.body.outlets).toEqual([]);
    expect(peek.body.business).toBeNull();
  });
});

describe("/auth/me/preferences", () => {
  it.each([
    ["unknown field", { role: "BUSINESS_OWNER" }],
    ["bad enum", { appearance: "neon" }],
    ["bad colour", { accent: "red" }],
    ["xss colour", { accent: NASTY_XSS }],
    ["number", { textSize: 3 }],
    ["array body", ["dark"]],
  ])("PUT 400 on %s and nothing is saved", async (_n, body) => {
    const s = await signIn(srv.base, h.users.delivery.email, h.outletId);
    const before = (await s.call("GET", "/auth/me/preferences")).body;
    expect((await s.call("PUT", "/auth/me/preferences", body)).status).toBe(400);
    expect((await s.call("GET", "/auth/me/preferences")).body).toEqual(before);
  });

  it("PUT {} is a no-op 200; colours are upper-cased", async () => {
    const s = await signIn(srv.base, h.users.delivery.email, h.outletId);
    expect((await s.call("PUT", "/auth/me/preferences", {})).status).toBe(200);
    const r = await s.call("PUT", "/auth/me/preferences", { accent: "#abcdef" });
    expect(r.body.accent).toBe("#ABCDEF");
  });
});

