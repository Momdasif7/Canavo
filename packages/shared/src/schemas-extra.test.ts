/** Cross-field refinements in the module schemas (offers, coupons, stock, tabs, platform). */
import { describe, expect, it } from "vitest";
import { businessCreateSchema } from "./schemas-business";
import { billDiscountConfigSchema, couponCreateSchema, couponUpdateSchema, offerCreateSchema, offerUpdateSchema } from "./schemas-crm";
import { stockAdjustSchema, stockTransferCreateSchema } from "./schemas-inventory";
import { SETTING_SCHEMAS } from "./schemas-platform";
import { sessionBillSchema } from "./schemas-service";
import { formatReceiptText, type ReceiptData } from "./receipt";

const ok = (s: { safeParse: (v: unknown) => { success: boolean } }, v: unknown) => s.safeParse(v).success;

describe("offers (UT-SCH-OFF)", () => {
  const bxgy = { name: "Buy 2 get 1", type: "BUY_X_GET_Y", config: { buy: { quantity: 2 }, get: { quantity: 1 } } };
  it("config is validated against the offer type", () => {
    expect(ok(offerCreateSchema, bxgy)).toBe(true);
    expect(ok(offerCreateSchema, { ...bxgy, config: { buy: { quantity: 0 }, get: { quantity: 1 } } })).toBe(false);
    expect(ok(offerCreateSchema, { ...bxgy, type: "BILL_DISCOUNT", config: { discountType: "PERCENT", value: 150 } })).toBe(false);
  });
  it("happy-hour windows need both ends and may cross midnight; endsAt must be after startsAt", () => {
    expect(ok(offerCreateSchema, { ...bxgy, startTime: "22:00", endTime: "02:00" })).toBe(true);
    expect(ok(offerCreateSchema, { ...bxgy, startTime: "16:00" })).toBe(false);
    expect(ok(offerCreateSchema, { ...bxgy, startsAt: "2026-11-02T00:00:00Z", endsAt: "2026-11-01T00:00:00Z" })).toBe(false);
    expect(ok(offerCreateSchema, { ...bxgy, startsAt: "2026-11-01T00:00:00Z", endsAt: "2026-11-01T00:00:00Z" })).toBe(false);
    expect(ok(offerUpdateSchema, { endTime: "18:00" })).toBe(false);
  });
  it("bill discount percent ≤ 100; flat can be any positive paise", () => {
    expect(ok(billDiscountConfigSchema, { discountType: "PERCENT", value: 100 })).toBe(true);
    expect(ok(billDiscountConfigSchema, { discountType: "PERCENT", value: 100.5 })).toBe(false);
    expect(ok(billDiscountConfigSchema, { discountType: "FLAT", value: 150000 })).toBe(true);
  });
  it("coupon percent ≤ 100 on create and update", () => {
    expect(ok(couponCreateSchema, { code: "BIG", discountType: "PERCENT", value: 101 })).toBe(false);
    expect(ok(couponUpdateSchema, { discountType: "PERCENT", value: 101 })).toBe(false);
    expect(ok(couponCreateSchema, { code: "BIG", discountType: "FLAT", value: 10100 })).toBe(true);
  });
});

describe("inventory, tabs, platform (UT-SCH-INV/TAB/PLAT)", () => {
  it("stock adjust: exactly one of quantity / setTo, and quantity ≠ 0", () => {
    expect(ok(stockAdjustSchema, { inventoryItemId: "i", quantity: -2, reason: "spill" })).toBe(true);
    expect(ok(stockAdjustSchema, { inventoryItemId: "i", setTo: 10, reason: "count" })).toBe(true);
    expect(ok(stockAdjustSchema, { inventoryItemId: "i", quantity: 1, setTo: 1, reason: "both" })).toBe(false);
    expect(ok(stockAdjustSchema, { inventoryItemId: "i", reason: "none" })).toBe(false);
    expect(ok(stockAdjustSchema, { inventoryItemId: "i", quantity: 0, reason: "zero" })).toBe(false);
  });
  it("transfers: exactly one direction", () => {
    const items = [{ inventoryItemId: "i", quantity: 1 }];
    expect(ok(stockTransferCreateSchema, { toOutletId: "o2", items })).toBe(true);
    expect(ok(stockTransferCreateSchema, { toOutletId: "o2", fromOutletId: "o3", items })).toBe(false);
    expect(ok(stockTransferCreateSchema, { items })).toBe(false);
  });
  it("tab split: BY_ITEMS needs items or groups; EQUAL needs parts", () => {
    expect(ok(sessionBillSchema, { mode: "FULL" })).toBe(true);
    expect(ok(sessionBillSchema, { mode: "BY_ITEMS" })).toBe(false);
    expect(ok(sessionBillSchema, { mode: "BY_ITEMS", itemIds: ["a"] })).toBe(true);
    expect(ok(sessionBillSchema, { mode: "EQUAL" })).toBe(false);
    expect(ok(sessionBillSchema, { mode: "EQUAL", parts: 3 })).toBe(true);
  });
  it("IP whitelist entries: IPv4/IPv6 with optional CIDR", () => {
    const ip = SETTING_SCHEMAS["security.ipWhitelist"];
    for (const v of ["203.0.113.7", "10.0.0.0/8", "2001:db8::1", "2001:db8::/32"]) expect(ok(ip, [v]), v).toBe(true);
    for (const v of ["256.1.1.1", "10.0.0.0/33", "1.2.3.4/8/1", "example.com", "2001:db8::/129", "10.0.0.0/x"]) expect(ok(ip, [v]), v).toBe(false);
  });
  it("business onboarding needs at least one module and an owner account", () => {
    const b = { name: "Hotel", modules: ["BILLING"], owner: { name: "Ravi", phone: "9876543210", password: "Str0ngPass!" }, outlet: { name: "Main", stateCode: "33" } };
    expect(ok(businessCreateSchema, b)).toBe(true);
    expect(ok(businessCreateSchema, { ...b, modules: [] })).toBe(false);
  });
});

describe("receipt edge branches", () => {
  const r: ReceiptData = {
    documentType: "TAX_INVOICE", invoiceNumber: "INV-2026-00001", issuedAt: "2026-04-01T04:30:00Z",
    outlet: { name: "X".repeat(60), address: "" }, orderType: "TAKEAWAY", cashierName: "C",
    items: [{ name: "A very long item name that wraps", quantity: 1, unitPrice: 100, amount: 100, gstRate: 5, hsnCode: "1" }],
    subtotal: 100, discount: 0, serviceCharge: 0, cgst: 0, sgst: 0, igst: 0, roundOff: 0, grandTotal: 100,
    taxBreakup: [{ rate: 5, taxableValue: 100, cgst: 3, sgst: 2, igst: 0 }], payments: [], codDue: 0,
  };
  it("long outlet names are clipped, empty address skipped, legacy breakup rates halved, zero COD hidden", () => {
    const lines = formatReceiptText(r, 58);
    expect(lines[0]).toHaveLength(32);
    expect(lines.join("\n")).toContain("CGST @2.5%");
    expect(lines.join("\n")).not.toContain("CASH ON DELIVERY");
  });
});
