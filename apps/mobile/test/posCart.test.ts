/** POS cart: reducer, local GST bill (integer paise), cart → POST /orders body, persistence. */
import { billFor, cartReducer, initialCart, isCartEmpty, refreshLines, toOrderInput, type CartState } from "../src/pos/cart";
import { restoreCart, serializeCart } from "../src/pos/cartPersist";
import type { MenuItem, Outlet } from "../src/lib/types";

const item = (id: string, price: number, extra: Partial<MenuItem> = {}): MenuItem =>
  ({
    id, name: id, description: "", categoryId: "c", price, basePrice: price, foodType: "VEG", gstRate: 5, hsnCode: "9963",
    imageUrl: null, status: "AVAILABLE", availableFrom: null, availableTo: null, kitchenStation: "KITCHEN",
    variants: [{ id: `${id}-L`, name: "Large", price: price + 5000 }], addons: [{ id: `${id}-cheese`, name: "Cheese", price: 2000 }], ...extra,
  }) as MenuItem;

const outlet = (o: Partial<Outlet> = {}): Outlet =>
  ({
    id: "o1", name: "Outlet", address: "", stateCode: "29", gstin: "29ABCDE1234F1Z5", fssai: null, phone: null, latitude: null, longitude: null,
    geofenceMeters: 100, timezone: "Asia/Kolkata", invoicePrefix: "INV", pricesIncludeTax: false, compositionScheme: false,
    serviceChargeEnabled: false, serviceChargePercent: 0, roundOff: true, upiVpa: null, ...o,
  }) as Outlet;

const dosa = item("dosa", 12000);
const chai = item("chai", 2000);
const add = (s: CartState, i: MenuItem, variant = null as MenuItem["variants"][number] | null, addons: MenuItem["addons"] = [], quantity?: number) =>
  cartReducer(s, { type: "add", item: i, variant, addons, quantity });

describe("cart reducer", () => {
  it("merges the same item/size/add-ons, keeps different ones apart, caps at 999", () => {
    let s = add(initialCart, dosa);
    s = add(s, dosa);
    s = add(s, dosa, dosa.variants[0]);
    s = add(s, dosa, null, [dosa.addons[0]]);
    expect(s.lines.map((l) => [l.key, l.quantity, l.unitPrice])).toEqual([
      ["dosa|-|", 2, 12000],
      ["dosa|dosa-L|", 1, 17000],
      ["dosa|-|dosa-cheese", 1, 14000],
    ]);
    s = cartReducer(s, { type: "qty", key: "dosa|-|", delta: 5000 });
    expect(s.lines[0].quantity).toBe(999);
    s = cartReducer(s, { type: "qty", key: "dosa|-|", delta: -999 });
    expect(s.lines).toHaveLength(2);
  });

  it("changing the customer phone drops redeemed points; coupon upper-cased; clear keeps the order type", () => {
    let s = cartReducer(initialCart, { type: "phone", value: "9876543210" });
    s = cartReducer(s, { type: "points", value: 50.7 });
    expect(s.redeemPoints).toBe(50);
    s = cartReducer(s, { type: "phone", value: "9876543211" });
    expect(s.redeemPoints).toBe(0);
    s = cartReducer(s, { type: "coupon", value: " save10 " });
    expect(s.couponCode).toBe("SAVE10");
    s = cartReducer(add(cartReducer(s, { type: "orderType", value: "DINE_IN" }), chai), { type: "clear" });
    expect(s.orderType).toBe("DINE_IN");
    expect(isCartEmpty(s)).toBe(true);
  });

  it("refreshItems re-prices against the new menu and drops hidden items", () => {
    let s = add(add(initialCart, dosa), chai);
    s = cartReducer(s, { type: "refreshItems", menu: { items: [{ ...dosa, price: 13000 }, { ...chai, status: "HIDDEN" }] } as never });
    expect(s.lines.map((l) => [l.item.id, l.unitPrice])).toEqual([["dosa", 13000]]);
    expect(refreshLines(s.lines, { items: [{ ...dosa, price: 13000 }] } as never)).toBe(s.lines);
  });
});

describe("local bill (paise)", () => {
  it("5% GST exclusive: CGST/SGST split, rounded off to the rupee", () => {
    const s = add(add(initialCart, dosa), chai, null, [], 3); // 120 + 3×20 = 180.00
    const b = billFor(s, outlet())!;
    expect(b.subtotal).toBe(18000);
    expect(b.cgst + b.sgst).toBe(900);
    expect(b.grandTotal).toBe(18900);
    expect(Number.isInteger(b.grandTotal) && b.grandTotal % 100 === 0).toBe(true);
    expect(b.documentType).toBe("TAX_INVOICE");
  });

  it("non-GST outlet → plain BILL, zero tax", () => {
    const b = billFor(add(initialCart, dosa), outlet({ gstEnabled: false }))!;
    expect(b).toMatchObject({ documentType: "BILL", cgst: 0, sgst: 0, totalTax: 0, grandTotal: 12000 });
  });

  it("no outlet / empty cart → no bill", () => {
    expect(billFor(initialCart, outlet())).toBeNull();
    expect(billFor(add(initialCart, dosa), null)).toBeNull();
  });
});

describe("cart → order body", () => {
  it("online body carries clientOrderId, coupon and points; offline body never does promos or COD", () => {
    let s = add(initialCart, dosa, dosa.variants[0], [dosa.addons[0]], 2);
    s = cartReducer(s, { type: "phone", value: "9876543210" });
    s = cartReducer(s, { type: "coupon", value: "SAVE10" });
    s = cartReducer(s, { type: "points", value: 20 });
    const online = toOrderInput(s, { clientOrderId: "c-1" });
    expect(online).toMatchObject({
      clientOrderId: "c-1", orderType: "TAKEAWAY", customerPhone: "9876543210", couponCode: "SAVE10", redeemPoints: 20,
      items: [{ menuItemId: "dosa", variantId: "dosa-L", addonIds: ["dosa-cheese"], quantity: 2 }],
    });
    const offline = toOrderInput(s, { clientOrderId: "c-1", offline: true, createdAt: "2026-11-08T10:00:00.000Z" });
    expect(offline.couponCode).toBeUndefined();
    expect(offline.redeemPoints).toBeUndefined();
    expect(offline.createdAt).toBe("2026-11-08T10:00:00.000Z");
  });

  it("invalid phone is not sent; table label only for dine-in", () => {
    let s = cartReducer(add(initialCart, chai), { type: "phone", value: "12345" });
    s = cartReducer(s, { type: "table", value: " T4 " });
    expect(toOrderInput(s).customerPhone).toBeUndefined();
    expect(toOrderInput(s).tableLabel).toBeUndefined();
    expect(toOrderInput(cartReducer(s, { type: "orderType", value: "DINE_IN" })).tableLabel).toBe("T4");
  });
});

describe("cart persistence (app killed mid-order)", () => {
  it("round-trips and expires after 24 h", () => {
    const s = add(initialCart, dosa, null, [], 2);
    const raw = serializeCart(s, 1_000)!;
    expect(restoreCart(JSON.parse(raw), 2_000)?.lines[0].quantity).toBe(2);
    expect(restoreCart(JSON.parse(raw), 1_000 + 25 * 3600_000)).toBeNull();
    expect(serializeCart(initialCart)).toBeNull();
  });
});
