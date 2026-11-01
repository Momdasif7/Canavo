/**
 * Phase 2.2 / 2.3 — password links (the platform never knows a password), password policy,
 * signed-in devices. Real Postgres, non-superuser role (RLS on).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPasswordLink } from "../../src/services/password-links";
import { createHotel, createPlatformAdmin, db, login, PASSWORD, startServer, type Hotel } from "./helpers";

let srv: Awaited<ReturnType<typeof startServer>>;
let h: Hotel;

beforeAll(async () => {
  srv = await startServer();
  h = await createHotel("Accounts");
});
afterAll(() => srv.close());

const post = (path: string, body: unknown) =>
  fetch(`${srv.base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, body: await r.json() }));
const tokenOf = (url: string) => new URL(url).hash.replace("#token=", "");

describe("password policy", () => {
  it("rejects weak passwords for new staff and accepts a strong one", async () => {
    const owner = await login(srv.base, h.users.owner.email, h.outletId);
    const base = { name: "Policy Person", role: "CASHIER", outletIds: [h.outletId], email: `policy.${Date.now()}@it.local` };
    for (const weak of ["short1", "onlyletters", "1234567890", "password123"]) {
      const r = await owner.call("POST", "/staff", { ...base, phone: `9${String(Date.now()).slice(-9)}`, password: weak });
      expect(r.status, weak).toBe(400);
    }
    const ok = await owner.call("POST", "/staff", { ...base, phone: `9${String(Date.now()).slice(-9)}`, password: "Tiffin2026x" });
    expect(ok.status).toBe(201);
  });
});

describe("forgot / reset password", () => {
  it("answers the same whether or not the account exists, and never returns the link", async () => {
    const unknown = await post("/auth/password/forgot", { identifier: "nobody@nowhere.in" });
    const known = await post("/auth/password/forgot", { identifier: h.users.manager.email });
    expect(unknown).toEqual(known);
    expect(JSON.stringify(known.body)).not.toMatch(/token|devLink/);
    expect(await db.passwordResetToken.count({ where: { userId: h.users.manager.id, usedAt: null } })).toBe(1);
  });

  it("a link sets the password once, signs out every device, and enforces the policy", async () => {
    const before = await login(srv.base, h.users.manager.email, h.outletId);
    const { url } = await createPasswordLink(h.users.manager.id, "RESET");
    const token = tokenOf(url);
    expect((await post("/auth/password/reset", { token, password: "weakpass" })).status).toBe(400);
    const ok = await post("/auth/password/reset", { token, password: "NewKitchen2026" });
    expect(ok).toEqual({ status: 200, body: { ok: true, login: h.users.manager.email } });
    // Old session is dead immediately, the new password works, the link is single-use.
    expect((await before.call("GET", "/auth/me")).status).toBe(401);
    await expect(login(srv.base, h.users.manager.email, h.outletId, PASSWORD)).rejects.toThrow(/401/);
    await login(srv.base, h.users.manager.email, h.outletId, "NewKitchen2026");
    expect((await post("/auth/password/reset", { token, password: "Another2026pw" })).status).toBe(400);
  });

  it("a newer link cancels older ones; expired links fail", async () => {
    const first = await createPasswordLink(h.users.kitchen.id, "RESET");
    await createPasswordLink(h.users.kitchen.id, "RESET");
    expect((await post("/auth/password/reset", { token: tokenOf(first.url), password: "Kitchen2026ok" })).status).toBe(400);
    const late = await createPasswordLink(h.users.kitchen.id, "RESET");
    await db.passwordResetToken.updateMany({ where: { userId: h.users.kitchen.id, usedAt: null }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await post("/auth/password/reset", { token: tokenOf(late.url), password: "Kitchen2026ok" })).status).toBe(400);
  });
});

describe("signed-in devices", () => {
  it("lists sessions, marks the current one, and signing out a device kills its access token at once", async () => {
    const phone = await login(srv.base, h.users.cashier.email, h.outletId);
    const laptop = await login(srv.base, h.users.cashier.email, h.outletId);
    const list = (await laptop.call("GET", "/auth/sessions")).body as { id: string; current: boolean }[];
    expect(list.length).toBeGreaterThanOrEqual(2);
    expect(list.filter((s) => s.current)).toHaveLength(1);
    const phoneSession = ((await phone.call("GET", "/auth/sessions")).body as { id: string; current: boolean }[]).find((s) => s.current)!;
    expect((await laptop.call("DELETE", `/auth/sessions/${phoneSession.id}`)).status).toBe(204);
    expect((await phone.call("GET", "/auth/me")).status).toBe(401);
    expect((await laptop.call("GET", "/auth/me")).status).toBe(200);
  });

  it("can't sign out someone else's session", async () => {
    const other = await login(srv.base, h.users.inventory.email, h.outletId);
    const sid = ((await other.call("GET", "/auth/sessions")).body as { id: string; current: boolean }[]).find((s) => s.current)!.id;
    const cashier = await login(srv.base, h.users.cashier.email, h.outletId);
    expect((await cashier.call("DELETE", `/auth/sessions/${sid}`)).status).toBe(404);
    expect((await other.call("GET", "/auth/me")).status).toBe(200);
  });

  it("changing the password keeps this device and signs out the others", async () => {
    const a = await login(srv.base, h.users.delivery.email, h.outletId);
    const b = await login(srv.base, h.users.delivery.email, h.outletId);
    expect((await b.call("POST", "/auth/password/change", { currentPassword: "wrong", newPassword: "Delivery2026ok" })).status).toBe(400);
    expect((await b.call("POST", "/auth/password/change", { currentPassword: PASSWORD, newPassword: "Delivery2026ok" })).status).toBe(200);
    expect((await a.call("GET", "/auth/me")).status).toBe(401);
    expect((await b.call("GET", "/auth/me")).status).toBe(200);
  });
});

describe("platform: owners set their own passwords", () => {
  it("a new owner gets an invite link (no password from the platform); a locked-out owner gets a reset link", async () => {
    const admin = await login(srv.base, (await createPlatformAdmin()).email);
    const created = await admin.call("POST", `/platform/businesses/${h.businessId}/users`, { name: "New Owner", phone: `9${String(Date.now()).slice(-9)}`, email: `newowner.${Date.now()}@it.local` });
    expect(created.status).toBe(201);
    expect(created.body.invite.channel).toBe("none"); // no SMTP/SMS in tests
    expect(created.body.invite.devLink).toMatch(/\/reset-password#token=/);
    const user = await db.user.findUniqueOrThrow({ where: { id: created.body.id } });
    expect(user.passwordHash).toBeNull();
    // The invite works and the owner can then log in.
    expect((await post("/auth/password/reset", { token: tokenOf(created.body.invite.devLink), password: "OwnerChosen2026" })).status).toBe(200);
    await login(srv.base, created.body.email, undefined, "OwnerChosen2026");

    const reset = await admin.call("POST", `/platform/businesses/${h.businessId}/owners/${h.users.owner.id}/reset-link`, {});
    expect(reset.status).toBe(200);
    expect(reset.body.devLink).toMatch(/#token=/);
    // The old way (the platform typing a password) is gone.
    expect((await admin.call("POST", `/platform/businesses/${h.businessId}/owners/${h.users.owner.id}/reset-password`, { password: "Whatever2026" })).status).toBe(404);
  });
});
