/**
 * P2 gap 4 (docs/qa/known-gaps.md) — combinable coupons with a stacking cap.
 * Default stays one offer OR coupon per bill; an owner can opt a coupon in (`combinable`): it then applies
 * after the offers (item offers → bill offer → coupon on the remaining pre-tax value), cut so all promotions
 * stay within the business's maxStackedDiscountPercent (loyalty setting, default 30 %).
 * Non-GST outlet here, so pre-tax = menu price (the GST side is in known-gaps.test.ts).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHotel, db, login, startServer, type Client, type Hotel } from "./helpers";

let srv: Awaited<ReturnType<typeof startServer>>;
let h: Hotel;
let owner: Client;

beforeAll(async () => {
  srv = await startServer();
  h = await createHotel("Stack", { modules: ["BILLING", "KOT", "TABLES", "DELIVERY", "INVENTORY", "CUSTOMERS", "OFFERS", "REPORTS", "CHANNELS"] });
  owner = await login(srv.base, h.users.owner.email, h.outletId);
});
afterAll(() => srv.close());

type Applied = { kind: string; label: string; amount: number };
const biryani = (qty = 1) => [{ menuItemId: h.items.biryani, quantity: qty }]; // ₹160 each
const preview = (body: object) => owner.call("POST", "/customers/preview-promotions", { orderType: "TAKEAWAY", items: biryani(), ...body });
const order = (body: object) => owner.call("POST", "/orders", { orderType: "TAKEAWAY", items: biryani(), ...body });
const offerOnly = async (name: string, type: string, config: object) => {
  await db.offer.updateMany({ where: { businessId: h.businessId }, data: { active: false } });
  expect((await owner.call("POST", "/offers", { name, type, config })).status).toBe(201);
};
const coupon = async (code: string, body: object) => {
  const r = await owner.call("POST", "/offers/coupons", { code, ...body });
  expect(r.status).toBe(201);
  return r.body as { id: string; combinable: boolean };
};
const setCap = async (pct: number) => expect((await owner.call("PUT", "/customers/loyalty/config", { maxStackedDiscountPercent: pct })).status).toBe(200);
const kinds = (a: Applied[]) => a.map((x) => `${x.kind}:${x.amount}`);

describe("combinable coupons (gap 4)", () => {
  it("default: a coupon is not combinable and one offer per bill still applies", async () => {
    await offerOnly("10% off", "BILL_DISCOUNT", { discountType: "PERCENT", value: 10 });
    const c = await coupon("SOLO20", { discountType: "FLAT", value: 2000 });
    expect(c.combinable).toBe(false);
    const r = (await preview({ couponCode: "SOLO20" })).body;
    expect(kinds(r.applied)).toEqual(["COUPON:2000"]);
    expect(r.comparison.find((x: { label: string }) => x.label === "10% off").note).toMatch(/One offer per bill/);
    expect((await owner.call("GET", "/customers/loyalty/config")).body.maxStackedDiscountPercent).toBe(30);
  });

  it("a combinable coupon stacks after the bill offer, on the remaining value; the bill matches the preview", async () => {
    await coupon("STACK20", { discountType: "FLAT", value: 2000, combinable: true });
    const r = (await preview({ couponCode: "STACK20" })).body;
    expect(kinds(r.applied)).toEqual(["OFFER:1600", "COUPON:2000"]);
    expect(r.comparison.find((x: { kind: string }) => x.kind === "COUPON").note).toMatch(/after the offers/);
    const o = await order({ couponCode: "STACK20" });
    expect(o.status).toBe(201);
    expect(kinds(o.body.appliedOffers)).toEqual(["OFFER:1600", "COUPON:2000"]);
    const row = await db.order.findUniqueOrThrow({ where: { id: o.body.id } });
    expect(row.taxableValue).toBe(16000 - 3600);
    expect((await db.couponRedemption.findUniqueOrThrow({ where: { orderId: o.body.id } })).amount).toBe(2000);
  });

  it("stacking order: item offer first, then a % coupon on what is left (not on the full bill)", async () => {
    await offerOnly("₹30 off biryani", "ITEM_DISCOUNT", { discountType: "FLAT", value: 3000, target: { menuItemIds: [h.items.biryani] } });
    await coupon("PCT10", { discountType: "PERCENT", value: 10, combinable: true });
    const r = (await preview({ couponCode: "PCT10" })).body;
    expect(kinds(r.applied)).toEqual(["OFFER:3000", "COUPON:1300"]); // 10 % of ₹130, not of ₹160
  });

  it("cap: the coupon is cut so offers + coupon stay within maxStackedDiscountPercent", async () => {
    await offerOnly("10% off", "BILL_DISCOUNT", { discountType: "PERCENT", value: 10 });
    await coupon("PCT20", { discountType: "PERCENT", value: 20, combinable: true });
    await setCap(25); // ₹40 of ₹160
    const r = (await preview({ couponCode: "PCT20" })).body;
    // uncapped: 1600 + 20 % of 14400 = 2880 → 4480; cap 4000 → coupon 2400 (still beats the coupon alone, 3200)
    expect(kinds(r.applied)).toEqual(["OFFER:1600", "COUPON:2400"]);
    expect(r.warnings.join(" ")).toMatch(/reduced to keep all discounts within 25%/);
    const o = await order({ couponCode: "PCT20" });
    expect((await db.order.findUniqueOrThrow({ where: { id: o.body.id } })).taxableValue).toBe(12000);
  });

  it("tie: when stacking saves no more than the coupon alone, the single coupon is used (one promotion on the bill)", async () => {
    await setCap(20); // cap 3200 = 20 % coupon alone
    const r = (await preview({ couponCode: "PCT20" })).body;
    expect(kinds(r.applied)).toEqual(["COUPON:3200"]);
  });

  it("offers already over the cap: the coupon is not applied (and not used up) when the offer saves more", async () => {
    await setCap(5); // ₹8 < the ₹16 offer
    await coupon("TEN", { discountType: "FLAT", value: 1000, combinable: true });
    const r = (await preview({ couponCode: "TEN" })).body;
    expect(kinds(r.applied)).toEqual(["OFFER:1600"]);
    expect(r.warnings.join(" ")).toMatch(/Coupon TEN not applied.*5% stacking limit/);
    const o = await order({ couponCode: "TEN" });
    expect(o.status).toBe(201);
    expect((await db.coupon.findFirstOrThrow({ where: { businessId: h.businessId, code: "TEN" } })).usedCount).toBe(0);
    expect(await db.couponRedemption.count({ where: { orderId: o.body.id } })).toBe(0);
  });

  it("usage limits still hold under stacking (total and per customer); cancelling gives the use back", async () => {
    await setCap(30);
    await coupon("ONCE", { discountType: "FLAT", value: 1000, combinable: true, usageLimit: 1 });
    const first = await order({ couponCode: "ONCE" });
    expect(kinds(first.body.appliedOffers)).toEqual(["OFFER:1600", "COUPON:1000"]);
    const again = await order({ couponCode: "ONCE" });
    expect(again.status).toBe(400);
    expect(again.body.error).toMatch(/usage limit/);

    await coupon("PERCUST", { discountType: "FLAT", value: 1000, combinable: true, perCustomerLimit: 1 });
    const phone = "9876501234";
    expect((await preview({ couponCode: "PERCUST" })).body.warnings.join(" ")).toMatch(/needs the customer's phone/);
    const a = await order({ couponCode: "PERCUST", customerPhone: phone });
    expect(kinds(a.body.appliedOffers)).toEqual(["OFFER:1600", "COUPON:1000"]);
    const b = await order({ couponCode: "PERCUST", customerPhone: phone });
    expect(b.status).toBe(400);
    expect(b.body.error).toMatch(/already used by this customer/);

    const cancel = await owner.call("POST", `/orders/${first.body.id}/cancel`, { reason: "Customer left" });
    expect(cancel.status).toBe(200);
    expect((await db.coupon.findFirstOrThrow({ where: { businessId: h.businessId, code: "ONCE" } })).usedCount).toBe(0);
  });

  it("the online ordering page takes a coupon with the same rules; un-flagging a coupon restores one offer per bill", async () => {
    const slug = `stack-${Date.now().toString(36)}`;
    expect((await owner.call("PUT", "/storefront/settings", { slug, onlineOrdering: true, verifyPhoneOtp: false })).status).toBe(200);
    const place = (couponCode?: string) =>
      fetch(`${srv.base}/public/o/${slug}/orders`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ orderType: "TAKEAWAY", customerName: "Online", customerPhone: "9876509876", payment: "COUNTER", items: biryani(), couponCode }),
      });
    const bad = await place("NOPE");
    expect(bad.status).toBe(400);
    const ok = await place("stack20");
    expect(ok.status).toBe(201);
    const req = await db.channelRequest.findFirstOrThrow({ where: { publicToken: ((await ok.json()) as { token: string }).token } });
    const red = await db.couponRedemption.findUniqueOrThrow({ where: { orderId: req.orderId! } });
    expect(red.amount).toBe(2000);
    expect((await db.order.findUniqueOrThrow({ where: { id: req.orderId! } })).taxableValue).toBe(16000 - 1600 - 2000);

    const id = (await db.coupon.findFirstOrThrow({ where: { businessId: h.businessId, code: "STACK20" } })).id;
    const r = await owner.call("PATCH", `/offers/coupons/${id}`, { combinable: false });
    expect(r.body.combinable).toBe(false);
    expect(kinds((await preview({ couponCode: "STACK20" })).body.applied)).toEqual(["COUPON:2000"]);
  });
});
