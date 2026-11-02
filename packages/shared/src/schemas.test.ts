/** Request-schema validation: equivalence partitions and boundary values (Phase 4). */
import { describe, expect, it } from "vitest";
import {
  attendanceManualSchema, categorySchema, kotStatusSchema, menuItemSchema, orderCreateSchema, otpRequestSchema, otpVerifySchema, outletSchema,
  paymentSchema, staffCreateSchema,
} from "./schemas";
import { couponCreateSchema } from "./schemas-crm";

const ok = (s: { safeParse: (v: unknown) => { success: boolean } }, v: unknown) => s.safeParse(v).success;
const item = { menuItemId: "m1", quantity: 1 };

describe("Indian phone numbers (UT-SCH-PHONE)", () => {
  it.each([
    ["9876543210", true], ["6000000000", true], [" 9876543210 ", true],
    ["5876543210", false], ["987654321", false], ["98765432100", false], ["+919876543210", false], ["98765-43210", false], ["", false], ["९८७६५४३२१०", false],
  ])("%j → %s", (phone, valid) => expect(ok(otpRequestSchema, { phone })).toBe(valid));

  it("OTP code is exactly 6 digits", () => {
    expect(ok(otpVerifySchema, { phone: "9876543210", code: "123456" })).toBe(true);
    for (const code of ["12345", "1234567", "12a456", ""]) expect(ok(otpVerifySchema, { phone: "9876543210", code })).toBe(false);
  });
});

describe("outlet settings (UT-SCH-OUT)", () => {
  const base = { name: "Outlet", stateCode: "33" };
  it("GSTIN format: 15 chars, state code, PAN, entity, Z, checksum char", () => {
    expect(ok(outletSchema, { ...base, gstin: "33ABCDE1234F1Z5" })).toBe(true);
    expect(ok(outletSchema, { ...base, gstin: "" })).toBe(true);
    for (const g of ["33ABCDE1234F1Z", "33abcde1234f1z5", "33ABCDE1234F1Y5", "3XABCDE1234F1Z5", "33ABCDE1234F0Z5"]) expect(ok(outletSchema, { ...base, gstin: g }), g).toBe(false);
  });
  it("FSSAI is 14 digits; state code is 2 digits; invoice prefix 1–5 upper-case alphanumerics", () => {
    expect(ok(outletSchema, { ...base, fssai: "12345678901234" })).toBe(true);
    expect(ok(outletSchema, { ...base, fssai: "1234567890123" })).toBe(false);
    expect(ok(outletSchema, { ...base, stateCode: "3" })).toBe(false);
    expect(ok(outletSchema, { ...base, invoicePrefix: "ABCDE" })).toBe(true);
    for (const p of ["", "ABCDEF", "inv", "IN-V"]) expect(ok(outletSchema, { ...base, invoicePrefix: p }), p).toBe(false);
  });
});

describe("orders and payments (UT-SCH-ORD)", () => {
  it("quantity boundaries: 0 ✗, 1 ✓, 999 ✓, 1000 ✗, 1.5 ✗, -1 ✗", () => {
    for (const [q, v] of [[0, false], [1, true], [999, true], [1000, false], [1.5, false], [-1, false]] as const) {
      expect(ok(orderCreateSchema, { orderType: "TAKEAWAY", items: [{ ...item, quantity: q }] }), String(q)).toBe(v);
    }
  });
  it("needs at least one item and a known order type", () => {
    expect(ok(orderCreateSchema, { orderType: "TAKEAWAY", items: [] })).toBe(false);
    expect(ok(orderCreateSchema, { orderType: "DRIVE_THRU", items: [item] })).toBe(false);
  });
  it("discount: FLAT is non-negative integer paise; PERCENT is 0–100", () => {
    const o = (discount: unknown) => ok(orderCreateSchema, { orderType: "TAKEAWAY", items: [item], discount });
    expect(o({ type: "FLAT", value: 0 })).toBe(true);
    expect(o({ type: "FLAT", value: -1 })).toBe(false);
    expect(o({ type: "FLAT", value: 10.5 })).toBe(false);
    expect(o({ type: "PERCENT", value: 100 })).toBe(true);
    expect(o({ type: "PERCENT", value: 100.01 })).toBe(false);
  });
  it("clientOrderId must be a UUID; coupon codes are normalised to upper case", () => {
    expect(ok(orderCreateSchema, { orderType: "TAKEAWAY", items: [item], clientOrderId: "abc" })).toBe(false);
    expect(orderCreateSchema.parse({ orderType: "TAKEAWAY", items: [item], couponCode: " fest10 " }).couponCode).toBe("FEST10");
  });
  it("mass assignment: unknown fields (e.g. grandTotal, outletId, cashierId) are stripped", () => {
    const parsed = orderCreateSchema.parse({ orderType: "TAKEAWAY", items: [item], grandTotal: 1, outletId: "x", cashierId: "y" }) as Record<string, unknown>;
    expect(parsed.grandTotal ?? parsed.outletId ?? parsed.cashierId).toBeUndefined();
  });
  it("payments: positive integer paise, known modes, at least one", () => {
    expect(ok(paymentSchema, { payments: [{ mode: "UPI", amount: 1 }] })).toBe(true);
    expect(ok(paymentSchema, { payments: [{ mode: "CASH", amount: 0 }] })).toBe(false);
    expect(ok(paymentSchema, { payments: [{ mode: "CASH", amount: -100 }] })).toBe(false);
    expect(ok(paymentSchema, { payments: [{ mode: "BITCOIN", amount: 100 }] })).toBe(false);
    expect(ok(paymentSchema, { payments: [] })).toBe(false);
  });
  it("KOT status is one of the 4 states", () => {
    for (const s of ["RECEIVED", "PREPARING", "READY", "SERVED"]) expect(ok(kotStatusSchema, { status: s })).toBe(true);
    expect(ok(kotStatusSchema, { status: "EATEN" })).toBe(false);
  });

  // BUG-021 (open): money fields have no upper bound, but the DB columns are int4
  // (max 2,147,483,647 paise ≈ ₹2.14 crore). An out-of-range price passes validation
  // and fails inside Postgres as a 500. it.fails flips when the bound is added.
  it.fails("UT-SCH-021 (BUG-021) prices above the int4 column limit are rejected at validation (400, not DB 500)", () => {
    expect(ok(menuItemSchema, { name: "x", categoryId: "c", price: 2_147_483_648 })).toBe(false);
  });
});

describe("menu, staff, attendance, coupons (UT-SCH-MISC)", () => {
  it("menu item: name 1–100, HH:MM time slots, HSN ≤ 8", () => {
    const m = { name: "Idli", categoryId: "c", price: 3000 };
    expect(ok(menuItemSchema, m)).toBe(true);
    expect(ok(menuItemSchema, { ...m, name: "" })).toBe(false);
    expect(ok(menuItemSchema, { ...m, name: "x".repeat(101) })).toBe(false);
    expect(ok(menuItemSchema, { ...m, availableFrom: "07:00", availableTo: "23:59" })).toBe(true);
    expect(ok(menuItemSchema, { ...m, availableFrom: "24:00" })).toBe(false);
    expect(ok(menuItemSchema, { ...m, hsnCode: "123456789" })).toBe(false);
    expect(ok(menuItemSchema, { ...m, price: 10.5 })).toBe(false);
  });
  it("category name required; staff PIN is 4–6 digits", () => {
    expect(ok(categorySchema, { name: "" })).toBe(false);
    const s = { name: "Asha", phone: "9876543210", role: "CASHIER", outletIds: ["o"] };
    expect(ok(staffCreateSchema, { ...s, pin: "1234" })).toBe(true);
    expect(ok(staffCreateSchema, { ...s, pin: "123" })).toBe(false);
    expect(ok(staffCreateSchema, { ...s, pin: "1234567" })).toBe(false);
    expect(ok(staffCreateSchema, { ...s, outletIds: [] })).toBe(false); // non-owners need an outlet
  });
  it("manual attendance needs a clock-in for PRESENT / HALF_DAY", () => {
    expect(ok(attendanceManualSchema, { userId: "u", date: "2026-10-01", status: "ABSENT" })).toBe(true);
    expect(ok(attendanceManualSchema, { userId: "u", date: "2026-10-01", status: "PRESENT" })).toBe(false);
    expect(ok(attendanceManualSchema, { userId: "u", date: "01-10-2026", status: "ABSENT" })).toBe(false);
  });
  it("coupon codes are validated", () => {
    const parsed = couponCreateSchema.safeParse({ code: "fest10", discountType: "PERCENT", value: 10 });
    expect(parsed.success).toBe(true);
  });
});
