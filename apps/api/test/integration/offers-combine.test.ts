/** Phase 3.7 — "why this offer won" and combinable offers. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHotel, db, login, startServer, type Client, type Hotel } from "./helpers";

let srv: Awaited<ReturnType<typeof startServer>>;
let h: Hotel;
let owner: Client;

beforeAll(async () => {
  srv = await startServer();
  h = await createHotel("Offers");
  owner = await login(srv.base, h.users.owner.email, h.outletId);
});
afterAll(() => srv.close());

const preview = (items: { menuItemId: string; quantity: number }[]) => owner.call("POST", "/customers/preview-promotions", { orderType: "TAKEAWAY", items });
const offer = (name: string, type: string, config: object, combinable = false) => owner.call("POST", "/offers", { name, type, config, combinable });

describe("offers", () => {
  it("explains which offer won and why the others didn't apply", async () => {
    expect((await offer("10% off the bill", "BILL_DISCOUNT", { discountType: "PERCENT", value: 10 })).status).toBe(201);
    await offer("₹5 off chai", "ITEM_DISCOUNT", { discountType: "FLAT", value: 500, target: { menuItemIds: [h.items.chai] } });
    const r = (await preview([{ menuItemId: h.items.biryani, quantity: 1 }, { menuItemId: h.items.chai, quantity: 1 }])).body;
    expect(r.applied).toHaveLength(1);
    const won = r.comparison.find((c: { applied: boolean }) => c.applied);
    expect(won.label).toBe("10% off the bill");
    expect(won.note).toBe("Saves the most");
    const lost = r.comparison.find((c: { label: string }) => c.label === "₹5 off chai");
    expect(lost).toMatchObject({ applied: false });
    expect(lost.note).toMatch(/One offer per bill/);
    expect(lost.saving).toBeGreaterThan(0);
  });

  it("a combinable offer applies on top, only on items not already discounted", async () => {
    await db.offer.updateMany({ where: { businessId: h.businessId }, data: { active: false } });
    await offer("₹10 off samosa", "ITEM_DISCOUNT", { discountType: "FLAT", value: 1000, target: { menuItemIds: [h.items.samosa] } });
    await offer("₹3 off chai (combinable)", "ITEM_DISCOUNT", { discountType: "FLAT", value: 300, target: { menuItemIds: [h.items.chai] } }, true);
    await offer("₹2 off samosa (combinable)", "ITEM_DISCOUNT", { discountType: "FLAT", value: 200, target: { menuItemIds: [h.items.samosa] } }, true);
    const r = (await preview([{ menuItemId: h.items.samosa, quantity: 1 }, { menuItemId: h.items.chai, quantity: 1 }])).body;
    const labels = r.applied.map((a: { label: string }) => a.label).sort();
    expect(labels).toEqual(["₹10 off samosa", "₹3 off chai (combinable)"]);
    expect(r.comparison.find((c: { label: string }) => c.label === "₹2 off samosa (combinable)").note).toMatch(/already have a discount/);
    // The real bill matches the preview.
    const o = await owner.call("POST", "/orders", { orderType: "TAKEAWAY", items: [{ menuItemId: h.items.samosa, quantity: 1 }, { menuItemId: h.items.chai, quantity: 1 }] });
    expect(o.body.appliedOffers.map((a: { label: string }) => a.label).sort()).toEqual(labels);
  });

  it("without combinable offers, still one offer per bill (unchanged)", async () => {
    await db.offer.updateMany({ where: { businessId: h.businessId }, data: { combinable: false } });
    const r = (await preview([{ menuItemId: h.items.samosa, quantity: 1 }, { menuItemId: h.items.chai, quantity: 1 }])).body;
    expect(r.applied).toHaveLength(1);
  });
});
