import { describe, expect, it } from "vitest";
import { computeAvailability, type RecipeLine } from "./stock-availability";

const line = (inventoryItemId: string, quantity: number, variantId: string | null = null): RecipeLine => ({
  inventoryItemId,
  quantity,
  variantId,
  itemName: inventoryItemId.toUpperCase(),
});

describe("computeAvailability (automatic out-of-stock)", () => {
  it("item without sizes is available while every ingredient covers one portion", () => {
    const r = computeAvailability([], [line("pav", 1), line("potato", 0.08)], new Map([["pav", 1], ["potato", 0.08]]));
    expect(r).toEqual({ stockOut: false, stockOutVariantIds: [], reason: null });
  });

  it("goes out of stock when one ingredient can't cover a portion, naming it", () => {
    const r = computeAvailability([], [line("pav", 1), line("potato", 0.08)], new Map([["pav", 0.5], ["potato", 5]]));
    expect(r).toEqual({ stockOut: true, stockOutVariantIds: [], reason: "PAV" });
  });

  it("zero and negative stock both count as out; missing stock rows count as zero", () => {
    expect(computeAvailability([], [line("a", 1)], new Map([["a", 0]])).stockOut).toBe(true);
    expect(computeAvailability([], [line("a", 1)], new Map([["a", -3]])).stockOut).toBe(true);
    expect(computeAvailability([], [line("a", 1)], new Map()).stockOut).toBe(true);
  });

  it("items without a recipe are never auto out of stock", () => {
    expect(computeAvailability([], [], new Map())).toEqual({ stockOut: false, stockOutVariantIds: [], reason: null });
    expect(computeAvailability(["s", "l"], [], new Map()).stockOut).toBe(false);
  });

  it("sizes: only the size whose own recipe can't be made is out", () => {
    const recipes = [line("milk", 0.1), line("milk", 0.18, "large")];
    const r = computeAvailability(["regular", "large"], recipes, new Map([["milk", 0.15]]));
    expect(r).toEqual({ stockOut: false, stockOutVariantIds: ["large"], reason: "MILK" });
  });

  it("sizes: the whole item is out when every size is out", () => {
    const recipes = [line("milk", 0.1), line("milk", 0.18, "large")];
    const r = computeAvailability(["regular", "large"], recipes, new Map([["milk", 0.05]]));
    expect(r).toEqual({ stockOut: true, stockOutVariantIds: [], reason: "MILK" });
  });

  it("sizes without their own recipe use the item's default recipe", () => {
    const r = computeAvailability(["half", "full"], [line("rice", 0.2)], new Map([["rice", 0.1]]));
    expect(r.stockOut).toBe(true);
  });

  it("floating-point stock exactly equal to the portion is enough", () => {
    expect(computeAvailability([], [line("oil", 0.3)], new Map([["oil", 0.1 + 0.2]])).stockOut).toBe(false);
  });
});
