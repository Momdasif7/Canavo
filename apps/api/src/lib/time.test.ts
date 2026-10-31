import { describe, expect, it } from "vitest";
import { addDays, startOfLocalDay, zonedParts } from "./time";

describe("time helpers", () => {
  it("finds local midnight for IST (UTC+5:30)", () => {
    expect(startOfLocalDay("2026-10-02", "Asia/Kolkata").toISOString()).toBe("2026-10-01T18:30:00.000Z");
  });
  it("finds local midnight for zones behind UTC", () => {
    expect(startOfLocalDay("2026-01-15", "America/New_York").toISOString()).toBe("2026-01-15T05:00:00.000Z");
  });
  it("reads wall-clock parts in a zone", () => {
    expect(zonedParts(new Date("2026-10-02T19:00:00Z"), "Asia/Kolkata")).toEqual({ date: "2026-10-03", minutes: 30 });
  });
  it("adds days across month ends", () => {
    expect(addDays("2026-02-28", 1)).toBe("2026-03-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });
});
