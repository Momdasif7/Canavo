/**
 * BUG-022 (open — needs a decision on the allowed offline window):
 * POST /orders accepts any client `createdAt` (it exists for offline bills). It
 * drives the invoice FY, promotion time (coupons/happy hours), item time slots
 * and the bill's report date — so a cashier can backdate into a closed FY or
 * future-date bills. `it.fails` documents current behaviour and flips when fixed.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { db, demoTenant, loginAs } from "./helpers";

let menuItemId: string;
let outletId: string;

beforeAll(async () => {
  const demo = await demoTenant();
  outletId = demo.outlet.id;
  const item = await db.menuItem.findFirstOrThrow({ where: { businessId: demo.businessId, status: "AVAILABLE", variants: { none: {} }, availableFrom: null } });
  menuItemId = item.id;
});

const bill = (createdAt: string) => ({ orderType: "TAKEAWAY", createdAt, items: [{ menuItemId, quantity: 1 }] });

describe("@critical BUG-022 client createdAt bounds", () => {
  it.fails("ABUSE-BIL-001 a bill backdated into a previous, closed financial year is refused", async () => {
    const cashier = await loginAs("cashier@canavo.local", outletId);
    const res = await cashier.post("/orders", bill("2024-06-01T06:00:00.000Z"));
    // today: 201 with invoice INV-2024-xxxxx in FY 2024-25
    expect(res.status).toBe(400);
  });

  it.fails("ABUSE-BIL-002 a bill dated in the future is refused", async () => {
    const cashier = await loginAs("cashier@canavo.local", outletId);
    const res = await cashier.post("/orders", bill("2030-01-01T06:00:00.000Z"));
    expect(res.status).toBe(400);
  });

  it("ABUSE-BIL-003 evidence: the backdated bill really lands in the old FY today", async () => {
    const cashier = await loginAs("cashier@canavo.local", outletId);
    const res = await cashier.post("/orders", bill("2024-06-01T06:00:00.000Z"));
    expect(res.status).toBe(201);
    expect(res.body.invoiceNumber).toMatch(/^INV-2024-/);
    expect(res.body.createdAt).toBe("2024-06-01T06:00:00.000Z");
  });
});
