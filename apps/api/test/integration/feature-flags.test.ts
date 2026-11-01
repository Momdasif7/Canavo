/**
 * Phase 1 / D11 + D14 — per-hotel feature flags. New capabilities are OFF for a
 * hotel until the platform Super Admin enables them; AUTO_STOCK_OUT is the first.
 */
import bcrypt from "bcryptjs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHotel, db, login, PASSWORD, startServer, type Hotel } from "./helpers";

let srv: Awaited<ReturnType<typeof startServer>>;
let h: Hotel;
let adminEmail: string;
let inventoryItemId: string;

beforeAll(async () => {
  srv = await startServer();
  h = await createHotel("Flags");
  adminEmail = `platform.${Date.now()}@it.local`;
  await db.user.create({ data: { role: "SUPER_ADMIN", name: "IT Admin", email: adminEmail, phone: `8${String(Date.now()).slice(-9)}`, passwordHash: await bcrypt.hash(PASSWORD, 4) } });
  // Biryani needs 0.2 kg rice; the outlet has none.
  const inv = await db.inventoryItem.create({ data: { businessId: h.businessId, name: "Rice", unit: "KG" } });
  inventoryItemId = inv.id;
  await db.recipe.create({ data: { menuItemId: h.items.biryani, inventoryItemId: inv.id, quantity: 0.2 } });
});
afterAll(() => srv.close());

const biryani = async (c: Awaited<ReturnType<typeof login>>) => (await c.call("GET", "/menu")).body.items.find((i: { id: string }) => i.id === h.items.biryani);

describe("feature flags", () => {
  it("flag OFF (default for an existing hotel): no automatic out-of-stock, item stays sellable", async () => {
    const cashier = await login(srv.base, h.users.cashier.email, h.outletId);
    const me = (await cashier.call("GET", "/auth/me")).body;
    expect(me.features).toEqual({});
    expect((await biryani(cashier)).stockOut).toBe(false);
    const bill = await cashier.call("POST", "/orders", { orderType: "TAKEAWAY", items: [{ menuItemId: h.items.biryani, quantity: 1 }] });
    expect(bill.status).toBe(201);
    // the sale still deducted stock (inventory behaviour unchanged)
    expect((await db.inventoryStock.findFirst({ where: { outletId: h.outletId, inventoryItemId } }))?.quantity).toBeCloseTo(-0.2);
  });

  it("only the platform Super Admin can switch flags", async () => {
    const owner = await login(srv.base, h.users.owner.email, h.outletId);
    expect((await owner.call("PATCH", `/platform/businesses/${h.businessId}`, { features: { AUTO_STOCK_OUT: true } })).status).toBe(403);
    const admin = await login(srv.base, adminEmail);
    expect((await admin.call("PATCH", `/platform/businesses/${h.businessId}`, { features: { NOT_A_FLAG: true } })).status).toBe(400);
  });

  it("flag ON: availability computed immediately, billing refuses, /auth/me shows the flag", async () => {
    const admin = await login(srv.base, adminEmail);
    const r = await admin.call("PATCH", `/platform/businesses/${h.businessId}`, { features: { AUTO_STOCK_OUT: true } });
    expect(r.status).toBe(200);
    expect(r.body.features).toEqual({ AUTO_STOCK_OUT: true });
    const detail = (await admin.call("GET", `/platform/businesses/${h.businessId}`)).body;
    expect(detail.featureCatalog.AUTO_STOCK_OUT.requires).toEqual(["INVENTORY"]);
    const cashier = await login(srv.base, h.users.cashier.email, h.outletId);
    expect((await cashier.call("GET", "/auth/me")).body.features).toEqual({ AUTO_STOCK_OUT: true });
    const item = await biryani(cashier);
    expect(item.stockOut).toBe(true);
    expect(item.stockOutReason).toBe("Rice");
    const bill = await cashier.call("POST", "/orders", { orderType: "TAKEAWAY", items: [{ menuItemId: h.items.biryani, quantity: 1 }] });
    expect(bill.status).toBe(400);
    expect(bill.body.error).toMatch(/out of stock/);
    const audit = await db.auditLog.findFirst({ where: { action: "platform.business.update", entityId: h.businessId }, orderBy: { createdAt: "desc" } });
    expect(JSON.stringify(audit?.meta)).toContain("AUTO_STOCK_OUT");
  });

  it("flag needs its module: without INVENTORY it has no effect", async () => {
    await db.business.update({ where: { id: h.businessId }, data: { modules: ["BILLING", "KOT"] } });
    const cashier = await login(srv.base, h.users.cashier.email, h.outletId);
    expect((await cashier.call("GET", "/auth/me")).body.features).toEqual({});
    expect((await biryani(cashier)).stockOut).toBe(false);
    await db.business.update({ where: { id: h.businessId }, data: { modules: ["BILLING", "KOT", "INVENTORY"] } });
  });

  it("flag OFF again: automatic flags are cleared and the item is sellable", async () => {
    const admin = await login(srv.base, adminEmail);
    expect((await admin.call("PATCH", `/platform/businesses/${h.businessId}`, { features: { AUTO_STOCK_OUT: false } })).status).toBe(200);
    const left = await db.outletItemOverride.count({ where: { outletId: h.outletId, stockOut: true } });
    expect(left).toBe(0);
    const cashier = await login(srv.base, h.users.cashier.email, h.outletId);
    expect((await cashier.call("POST", "/orders", { orderType: "TAKEAWAY", items: [{ menuItemId: h.items.biryani, quantity: 1 }] })).status).toBe(201);
  });
});
