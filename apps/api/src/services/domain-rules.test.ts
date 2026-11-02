/**
 * Phase 4 unit tests for the pure business rules in the API services:
 * delivery dispatch (decision table), geofence boundary, weighted-average cost,
 * offer engine optimality/safety (property-based), loyalty monotonicity and the
 * Buy-X-Get-Y free-item suggestion.
 */
import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import { loyaltyConfigSchema } from "@canavo/shared";

vi.mock("../db", () => ({ prisma: {}, platformPrisma: {} }));

import { partnerStatus, rankAvailablePartners } from "./delivery-assign";
import { withinGeofence } from "./attendance";
import { weightedAverageCost } from "./inventory";
import {
  bestOffer, couponAmount, couponError, evaluateLineOffers, pointsToEarn, redeemPoints, suggestFreeItems, tierForSpend,
  type EngineCoupon, type EngineLine, type EngineOffer, type TaxMode,
} from "./offer-engine";

const RUNS = Number(process.env.PBT_RUNS ?? 1000);

// ---------------------------------------------------------------------------
describe("delivery dispatch rule — decision table (UT-DEL)", () => {
  // onDuty | atOutlet | outForDelivery | active | max → available? reason
  it.each([
    [false, true, 0, 0, 2, false, "Not clocked in"],
    [false, false, 1, 1, 2, false, "Not clocked in"], // not on duty wins over everything
    [true, true, 0, 0, 2, true, null],
    [true, true, 0, 1, 2, true, null], // one order, at outlet → can take a second (trip of two)
    [true, true, 0, 2, 2, false, "Has 2 of 2 orders"], // limit reached
    [true, true, 0, 3, 2, false, "Has 3 of 2 orders"], // over limit (manager override) stays blocked
    [true, true, 1, 1, 2, false, "Out for delivery"], // picked up → on a run
    [true, false, 0, 0, 2, false, "Returning to the outlet"], // delivered all, not back yet
    [true, false, 1, 2, 2, false, "Out for delivery"],
    [true, true, 0, 0, 1, true, null],
    [true, true, 0, 1, 1, false, "Has 1 of 1 orders"], // N = 1
  ])("UT-DEL-%# onDuty=%s atOutlet=%s out=%i active=%i max=%i → available=%s (%s)", (onDuty, atOutlet, outForDelivery, active, max, available, reason) => {
    const s = partnerStatus({ onDuty, atOutlet, outForDelivery, active, max });
    expect(s.reason === null).toBe(available);
    expect(s.reason).toBe(reason);
    expect(s.onRun).toBe(!atOutlet || outForDelivery > 0);
  });

  it("UT-DEL-020 ranking fills a partner who already has an order, then longest-waiting", () => {
    const t = (iso: string | null) => (iso ? new Date(iso) : null);
    const ps = [
      { id: "a", available: true, active: 0, lastAssignedAt: t("2026-11-02T10:00:00Z") },
      { id: "b", available: true, active: 1, lastAssignedAt: t("2026-11-02T11:00:00Z") },
      { id: "c", available: false, active: 1, lastAssignedAt: null },
      { id: "d", available: true, active: 0, lastAssignedAt: null }, // never assigned = waited longest
      { id: "e", available: true, active: 1, lastAssignedAt: t("2026-11-02T09:00:00Z") },
    ];
    expect(rankAvailablePartners(ps).map((p) => p.id)).toEqual(["e", "b", "d", "a"]);
    expect(rankAvailablePartners([])).toEqual([]);
  });

  it("PBT-DEL-001 a partner at or over the limit, on a run, or off duty is never offered an order", () => {
    fc.assert(
      fc.property(fc.boolean(), fc.boolean(), fc.nat(3), fc.nat(5), fc.integer({ min: 1, max: 5 }), (onDuty, atOutlet, out, active, max) => {
        const available = partnerStatus({ onDuty, atOutlet, outForDelivery: out, active, max }).reason === null;
        if (available) expect(onDuty && atOutlet && out === 0 && active < max).toBe(true);
      }),
      { numRuns: RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
describe("geofence (UT-ATT-GEO)", () => {
  it.each([
    // distance, radius, accuracy → inside?
    [149, 150, undefined, true], // inside
    [150, 150, undefined, true], // exactly on the boundary counts as inside
    [151, 150, undefined, false], // 1 m outside
    [151, 150, 1, true], // reported accuracy widens the fence
    [250, 150, 100, true], // allowance capped at 100 m …
    [251, 150, 500, false], // … even if the phone claims 500 m accuracy
    [0, 0, undefined, true],
    [1, 0, 0, false],
  ])("UT-ATT-GEO-%# %im from a %im fence (accuracy %s) → %s", (d, r, acc, inside) => {
    expect(withinGeofence(d, r, acc)).toBe(inside);
  });
});

// ---------------------------------------------------------------------------
describe("weighted-average cost (PBT-INV)", () => {
  it("PBT-INV-001 new cost lies between the old and purchase cost; zero/negative stock takes the purchase cost", () => {
    fc.assert(
      fc.property(fc.integer({ min: -1000, max: 100_000 }), fc.integer({ min: 0, max: 1_000_000 }), fc.integer({ min: 0, max: 100_000 }), fc.integer({ min: 0, max: 1_000_000 }), (eq, ec, aq, ac) => {
        const c = weightedAverageCost(eq, ec, aq, ac);
        expect(Number.isInteger(c)).toBe(true);
        if (aq <= 0) {
          expect(c).toBe(ec);
          return;
        }
        if (eq <= 0) {
          expect(c).toBe(ac);
          return;
        }
        expect(c).toBeGreaterThanOrEqual(Math.min(ec, ac));
        expect(c).toBeLessThanOrEqual(Math.max(ec, ac));
      }),
      { numRuns: RUNS },
    );
  });

  it("UT-INV-WAC-001 hand example: 10 kg @ ₹40 + 30 kg @ ₹60 → ₹55/kg", () => {
    expect(weightedAverageCost(10, 4000, 30, 6000)).toBe(5500);
    expect(weightedAverageCost(-5, 4000, 30, 6000)).toBe(6000); // negative stock ignored
  });
});

// ---------------------------------------------------------------------------
let seq = 0;
const offer = (p: Partial<EngineOffer> & Pick<EngineOffer, "type" | "config">): EngineOffer => ({
  id: `o${++seq}`, name: p.type, active: true, outletIds: [], startsAt: null, endsAt: null, daysOfWeek: [], startTime: null, endTime: null, priority: 0, ...p,
});
const EXCL: TaxMode = { pricesIncludeTax: false, compositionScheme: false };

const arbLine: fc.Arbitrary<EngineLine> = fc.record({
  menuItemId: fc.constantFrom("chai", "samosa", "dosa", "idli"),
  categoryIds: fc.constantFrom(["cat-bev"], ["cat-snacks"], ["cat-meals"]),
  unitPrice: fc.integer({ min: 0, max: 30_000 }),
  quantity: fc.integer({ min: 1, max: 10 }),
  manualDiscount: fc.integer({ min: 0, max: 5_000 }),
});
const arbOffer: fc.Arbitrary<EngineOffer> = fc.oneof(
  fc.record({ v: fc.integer({ min: 1, max: 100 }), cat: fc.constantFrom("cat-bev", "cat-snacks"), pr: fc.integer({ min: -5, max: 5 }) })
    .map(({ v, cat, pr }) => offer({ type: "ITEM_DISCOUNT", priority: pr, config: { target: { categoryIds: [cat] }, discountType: "PERCENT", value: v } })),
  fc.record({ v: fc.integer({ min: 1, max: 5_000 }), pr: fc.integer({ min: -5, max: 5 }) })
    .map(({ v, pr }) => offer({ type: "ITEM_DISCOUNT", priority: pr, config: { target: { menuItemIds: ["dosa"] }, discountType: "FLAT", value: v } })),
  fc.record({ b: fc.integer({ min: 1, max: 3 }), pr: fc.integer({ min: -5, max: 5 }) })
    .map(({ b, pr }) => offer({ type: "BUY_X_GET_Y", priority: pr, config: { buy: { menuItemIds: ["samosa"], quantity: b }, get: { menuItemIds: ["chai"], quantity: 1 } } })),
  fc.record({ min: fc.integer({ min: 0, max: 50_000 }), v: fc.integer({ min: 1, max: 50 }), pr: fc.integer({ min: -5, max: 5 }) })
    .map(({ min, v, pr }) => offer({ type: "BILL_DISCOUNT", priority: pr, config: { minOrder: min, discountType: "PERCENT", value: v } })),
  fc.record({ price: fc.integer({ min: 0, max: 20_000 }), pr: fc.integer({ min: -5, max: 5 }) })
    .map(({ price, pr }) => offer({ type: "COMBO", priority: pr, config: { items: [{ menuItemId: "dosa", quantity: 1 }, { menuItemId: "chai", quantity: 1 }], price } })),
);

describe("offer engine — properties (PBT-OFF)", () => {
  const cart = fc.tuple(fc.array(arbLine, { minLength: 1, maxLength: 6 }), fc.array(arbOffer, { maxLength: 6 }), fc.constantFrom(0, 5, 18));

  it("PBT-OFF-001 one offer per bill: bestOffer saves at least as much as any single offer, and wins ties by priority", () => {
    fc.assert(
      fc.property(cart, ([lines, offers, rate]) => {
        const rates = lines.map(() => rate);
        const best = bestOffer(offers, lines, rates, EXCL);
        for (const o of offers) {
          const solo = bestOffer([o], lines, rates, EXCL);
          if (!solo) continue;
          expect(best).not.toBeNull();
          expect(best!.saving).toBeGreaterThanOrEqual(solo.saving);
          if (solo.saving === best!.saving) expect(best!.offer.priority).toBeGreaterThanOrEqual(o.priority);
        }
        if (!best) for (const o of offers) expect(bestOffer([o], lines, rates, EXCL)).toBeNull();
      }),
      { numRuns: RUNS },
    );
  });

  it("PBT-OFF-002 line offers never discount a line below zero (after the manual discount) and never go negative", () => {
    fc.assert(
      fc.property(cart, ([lines, offers]) => {
        const r = evaluateLineOffers(offers, lines);
        r.lineDiscounts.forEach((d, i) => {
          expect(Number.isInteger(d) && d >= 0).toBe(true);
          expect(d).toBeLessThanOrEqual(Math.max(0, lines[i].unitPrice * lines[i].quantity - lines[i].manualDiscount));
        });
      }),
      { numRuns: RUNS },
    );
  });

  it("PBT-OFF-003 the saving never exceeds the bill; adding an offer that can't apply changes nothing", () => {
    const dead = offer({ type: "ITEM_DISCOUNT", priority: 99, config: { target: { menuItemIds: ["not-on-menu"] }, discountType: "PERCENT", value: 100 } });
    fc.assert(
      fc.property(cart, ([lines, offers, rate]) => {
        const rates = lines.map(() => rate);
        const a = bestOffer(offers, lines, rates, EXCL);
        const b = bestOffer([...offers, dead], lines, rates, EXCL);
        expect(b?.saving ?? 0).toBe(a?.saving ?? 0);
        const bill = lines.reduce((s, l) => s + Math.max(0, l.unitPrice * l.quantity - l.manualDiscount), 0);
        expect(a?.saving ?? 0).toBeLessThanOrEqual(bill);
      }),
      { numRuns: RUNS },
    );
  });

  it("PBT-OFF-004 coupon amount is within [0, base] and respects maxDiscount", () => {
    fc.assert(
      fc.property(fc.constantFrom("FLAT" as const, "PERCENT" as const), fc.integer({ min: 1, max: 100 }), fc.option(fc.integer({ min: 0, max: 10_000 }), { nil: null }), fc.integer({ min: 0, max: 1_000_000 }), (t, v, max, base) => {
        const a = couponAmount({ discountType: t, value: t === "FLAT" ? v * 100 : v, maxDiscount: max }, base);
        expect(a).toBeGreaterThanOrEqual(0);
        expect(a).toBeLessThanOrEqual(base);
        if (max !== null) expect(a).toBeLessThanOrEqual(max);
      }),
      { numRuns: RUNS },
    );
  });
});

describe("coupons — boundary values (UT-CPN)", () => {
  const at = new Date("2026-11-02T10:00:00Z");
  const c = (p: Partial<EngineCoupon> = {}): EngineCoupon => ({
    code: "FEST10", discountType: "PERCENT", value: 10, maxDiscount: null, minOrder: 0, usageLimit: null, perCustomerLimit: null,
    usedCount: 0, startsAt: null, expiresAt: null, active: true, ...p,
  });
  const ctx = { at, subtotal: 10_000, hasCustomer: true, customerUses: 0 };
  it("UT-CPN-001 expiry is exclusive: valid until the instant before expiresAt", () => {
    expect(couponError(c({ expiresAt: new Date(at.getTime() + 1) }), ctx)).toBeNull();
    expect(couponError(c({ expiresAt: at }), ctx)).toMatch(/expired/);
    expect(couponError(c({ startsAt: at }), ctx)).toBeNull();
    expect(couponError(c({ startsAt: new Date(at.getTime() + 1) }), ctx)).toMatch(/not valid yet/);
  });
  it("UT-CPN-002 usage limit: N-1 used → OK, N used → refused; per-customer limit needs a phone", () => {
    expect(couponError(c({ usageLimit: 5, usedCount: 4 }), ctx)).toBeNull();
    expect(couponError(c({ usageLimit: 5, usedCount: 5 }), ctx)).toMatch(/usage limit/);
    expect(couponError(c({ perCustomerLimit: 1 }), { ...ctx, hasCustomer: false })).toMatch(/phone/);
    expect(couponError(c({ perCustomerLimit: 1 }), { ...ctx, customerUses: 1 })).toMatch(/already used/);
  });
  it("UT-CPN-003 minimum order is inclusive; personal coupons belong to one customer", () => {
    expect(couponError(c({ minOrder: 10_000 }), ctx)).toBeNull();
    expect(couponError(c({ minOrder: 10_001 }), ctx)).toMatch(/minimum order/);
    expect(couponError(c({ customerId: "cust-1" }), { ...ctx, customerId: "cust-2" })).toMatch(/different customer/);
    expect(couponError(c({ active: false }), ctx)).toMatch(/not active/);
    expect(couponError(null, ctx)).toBe("Invalid coupon code");
  });
});

describe("loyalty — monotonic and capped (PBT-LOY)", () => {
  const cfg = loyaltyConfigSchema.parse({});
  it("PBT-LOY-001 more spend never lowers the tier; a bigger bill never earns fewer points; higher tiers earn at least as much", () => {
    const order = ["BRONZE", "SILVER", "GOLD", "PLATINUM"];
    fc.assert(
      fc.property(fc.nat(10_000_000), fc.nat(10_000_000), (x, y) => {
        const [lo, hi] = x <= y ? [x, y] : [y, x];
        expect(order.indexOf(tierForSpend(hi, cfg))).toBeGreaterThanOrEqual(order.indexOf(tierForSpend(lo, cfg)));
        for (const t of order as ("BRONZE" | "SILVER" | "GOLD" | "PLATINUM")[]) expect(pointsToEarn(hi, t, cfg)).toBeGreaterThanOrEqual(pointsToEarn(lo, t, cfg));
        expect(pointsToEarn(hi, "PLATINUM", cfg)).toBeGreaterThanOrEqual(pointsToEarn(hi, "BRONZE", cfg));
      }),
      { numRuns: RUNS },
    );
  });
  it("UT-LOY-001 tier thresholds are inclusive", () => {
    expect(tierForSpend(499_999, cfg)).toBe("BRONZE");
    expect(tierForSpend(500_000, cfg)).toBe("SILVER");
    expect(tierForSpend(1_500_000, cfg)).toBe("GOLD");
    expect(tierForSpend(4_000_000, cfg)).toBe("PLATINUM");
  });
  it("PBT-LOY-002 redeemed value ≤ balance × point value and ≤ maxRedeemPercent of the bill", () => {
    fc.assert(
      fc.property(fc.nat(100_000), fc.nat(100_000), fc.nat(5_000_000), (balance, requested, remaining) => {
        const r = redeemPoints(cfg, { balance, requested, remaining });
        if (!r.ok) return;
        expect(r.points).toBeLessThanOrEqual(Math.min(balance, requested));
        expect(r.points).toBeGreaterThanOrEqual(cfg.minRedeemPoints);
        expect(r.value).toBe(r.points * cfg.pointValuePaise);
        expect(r.value).toBeLessThanOrEqual(Math.floor((remaining * cfg.maxRedeemPercent) / 100));
      }),
      { numRuns: RUNS },
    );
  });
});

describe("Buy X Get Y free-item suggestion (UT-BXGY)", () => {
  const bxgy = offer({ type: "BUY_X_GET_Y", config: { buy: { menuItemIds: ["samosa"], quantity: 2 }, get: { menuItemIds: ["chai"], quantity: 1 } } });
  const l = (id: string, q: number): EngineLine => ({ menuItemId: id, categoryIds: ["c"], unitPrice: 1500, quantity: q, manualDiscount: 0 });
  it("UT-BXGY-001 suggests the missing free item per completed set, nothing when already in the cart", () => {
    expect(suggestFreeItems([bxgy], [l("samosa", 2)]).map((s) => s.quantity)).toEqual([1]);
    expect(suggestFreeItems([bxgy], [l("samosa", 5)]).map((s) => s.quantity)).toEqual([2]);
    expect(suggestFreeItems([bxgy], [l("samosa", 4), l("chai", 2)])).toEqual([]);
    expect(suggestFreeItems([bxgy], [l("samosa", 1)])).toEqual([]);
  });
  it("UT-BXGY-002 skips category 'get' targets, same buy/get item, invalid config and other offer types; honours maxSets", () => {
    const cat = offer({ type: "BUY_X_GET_Y", config: { buy: { menuItemIds: ["samosa"], quantity: 1 }, get: { categoryIds: ["bev"], quantity: 1 } } });
    const same = offer({ type: "BUY_X_GET_Y", config: { buy: { menuItemIds: ["chai"], quantity: 2 }, get: { menuItemIds: ["chai"], quantity: 1 } } });
    const bad = offer({ type: "BUY_X_GET_Y", config: { buy: {} } });
    const capped = offer({ type: "BUY_X_GET_Y", config: { buy: { menuItemIds: ["samosa"], quantity: 1 }, get: { menuItemIds: ["chai"], quantity: 1 }, maxSets: 2 } });
    expect(suggestFreeItems([cat, same, bad], [l("samosa", 3), l("chai", 3)])).toEqual([]);
    expect(suggestFreeItems([capped], [l("samosa", 5)]).map((s) => s.quantity)).toEqual([2]);
    expect(suggestFreeItems([offer({ type: "COMBO", config: {} })], [l("samosa", 5)])).toEqual([]);
  });
});
