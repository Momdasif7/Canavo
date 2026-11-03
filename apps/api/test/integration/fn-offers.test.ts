/**
 * QA Phase 5 — group B — Offers & coupons: CRUD per type, validation, toggle,
 * /offers/active, coupon validate, POS preview == charged bill, one offer per
 * bill (coupon wins an exact tie), BXGY suggestions, happy-hour windows,
 * usage limits incl. release on cancel, OFFERS module off.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { as, bill, bind, db, hhmm, istMinutes, line, mkCategory, mkItem, outletAgent, pay, phone, preview, tenant, uid } from "./fx-b";

let T: Awaited<ReturnType<typeof tenant>>;
let token: string;
let catId: string;
let A: string; // ₹200
let B: string; // ₹100
let C: string; // ₹50

beforeAll(async () => {
  T = await tenant(); // no tax rates → 0% GST, so pre-tax == menu price
  token = (await T.owner()).token;
  catId = (await mkCategory(T.business.id, "Mains")).id;
  A = (await mkItem(T.business.id, catId, 20000, { name: "Thali" })).id;
  B = (await mkItem(T.business.id, catId, 10000, { name: "Lassi" })).id;
  C = (await mkItem(T.business.id, catId, 5000, { name: "Papad" })).id;
});

/** Offers are scoped to a fresh outlet so tests never see each other's offers. */
async function scope() {
  const { outletId, agent } = await outletAgent(T.business.id, token);
  const offer = (body: Record<string, unknown>) => agent.post("/offers", { outletIds: [outletId], ...body });
  return { outletId, agent, offer };
}
const coupon = (body: Record<string, unknown>) => bind(token, T.outlet.id).post("/offers/coupons", { code: `C${uid()}`.toUpperCase(), ...body });
const itemOff = (pct: number, ids = [A]) => ({ name: `Item ${pct}%`, type: "ITEM_DISCOUNT", config: { target: { menuItemIds: ids }, discountType: "PERCENT", value: pct } });
const billOff = (flat: number, extra: Record<string, unknown> = {}) => ({ name: `Bill ₹${flat / 100}`, type: "BILL_DISCOUNT", config: { discountType: "FLAT", value: flat, minOrder: 0, ...extra } });

/** Preview and real bill for the same cart; asserts they agree and returns both. */
async function previewEqualsBill(agent: ReturnType<typeof bind>, items: object[], extra: Record<string, unknown> = {}) {
  const p = await preview(agent, items, extra);
  expect(p.status, JSON.stringify(p.body)).toBe(200);
  const o = await bill(agent, items, extra);
  expect(o.status, JSON.stringify(o.body)).toBe(201);
  expect(o.body.grandTotal).toBe(p.body.bill.grandTotal);
  expect(o.body.discount).toBe(p.body.bill.discount);
  expect(o.body.promoDiscount).toBe(p.body.promoDiscount);
  expect(o.body.couponCode ?? null).toBe(p.body.couponCode);
  return { p: p.body, o: o.body };
}

describe("Offer CRUD & validation @regression", () => {
  const valid = () => [
    { name: "Combo meal", type: "COMBO", config: { items: [{ menuItemId: A, quantity: 1 }, { menuItemId: B, quantity: 1 }], price: 25000 } },
    { name: "Happy hour", type: "HAPPY_HOUR", startTime: "16:00", endTime: "19:00", config: { target: { categoryIds: [catId] }, discountType: "PERCENT", value: 20 } },
    { name: "B1G1", type: "BUY_X_GET_Y", config: { buy: { menuItemIds: [A], quantity: 1 }, get: { menuItemIds: [B], quantity: 1 } } },
    { name: "Item flat", type: "ITEM_DISCOUNT", config: { target: {}, discountType: "FLAT", value: 500 } },
    { name: "Bill 10%", type: "BILL_DISCOUNT", config: { discountType: "PERCENT", value: 10, minOrder: 30000, maxDiscount: 5000 } },
  ];

  it("IT-OFF-001 every offer type can be created, read with a summary and listed @regression", async () => {
    const { agent, offer } = await scope();
    for (const body of valid()) {
      const res = await offer(body);
      expect(res.status, body.type).toBe(201);
      const got = await agent.get(`/offers/${res.body.id}`);
      expect(got.status).toBe(200);
      expect(typeof got.body.summary).toBe("string");
    }
    const list = await agent.get("/offers?type=COMBO");
    expect(list.status).toBe(200);
    expect(list.body.every((o: { type: string }) => o.type === "COMBO")).toBe(true);
    const combo = list.body.find((o: { name: string }) => o.name === "Combo meal");
    expect(combo.summary).toContain("Thali + Lassi for");
  });

  it("IT-OFF-002 invalid offer configs → 400 @regression", async () => {
    const { offer } = await scope();
    const bad: Record<string, unknown>[] = [
      { name: "x", type: "BILL_DISCOUNT", config: { discountType: "FLAT", value: 100 } }, // name < 2
      { name: "Bad type", type: "FREEBIE", config: {} },
      { name: "Pct 150", type: "ITEM_DISCOUNT", config: { discountType: "PERCENT", value: 150 } },
      { name: "Zero val", type: "BILL_DISCOUNT", config: { discountType: "FLAT", value: 0 } },
      { name: "Neg min", type: "BILL_DISCOUNT", config: { discountType: "FLAT", value: 100, minOrder: -1 } },
      { name: "BXGY q0", type: "BUY_X_GET_Y", config: { buy: { quantity: 0 }, get: { quantity: 1 } } },
      { name: "BXGY q51", type: "BUY_X_GET_Y", config: { buy: { quantity: 51 }, get: { quantity: 1 } } },
      { name: "Combo empty", type: "COMBO", config: { items: [], price: 100 } },
      { name: "Combo no price", type: "COMBO", config: { items: [{ menuItemId: A, quantity: 1 }] } },
      { name: "Half window", type: "HAPPY_HOUR", startTime: "16:00", config: { discountType: "PERCENT", value: 10 } },
      { name: "Bad time", type: "HAPPY_HOUR", startTime: "24:00", endTime: "25:00", config: { discountType: "PERCENT", value: 10 } },
      { name: "Ends before", type: "BILL_DISCOUNT", startsAt: "2026-12-02T00:00:00.000Z", endsAt: "2026-12-01T00:00:00.000Z", config: { discountType: "FLAT", value: 100 } },
      { name: "Bad dow", type: "BILL_DISCOUNT", daysOfWeek: [7], config: { discountType: "FLAT", value: 100 } },
    ];
    for (const b of bad) expect((await offer(b)).status, JSON.stringify(b)).toBe(400);
  });

  it("IT-OFF-003 PATCH validates config against the stored type; one-sided time window → 400 @regression", async () => {
    const { agent, offer } = await scope();
    const o = await offer(billOff(1000));
    expect((await agent.patch(`/offers/${o.body.id}`, { config: { items: [{ menuItemId: A, quantity: 1 }], price: 1 } })).status).toBe(400);
    expect((await agent.patch(`/offers/${o.body.id}`, { startTime: "10:00" })).status).toBe(400);
    const ok = await agent.patch(`/offers/${o.body.id}`, { config: { discountType: "FLAT", value: 1500 }, priority: 5 });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ priority: 5, config: { value: 1500 } });
    expect((await agent.patch("/offers/nope", { priority: 1 })).status).toBe(404);
  });

  it("IT-OFF-004 toggle flips active; explicit {active:false} is idempotent; delete → 204 then 404 @regression", async () => {
    const { agent, offer } = await scope();
    const o = await offer(billOff(1000));
    expect((await agent.post(`/offers/${o.body.id}/toggle`)).body.active).toBe(false);
    expect((await agent.post(`/offers/${o.body.id}/toggle`)).body.active).toBe(true);
    expect((await agent.post(`/offers/${o.body.id}/toggle`, { active: false })).body.active).toBe(false);
    expect((await agent.post(`/offers/${o.body.id}/toggle`, { active: false })).body.active).toBe(false);
    expect((await agent.delete(`/offers/${o.body.id}`)).status).toBe(204);
    expect((await agent.get(`/offers/${o.body.id}`)).status).toBe(404);
  });

  it("IT-OFF-005 roles: cashier sees /offers/active but cannot manage; kitchen gets 403 @regression", async () => {
    const cashier = await T.cashier();
    expect((await cashier.get("/offers/active")).status).toBe(200);
    expect((await cashier.get("/offers")).status).toBe(403);
    expect((await cashier.post("/offers", billOff(100))).status).toBe(403);
    expect((await cashier.get("/offers/coupons")).status).toBe(403);
    expect((await cashier.post("/offers/coupons", { code: "HACK1", discountType: "FLAT", value: 100 })).status).toBe(403);
    expect((await (await T.kitchen()).get("/offers/active")).status).toBe(403);
  });

  it("IT-OFF-006 /offers/active lists only active, in-date, in-window offers for this outlet @regression", async () => {
    const { agent, outletId, offer } = await scope();
    const now = istMinutes();
    const live = await offer(billOff(100, {}));
    const off = await offer({ ...billOff(200), active: false });
    const past = await offer({ ...billOff(300), endsAt: new Date(Date.now() - 3600_000).toISOString() });
    const later = await offer({ ...billOff(400), startTime: hhmm(now + 120), endTime: hhmm(now + 180) });
    const elsewhere = await agent.post("/offers", { ...billOff(500), outletIds: [T.outlet.id] });
    const ids = (await agent.get("/offers/active")).body.offers.map((o: { id: string }) => o.id);
    expect(ids).toContain(live.body.id);
    for (const x of [off, past, later, elsewhere]) expect(ids).not.toContain(x.body.id);
    expect(outletId).toBeTruthy();
  });

  // Expected: a create without `config` is a validation error (400).
  // Actual: offerBase has config: z.unknown() and refineOffer skips the check when config is undefined,
  // so Prisma rejects the missing required Json column → 500 "Internal server error".
  it.fails("IT-OFF-008 (BUG-CANDIDATE-B7) offer without a config → 400, not 500 @regression", async () => {
    const { offer } = await scope();
    const res = await offer({ name: "No config", type: "COMBO" });
    expect(res.status).toBe(400);
  });

  // TEN-004: writes must not reference another business's IDs. Expected 400 for a COMBO naming a
  // foreign menu item / an offer targeting a foreign outlet. Actual: 201, the foreign ids are stored as-is.
  it.fails("IT-OFF-007 (BUG-CANDIDATE-B6) offer config / outletIds referencing another business's item or outlet → 400 @regression", async () => {
    const other = await tenant();
    const oc = await mkCategory(other.business.id);
    const foreignItem = await mkItem(other.business.id, oc.id, 100);
    const { agent } = await scope();
    const r1 = await agent.post("/offers", { name: "Foreign combo", type: "COMBO", config: { items: [{ menuItemId: foreignItem.id, quantity: 1 }], price: 1 } });
    const r2 = await agent.post("/offers", { ...billOff(100), outletIds: [other.outlet.id] });
    expect(r1.status).toBe(400);
    expect(r2.status).toBe(400);
  });
});

describe("Coupon CRUD & validate @regression", () => {
  it("IT-OFF-010 coupon create (FLAT / PERCENT), duplicate code (any case) → 409, bad values → 400 @regression", async () => {
    const code = `DUP${uid()}`.toUpperCase();
    expect((await coupon({ code, discountType: "FLAT", value: 5000 })).status).toBe(201);
    expect((await coupon({ code: code.toLowerCase(), discountType: "FLAT", value: 5000 })).status).toBe(409);
    expect((await coupon({ discountType: "PERCENT", value: 100 })).status).toBe(201);
    for (const b of [
      { discountType: "PERCENT", value: 101 }, { discountType: "FLAT", value: 0 }, { discountType: "FLAT", value: 10.5 },
      { code: "AB", discountType: "FLAT", value: 1 }, { code: "BAD CODE!", discountType: "FLAT", value: 1 },
      { discountType: "FLAT", value: 1, usageLimit: 0 }, { discountType: "FLAT", value: 1, minOrder: -1 }, { discountType: "BOGO", value: 1 },
    ]) expect((await coupon(b)).status, JSON.stringify(b)).toBe(400);
  });

  it("IT-OFF-011 coupon PATCH: switching to PERCENT with value > 100 → 400; rename to existing code → 409; GET / search @regression", async () => {
    const agent = bind(token, T.outlet.id);
    const a = await coupon({ discountType: "FLAT", value: 5000 });
    const b = await coupon({ discountType: "FLAT", value: 100 });
    expect((await agent.patch(`/offers/coupons/${a.body.id}`, { discountType: "PERCENT" })).status).toBe(400);
    expect((await agent.patch(`/offers/coupons/${a.body.id}`, { code: b.body.code })).status).toBe(409);
    const ok = await agent.patch(`/offers/coupons/${a.body.id}`, { value: 6000, usageLimit: 3 });
    expect(ok.body).toMatchObject({ value: 6000, usageLimit: 3 });
    expect((await agent.get(`/offers/coupons/${a.body.id}`)).body.code).toBe(a.body.code);
    const found = await agent.get(`/offers/coupons?search=${a.body.code.toLowerCase()}`);
    expect(found.body.map((c: { id: string }) => c.id)).toContain(a.body.id);
  });

  it("IT-OFF-012 POST /offers/coupons/validate: valid FLAT/PERCENT (capped) return estimatedDiscount @critical @regression", async () => {
    const agent = await T.cashier();
    const f = await coupon({ discountType: "FLAT", value: 5000, minOrder: 20000 });
    const p = await coupon({ discountType: "PERCENT", value: 10, maxDiscount: 7500 });
    const v1 = await agent.post("/offers/coupons/validate", { code: f.body.code.toLowerCase(), subtotal: 20000 });
    expect(v1.status).toBe(200);
    expect(v1.body).toMatchObject({ valid: true, estimatedDiscount: 5000 });
    expect((await agent.post("/offers/coupons/validate", { code: p.body.code, subtotal: 50000 })).body.estimatedDiscount).toBe(5000);
    expect((await agent.post("/offers/coupons/validate", { code: p.body.code, subtotal: 100000 })).body.estimatedDiscount).toBe(7500);
    // FLAT never exceeds the subtotal
    const big = await coupon({ discountType: "FLAT", value: 99999 });
    expect((await agent.post("/offers/coupons/validate", { code: big.body.code, subtotal: 1000 })).body.estimatedDiscount).toBe(1000);
  });

  it("IT-OFF-013 validate decision table: unknown / inactive / expired / not started / below min order / limit reached → 400 @regression", async () => {
    const agent = await T.cashier();
    const hour = 3600_000;
    const cases: [Record<string, unknown> | null, number, RegExp][] = [
      [null, 10000, /Invalid coupon/],
      [{ active: false }, 10000, /not active/],
      [{ expiresAt: new Date(Date.now() - hour).toISOString() }, 10000, /expired/],
      [{ startsAt: new Date(Date.now() + hour).toISOString() }, 10000, /not valid yet/],
      [{ minOrder: 20000 }, 19999, /minimum order/],
      [{ perCustomerLimit: 1 }, 10000, /phone/],
    ];
    for (const [extra, subtotal, msg] of cases) {
      const code = extra ? (await coupon({ discountType: "FLAT", value: 100, ...extra })).body.code : "NOSUCHCODE";
      const res = await agent.post("/offers/coupons/validate", { code, subtotal });
      expect(res.status, String(msg)).toBe(400);
      expect(res.body.error).toMatch(msg);
    }
    const lim = await coupon({ discountType: "FLAT", value: 100, usageLimit: 2 });
    await db.coupon.update({ where: { id: lim.body.id }, data: { usedCount: 2 } });
    expect((await agent.post("/offers/coupons/validate", { code: lim.body.code, subtotal: 10000 })).body.error).toMatch(/usage limit/);
    // BVA: subtotal exactly minOrder is valid
    const mo = await coupon({ discountType: "FLAT", value: 100, minOrder: 20000 });
    expect((await agent.post("/offers/coupons/validate", { code: mo.body.code, subtotal: 20000 })).status).toBe(200);
  });

  it("IT-OFF-014 deleting an unused coupon → 204; a used coupon is only deactivated (history kept) @regression", async () => {
    const { agent } = await scope();
    const unused = await coupon({ discountType: "FLAT", value: 100 });
    expect((await agent.delete(`/offers/coupons/${unused.body.id}`)).status).toBe(204);
    const used = await coupon({ discountType: "FLAT", value: 100 });
    expect((await bill(agent, [line(A)], { couponCode: used.body.code })).status).toBe(201);
    const del = await agent.delete(`/offers/coupons/${used.body.id}`);
    expect(del.body).toEqual({ deleted: false, deactivated: true });
    expect((await db.coupon.findUniqueOrThrow({ where: { id: used.body.id } })).active).toBe(false);
  });
});

describe("POS preview equals the charged bill; one offer per bill @critical @regression", () => {
  it("IT-OFF-020 item offer alone: preview == bill, 10% off Thali @critical @regression", async () => {
    const { agent, offer } = await scope();
    await offer(itemOff(10));
    const { o } = await previewEqualsBill(agent, [line(A), line(B)]);
    expect(o.promoDiscount).toBe(2000);
    expect(o.grandTotal).toBe(28000);
  });

  it("IT-OFF-021 coupon alone: preview == bill and usedCount increments once @critical @regression", async () => {
    const { agent } = await scope();
    const c = await coupon({ discountType: "FLAT", value: 3000 });
    const { o, p } = await previewEqualsBill(agent, [line(A)], { couponCode: c.body.code });
    expect(p.applied).toEqual([expect.objectContaining({ kind: "COUPON", amount: 3000 })]);
    expect(o.grandTotal).toBe(17000);
    expect((await db.coupon.findUniqueOrThrow({ where: { id: c.body.id } })).usedCount).toBe(1);
    // the preview itself never consumes the coupon; paying doesn't count it again
    await pay(agent, o.id, o.grandTotal);
    expect((await db.coupon.findUniqueOrThrow({ where: { id: c.body.id } })).usedCount).toBe(1);
    expect(await db.couponRedemption.count({ where: { couponId: c.body.id } })).toBe(1);
  });

  it("IT-OFF-022 offer saves more than the coupon → offer applied, coupon not used (warning in preview) @critical @regression", async () => {
    const { agent, offer } = await scope();
    await offer(billOff(2500));
    const c = await coupon({ discountType: "FLAT", value: 2000 });
    const { o, p } = await previewEqualsBill(agent, [line(A)], { couponCode: c.body.code });
    expect(p.applied.map((x: { kind: string }) => x.kind)).toEqual(["OFFER"]);
    expect(p.warnings.join()).toMatch(/not applied/);
    expect(o.promoDiscount).toBe(2500);
    expect(o.couponCode).toBeNull();
    expect((await db.coupon.findUniqueOrThrow({ where: { id: c.body.id } })).usedCount).toBe(0);
  });

  it("IT-OFF-023 coupon saves more than the offer → only the coupon applies @critical @regression", async () => {
    const { agent, offer } = await scope();
    await offer(itemOff(10)); // 2000
    const c = await coupon({ discountType: "FLAT", value: 2001 });
    const { o, p } = await previewEqualsBill(agent, [line(A)], { couponCode: c.body.code });
    expect(p.applied.map((x: { kind: string }) => x.kind)).toEqual(["COUPON"]);
    expect(o.promoDiscount).toBe(2001);
  });

  it("IT-OFF-024 exact tie (offer ₹20 vs coupon ₹20) → the COUPON wins, in preview and bill @critical @regression", async () => {
    const { agent, offer } = await scope();
    await offer({ ...itemOff(10), priority: 100 }); // 10% of ₹200 = ₹20, even with top priority
    const c = await coupon({ discountType: "FLAT", value: 2000 });
    const { o, p } = await previewEqualsBill(agent, [line(A)], { couponCode: c.body.code });
    expect(p.applied).toEqual([expect.objectContaining({ kind: "COUPON", amount: 2000 })]);
    expect(o.couponCode).toBe(c.body.code);
    expect(o.appliedOffers).toEqual([expect.objectContaining({ kind: "COUPON" })]);
    expect((await db.coupon.findUniqueOrThrow({ where: { id: c.body.id } })).usedCount).toBe(1);
  });

  it("IT-OFF-025 two offers: only the bigger saving applies (no stacking) @critical @regression", async () => {
    const { agent, offer } = await scope();
    await offer(itemOff(10)); // 2000
    await offer(billOff(3000));
    const { o, p } = await previewEqualsBill(agent, [line(A), line(B)]);
    expect(p.applied).toHaveLength(1);
    expect(o.promoDiscount).toBe(3000);
  });

  it("IT-OFF-026 COMBO: Thali + Lassi for ₹250 saves ₹50, repeats per full set @critical @regression", async () => {
    const { agent, offer } = await scope();
    await offer({ name: "Combo", type: "COMBO", config: { items: [{ menuItemId: A, quantity: 1 }, { menuItemId: B, quantity: 1 }], price: 25000 } });
    expect((await previewEqualsBill(agent, [line(A, 2), line(B, 1)])).o.promoDiscount).toBe(5000);
    expect((await previewEqualsBill(agent, [line(A, 2), line(B, 2)])).o.promoDiscount).toBe(10000);
    expect((await previewEqualsBill(agent, [line(A, 1)])).o.promoDiscount).toBe(0);
  });

  it("IT-OFF-027 BUY_X_GET_Y: buy Thali get Lassi free; free item suggested when Lassi is missing @critical @regression", async () => {
    const { agent, offer } = await scope();
    const o = await offer({ name: "Thali + free Lassi", type: "BUY_X_GET_Y", config: { buy: { menuItemIds: [A], quantity: 1 }, get: { menuItemIds: [B], quantity: 1 } } });
    const p = await preview(agent, [line(A, 2)]);
    expect(p.body.suggestions).toEqual([expect.objectContaining({ offerId: o.body.id, menuItemId: B, quantity: 2, unitPrice: 10000 })]);
    const r = await previewEqualsBill(agent, [line(A, 2), line(B, 2)]);
    expect(r.o.promoDiscount).toBe(20000);
    expect(r.p.suggestions).toEqual([]);
  });

  it("IT-OFF-028 BXGY free item is NOT suggested when a bigger offer would win instead @critical @regression", async () => {
    const { agent, offer } = await scope();
    await offer({ name: "BXGY", type: "BUY_X_GET_Y", config: { buy: { menuItemIds: [A], quantity: 1 }, get: { menuItemIds: [B], quantity: 1 } } });
    await offer(billOff(15000)); // beats the ₹100 free Lassi
    const p = await preview(agent, [line(A)]);
    expect(p.status).toBe(200);
    expect(p.body.suggestions).toEqual([]);
    // and with Lassi added the bill offer is what's charged — Lassi is NOT free
    const { o } = await previewEqualsBill(agent, [line(A), line(B)]);
    expect(o.promoDiscount).toBe(15000);
    expect(o.appliedOffers).toEqual([expect.objectContaining({ kind: "OFFER", label: "Bill ₹150", amount: 15000 })]);
  });

  it("IT-OFF-029 happy hour applies inside its window and not outside (outlet time) @critical @regression", async () => {
    const now = istMinutes();
    const inside = await scope();
    await inside.offer({ name: "HH in", type: "HAPPY_HOUR", startTime: hhmm(now - 60), endTime: hhmm(now + 60), config: { target: {}, discountType: "PERCENT", value: 50 } });
    expect((await previewEqualsBill(inside.agent, [line(C)])).o.promoDiscount).toBe(2500);
    const outside = await scope();
    await outside.offer({ name: "HH out", type: "HAPPY_HOUR", startTime: hhmm(now + 120), endTime: hhmm(now + 180), config: { target: {}, discountType: "PERCENT", value: 50 } });
    expect((await previewEqualsBill(outside.agent, [line(C)])).o.promoDiscount).toBe(0);
  });

  it("IT-OFF-030 inactive / expired / future / other-weekday / other-outlet offers are not applied @regression", async () => {
    const { agent, offer } = await scope();
    const wd = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" })).getDay();
    await offer({ ...billOff(1000), active: false });
    await offer({ ...billOff(1100), endsAt: new Date(Date.now() - 60_000).toISOString() });
    await offer({ ...billOff(1200), startsAt: new Date(Date.now() + 3600_000).toISOString() });
    await offer({ ...billOff(1300), daysOfWeek: [(wd + 3) % 7] });
    await agent.post("/offers", { ...billOff(1400), outletIds: [T.outlet.id] });
    expect((await previewEqualsBill(agent, [line(A)])).o.promoDiscount).toBe(0);
    await offer({ ...billOff(900), daysOfWeek: [wd] });
    expect((await previewEqualsBill(agent, [line(A)])).o.promoDiscount).toBe(900);
  });

  it("IT-OFF-031 BILL_DISCOUNT minOrder BVA and maxDiscount cap @critical @regression", async () => {
    const { agent, offer } = await scope();
    await offer({ name: "10% over 250", type: "BILL_DISCOUNT", config: { discountType: "PERCENT", value: 10, minOrder: 25000, maxDiscount: 3000 } });
    expect((await previewEqualsBill(agent, [line(A), line(C)])).o.promoDiscount).toBe(2500); // exactly 25000
    expect((await previewEqualsBill(agent, [line(A), line(C, 1, { discount: 1 })])).o.promoDiscount).toBe(0); // 24999 after manual line discount
    expect((await previewEqualsBill(agent, [line(A, 3)])).o.promoDiscount).toBe(3000); // capped
  });

  it("IT-OFF-032 coupon on a 5% GST item (prices incl. tax): preview == bill, coupon reduces the pre-tax value @critical @regression", async () => {
    const { agent } = await scope();
    const taxed = await mkItem(T.business.id, catId, 21000, { gstRate: 5 });
    const c = await coupon({ discountType: "FLAT", value: 5000 });
    const { o } = await previewEqualsBill(agent, [line(taxed.id)], { couponCode: c.body.code });
    expect(o.discount).toBe(5000);
    expect(o.taxableValue).toBe(15000);
    expect(o.grandTotal).toBe(15800); // 150 + 5% = 157.50 → rounded to ₹158
  });

  it("IT-OFF-033 manual bill discount + offer: preview == bill @critical @regression", async () => {
    const { agent, offer } = await scope();
    await offer(itemOff(10));
    const { o } = await previewEqualsBill(agent, [line(A), line(B)], { discount: { type: "PERCENT", value: 5 } });
    // offer saving is measured after the cashier's 5%: 2000 × 0.95
    expect(o.promoDiscount).toBe(1900);
    expect(o.grandTotal).toBe(26600); // (30000 − 2000) × 0.95
  });
});

describe("Coupon usage limits on real bills @critical @regression", () => {
  it("IT-OFF-040 usageLimit 1: second bill refused; cancelling the first releases the use @critical @regression", async () => {
    const { agent } = await scope();
    const c = await coupon({ discountType: "FLAT", value: 1000, usageLimit: 1 });
    const first = await bill(agent, [line(A)], { couponCode: c.body.code });
    expect(first.status).toBe(201);
    const second = await bill(agent, [line(A)], { couponCode: c.body.code });
    expect(second.status).toBe(400);
    expect(second.body.error).toMatch(/usage limit/);
    expect((await agent.post(`/orders/${first.body.id}/cancel`, { reason: "customer left" })).status).toBe(200);
    const after = await db.coupon.findUniqueOrThrow({ where: { id: c.body.id } });
    expect(after.usedCount).toBe(0);
    expect(await db.couponRedemption.count({ where: { couponId: c.body.id } })).toBe(0);
    expect((await bill(agent, [line(A)], { couponCode: c.body.code })).status).toBe(201);
  });

  it("IT-OFF-041 cancelling a PAID bill also releases the coupon use (once, even if cancelled twice) @critical @regression", async () => {
    const { agent } = await scope();
    const c = await coupon({ discountType: "FLAT", value: 1000, usageLimit: 5 });
    const o = await bill(agent, [line(A)], { couponCode: c.body.code });
    await bill(agent, [line(A)], { couponCode: c.body.code });
    await pay(agent, o.body.id, o.body.grandTotal);
    expect((await agent.post(`/orders/${o.body.id}/cancel`, { reason: "refund" })).status).toBe(200);
    expect((await agent.post(`/orders/${o.body.id}/cancel`, { reason: "refund" })).status).toBe(409);
    expect((await db.coupon.findUniqueOrThrow({ where: { id: c.body.id } })).usedCount).toBe(1);
  });

  it("IT-OFF-042 concurrent bills on a usageLimit-1 coupon: exactly one succeeds @critical @regression", async () => {
    const { agent } = await scope();
    await bill(agent, [line(C)]); // warm the invoice counter for this outlet
    const c = await coupon({ discountType: "FLAT", value: 1000, usageLimit: 1 });
    const res = await Promise.all(Array.from({ length: 5 }, () => bill(agent, [line(A)], { couponCode: c.body.code })));
    expect(res.filter((r) => r.status === 201)).toHaveLength(1);
    expect(res.every((r) => r.status === 201 || r.status === 400 || r.status === 409)).toBe(true);
    expect((await db.coupon.findUniqueOrThrow({ where: { id: c.body.id } })).usedCount).toBe(1);
  });

  it("IT-OFF-043 perCustomerLimit 1: needs a phone; same customer refused the 2nd time; another customer OK @critical @regression", async () => {
    const { agent } = await scope();
    const c = await coupon({ discountType: "FLAT", value: 1000, perCustomerLimit: 1 });
    const p1 = phone();
    expect((await bill(agent, [line(A)], { couponCode: c.body.code })).body.error).toMatch(/phone/);
    expect((await bill(agent, [line(A)], { couponCode: c.body.code, customerPhone: p1 })).status).toBe(201);
    const again = await bill(agent, [line(A)], { couponCode: c.body.code, customerPhone: p1 });
    expect(again.status).toBe(400);
    expect(again.body.error).toMatch(/already used/);
    expect((await bill(agent, [line(A)], { couponCode: c.body.code, customerPhone: phone() })).status).toBe(201);
  });

  it("IT-OFF-044 bill below coupon minOrder / expired coupon → 400, nothing billed @regression", async () => {
    const { agent, outletId } = await scope();
    const mo = await coupon({ discountType: "FLAT", value: 1000, minOrder: 25000 });
    expect((await bill(agent, [line(A)], { couponCode: mo.body.code })).status).toBe(400);
    const ex = await coupon({ discountType: "FLAT", value: 1000, expiresAt: new Date(Date.now() - 1000).toISOString() });
    expect((await bill(agent, [line(A)], { couponCode: ex.body.code })).status).toBe(400);
    expect(await db.order.count({ where: { outletId } })).toBe(0);
  });

  it("IT-OFF-045 personal coupon works only for its customer @regression", async () => {
    const { agent } = await scope();
    const owner = phone();
    const cust = await db.customer.create({ data: { businessId: T.business.id, phone: owner } });
    const c = await coupon({ discountType: "PERCENT", value: 20, maxDiscount: 10000 });
    await db.coupon.update({ where: { id: c.body.id }, data: { customerId: cust.id } });
    const wrong = await bill(agent, [line(A)], { couponCode: c.body.code, customerPhone: phone() });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error).toMatch(/different customer/);
    const right = await bill(agent, [line(A)], { couponCode: c.body.code, customerPhone: owner });
    expect(right.status).toBe(201);
    expect(right.body.promoDiscount).toBe(4000);
  });

  it("IT-OFF-046 coupon code is case-insensitive on the bill; unknown code → 400 @regression", async () => {
    const { agent } = await scope();
    const c = await coupon({ discountType: "FLAT", value: 1000 });
    expect((await bill(agent, [line(A)], { couponCode: ` ${c.body.code.toLowerCase()} ` })).body.couponCode).toBe(c.body.code);
    expect((await bill(agent, [line(A)], { couponCode: "NOPE-NOPE" })).status).toBe(400);
  });

  it("IT-OFF-047 coupon report counts live redemptions and excludes cancelled bills @regression", async () => {
    const { agent } = await scope();
    const c = await coupon({ discountType: "FLAT", value: 1000 });
    const o1 = await bill(agent, [line(A)], { couponCode: c.body.code });
    await bill(agent, [line(A)], { couponCode: c.body.code });
    await agent.post(`/orders/${o1.body.id}/cancel`, { reason: "oops" });
    const rep = await agent.get("/offers/coupons/report");
    const row = rep.body.rows.find((r: { code: string }) => r.code === c.body.code);
    expect(row).toMatchObject({ redemptions: 1, discount: 1000, sales: 19000 });
  });
});

describe("OFFERS module disabled @regression", () => {
  it("IT-OFF-050 /offers endpoints → 403; coupon on a bill → 400; stored offers are not applied @critical @regression", async () => {
    const t = await tenant({ modules: ["BILLING", "KOT", "CUSTOMERS"] });
    const cat = await mkCategory(t.business.id);
    const item = await mkItem(t.business.id, cat.id, 20000);
    await db.coupon.create({ data: { businessId: t.business.id, code: "OFFOFF", discountType: "FLAT", value: 1000 } });
    await db.offer.create({ data: { businessId: t.business.id, name: "Ghost", type: "BILL_DISCOUNT", config: { discountType: "FLAT", value: 5000 } } });
    const owner = await t.owner();
    for (const p of ["/offers", "/offers/active", "/offers/coupons"]) expect((await owner.get(p)).status, p).toBe(403);
    expect((await owner.post("/offers/coupons/validate", { code: "OFFOFF", subtotal: 20000 })).status).toBe(403);
    const withCoupon = await bill(owner, [line(item.id)], { couponCode: "OFFOFF" });
    expect(withCoupon.status).toBe(400);
    expect(withCoupon.body.error).toMatch(/not enabled/);
    const pv = await preview(owner, [line(item.id)], { couponCode: "OFFOFF" });
    expect(pv.body.warnings.join()).toMatch(/not enabled/);
    const plain = await bill(owner, [line(item.id)]);
    expect(plain.body.promoDiscount).toBe(0);
    expect(plain.body.grandTotal).toBe(20000);
  });

  it("IT-OFF-051 demo coupons WELCOME50 / FEST10 validate in the seeded tenant @regression", async () => {
    const owner = await as("owner@canavo.local", (await db.outlet.findFirstOrThrow({ where: { business: { users: { some: { email: "owner@canavo.local" } } } }, orderBy: { createdAt: "asc" } })).id);
    const w = await owner.post("/offers/coupons/validate", { code: "welcome50", subtotal: 20000, customerPhone: phone() });
    expect(w.status).toBe(200);
    expect(w.body.estimatedDiscount).toBe(5000);
    const f = await owner.post("/offers/coupons/validate", { code: "FEST10", subtotal: 100000 });
    expect(f.body.estimatedDiscount).toBe(7500);
    expect((await owner.post("/offers/coupons/validate", { code: "WELCOME50", subtotal: 19999, customerPhone: phone() })).status).toBe(400);
  });
});
