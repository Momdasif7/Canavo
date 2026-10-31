import { describe, expect, it, vi } from "vitest";

// The service module imports the DB client, realtime and notify; the helpers under test are pure.
vi.mock("../db", () => ({ prisma: {} }));
vi.mock("../realtime", () => ({ emitToOutlet: () => {}, emitToUser: () => {} }));
vi.mock("./notify", () => ({ notify: async () => {}, outletManagers: async () => [] }));

import { computePurchaseTotals } from "@canavo/shared";
import {
  computeConsumption,
  convertQuantity,
  isLowStock,
  netPrice,
  recipeCost,
  resolveRecipe,
  round3,
  unitsCompatible,
  weightedAverageCost,
} from "./inventory";

describe("round3", () => {
  it("rounds to 3 decimals without float noise", () => {
    expect(round3(0.1 + 0.2)).toBe(0.3);
    expect(round3(1.23456)).toBe(1.235);
    expect(round3(-0.0005)).toBe(-0);
  });
});

describe("convertQuantity", () => {
  it("converts within unit families", () => {
    expect(convertQuantity(250, "G", "KG")).toBe(0.25);
    expect(convertQuantity(1.5, "KG", "G")).toBe(1500);
    expect(convertQuantity(100, "ML", "L")).toBe(0.1);
    expect(convertQuantity(2, "L", "ML")).toBe(2000);
    expect(convertQuantity(2, "DOZEN", "PIECE")).toBe(24);
    expect(convertQuantity(6, "PIECE", "DOZEN")).toBe(0.5);
    expect(convertQuantity(3, "PACKET", "PACKET")).toBe(3);
  });
  it("rejects incompatible units", () => {
    expect(unitsCompatible("KG", "L")).toBe(false);
    expect(() => convertQuantity(1, "KG", "L")).toThrow(/Cannot convert/);
    expect(() => convertQuantity(1, "PACKET", "PIECE")).toThrow();
  });
});

describe("weightedAverageCost", () => {
  it("blends existing stock and new purchase", () => {
    // 10 kg @ ₹40 + 30 kg @ ₹60 → ₹55
    expect(weightedAverageCost(10, 4000, 30, 6000)).toBe(5500);
  });
  it("uses the purchase cost when there is no positive stock", () => {
    expect(weightedAverageCost(0, 4000, 5, 4500)).toBe(4500);
    expect(weightedAverageCost(-3, 4000, 5, 4500)).toBe(4500);
  });
  it("keeps cost when nothing is added", () => {
    expect(weightedAverageCost(10, 4000, 0, 9999)).toBe(4000);
  });
});

describe("recipe resolution", () => {
  const recipes = [
    { menuItemId: "chai", variantId: null, inventoryItemId: "milk", quantity: 0.1 },
    { menuItemId: "chai", variantId: null, inventoryItemId: "tea", quantity: 0.005 },
    { menuItemId: "chai", variantId: "large", inventoryItemId: "milk", quantity: 0.18 },
    { menuItemId: "chai", variantId: "large", inventoryItemId: "tea", quantity: 0.008 },
    { menuItemId: "samosa", variantId: null, inventoryItemId: "potato", quantity: 0.08 },
  ];
  it("prefers variant-specific rows", () => {
    expect(resolveRecipe(recipes, "chai", "large").map((r) => r.quantity)).toEqual([0.18, 0.008]);
  });
  it("falls back to variant-less rows", () => {
    expect(resolveRecipe(recipes, "chai", "regular").map((r) => r.quantity)).toEqual([0.1, 0.005]);
    expect(resolveRecipe(recipes, "chai", null)).toHaveLength(2);
  });
  it("returns nothing for items without a recipe", () => {
    expect(resolveRecipe(recipes, "dosa", null)).toEqual([]);
  });
  it("aggregates consumption across order lines", () => {
    const usage = computeConsumption(
      [
        { menuItemId: "chai", variantId: "regular", quantity: 3 },
        { menuItemId: "chai", variantId: "large", quantity: 1 },
        { menuItemId: "samosa", variantId: null, quantity: 2 },
        { menuItemId: "dosa", variantId: null, quantity: 1 },
      ],
      recipes,
    );
    expect(usage.get("milk")).toBe(0.48);
    expect(usage.get("tea")).toBe(0.023);
    expect(usage.get("potato")).toBe(0.16);
    expect(usage.size).toBe(3);
  });
});

describe("costing helpers", () => {
  it("computes recipe cost in paise", () => {
    // 0.1 L milk @ ₹56/L + 0.005 kg tea @ ₹480/kg + 0.01 kg sugar @ ₹44/kg
    expect(recipeCost([{ quantity: 0.1, costPerUnit: 5600 }, { quantity: 0.005, costPerUnit: 48000 }, { quantity: 0.01, costPerUnit: 4400 }])).toBe(844);
  });
  it("strips GST from tax-inclusive prices", () => {
    expect(netPrice(10500, 5, true)).toBe(10000);
    expect(netPrice(10000, 5, false)).toBe(10000);
  });
  it("flags low stock only when a reorder level is set", () => {
    expect(isLowStock(2, 5)).toBe(true);
    expect(isLowStock(5, 5)).toBe(true);
    expect(isLowStock(6, 5)).toBe(false);
    expect(isLowStock(-1, 0)).toBe(false);
  });
  it("computes purchase totals with GST per line", () => {
    const t = computePurchaseTotals([
      { quantity: 10, unitCost: 5600, taxRate: 0 },
      { quantity: 2.5, unitCost: 48000, taxRate: 5 },
    ]);
    expect(t.subtotal).toBe(56000 + 120000);
    expect(t.tax).toBe(6000);
    expect(t.total).toBe(182000);
    expect(t.lines[1].total).toBe(126000);
  });
});
