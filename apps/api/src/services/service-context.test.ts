import { describe, expect, it, vi } from "vitest";

vi.mock("../db", () => ({ prisma: {} }));

import { canTransitionDelivery, equalSplit, groupBillItems, preOrderReleaseAt, selectZone } from "./service-context";

describe("selectZone", () => {
  const zones = [
    { id: "far", radiusKm: 6, active: true },
    { id: "near", radiusKm: 3, active: true },
    { id: "off", radiusKm: 1, active: false },
  ];
  it("picks the smallest zone that covers the distance", () => {
    expect(selectZone(zones, 0.5)?.id).toBe("near");
    expect(selectZone(zones, 3)?.id).toBe("near");
    expect(selectZone(zones, 3.01)?.id).toBe("far");
  });
  it("returns null outside every zone and ignores inactive zones", () => {
    expect(selectZone(zones, 6.5)).toBeNull();
    expect(selectZone([{ id: "off", radiusKm: 10, active: false }], 1)).toBeNull();
  });
});

describe("equalSplit", () => {
  it("sums exactly to the total", () => {
    for (const [total, parts] of [[100000, 3], [99999, 7], [1, 2], [0, 4], [123457, 50]]) {
      const split = equalSplit(total, parts);
      expect(split).toHaveLength(parts);
      expect(split.reduce((a, b) => a + b, 0)).toBe(total);
      expect(Math.max(...split) - Math.min(...split)).toBeLessThanOrEqual(1);
    }
  });
  it("puts extra paise first", () => {
    expect(equalSplit(1000, 3)).toEqual([334, 333, 333]);
  });
  it("rejects invalid parts", () => {
    expect(() => equalSplit(100, 0)).toThrow();
  });
});

describe("groupBillItems", () => {
  const items = [
    { id: "a", seat: 1, billedOrderId: null },
    { id: "b", seat: 2, billedOrderId: null },
    { id: "c", seat: 1, billedOrderId: null },
    { id: "d", seat: null, billedOrderId: null },
    { id: "e", seat: 2, billedOrderId: "o1" },
  ];
  it("FULL and EQUAL bill every unbilled item once", () => {
    expect(groupBillItems(items, "FULL")).toEqual([{ label: "Full", itemIds: ["a", "b", "c", "d"] }]);
    expect(groupBillItems(items, "EQUAL")[0].itemIds).toEqual(["a", "b", "c", "d"]);
  });
  it("BY_SEAT groups per seat with unseated items as Shared", () => {
    const g = groupBillItems(items, "BY_SEAT");
    expect(g.map((x) => [x.label, x.itemIds])).toEqual([
      ["Seat 1", ["a", "c"]],
      ["Seat 2", ["b"]],
      ["Shared", ["d"]],
    ]);
  });
  it("BY_SEAT honours a seat filter", () => {
    expect(groupBillItems(items, "BY_SEAT", { seats: [2] }).map((x) => x.itemIds)).toEqual([["b"]]);
    expect(() => groupBillItems(items, "BY_SEAT", { seats: [9] })).toThrow();
  });
  it("BY_ITEMS validates ids and duplicates", () => {
    expect(groupBillItems(items, "BY_ITEMS", { itemIds: ["a", "d"] })).toEqual([{ label: "Bill 1", itemIds: ["a", "d"] }]);
    expect(groupBillItems(items, "BY_ITEMS", { groups: [["a"], ["b", "c"]] }).length).toBe(2);
    expect(() => groupBillItems(items, "BY_ITEMS", { itemIds: ["e"] })).toThrow(/not an unbilled/);
    expect(() => groupBillItems(items, "BY_ITEMS", { groups: [["a"], ["a"]] })).toThrow(/more than one/);
  });
  it("fails when nothing is left to bill", () => {
    expect(() => groupBillItems([{ id: "x", seat: null, billedOrderId: "o" }], "FULL")).toThrow(/Nothing left/);
  });
});

describe("preOrderReleaseAt", () => {
  const now = new Date("2026-10-02T10:00:00Z");
  it("holds the KOT until lead time before the slot", () => {
    expect(preOrderReleaseAt(new Date("2026-10-02T12:00:00Z"), 30, now)?.toISOString()).toBe("2026-10-02T11:30:00.000Z");
  });
  it("fires immediately when the slot is within the lead time", () => {
    expect(preOrderReleaseAt(new Date("2026-10-02T10:20:00Z"), 30, now)).toBeUndefined();
    expect(preOrderReleaseAt(new Date("2026-10-02T10:30:30Z"), 30, now)).toBeUndefined();
  });
});

describe("canTransitionDelivery", () => {
  it("moves forward only, allows skipping, cancels from open states", () => {
    expect(canTransitionDelivery("PENDING", "ACCEPTED")).toBe(true);
    expect(canTransitionDelivery("ACCEPTED", "OUT_FOR_DELIVERY")).toBe(true);
    expect(canTransitionDelivery("OUT_FOR_DELIVERY", "PREPARING")).toBe(false);
    expect(canTransitionDelivery("PREPARING", "CANCELLED")).toBe(true);
    expect(canTransitionDelivery("DELIVERED", "CANCELLED")).toBe(false);
    expect(canTransitionDelivery("CANCELLED", "PENDING")).toBe(false);
  });
});
