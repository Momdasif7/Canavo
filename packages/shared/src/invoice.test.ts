import { describe, expect, it } from "vitest";
import { mergeSeriesState, nextSeriesNumber, parseInvoiceNumber } from "./invoice";

describe("nextSeriesNumber", () => {
  it("starts a fresh FY at 1 and advances the state", () => {
    const r = nextSeriesNumber({ prefix: "INVA1", lastSeqByFy: {} }, "2026-06-10T08:00:00Z", "Asia/Kolkata");
    expect(r.number).toBe("INVA1-2026-00001");
    expect(r.state).toEqual({ prefix: "INVA1", lastSeqByFy: { "2026": 1 } });
    const r2 = nextSeriesNumber(r.state, "2026-06-10T09:00:00Z", "Asia/Kolkata");
    expect(r2.number).toBe("INVA1-2026-00002");
  });

  it("continues from the last number of the bill's FY and leaves other FYs alone", () => {
    const r = nextSeriesNumber({ prefix: "INVA1", lastSeqByFy: { "2025": 41, "2026": 6 } }, "2026-02-01T08:00:00Z");
    expect(r.number).toBe("INVA1-2025-00042");
    expect(r.state.lastSeqByFy).toEqual({ "2025": 42, "2026": 6 });
  });

  it("uses the outlet timezone at the FY boundary", () => {
    // 31 Mar 2026 20:00 UTC is already 1 Apr in India (new FY) but still March in New York.
    const at = "2026-03-31T20:00:00Z";
    expect(nextSeriesNumber({ prefix: "INVB2", lastSeqByFy: {} }, at, "Asia/Kolkata").number).toBe("INVB2-2026-00001");
    expect(nextSeriesNumber({ prefix: "INVB2", lastSeqByFy: {} }, at, "America/New_York").number).toBe("INVB2-2025-00001");
  });

  it("does not mutate the input state and round-trips through parseInvoiceNumber", () => {
    const s = { prefix: "INVA1", lastSeqByFy: { "2026": 9 } };
    const r = nextSeriesNumber(s, new Date("2026-07-01T00:00:00Z"));
    expect(s.lastSeqByFy["2026"]).toBe(9);
    expect(parseInvoiceNumber(r.number)).toEqual({ prefix: "INVA1", fyStart: 2026, seq: 10 });
  });

  it("refuses numbers over the 16-character GST limit", () => {
    expect(() => nextSeriesNumber({ prefix: "TOOLONGA1", lastSeqByFy: {} }, "2026-06-01T00:00:00Z")).toThrow(/16-character/);
  });
});

describe("mergeSeriesState", () => {
  it("keeps the higher count per FY when the prefix matches", () => {
    expect(mergeSeriesState({ prefix: "INVA1", lastSeqByFy: { "2026": 3 } }, { prefix: "INVA1", lastSeqByFy: { "2026": 7, "2025": 2 } })).toEqual({
      prefix: "INVA1",
      lastSeqByFy: { "2026": 7, "2025": 2 },
    });
  });

  it("drops local counts of a different series", () => {
    expect(mergeSeriesState({ prefix: "INVA2", lastSeqByFy: { "2026": 1 } }, { prefix: "INVA1", lastSeqByFy: { "2026": 9 } })).toEqual({ prefix: "INVA2", lastSeqByFy: { "2026": 1 } });
    expect(mergeSeriesState({ prefix: "INVA2", lastSeqByFy: {} }, null)).toEqual({ prefix: "INVA2", lastSeqByFy: {} });
  });
});
