/**
 * QA Phase 5 — Group A functional tests: Auth (password login, lockout,
 * refresh rotation, logout, tokenVersion, suspended business, /auth/me).
 *
 * Login-limiter budget: /auth/login is limited to 50 req / 15 min per IP and the
 * limiter is per test file, so this file keeps real /auth/login calls < 50 and
 * mints sessions with `sessionFor` everywhere login itself isn't under test.
 */
import jwt from "jsonwebtoken";
import { beforeAll, describe, expect, it } from "vitest";
import { effectivePermissions } from "@canavo/shared";
import { PASSWORD, createTenant, db } from "./helpers";
import { agentFromToken, raw, sessionFor } from "./fx-a";

const login = (email: string, password = PASSWORD) => raw().post("/auth/login").send({ email, password });
const GENERIC = "Invalid email or password";

let t: Awaited<ReturnType<typeof createTenant>>;
beforeAll(async () => {
  t = await createTenant({ name: "Auth tenant" });
});

describe("Auth — password login (equivalence classes)", () => {
  it("IT-AUTH-001 valid credentials issue a 15-min access token and an opaque refresh token @regression @critical", async () => {
    const res = await login(t.users.CASHIER.email);
    expect(res.status).toBe(200);
    expect(res.body.expiresIn).toBe(900);
    expect(typeof res.body.refreshToken).toBe("string");
    const claims = jwt.decode(res.body.accessToken) as { sub: string; role: string; tv: number; exp: number; iat: number };
    expect(claims.sub).toBe(t.users.CASHIER.id);
    expect(claims.role).toBe("CASHIER");
    expect(claims.exp - claims.iat).toBe(900);
    const row = await db.refreshToken.findFirst({ where: { userId: t.users.CASHIER.id }, orderBy: { createdAt: "desc" } });
    expect(row!.expiresAt.getTime() - row!.createdAt.getTime()).toBeGreaterThan(6.9 * 24 * 3600e3);
    // only the hash is stored
    expect(row!.tokenHash).not.toBe(res.body.refreshToken);
  });

  it("IT-AUTH-002 email is case-insensitive @regression", async () => {
    const res = await login(t.users.KITCHEN.email.toUpperCase());
    expect(res.status).toBe(200);
  });

  it("IT-AUTH-003 wrong password → 401 generic message, failedLogins incremented @regression @critical", async () => {
    const res = await login(t.users.DELIVERY.email, "Wrong@123");
    expect(res.status).toBe(401);
    expect(res.body.error).toBe(GENERIC);
    expect((await db.user.findUniqueOrThrow({ where: { id: t.users.DELIVERY.id } })).failedLogins).toBe(1);
    await db.user.update({ where: { id: t.users.DELIVERY.id }, data: { failedLogins: 0 } });
  });

  it("IT-AUTH-004 unknown email → same 401 + same message as wrong password (no enumeration) @regression @critical", async () => {
    const res = await login("nobody.at.all@it.canavo.test");
    expect(res.status).toBe(401);
    expect(res.body.error).toBe(GENERIC);
  });

  it("IT-AUTH-005 INACTIVE user with correct password → 401 generic @regression @critical", async () => {
    const tt = await createTenant();
    await db.user.update({ where: { id: tt.users.CASHIER.id }, data: { status: "INACTIVE" } });
    const res = await login(tt.users.CASHIER.email);
    expect(res.status).toBe(401);
    expect(res.body.error).toBe(GENERIC);
  });

  it("IT-AUTH-006 user without a password (OTP-only account) cannot password-login @regression", async () => {
    const tt = await createTenant();
    await db.user.update({ where: { id: tt.users.KITCHEN.id }, data: { passwordHash: null } });
    const res = await login(tt.users.KITCHEN.email, "");
    expect(res.status).toBe(400); // empty password fails validation
    const res2 = await login(tt.users.KITCHEN.email, "anything");
    expect(res2.status).toBe(401);
  });

  it("IT-AUTH-007 malformed bodies → 400 (not 500) @regression", async () => {
    expect((await raw().post("/auth/login").send({ email: "not-an-email", password: "x" })).status).toBe(400);
    expect((await raw().post("/auth/login").send({})).status).toBe(400);
    expect((await raw().post("/auth/login").set("content-type", "application/json").send("{bad json")).status).toBe(400);
  });
});

describe("Auth — lockout (boundary values on 5 failures, state transitions)", () => {
  it("IT-AUTH-010 4 failures do NOT lock (boundary 5-1); correct password then works and resets the counter @regression @critical", async () => {
    const tt = await createTenant();
    const email = tt.users.CASHIER.email;
    for (let i = 0; i < 4; i++) expect((await login(email, "bad-pass-" + i)).status).toBe(401);
    let u = await db.user.findUniqueOrThrow({ where: { id: tt.users.CASHIER.id } });
    expect(u.failedLogins).toBe(4);
    expect(u.lockedUntil).toBeNull();
    expect((await login(email)).status).toBe(200);
    u = await db.user.findUniqueOrThrow({ where: { id: tt.users.CASHIER.id } });
    expect(u.failedLogins).toBe(0);
  });

  it("IT-AUTH-011 5th failure locks ~15 min; correct password then → 423 @regression @critical", async () => {
    const tt = await createTenant();
    const email = tt.users.KITCHEN.email;
    for (let i = 0; i < 5; i++) expect((await login(email, "bad-pass-" + i)).status).toBe(401);
    const u = await db.user.findUniqueOrThrow({ where: { id: tt.users.KITCHEN.id } });
    expect(u.lockedUntil).not.toBeNull();
    const mins = (u.lockedUntil!.getTime() - Date.now()) / 60_000;
    expect(mins).toBeGreaterThan(14);
    expect(mins).toBeLessThanOrEqual(15);
    const res = await login(email);
    expect(res.status).toBe(423);
    expect(res.body.error).toMatch(/Try again in \d+ min/);
  });

  it("IT-AUTH-012 lock expiry → correct password logs in and clears lockedUntil @regression", async () => {
    const tt = await createTenant();
    await db.user.update({ where: { id: tt.users.DELIVERY.id }, data: { lockedUntil: new Date(Date.now() - 1000), failedLogins: 0 } });
    expect((await login(tt.users.DELIVERY.email)).status).toBe(200);
    const u = await db.user.findUniqueOrThrow({ where: { id: tt.users.DELIVERY.id } });
    expect(u.lockedUntil).toBeNull();
  });

  it("IT-AUTH-013 an account locked in the DB refuses the correct password with 423 + remaining minutes @regression", async () => {
    const tt = await createTenant();
    await db.user.update({ where: { id: tt.users.CASHIER.id }, data: { lockedUntil: new Date(Date.now() + 10 * 60_000) } });
    const res = await login(tt.users.CASHIER.email);
    expect(res.status).toBe(423);
    expect(res.body.error).toMatch(/10 min/);
  });

  // BUG-CANDIDATE-A1: registerFailure() does read-modify-write of failedLogins
  // (`failedLogins: user.failedLogins + 1` from the value read before bcrypt),
  // so parallel wrong-password requests all write the same small number and
  // the 5-failure lockout never triggers. Expected: after 8 wrong attempts the
  // account is locked (lockedUntil set). Actual: lockedUntil null, failedLogins 1.
  it.fails("IT-AUTH-014 8 concurrent wrong passwords must still lock the account (BUG-CANDIDATE-A1) @regression @critical", async () => {
    const tt = await createTenant();
    const email = tt.users.INVENTORY_MANAGER.email;
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => login(email, "parallel-bad-" + i)));
    expect(results.every((r) => r.status === 401 || r.status === 423)).toBe(true);
    const u = await db.user.findUniqueOrThrow({ where: { id: tt.users.INVENTORY_MANAGER.id } });
    expect(u.lockedUntil).not.toBeNull();
  });
});

describe("Auth — suspended business", () => {
  it("IT-AUTH-020 correct password for a user of a SUSPENDED business → 403 @regression @critical", async () => {
    const tt = await createTenant({ status: "SUSPENDED" });
    const res = await login(tt.users.BUSINESS_OWNER.email);
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/suspended/i);
  });

  // BUG-CANDIDATE-A2: assertBusinessActive() runs BEFORE the password check,
  // so anyone can learn that an email belongs to a suspended business without
  // knowing the password. Expected: wrong password → 401 "Invalid email or
  // password" (same as any other wrong password). Actual: 403 "This business
  // account is suspended…".
  it.fails("IT-AUTH-021 WRONG password for a suspended-business user must not reveal the account (BUG-CANDIDATE-A2) @regression", async () => {
    const tt = await createTenant({ status: "SUSPENDED" });
    const res = await login(tt.users.CASHIER.email, "definitely-wrong");
    expect(res.status).toBe(401);
    expect(res.body.error).toBe(GENERIC);
  });

  it("IT-AUTH-022 an existing access token stops working once the business is suspended @regression @critical", async () => {
    const tt = await createTenant();
    const s = await sessionFor(tt.users.CASHIER.id);
    expect((await s.get("/auth/me")).status).toBe(200);
    await db.business.update({ where: { id: tt.business.id }, data: { status: "SUSPENDED" } });
    const res = await s.get("/auth/me");
    expect([401, 403]).toContain(res.status);
  });
});

describe("Auth — refresh rotation & logout (state transitions)", () => {
  it("IT-AUTH-030 refresh returns NEW access + refresh tokens and revokes the old refresh row @regression @critical", async () => {
    const s = await sessionFor(t.users.CASHIER.id);
    const res = await raw().post("/auth/refresh").send({ refreshToken: s.refreshToken });
    expect(res.status).toBe(200);
    expect(res.body.refreshToken).not.toBe(s.refreshToken);
    expect(res.body.expiresIn).toBe(900);
    expect((await agentFromToken(res.body.accessToken).get("/auth/me")).status).toBe(200);
    const old = await db.refreshToken.findFirst({ where: { userId: t.users.CASHIER.id, replacedBy: { not: null } }, orderBy: { createdAt: "desc" } });
    expect(old?.revokedAt).not.toBeNull();
  });

  it("IT-AUTH-031 replaying a rotated refresh token → 401 and the whole family is revoked (newest token fails too) @regression @critical", async () => {
    const s = await sessionFor(t.users.KITCHEN.id);
    const r1 = await raw().post("/auth/refresh").send({ refreshToken: s.refreshToken });
    expect(r1.status).toBe(200);
    const replay = await raw().post("/auth/refresh").send({ refreshToken: s.refreshToken });
    expect(replay.status).toBe(401);
    expect(replay.body.error).toMatch(/reuse/i);
    const r2 = await raw().post("/auth/refresh").send({ refreshToken: r1.body.refreshToken });
    expect(r2.status).toBe(401);
  });

  it("IT-AUTH-032 reuse detection only kills the affected family — another device's session survives @regression", async () => {
    const a = await sessionFor(t.users.DELIVERY.id);
    const b = await sessionFor(t.users.DELIVERY.id);
    await raw().post("/auth/refresh").send({ refreshToken: a.refreshToken });
    await raw().post("/auth/refresh").send({ refreshToken: a.refreshToken }); // replay → family A revoked
    expect((await raw().post("/auth/refresh").send({ refreshToken: b.refreshToken })).status).toBe(200);
  });

  it("IT-AUTH-033 unknown refresh token → 401; too-short / missing → 400 @regression", async () => {
    expect((await raw().post("/auth/refresh").send({ refreshToken: "x".repeat(64) })).status).toBe(401);
    expect((await raw().post("/auth/refresh").send({ refreshToken: "short" })).status).toBe(400);
    expect((await raw().post("/auth/refresh").send({})).status).toBe(400);
  });

  it("IT-AUTH-034 expired refresh token (db) → 401 Session expired @regression", async () => {
    const s = await sessionFor(t.users.INVENTORY_MANAGER.id);
    const row = await db.refreshToken.findFirstOrThrow({ where: { userId: t.users.INVENTORY_MANAGER.id, revokedAt: null }, orderBy: { createdAt: "desc" } });
    await db.refreshToken.update({ where: { id: row.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const res = await raw().post("/auth/refresh").send({ refreshToken: s.refreshToken });
    expect(res.status).toBe(401);
  });

  it("IT-AUTH-035 logout → 204 and the refresh family can no longer be used @regression @critical", async () => {
    const s = await sessionFor(t.users.CASHIER.id);
    const r1 = await raw().post("/auth/refresh").send({ refreshToken: s.refreshToken });
    const out = await raw().post("/auth/logout").send({ refreshToken: r1.body.refreshToken });
    expect(out.status).toBe(204);
    expect((await raw().post("/auth/refresh").send({ refreshToken: r1.body.refreshToken })).status).toBe(401);
  });

  it("IT-AUTH-036 logout with an unknown token is idempotent (204) @regression", async () => {
    expect((await raw().post("/auth/logout").send({ refreshToken: "z".repeat(40) })).status).toBe(204);
  });

  it("IT-AUTH-037 refresh refused once the user is deactivated @regression @critical", async () => {
    const tt = await createTenant();
    const s = await sessionFor(tt.users.CASHIER.id);
    await db.user.update({ where: { id: tt.users.CASHIER.id }, data: { status: "INACTIVE" } });
    expect((await raw().post("/auth/refresh").send({ refreshToken: s.refreshToken })).status).toBe(401);
    expect((await s.get("/auth/me")).status).toBe(401);
  });
});

describe("Auth — access token validation", () => {
  it("IT-AUTH-040 tokenVersion bump invalidates existing access tokens @regression @critical", async () => {
    const tt = await createTenant();
    const s = await sessionFor(tt.users.KITCHEN.id);
    expect((await s.get("/auth/me")).status).toBe(200);
    await db.user.update({ where: { id: tt.users.KITCHEN.id }, data: { tokenVersion: { increment: 1 } } });
    const res = await s.get("/auth/me");
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/no longer valid/);
  });

  it("IT-AUTH-041 missing / non-Bearer / garbage / wrong-secret / expired / alg=none tokens → 401 @regression @critical", async () => {
    const u = t.users.CASHIER;
    const now = Math.floor(Date.now() / 1000);
    const forged = jwt.sign({ sub: u.id, role: "BUSINESS_OWNER", tv: 0 }, "not-the-secret");
    const expired = jwt.sign({ sub: u.id, role: "CASHIER", tv: 0, exp: now - 10 }, process.env.JWT_ACCESS_SECRET!);
    const none = jwt.sign({ sub: u.id, role: "CASHIER", tv: 0 }, "", { algorithm: "none" });
    expect((await raw().get("/auth/me")).status).toBe(401);
    expect((await raw().get("/auth/me").set("authorization", "Basic abc")).status).toBe(401);
    for (const tok of ["garbage", forged, expired, none]) {
      expect((await agentFromToken(tok).get("/auth/me")).status, tok.slice(0, 20)).toBe(401);
    }
  });

  it("IT-AUTH-042 the role claim in the JWT is not trusted — permissions come from the DB role @regression @critical", async () => {
    const tamperedRole = jwt.sign({ sub: t.users.KITCHEN.id, role: "BUSINESS_OWNER", tv: 0 }, process.env.JWT_ACCESS_SECRET!);
    const a = agentFromToken(tamperedRole, t.outlet.id);
    const me = await a.get("/auth/me");
    expect(me.body.role).toBe("KITCHEN");
    expect((await a.get("/staff")).status).toBe(403);
  });
});

describe("Auth — /auth/me", () => {
  it("IT-AUTH-050 shape: profile + business + modules + outlets + permissions; no secrets @regression @critical", async () => {
    const s = await sessionFor(t.users.CASHIER.id);
    const res = await s.get("/auth/me");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: t.users.CASHIER.id, role: "CASHIER", platformAdmin: false, businessId: t.business.id });
    expect(res.body.outlets).toEqual([expect.objectContaining({ id: t.outlet.id, businessId: t.business.id })]);
    const text = JSON.stringify(res.body);
    for (const k of ["passwordHash", "pinHash", "aadhaarEnc", "tokenVersion", "failedLogins", "lockedUntil"]) expect(text).not.toContain(k);
    expect(res.body.permissions.sort()).toEqual([...effectivePermissions("CASHIER", res.body.modules)].sort());
  });

  it("IT-AUTH-051 permissions = role ∩ modules (business without KOT/TABLES/DELIVERY) @regression @critical", async () => {
    const tt = await createTenant({ modules: ["BILLING", "INVENTORY"] });
    const k = await (await sessionFor(tt.users.KITCHEN.id)).get("/auth/me");
    expect(k.body.modules).toEqual(["BILLING", "INVENTORY"]);
    expect(k.body.permissions).not.toContain("kot:view");
    expect(k.body.permissions).toContain("inventory:view");
    const c = await (await sessionFor(tt.users.CASHIER.id)).get("/auth/me");
    expect(c.body.permissions).toContain("order:create");
    expect(c.body.permissions).not.toContain("table:serve");
    expect(c.body.permissions).not.toContain("customer:view");
  });

  it("IT-AUTH-052 owner sees every outlet of the business in /auth/me @regression", async () => {
    const tt = await createTenant();
    const o2 = await db.outlet.create({ data: { businessId: tt.business.id, name: "Zeta second", stateCode: "33" } });
    const me = await (await sessionFor(tt.users.BUSINESS_OWNER.id)).get("/auth/me");
    expect(me.body.outlets.map((o: { id: string }) => o.id).sort()).toEqual([tt.outlet.id, o2.id].sort());
  });

  it("IT-AUTH-053 super admin /auth/me: platformAdmin=true, no business, no outlets @regression @critical", async () => {
    const me = await (await sessionFor("admin@canavo.local")).get("/auth/me");
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({ platformAdmin: true, business: null, modules: null, outlets: [] });
    expect(me.body.permissions.sort()).toEqual(["admin:backup", "audit:view", "platform:manage"].sort());
  });
});
