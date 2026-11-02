import { describe, expect, it } from "vitest";
import {
  ACCENT_PRESETS,
  contrastRatio,
  DEFAULT_ACCENT,
  hexToRgb,
  normalizeBrand,
  normalizeUserPreferences,
  primaryCssVars,
  primaryScale,
  userPreferencesUpdateSchema,
} from "./appearance";

describe("primary colour scale", () => {
  it("keeps the hand-tuned CANAVO orange scale exactly (default look unchanged)", () => {
    expect(primaryScale(DEFAULT_ACCENT)).toEqual({
      DEFAULT: "255 107 53",
      "50": "255 243 238",
      "100": "255 227 214",
      "200": "255 196 170",
      "500": "255 107 53",
      "600": "232 84 31",
      "700": "194 66 21",
      fg: "255 255 255",
    });
    expect(primaryScale("#ff6b35")).toEqual(primaryScale(DEFAULT_ACCENT));
  });

  it("tints lighter shades towards white and darker shades towards black", () => {
    const s = primaryScale("#2563EB");
    expect(s.DEFAULT).toBe("37 99 235");
    expect(s["500"]).toBe(s.DEFAULT);
    const lum = (t: string) => t.split(" ").map(Number).reduce((a, b) => a + b, 0);
    expect(lum(s["50"])).toBeGreaterThan(lum(s["100"]));
    expect(lum(s["100"])).toBeGreaterThan(lum(s["200"]));
    expect(lum(s["200"])).toBeGreaterThan(lum(s.DEFAULT));
    expect(lum(s.DEFAULT)).toBeGreaterThan(lum(s["600"]));
    expect(lum(s["600"])).toBeGreaterThan(lum(s["700"]));
    expect(s["50"].split(" ").map(Number).every((c) => c >= 230)).toBe(true);
  });

  it("uses white text on saturated accents and dark text on pale ones", () => {
    for (const p of ACCENT_PRESETS) expect(primaryScale(p.hex).fg, p.name).toBe("255 255 255");
    expect(primaryScale("#FACC15").fg).toBe("23 23 31"); // yellow
    expect(primaryScale("#A3E635").fg).toBe("23 23 31"); // lime
    expect(primaryScale("#FFFFFF").fg).toBe("23 23 31");
  });

  it("every preset keeps its foreground readable", () => {
    for (const p of ACCENT_PRESETS) {
      const s = primaryScale(p.hex);
      const rgb = (t: string) => t.split(" ").map(Number) as [number, number, number];
      expect(contrastRatio(rgb(s.DEFAULT), rgb(s.fg)), p.name).toBeGreaterThanOrEqual(2.5);
    }
  });

  it("emits CSS variables for every shade", () => {
    expect(primaryCssVars("#16A34A")).toMatchObject({ "--primary": "22 163 74", "--primary-fg": "255 255 255" });
    expect(Object.keys(primaryCssVars("#16A34A")).sort()).toEqual(
      ["--primary", "--primary-100", "--primary-200", "--primary-50", "--primary-500", "--primary-600", "--primary-700", "--primary-fg"].sort(),
    );
  });

  it("rejects malformed hex", () => {
    expect(() => hexToRgb("orange")).toThrow();
    expect(hexToRgb("#0d9488")).toEqual([13, 148, 136]);
  });
});

describe("appearance settings", () => {
  it("normalizes stored JSON, dropping invalid fields", () => {
    expect(normalizeBrand({})).toEqual({ accent: "#FF6B35", corners: "rounded" });
    expect(normalizeBrand({ accent: "#2563eb", corners: "square", junk: 1 })).toEqual({ accent: "#2563EB", corners: "square" });
    expect(normalizeBrand({ accent: "blue", corners: "wavy" })).toEqual({ accent: "#FF6B35", corners: "rounded" });
    expect(normalizeUserPreferences(null)).toEqual({ appearance: "system", textSize: "normal", density: "comfortable", accent: null });
    expect(normalizeUserPreferences({ appearance: "dark", textSize: "huge", accent: "#7c3aed" })).toEqual({
      appearance: "dark",
      textSize: "normal",
      density: "comfortable",
      accent: "#7C3AED",
    });
  });

  it("accepts partial updates and rejects unknown keys", () => {
    expect(userPreferencesUpdateSchema.parse({ density: "compact" })).toEqual({ density: "compact" });
    expect(userPreferencesUpdateSchema.parse({ accent: null })).toEqual({ accent: null });
    expect(userPreferencesUpdateSchema.safeParse({ appearance: "neon" }).success).toBe(false);
    expect(userPreferencesUpdateSchema.safeParse({ role: "BUSINESS_OWNER" }).success).toBe(false);
  });
});
