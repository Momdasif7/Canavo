import { describe, expect, it } from "vitest";
import { employerShare } from "./schemas-canteen";

describe("employerShare", () => {
  it("percent, capped per meal and by what's left of the day", () => {
    const rule = { type: "PERCENT" as const, value: 50, maxPerMeal: 6000, maxPerDay: 8000 };
    expect(employerShare(rule, 16000)).toBe(6000);
    expect(employerShare(rule, 16000, 6000)).toBe(2000);
    expect(employerShare(rule, 16000, 9000)).toBe(0);
  });
  it("flat never exceeds the meal; no rule = 0", () => {
    expect(employerShare({ type: "FLAT", value: 5000 }, 1500)).toBe(1500);
    expect(employerShare(null, 1500)).toBe(0);
  });
});
