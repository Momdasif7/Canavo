/** Phase 3.6 — 0% GST safeguard and the ₹-discount GST setting (D1). */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHotel, db, login, startServer, type Client, type Hotel } from "./helpers";

let srv: Awaited<ReturnType<typeof startServer>>;
let h: Hotel, noGst: Hotel;
let owner: Client;

beforeAll(async () => {
  srv = await startServer();
  h = await createHotel("GstGuard", { gst: true });
  noGst = await createHotel("NoGst", { gst: false });
  owner = await login(srv.base, h.users.owner.email, h.outletId);
  // Fixture items have no tax rate (→ the hotel default, 0% exempt): give the food a real 5% rate.
  const gst5 = await db.taxRate.findFirstOrThrow({ where: { businessId: h.businessId, cgst: 2.5, sgst: 2.5 } });
  await db.menuItem.updateMany({ where: { id: { in: Object.values(h.items) } }, data: { taxRateId: gst5.id } });
});
afterAll(() => srv.close());

describe("0% GST safeguard", () => {
  it("lists 0%-rated items on a GST-registered outlet only", async () => {
    const cat = await db.menuCategory.findFirstOrThrow({ where: { businessId: h.businessId } });
    const exempt = await db.menuItem.create({ data: { businessId: h.businessId, categoryId: cat.id, name: "Plain water", price: 1000, gstRate: 0 } });
    const r = (await owner.call("GET", "/menu/tax-check")).body;
    expect(r.applies).toBe(true);
    expect(r.zeroRated.map((i: { id: string }) => i.id)).toContain(exempt.id);
    expect(r.zeroRated.map((i: { id: string }) => i.id)).not.toContain(h.items.chai);
    const other = await login(srv.base, noGst.users.owner.email, noGst.outletId);
    expect((await other.call("GET", "/menu/tax-check")).body).toEqual({ applies: false, zeroRated: [] });
  });
});

describe("₹ discounts and GST (D1)", () => {
  const bill = (c: Client) => c.call("POST", "/orders", { orderType: "TAKEAWAY", items: [{ menuItemId: h.items.biryani, quantity: 1 }], discount: { type: "FLAT", value: 5000 } });

  it("default: ₹50 off the pre-tax price; with the setting on: exactly ₹50 off the total", async () => {
    const full = (await owner.call("POST", "/orders", { orderType: "TAKEAWAY", items: [{ menuItemId: h.items.biryani, quantity: 1 }] })).body;
    const pre = (await bill(owner)).body;
    expect(full.grandTotal - pre.grandTotal).toBeGreaterThan(5000);
    const manager = await login(srv.base, h.users.manager.email, h.outletId);
    // Billing setting: managers have settings:billing; the field is a billing field.
    expect((await manager.call("PATCH", "/outlets/current", { flatDiscountsIncludeTax: true })).status).toBe(200);
    const inc = (await bill(owner)).body;
    expect(Math.abs(full.grandTotal - inc.grandTotal - 5000)).toBeLessThanOrEqual(1);
    await db.outlet.update({ where: { id: h.outletId }, data: { flatDiscountsIncludeTax: false } });
  });

  it("a % coupon gives the same total whether ₹ discounts include GST or not; a ₹ coupon follows the setting", async () => {
    await db.coupon.createMany({
      data: [
        { businessId: h.businessId, code: "TENPC", discountType: "PERCENT", value: 10 },
        { businessId: h.businessId, code: "FIFTY", discountType: "FLAT", value: 5000 },
      ],
    });
    const items = [{ menuItemId: h.items.biryani, quantity: 1 }];
    const total = async (code: string) => (await owner.call("POST", "/orders", { orderType: "TAKEAWAY", items, couponCode: code })).body.grandTotal as number;
    const full = (await owner.call("POST", "/orders", { orderType: "TAKEAWAY", items })).body.grandTotal as number;
    const pctOff = await total("TENPC");
    const flatOff = await total("FIFTY");
    await db.outlet.update({ where: { id: h.outletId }, data: { flatDiscountsIncludeTax: true } });
    expect(await total("TENPC")).toBe(pctOff);
    expect(full - (await total("FIFTY"))).toBe(5000);
    expect(full - flatOff).toBeGreaterThan(5000);
    await db.outlet.update({ where: { id: h.outletId }, data: { flatDiscountsIncludeTax: false } });
  });

  it("only the owner can change the approval limit", async () => {
    const manager = await login(srv.base, h.users.manager.email, h.outletId);
    expect((await manager.call("PATCH", "/outlets/current", { approvalDiscountPercent: 50 })).status).toBe(403);
    expect((await owner.call("PATCH", "/outlets/current", { approvalDiscountPercent: 15 })).status).toBe(200);
  });
});
