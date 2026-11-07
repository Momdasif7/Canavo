/** Appearance: each user's own preferences (only their row) and the business brand (owner only, own business only). */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHotel, createPlatformAdmin, db, login, startServer, type Hotel } from "./helpers";

let srv: Awaited<ReturnType<typeof startServer>>;
let h: Hotel;
let other: Hotel;

beforeAll(async () => {
  srv = await startServer();
  h = await createHotel("Appearance");
  other = await createHotel("Appearance Other");
});
afterAll(() => srv.close());

describe("user appearance preferences", () => {
  it("defaults, partial updates and /auth/me for every role", async () => {
    const cashier = await login(srv.base, h.users.cashier.email, h.outletId);
    expect((await cashier.call("GET", "/auth/me/preferences")).body).toEqual({ appearance: "system", textSize: "normal", density: "comfortable", accent: null });

    const put = await cashier.call("PUT", "/auth/me/preferences", { appearance: "dark", accent: "#2563eb" });
    expect(put.status).toBe(200);
    expect(put.body).toEqual({ appearance: "dark", textSize: "normal", density: "comfortable", accent: "#2563EB" });
    // Fields left out keep their saved value.
    expect((await cashier.call("PUT", "/auth/me/preferences", { density: "compact" })).body).toMatchObject({ appearance: "dark", density: "compact", accent: "#2563EB" });

    const me = (await cashier.call("GET", "/auth/me")).body;
    expect(me.preferences).toEqual({ appearance: "dark", textSize: "normal", density: "compact", accent: "#2563EB" });
    expect(me.brand).toEqual({ accent: "#FF6B35", corners: "rounded" });

    for (const k of ["kitchen", "delivery"] as const) {
      const c = await login(srv.base, h.users[k].email, h.outletId);
      expect((await c.call("PUT", "/auth/me/preferences", { textSize: "large" })).status, k).toBe(200);
    }
  });

  it("only changes the caller's own row and rejects invalid values / other fields", async () => {
    const manager = await login(srv.base, h.users.manager.email, h.outletId);
    const before = await db.user.findUniqueOrThrow({ where: { id: h.users.cashier.id }, select: { preferences: true, role: true } });
    expect((await manager.call("PUT", "/auth/me/preferences", { appearance: "light", textSize: "small" })).status).toBe(200);
    const after = await db.user.findUniqueOrThrow({ where: { id: h.users.cashier.id }, select: { preferences: true, role: true } });
    expect(after).toEqual(before);
    expect((await db.user.findUniqueOrThrow({ where: { id: h.users.manager.id } })).preferences).toMatchObject({ appearance: "light", textSize: "small" });

    expect((await manager.call("PUT", "/auth/me/preferences", { appearance: "neon" })).status).toBe(400);
    expect((await manager.call("PUT", "/auth/me/preferences", { accent: "orange" })).status).toBe(400);
    expect((await manager.call("PUT", "/auth/me/preferences", { userId: h.users.cashier.id, appearance: "dark" })).status).toBe(400);
    expect((await manager.call("PUT", "/auth/me/preferences", { role: "BUSINESS_OWNER" })).status).toBe(400);
  });

  it("platform admins have preferences too (default brand outside a business)", async () => {
    const admin = await createPlatformAdmin();
    const c = await login(srv.base, admin.email);
    expect((await c.call("PUT", "/auth/me/preferences", { appearance: "dark" })).status).toBe(200);
    const me = (await c.call("GET", "/auth/me")).body;
    expect(me.preferences.appearance).toBe("dark");
    expect(me.brand).toEqual({ accent: "#FF6B35", corners: "rounded" });
  });
});

describe("business brand", () => {
  it("only the owner (outlet:manage) changes it; everyone in the business gets it in /auth/me", async () => {
    for (const k of ["manager", "cashier", "kitchen"] as const) {
      const c = await login(srv.base, h.users[k].email, h.outletId);
      expect((await c.call("PUT", "/admin/brand", { accent: "#16A34A", corners: "square" })).status, k).toBe(403);
    }
    const owner = await login(srv.base, h.users.owner.email, h.outletId);
    const put = await owner.call("PUT", "/admin/brand", { accent: "#16a34a", corners: "square" });
    expect(put.status).toBe(200);
    expect(put.body).toEqual({ accent: "#16A34A", corners: "square" });
    expect((await owner.call("PUT", "/admin/brand", { accent: "green" })).status).toBe(400);

    const cashier = await login(srv.base, h.users.cashier.email, h.outletId);
    expect((await cashier.call("GET", "/admin/brand")).body).toEqual({ accent: "#16A34A", corners: "square" });
    expect((await cashier.call("GET", "/auth/me")).body.brand).toEqual({ accent: "#16A34A", corners: "square" });

    // Another business keeps its own (default) brand.
    const otherCashier = await login(srv.base, other.users.cashier.email, other.outletId);
    expect((await otherCashier.call("GET", "/auth/me")).body.brand).toEqual({ accent: "#FF6B35", corners: "rounded" });
    expect((await db.business.findUniqueOrThrow({ where: { id: other.businessId } })).brand).toEqual({});
  });
});
