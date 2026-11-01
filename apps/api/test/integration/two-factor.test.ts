/** Phase 2.1 — two-step login (TOTP + recovery codes), resets, and the REQUIRE_2FA hotel flag. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { currentStep, totpAt } from "../../src/lib/totp";
import { createHotel, createPlatformAdmin, db, login, PASSWORD, startServer, type Client, type Hotel } from "./helpers";

let srv: Awaited<ReturnType<typeof startServer>>;
let h: Hotel;

beforeAll(async () => {
  srv = await startServer();
  h = await createHotel("TwoFactor");
});
afterAll(() => srv.close());

const post = (path: string, body: unknown) =>
  fetch(`${srv.base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json() }));

/** Turn on 2FA for a signed-in client; returns the secret and recovery codes. */
async function enable(c: Client) {
  const setup = await c.call("POST", "/auth/2fa/setup");
  expect(setup.status).toBe(200);
  expect(setup.body.otpauthUri).toMatch(/^otpauth:\/\/totp\/CANAVO/);
  const secret: string = setup.body.secret;
  const on = await c.call("POST", "/auth/2fa/enable", { code: totpAt(secret, currentStep()) });
  expect(on.status).toBe(200);
  return { secret, recoveryCodes: on.body.recoveryCodes as string[] };
}

describe("two-step login", () => {
  let secret: string;
  let recoveryCodes: string[];

  it("setup needs a correct code; then the password alone no longer signs in", async () => {
    const c = await login(srv.base, h.users.manager.email, h.outletId);
    await c.call("POST", "/auth/2fa/setup");
    expect((await c.call("POST", "/auth/2fa/enable", { code: "000000" })).status).toBe(400);
    ({ secret, recoveryCodes } = await enable(c));
    expect(recoveryCodes).toHaveLength(10);
    expect((await c.call("GET", "/auth/me")).body.twoFactorEnabled).toBe(true);

    const first = await post("/auth/login", { email: h.users.manager.email, password: PASSWORD });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ mfaRequired: true });
    expect(first.body.accessToken).toBeUndefined();
    // The ticket is not an access token.
    const misuse = await fetch(`${srv.base}/auth/me`, { headers: { authorization: `Bearer ${first.body.mfaToken}` } });
    expect(misuse.status).toBe(401);
  });

  it("the app code completes sign-in once; the same code can't be replayed", async () => {
    const t1 = (await post("/auth/login", { email: h.users.manager.email, password: PASSWORD })).body.mfaToken;
    // Use the next step's code (the setup consumed the current one).
    const code = totpAt(secret, currentStep() + 1);
    const ok = await post("/auth/2fa/verify", { mfaToken: t1, code });
    expect(ok.status).toBe(200);
    expect(ok.body.accessToken).toBeTruthy();
    const t2 = (await post("/auth/login", { email: h.users.manager.email, password: PASSWORD })).body.mfaToken;
    expect((await post("/auth/2fa/verify", { mfaToken: t2, code })).status).toBe(401);
  });

  it("a recovery code works once", async () => {
    const t = (await post("/auth/login", { email: h.users.manager.email, password: PASSWORD })).body.mfaToken;
    expect((await post("/auth/2fa/verify", { mfaToken: t, recoveryCode: recoveryCodes[0]!.toUpperCase() })).status).toBe(200);
    const t2 = (await post("/auth/login", { email: h.users.manager.email, password: PASSWORD })).body.mfaToken;
    expect((await post("/auth/2fa/verify", { mfaToken: t2, recoveryCode: recoveryCodes[0] })).status).toBe(401);
    const status = (await (await login2fa(h.users.manager.email, recoveryCodes[1]!)).call("GET", "/auth/2fa")).body;
    expect(status).toMatchObject({ enabled: true, recoveryCodesLeft: 8 });
  });

  it("wrong codes count towards the account lockout even with the right password", async () => {
    const u = await db.user.findUniqueOrThrow({ where: { id: h.users.manager.id } });
    await db.user.update({ where: { id: u.id }, data: { failedLogins: 0, lockedUntil: null } });
    for (let i = 0; i < 5; i++) {
      const t = (await post("/auth/login", { email: h.users.manager.email, password: PASSWORD })).body.mfaToken;
      expect((await post("/auth/2fa/verify", { mfaToken: t, code: "123456" })).status).toBe(401);
    }
    expect((await post("/auth/login", { email: h.users.manager.email, password: PASSWORD })).status).toBe(423);
    await db.user.update({ where: { id: u.id }, data: { failedLogins: 0, lockedUntil: null } });
  });

  it("the owner can reset a manager's 2FA (signs them out); a manager can't reset the owner's", async () => {
    const owner = await login(srv.base, h.users.owner.email, h.outletId);
    expect((await owner.call("POST", `/staff/${h.users.manager.id}/reset-2fa`)).status).toBe(200);
    const after = await post("/auth/login", { email: h.users.manager.email, password: PASSWORD });
    expect(after.body.accessToken).toBeTruthy();
    const manager = await login(srv.base, h.users.manager.email, h.outletId);
    expect((await manager.call("POST", `/staff/${h.users.owner.id}/reset-2fa`)).status).toBeGreaterThanOrEqual(403);
  });

  it("turning it off needs the password and a current code", async () => {
    const c = await login(srv.base, h.users.cashier.email, h.outletId);
    const { secret: s, recoveryCodes: rc } = await enable(c);
    // Setup used the current step's code, so sign in with a recovery code and keep step+1 for "disable".
    const c2 = await login2fa(h.users.cashier.email, rc[0]);
    expect((await c2.call("POST", "/auth/2fa/disable", { password: "wrong", code: totpAt(s, currentStep() + 1) })).status).toBe(400);
    expect((await c2.call("POST", "/auth/2fa/disable", { password: PASSWORD, code: totpAt(s, currentStep() + 1) })).status).toBe(200);
    expect((await post("/auth/login", { email: h.users.cashier.email, password: PASSWORD })).body.accessToken).toBeTruthy();
  });
});

describe("REQUIRE_2FA hotel flag", () => {
  it("owners and managers without 2FA can only reach /auth until they set it up; cashiers are unaffected", async () => {
    await db.business.update({ where: { id: h.businessId }, data: { features: { REQUIRE_2FA: true } } });
    try {
      const owner = await login(srv.base, h.users.owner.email, h.outletId);
      const blocked = await owner.call("GET", "/orders");
      expect(blocked.status).toBe(403);
      expect(blocked.body.details).toEqual({ code: "TWO_FACTOR_SETUP_REQUIRED" });
      expect((await owner.call("GET", "/auth/me")).body.twoFactorSetupRequired).toBe(true);
      await enable(owner);
      expect((await owner.call("GET", "/orders")).status).toBe(200);
      const cashier = await login(srv.base, h.users.kitchen.email, h.outletId);
      expect((await cashier.call("GET", "/auth/me")).body.twoFactorSetupRequired).toBe(false);
    } finally {
      await db.business.update({ where: { id: h.businessId }, data: { features: {} } });
    }
  });

  it("the platform can reset an owner's 2FA", async () => {
    const admin = await login(srv.base, (await createPlatformAdmin()).email);
    expect((await admin.call("POST", `/platform/businesses/${h.businessId}/owners/${h.users.owner.id}/reset-2fa`)).status).toBe(200);
    expect((await db.user.findUniqueOrThrow({ where: { id: h.users.owner.id } })).totpEnabledAt).toBeNull();
    expect(await db.recoveryCode.count({ where: { userId: h.users.owner.id } })).toBe(0);
  });
});

/** Sign in through both steps. */
async function login2fa(email: string, recoveryCode?: string, secret?: string): Promise<Client> {
  const t = (await post("/auth/login", { email, password: PASSWORD })).body.mfaToken;
  const r = await post("/auth/2fa/verify", { mfaToken: t, ...(recoveryCode ? { recoveryCode } : { code: totpAt(secret!, currentStep()) }) });
  expect(r.status).toBe(200);
  const token = r.body.accessToken as string;
  return {
    token,
    call: async (method, path, body) => {
      const res = await fetch(`${srv.base}${path}`, {
        method,
        headers: { authorization: `Bearer ${token}`, "x-outlet-id": h.outletId, ...(body !== undefined && { "content-type": "application/json" }) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      return { status: res.status, body: await res.json().catch(() => null), headers: res.headers };
    },
  };
}
