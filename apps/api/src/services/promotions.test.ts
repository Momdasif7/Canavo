import { describe, expect, it } from "vitest";
import { computeBill, loyaltyConfigSchema } from "@canavo/shared";
import {
  bestOffer,
  couponAmount,
  couponError,
  evaluateBillOffer,
  evaluateLineOffers,
  isOfferActive,
  offerConfigError,
  pointsToEarn,
  preTaxRemaining,
  redeemPoints,
  tierForSpend,
  windowDayOffset,
  type EngineCoupon,
  type EngineLine,
  type EngineOffer,
} from "./offer-engine";

const cfg = loyaltyConfigSchema.parse({});
const TZ = "Asia/Kolkata";
// 2026-10-02 is a Friday. IST = UTC+5:30.
const ist = (local: string) => new Date(`${local}+05:30`);

let seq = 0;
function offer(partial: Partial<EngineOffer> & Pick<EngineOffer, "type" | "config">): EngineOffer {
  return {
    id: `o${++seq}`,
    name: partial.type,
    active: true,
    outletIds: [],
    startsAt: null,
    endsAt: null,
    daysOfWeek: [],
    startTime: null,
    endTime: null,
    priority: 0,
    ...partial,
  };
}
const line = (menuItemId: string, unitPrice: number, quantity: number, extra: Partial<EngineLine> = {}): EngineLine => ({
  menuItemId,
  categoryIds: [extra.categoryIds?.[0] ?? "cat-snacks"],
  unitPrice,
  quantity,
  manualDiscount: 0,
  ...extra,
});

describe("offer time eligibility", () => {
  const happy = offer({ type: "HAPPY_HOUR", startTime: "15:00", endTime: "17:00", config: {} });
  it("applies inside the HH:MM window in outlet time", () => {
    expect(isOfferActive(happy, { outletId: "x", at: ist("2026-10-02T15:00:00"), timezone: TZ })).toBe(true);
    expect(isOfferActive(happy, { outletId: "x", at: ist("2026-10-02T16:59:00"), timezone: TZ })).toBe(true);
    expect(isOfferActive(happy, { outletId: "x", at: ist("2026-10-02T17:00:00"), timezone: TZ })).toBe(false);
    expect(isOfferActive(happy, { outletId: "x", at: ist("2026-10-02T14:59:00"), timezone: TZ })).toBe(false);
  });
  it("uses the outlet timezone, not UTC", () => {
    // 09:45 UTC = 15:15 IST
    expect(isOfferActive(happy, { outletId: "x", at: new Date("2026-10-02T09:45:00Z"), timezone: TZ })).toBe(true);
    expect(isOfferActive(happy, { outletId: "x", at: new Date("2026-10-02T09:45:00Z"), timezone: "UTC" })).toBe(false);
  });
  it("handles windows crossing midnight", () => {
    expect(windowDayOffset(23 * 60, "22:00", "02:00")).toBe(0);
    expect(windowDayOffset(60, "22:00", "02:00")).toBe(-1);
    expect(windowDayOffset(3 * 60, "22:00", "02:00")).toBeNull();
    const late = offer({ type: "HAPPY_HOUR", startTime: "22:00", endTime: "02:00", daysOfWeek: [5], config: {} }); // Fridays
    expect(isOfferActive(late, { outletId: "x", at: ist("2026-10-02T23:30:00"), timezone: TZ })).toBe(true); // Fri
    expect(isOfferActive(late, { outletId: "x", at: ist("2026-10-03T01:30:00"), timezone: TZ })).toBe(true); // Sat early = Fri night
    expect(isOfferActive(late, { outletId: "x", at: ist("2026-10-03T23:30:00"), timezone: TZ })).toBe(false); // Sat night
    expect(isOfferActive(late, { outletId: "x", at: ist("2026-10-02T01:30:00"), timezone: TZ })).toBe(false); // Thu night tail
  });
  it("checks weekday, date range, outlet and active flag", () => {
    const at = ist("2026-10-02T12:00:00");
    const ctx = { outletId: "o1", at, timezone: TZ };
    expect(isOfferActive(offer({ type: "ITEM_DISCOUNT", daysOfWeek: [0, 6], config: {} }), ctx)).toBe(false);
    expect(isOfferActive(offer({ type: "ITEM_DISCOUNT", daysOfWeek: [5], config: {} }), ctx)).toBe(true);
    expect(isOfferActive(offer({ type: "ITEM_DISCOUNT", outletIds: ["o2"], config: {} }), ctx)).toBe(false);
    expect(isOfferActive(offer({ type: "ITEM_DISCOUNT", outletIds: ["o1"], config: {} }), ctx)).toBe(true);
    expect(isOfferActive(offer({ type: "ITEM_DISCOUNT", endsAt: ist("2026-10-02T11:00:00"), config: {} }), ctx)).toBe(false);
    expect(isOfferActive(offer({ type: "ITEM_DISCOUNT", startsAt: ist("2026-10-03T00:00:00"), config: {} }), ctx)).toBe(false);
    expect(isOfferActive(offer({ type: "ITEM_DISCOUNT", active: false, config: {} }), ctx)).toBe(false);
  });
});

describe("item discounts", () => {
  it("applies percent off to targeted categories (incl. sub-categories)", () => {
    const o = offer({ type: "HAPPY_HOUR", config: { target: { categoryIds: ["bev"] }, discountType: "PERCENT", value: 20 } });
    const r = evaluateLineOffers([o], [
      line("chai", 1500, 2, { categoryIds: ["hot", "bev"] }),
      line("samosa", 3000, 1),
    ]);
    expect(r.lineDiscounts).toEqual([600, 0]);
    expect(r.applied[0].amount).toBe(600);
  });
  it("FLAT is paise per unit and never exceeds the unit price", () => {
    const o = offer({ type: "ITEM_DISCOUNT", config: { target: { menuItemIds: ["chai"] }, discountType: "FLAT", value: 2000 } });
    expect(evaluateLineOffers([o], [line("chai", 1500, 3)]).lineDiscounts).toEqual([4500]);
  });
  it("never discounts a line below zero after the manual discount", () => {
    const o = offer({ type: "ITEM_DISCOUNT", config: { discountType: "PERCENT", value: 50 } });
    const r = evaluateLineOffers([o], [line("chai", 1000, 2, { manualDiscount: 1500 })]);
    expect(r.lineDiscounts).toEqual([500]);
    const none = evaluateLineOffers([o], [line("chai", 1000, 2, { manualDiscount: 2000 })]);
    expect(none.lineDiscounts).toEqual([0]);
    expect(none.applied).toHaveLength(0);
  });
  it("skips offers with invalid config", () => {
    const bad = offer({ type: "ITEM_DISCOUNT", config: { discountType: "PERCENT" } });
    expect(evaluateLineOffers([bad], [line("chai", 1000, 1)]).lineDiscounts).toEqual([0]);
    expect(offerConfigError("ITEM_DISCOUNT", { discountType: "PERCENT" })).toMatch(/value/);
    expect(offerConfigError("COMBO", { items: [{ menuItemId: "a", quantity: 1 }], price: 100 })).toBeNull();
  });
});

describe("buy X get Y", () => {
  const b2g1chai = offer({
    type: "BUY_X_GET_Y",
    config: { buy: { menuItemIds: ["samosa"], quantity: 2 }, get: { menuItemIds: ["chai"], quantity: 1 }, getDiscountPercent: 100 },
  });
  it("makes the get item free once per qualifying set", () => {
    const r = evaluateLineOffers([b2g1chai], [line("samosa", 3000, 2), line("chai", 1500, 1)]);
    expect(r.lineDiscounts).toEqual([0, 1500]);
  });
  it("repeats as many times as qualifies", () => {
    const r = evaluateLineOffers([b2g1chai], [line("samosa", 3000, 5), line("chai", 1500, 3)]);
    expect(r.lineDiscounts).toEqual([0, 3000]); // 5 samosas → 2 sets
  });
  it("needs the buy quantity", () => {
    expect(evaluateLineOffers([b2g1chai], [line("samosa", 3000, 1), line("chai", 1500, 2)]).applied).toHaveLength(0);
  });
  it("discounts the cheapest eligible units within the same pool", () => {
    const anySnack = offer({
      type: "BUY_X_GET_Y",
      config: { buy: { categoryIds: ["cat-snacks"], quantity: 2 }, get: { categoryIds: ["cat-snacks"], quantity: 1 } },
    });
    // units: 50,50,40,40,30,30 → two sets, free = 30 + 30
    const r = evaluateLineOffers([anySnack], [line("sandwich", 5000, 2), line("pakoda", 4000, 2), line("puff", 3000, 2)]);
    expect(r.lineDiscounts).toEqual([0, 0, 6000]);
    // 4 units only → one set, cheapest (30) free
    const r2 = evaluateLineOffers([anySnack], [line("sandwich", 5000, 2), line("puff", 3000, 1), line("pakoda", 4000, 1)]);
    expect(r2.lineDiscounts).toEqual([0, 3000, 0]);
  });
  it("supports partial discounts and maxSets", () => {
    const half = offer({
      type: "BUY_X_GET_Y",
      config: { buy: { menuItemIds: ["chai"], quantity: 1 }, get: { menuItemIds: ["chai"], quantity: 1 }, getDiscountPercent: 50, maxSets: 1 },
    });
    expect(evaluateLineOffers([half], [line("chai", 2000, 4)]).lineDiscounts).toEqual([1000]);
  });
});

describe("combo", () => {
  const combo = offer({
    type: "COMBO",
    config: { items: [{ menuItemId: "vadapav", quantity: 1 }, { menuItemId: "chai", quantity: 1 }], price: 3500 },
  });
  it("discounts the set down to the combo price", () => {
    const r = evaluateLineOffers([combo], [line("vadapav", 2500, 1), line("chai", 1500, 1)]);
    expect(r.applied[0].amount).toBe(500);
    expect(r.lineDiscounts.reduce((a, b) => a + b, 0)).toBe(500);
  });
  it("repeats per full set only", () => {
    const r = evaluateLineOffers([combo], [line("vadapav", 2500, 3), line("chai", 1500, 2)]);
    expect(r.applied[0].amount).toBe(1000);
  });
  it("does nothing when an item is missing or the combo is not cheaper", () => {
    expect(evaluateLineOffers([combo], [line("vadapav", 2500, 2)]).applied).toHaveLength(0);
    const pricey = offer({ type: "COMBO", config: { items: [{ menuItemId: "chai", quantity: 2 }], price: 5000 } });
    expect(evaluateLineOffers([pricey], [line("chai", 1500, 2)]).applied).toHaveLength(0);
  });
});

describe("no double-dipping", () => {
  it("units used by a higher-priority offer are not discounted again", () => {
    const happy = offer({ type: "HAPPY_HOUR", priority: 10, config: { target: { menuItemIds: ["chai"] }, discountType: "PERCENT", value: 20 } });
    const combo = offer({
      type: "COMBO",
      priority: 0,
      config: { items: [{ menuItemId: "vadapav", quantity: 1 }, { menuItemId: "chai", quantity: 1 }], price: 3500 },
    });
    // 2 chai both taken by happy hour → combo can't form
    const r = evaluateLineOffers([combo, happy], [line("vadapav", 2500, 1), line("chai", 1500, 2)]);
    expect(r.applied.map((a) => a.type)).toEqual(["HAPPY_HOUR"]);
    expect(r.lineDiscounts).toEqual([0, 600]);
  });
  it("lower-priority offers use only leftover units", () => {
    const combo = offer({
      type: "COMBO",
      priority: 10,
      config: { items: [{ menuItemId: "vadapav", quantity: 1 }, { menuItemId: "chai", quantity: 1 }], price: 3500 },
    });
    const happy = offer({ type: "HAPPY_HOUR", priority: 0, config: { target: { menuItemIds: ["chai"] }, discountType: "PERCENT", value: 20 } });
    const r = evaluateLineOffers([happy, combo], [line("vadapav", 2500, 1), line("chai", 1500, 3)]);
    expect(r.applied.map((a) => a.type)).toEqual(["COMBO", "HAPPY_HOUR"]);
    const happyAmt = r.applied.find((a) => a.type === "HAPPY_HOUR")!.amount;
    expect(happyAmt).toBe(600); // only the 2 chai not in the combo
  });
  it("BxGy buy units can't be reused by another BxGy", () => {
    const o1 = offer({
      type: "BUY_X_GET_Y",
      priority: 2,
      config: { buy: { menuItemIds: ["samosa"], quantity: 2 }, get: { menuItemIds: ["chai"], quantity: 1 } },
    });
    const o2 = offer({
      type: "BUY_X_GET_Y",
      priority: 1,
      config: { buy: { menuItemIds: ["samosa"], quantity: 2 }, get: { menuItemIds: ["coffee"], quantity: 1 } },
    });
    const r = evaluateLineOffers([o1, o2], [line("samosa", 3000, 2), line("chai", 1500, 1), line("coffee", 2000, 1)]);
    expect(r.applied).toHaveLength(1);
    expect(r.lineDiscounts).toEqual([0, 1500, 0]);
  });
});

describe("bill offers, pre-tax and coupons", () => {
  const mode = { pricesIncludeTax: true, compositionScheme: false };
  it("preTaxRemaining matches computeBill", () => {
    const lines = [
      { unitPrice: 10500, quantity: 2, gstRate: 5, lineDiscount: 1050 },
      { unitPrice: 11800, quantity: 1, gstRate: 18, lineDiscount: 0 },
    ];
    const discounts = [{ type: "PERCENT" as const, value: 10 }, { type: "FLAT" as const, value: 1234 }];
    const rem = preTaxRemaining(lines, mode, discounts);
    const bill = computeBill(
      lines.map((l) => ({ ...l })),
      { ...mode, interState: false, serviceChargeEnabled: false, serviceChargePercent: 0, roundOff: false },
      discounts,
    );
    expect(rem).toBe(bill.taxableValue);
  });
  it("preTaxRemaining matches computeBill with cess (total inclusive rate) and with GST off", () => {
    const tax = { cgst: 2.5, sgst: 2.5, igst: 5, cess: 1, extras: [{ label: "VAT", percent: 2 }] };
    const lines = [{ unitPrice: 10800, quantity: 3, tax, gstRate: 8, lineDiscount: 500 }];
    const discounts = [{ type: "FLAT" as const, value: 999 }];
    const cfg = { interState: false, serviceChargeEnabled: false, serviceChargePercent: 0, roundOff: false };
    expect(preTaxRemaining(lines, mode, discounts)).toBe(computeBill(lines, { ...mode, ...cfg }, discounts).taxableValue);
    const off = { ...mode, taxEnabled: false };
    expect(preTaxRemaining(lines, off, discounts)).toBe(computeBill(lines, { ...off, ...cfg }, discounts).taxableValue);
  });
  it("bill discount respects minOrder and maxDiscount", () => {
    const o = offer({ type: "BILL_DISCOUNT", config: { minOrder: 50000, discountType: "PERCENT", value: 10, maxDiscount: 10000 } });
    expect(evaluateBillOffer([o], 49999, 47619)).toBeNull();
    expect(evaluateBillOffer([o], 60000, 57143)!.amount).toBe(5714);
    expect(evaluateBillOffer([o], 200000, 190476)!.amount).toBe(10000);
  });
  it("picks the highest-priority, then best bill offer", () => {
    const a = offer({ type: "BILL_DISCOUNT", config: { discountType: "FLAT", value: 5000 } });
    const b = offer({ type: "BILL_DISCOUNT", config: { discountType: "FLAT", value: 8000 } });
    const c = offer({ type: "BILL_DISCOUNT", priority: 5, config: { discountType: "FLAT", value: 1000 } });
    expect(evaluateBillOffer([a, b], 100000, 100000)!.offer.id).toBe(b.id);
    expect(evaluateBillOffer([a, b, c], 100000, 100000)!.offer.id).toBe(c.id);
  });

  const coupon = (p: Partial<EngineCoupon> = {}): EngineCoupon => ({
    code: "WELCOME50",
    discountType: "FLAT",
    value: 5000,
    maxDiscount: null,
    minOrder: 20000,
    usageLimit: null,
    perCustomerLimit: null,
    usedCount: 0,
    startsAt: null,
    expiresAt: null,
    active: true,
    ...p,
  });
  const at = new Date("2026-10-02T10:00:00Z");
  const ok = { at, subtotal: 25000, hasCustomer: true, customerUses: 0 };
  it("validates coupon rules with clear messages", () => {
    expect(couponError(null, ok)).toBe("Invalid coupon code");
    expect(couponError(coupon(), ok)).toBeNull();
    expect(couponError(coupon({ active: false }), ok)).toMatch(/not active/);
    expect(couponError(coupon({ startsAt: new Date("2026-10-03T00:00:00Z") }), ok)).toMatch(/not valid yet/);
    expect(couponError(coupon({ expiresAt: new Date("2026-10-01T00:00:00Z") }), ok)).toMatch(/expired/);
    expect(couponError(coupon({ usageLimit: 5, usedCount: 5 }), ok)).toMatch(/usage limit/);
    expect(couponError(coupon({ perCustomerLimit: 1 }), { ...ok, hasCustomer: false })).toMatch(/phone/);
    expect(couponError(coupon({ perCustomerLimit: 1 }), { ...ok, customerUses: 1 })).toMatch(/already used/);
    expect(couponError(coupon(), { ...ok, subtotal: 19999 })).toMatch(/minimum order of ₹200\.00/);
  });
  it("computes coupon amounts with caps", () => {
    expect(couponAmount(coupon(), 30000)).toBe(5000);
    expect(couponAmount(coupon(), 3000)).toBe(3000); // never more than the bill
    expect(couponAmount(coupon({ discountType: "PERCENT", value: 10, maxDiscount: 7500 }), 50000)).toBe(5000);
    expect(couponAmount(coupon({ discountType: "PERCENT", value: 10, maxDiscount: 7500 }), 100000)).toBe(7500);
  });
});

describe("loyalty", () => {
  it("earns 1 point per ₹10 with tier multipliers", () => {
    expect(pointsToEarn(12000, "BRONZE", cfg)).toBe(12);
    expect(pointsToEarn(12000, "SILVER", cfg)).toBe(15);
    expect(pointsToEarn(12000, "GOLD", cfg)).toBe(18);
    expect(pointsToEarn(12000, "PLATINUM", cfg)).toBe(24);
    expect(pointsToEarn(999, "BRONZE", cfg)).toBe(0);
  });
  it("assigns tiers by total spend", () => {
    expect(tierForSpend(499_999, cfg)).toBe("BRONZE");
    expect(tierForSpend(500_000, cfg)).toBe("SILVER");
    expect(tierForSpend(1_500_000, cfg)).toBe("GOLD");
    expect(tierForSpend(4_000_000, cfg)).toBe("PLATINUM");
  });
  it("redeems points at ₹0.25 each", () => {
    expect(redeemPoints(cfg, { balance: 500, requested: 200, remaining: 100000 })).toEqual({ ok: true, points: 200, value: 5000 });
  });
  it("caps redemption at 50% of the bill", () => {
    // ₹300 bill → max ₹150 → 600 points
    expect(redeemPoints(cfg, { balance: 1000, requested: 1000, remaining: 30000 })).toEqual({ ok: true, points: 600, value: 15000 });
  });
  it("enforces minimum, balance and small bills", () => {
    expect(redeemPoints(cfg, { balance: 500, requested: 50, remaining: 100000 })).toMatchObject({ ok: false, error: expect.stringMatching(/Minimum 100/) });
    expect(redeemPoints(cfg, { balance: 150, requested: 200, remaining: 100000 })).toMatchObject({ ok: false, error: expect.stringMatching(/Only 150/) });
    // ₹40 bill → max ₹20 → 80 points < 100 minimum
    expect(redeemPoints(cfg, { balance: 500, requested: 100, remaining: 4000 })).toMatchObject({ ok: false, error: expect.stringMatching(/at most 80/) });
  });
});

describe("one offer per bill (bestOffer)", () => {
  const mode = { pricesIncludeTax: false, compositionScheme: false, taxEnabled: false };
  const samosa = line("samosa", 3000, 2, { categoryIds: ["cat-snacks"] });
  const chai = line("chai", 1500, 1, { categoryIds: ["cat-hot"] });
  const bxgy = offer({
    type: "BUY_X_GET_Y",
    name: "Buy 2 Samosa, get 1 Chai free",
    config: { buy: { menuItemIds: ["samosa"], quantity: 2 }, get: { menuItemIds: ["chai"], quantity: 1 }, getDiscountPercent: 100 },
  });
  const happy = offer({ type: "HAPPY_HOUR", name: "Happy Hour 20% off Hot Beverages", priority: 5, config: { target: { categoryIds: ["cat-hot"] }, discountType: "PERCENT", value: 20 } });
  const bill10 = offer({ type: "BILL_DISCOUNT", name: "10% off", config: { discountType: "PERCENT", value: 10, minOrder: 0 } });

  it("free chai beats a higher-priority 20% happy hour: bill = ₹60", () => {
    const lines = [samosa, chai];
    const best = bestOffer([happy, bxgy, bill10], lines, [0, 0], mode)!;
    expect(best.offer.id).toBe(bxgy.id);
    expect(best.saving).toBe(1500);
    expect(best.lineDiscounts).toEqual([0, 1500]);
  });
  it("picks the bill discount when it saves more", () => {
    const big = offer({ type: "BILL_DISCOUNT", name: "₹50 off", config: { discountType: "FLAT", value: 5000, minOrder: 0 } });
    const best = bestOffer([happy, bxgy, big], [line("samosa", 3000, 4), chai], [0, 0], mode)!;
    expect(best.offer.id).toBe(big.id);
    expect(best.lineDiscounts).toBeUndefined();
  });
  it("ties go to the higher priority", () => {
    const a = offer({ type: "ITEM_DISCOUNT", name: "A", priority: 1, config: { discountType: "FLAT", value: 500 } });
    const b = offer({ type: "ITEM_DISCOUNT", name: "B", priority: 9, config: { discountType: "FLAT", value: 500 } });
    expect(bestOffer([a, b], [chai], [0], mode)!.offer.id).toBe(b.id);
  });
  it("no offer when nothing qualifies", () => {
    expect(bestOffer([bxgy], [line("samosa", 3000, 1)], [0], mode)).toBeNull();
  });
});
