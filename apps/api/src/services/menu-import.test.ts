import { describe, expect, it } from "vitest";
import fc from "fast-check";

import { cellText, pairs } from "./menu-import";

/** The original implementation, kept as the oracle for behaviour on normal input. */
function pairsRegex(s: string) {
  return s
    .split(/[;\n]/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      // eslint-disable-next-line regexp/no-super-linear-backtracking -- the old implementation, kept only as a test oracle
      const m = p.match(/^(.*?)\s*[=:]\s*([^=:]+)$/);
      return m ? { key: m[1].trim(), value: m[2].trim() } : { key: p, value: "" };
    });
}

describe("menu import 'Sizes' / 'Ingredients' cell parser", () => {
  it("UT-IMP-001 parses the documented syntax", () => {
    expect(pairs("Regular=15; Large=25")).toEqual([{ key: "Regular", value: "15" }, { key: "Large", value: "25" }]);
    expect(pairs("Potato=0.08; Pav=1")).toEqual([{ key: "Potato", value: "0.08" }, { key: "Pav", value: "1" }]);
    expect(pairs("Half : 60\nFull: 110")).toEqual([{ key: "Half", value: "60" }, { key: "Full", value: "110" }]);
    expect(pairs("Plain")).toEqual([{ key: "Plain", value: "" }]);
    expect(pairs("")).toEqual([]);
  });

  it("PBT-IMP-001 matches the original regex behaviour on arbitrary short input", () => {
    const alphabet = fc.constantFrom("a", "B", "1", ".", " ", "\t", "=", ":", ";", "\n", " ", "₹", "த");
    fc.assert(
      fc.property(fc.array(alphabet, { maxLength: 40 }).map((a) => a.join("")), (s) => {
        expect(pairs(s)).toEqual(pairsRegex(s));
      }),
      { numRuns: 5000 },
    );
  });

  it("SEC-IMP-001 (BUG-006) is linear-time on a hostile 200k-character cell (ReDoS)", () => {
    const hostile = `a${" ".repeat(200_000)}=`;
    const t = performance.now();
    pairs(hostile);
    expect(performance.now() - t).toBeLessThan(200);
  });
});

describe("Excel cell → text (BUG-016)", () => {
  it("UT-IMP-002 error cells and error formula results become empty, never \"[object Object]\"", () => {
    expect(cellText({ error: "#N/A" } as never)).toBe("");
    expect(cellText({ formula: "A1/0", result: { error: "#DIV/0!" } } as never)).toBe("");
    expect(cellText({ formula: "B2*2", result: 30 } as never)).toBe("30");
    expect(cellText({ richText: [{ text: "Masala " }, { text: "Dosa" }] } as never)).toBe("Masala Dosa");
    expect(cellText("Idli")).toBe("Idli");
  });
});
