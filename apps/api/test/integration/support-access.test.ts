/** Phase 2.4 — owner-consented, time-limited, read-only support access, fully audited. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { currentStep, totpAt } from "../../src/lib/totp";
import { createHotel, createPlatformAdmin, db, login, startServer, type Client, type Hotel } from "./helpers";

let srv: Awaited<ReturnType<typeof startServer>>;
let h: Hotel, other: Hotel;
let admin: Client;
let owner: Client;

beforeAll(async () => {
  srv = await startServer();
  [h, other] = [await createHotel("Support"), await createHotel("SupportOther")];
  owner = await login(srv.base, h.users.owner.email, h.outletId);
  admin = await login(srv.base, (await createPlatformAdmin()).email);
});
afterAll(() => srv.close());

const asSupport = (path: string, method = "GET", body?: unknown, businessId = h.businessId) =>
  admin.call(method, path, body, { "x-support-business": businessId, "x-outlet-id": h.outletId });

describe("support access", () => {
  it("without a grant the platform admin still can't open the hotel", async () => {
    expect((await admin.call("GET", "/orders", undefined, { "x-outlet-id": h.outletId })).status).toBe(403);
    const r = await asSupport("/orders");
    expect(r.status).toBe(403);
    expect(r.body.error).toMatch(/hasn't granted support access/);
  });

  it("only the owner can grant it, for 1–72 hours", async () => {
    const manager = await login(srv.base, h.users.manager.email, h.outletId);
    expect((await manager.call("POST", "/support-access", { hours: 4 })).status).toBe(403);
    expect((await owner.call("POST", "/support-access", { hours: 100 })).status).toBe(400);
    const g = await owner.call("POST", "/support-access", { hours: 4, reason: "Printer setup help" });
    expect(g.status).toBe(201);
  });

  it("requires the platform admin's own two-step login", async () => {
    const r = await asSupport("/orders");
    expect(r.status).toBe(403);
    expect(r.body.error).toMatch(/two-step login/);
    const setup = await admin.call("POST", "/auth/2fa/setup");
    expect((await admin.call("POST", "/auth/2fa/enable", { code: totpAt(setup.body.secret, currentStep()) })).status).toBe(200);
  });

  it("with a grant: read-only access to that hotel only, shown as a support session", async () => {
    expect((await asSupport("/orders")).status).toBe(200);
    const me = (await asSupport("/auth/me")).body;
    expect(me.platformAdmin).toBe(false);
    expect(me.support).toMatchObject({ businessId: h.businessId, readOnly: true });
    expect(me.outlets.map((o: { id: string }) => o.id).sort()).toEqual([h.outletId, h.outlet2Id].sort());
    // No writes, no owner-only export.
    const write = await asSupport("/orders", "POST", { orderType: "TAKEAWAY", items: [{ menuItemId: h.items.chai, quantity: 1 }] });
    expect(write.status).toBe(403);
    expect(write.body.error).toMatch(/read-only/);
    expect((await asSupport("/admin/export")).status).toBe(403);
    // Another hotel stays closed.
    expect((await asSupport("/orders", "GET", undefined, other.businessId)).status).toBe(403);
    // Can't extend its own access from inside.
    expect((await asSupport("/support-access", "GET")).status).toBe(403);
  });

  it("the owner sees exactly what was viewed, and can end it at once", async () => {
    const list = (await owner.call("GET", "/support-access")).body;
    const active = list.find((g: { active: boolean }) => g.active);
    expect(active.views).toBeGreaterThanOrEqual(1);
    const activity = (await owner.call("GET", `/support-access/${active.id}/activity`)).body as { path: string; method: string }[];
    expect(activity.some((a) => a.path === "/orders" && a.method === "GET")).toBe(true);
    expect((await owner.call("POST", `/support-access/${active.id}/revoke`)).status).toBe(200);
    expect((await asSupport("/orders")).status).toBe(403);
  });

  it("an expired grant stops working", async () => {
    const g = await owner.call("POST", "/support-access", { hours: 1 });
    expect((await asSupport("/orders")).status).toBe(200);
    await db.supportGrant.update({ where: { id: g.body.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await asSupport("/orders")).status).toBe(403);
  });

  it("the platform lists hotels with active grants", async () => {
    await owner.call("POST", "/support-access", { hours: 2, reason: "GST question" });
    const list = (await admin.call("GET", "/platform/support-grants")).body as { business: { id: string }; reason: string }[];
    expect(list.find((g) => g.business.id === h.businessId)?.reason).toBe("GST question");
    expect(list.some((g) => g.business.id === other.businessId)).toBe(false);
  });
});
