/**
 * Appearance: the business brand (accent colour, corner style — set by the owner,
 * applies to everyone in the business) and each user's own preferences
 * (light / dark, text size, density, optional personal accent — saved on their account).
 */
import { z } from "zod";

/**
 * CANAVO orange — the default accent. A deep orange (5.18:1 against white) so white button text
 * meets WCAG AA; the original bright #FF6B35 (2.8:1) is kept as LEGACY_ACCENT for businesses that
 * saved it explicitly and as the dark-theme default (where it is the readable one).
 */
export const DEFAULT_ACCENT = "#C2410C";
/** The pre-2026-11 brand orange (fails AA with white text; still valid as a custom colour). */
export const LEGACY_ACCENT = "#FF6B35";

/** Accent presets offered in the Appearance page (any other hex is allowed too). */
export const ACCENT_PRESETS = [
  { name: "CANAVO orange", hex: "#C2410C" },
  { name: "Ocean blue", hex: "#2563EB" },
  { name: "Leaf green", hex: "#16A34A" },
  { name: "Royal purple", hex: "#7C3AED" },
  { name: "Maroon", hex: "#B91C1C" },
  { name: "Teal", hex: "#0D9488" },
  { name: "Slate", hex: "#475569" },
  { name: "Pink", hex: "#DB2777" },
] as const;

const hexColor = z
  .string()
  .trim()
  .regex(/^#[0-9a-fA-F]{6}$/, "Colour must be a hex value like #C2410C")
  .transform((s) => s.toUpperCase());

export const CORNER_STYLES = ["rounded", "square"] as const;
export type CornerStyle = (typeof CORNER_STYLES)[number];

export const brandSchema = z
  .object({
    accent: hexColor.default(DEFAULT_ACCENT),
    corners: z.enum(CORNER_STYLES).default("rounded"),
  })
  .strict();
export type Brand = z.infer<typeof brandSchema>;

export const APPEARANCE_MODES = ["light", "dark", "system"] as const;
export type AppearanceMode = (typeof APPEARANCE_MODES)[number];
export const TEXT_SIZES = ["small", "normal", "large"] as const;
export type TextSize = (typeof TEXT_SIZES)[number];
export const DENSITIES = ["comfortable", "compact"] as const;
export type Density = (typeof DENSITIES)[number];

export const userPreferencesSchema = z
  .object({
    appearance: z.enum(APPEARANCE_MODES).default("system"),
    textSize: z.enum(TEXT_SIZES).default("normal"),
    density: z.enum(DENSITIES).default("comfortable"),
    /** Personal accent overriding the business brand colour; null = use the business colour */
    accent: hexColor.nullable().default(null),
  })
  .strict();
export type UserPreferences = z.infer<typeof userPreferencesSchema>;

/** PUT /auth/me/preferences: any subset; missing fields keep their saved value. */
export const userPreferencesUpdateSchema = z
  .object({
    appearance: z.enum(APPEARANCE_MODES),
    textSize: z.enum(TEXT_SIZES),
    density: z.enum(DENSITIES),
    accent: hexColor.nullable(),
  })
  .partial()
  .strict();

/** Stored JSON → a valid brand (unknown / invalid fields fall back to the defaults). */
export function normalizeBrand(raw: unknown): Brand {
  const obj = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  return {
    accent: hexColor.safeParse(obj.accent).data ?? DEFAULT_ACCENT,
    corners: z.enum(CORNER_STYLES).safeParse(obj.corners).data ?? "rounded",
  };
}

/** Stored JSON → valid preferences (unknown / invalid fields fall back to the defaults). */
export function normalizeUserPreferences(raw: unknown): UserPreferences {
  const obj = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  return {
    appearance: z.enum(APPEARANCE_MODES).safeParse(obj.appearance).data ?? "system",
    textSize: z.enum(TEXT_SIZES).safeParse(obj.textSize).data ?? "normal",
    density: z.enum(DENSITIES).safeParse(obj.density).data ?? "comfortable",
    accent: hexColor.safeParse(obj.accent).data ?? null,
  };
}

// ---------- Colour scale ----------

type Rgb = [number, number, number];

export function hexToRgb(hex: string): Rgb {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());
  if (!m) throw new Error(`Not a hex colour: ${hex}`);
  return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)];
}

const mix = (a: Rgb, b: Rgb, t: number): Rgb => [0, 1, 2].map((i) => Math.round(a[i] + (b[i] - a[i]) * t)) as Rgb;
const WHITE: Rgb = [255, 255, 255];
const BLACK: Rgb = [0, 0, 0];

/** WCAG relative luminance (0 = black, 1 = white). */
export function luminance([r, g, b]: Rgb): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

export function contrastRatio(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** Dark text colour used on pale accents (the light theme's --fg). */
const DARK_FG: Rgb = [23, 23, 31];

export const PRIMARY_SHADES = ["50", "100", "200", "500", "600", "700"] as const;
export type PrimaryShade = (typeof PRIMARY_SHADES)[number];
/** Space-separated "r g b" values, the format the CSS variables use (rgb(var(--primary) / 0.5)). */
export type PrimaryScale = Record<PrimaryShade | "DEFAULT" | "fg", string>;

const triplet = (c: Rgb) => c.join(" ");

/** The hand-tuned CANAVO orange scale (light theme): deep orange, white text, darker on hover / press. */
const DEFAULT_SCALE: PrimaryScale = {
  DEFAULT: "194 65 12", // #C2410C — 5.18:1 with white
  "50": "255 245 240", // #FFF5F0 — #C2410C text on it is 4.8:1
  "100": "255 227 214", // #FFE3D6
  "200": "255 196 170", // #FFC4AA
  "500": "194 65 12",
  "600": "163 52 9", // #A33409 (hover)
  "700": "134 43 8", // #862B08 (pressed / text on tints)
  fg: "255 255 255",
};

/**
 * Dark theme default: on dark surfaces the deep orange is too dim for text (3.3:1), so the default
 * accent switches back to the bright #FF6B35 with dark text on solid fills (6.3:1) — orange text on
 * the dark surfaces is 5.4:1+.
 */
const DEFAULT_DARK_SCALE: PrimaryScale = {
  DEFAULT: "255 107 53", // #FF6B35
  "50": "255 243 238",
  "100": "255 227 214",
  "200": "255 196 170",
  "500": "255 107 53",
  "600": "232 84 31", // #E8541F
  "700": "194 66 21", // #C24215
  fg: "23 23 31",
};

/** The original hand-tuned #FF6B35 scale, kept exactly for businesses that saved that colour. */
const LEGACY_SCALE: PrimaryScale = { ...DEFAULT_DARK_SCALE, fg: "255 255 255" };

export type ThemeMode = "light" | "dark";

/**
 * Tailwind-style shade scale from one accent hex: tints towards white for 50–200,
 * shades towards black for 600 (hover) and 700 (pressed). `fg` is the text colour
 * on a solid accent: white unless the accent is too pale for it (white text reads
 * fine on saturated brand colours down to ~2.5:1, so yellow / lime / pastel accents
 * get dark text instead). The default accent has its own hand-tuned light / dark scales.
 */
export function primaryScale(hex: string, theme: ThemeMode = "light"): PrimaryScale {
  const base = hexToRgb(hex);
  const t = triplet(base);
  if (t === DEFAULT_SCALE.DEFAULT) return { ...(theme === "dark" ? DEFAULT_DARK_SCALE : DEFAULT_SCALE) };
  if (t === LEGACY_SCALE.DEFAULT) return { ...LEGACY_SCALE };
  const fg = contrastRatio(base, WHITE) >= 2.5 ? WHITE : DARK_FG;
  return {
    DEFAULT: t,
    "50": triplet(mix(base, WHITE, 0.92)),
    "100": triplet(mix(base, WHITE, 0.8)),
    "200": triplet(mix(base, WHITE, 0.6)),
    "500": t,
    "600": triplet(mix(base, BLACK, 0.12)),
    "700": triplet(mix(base, BLACK, 0.26)),
    fg: triplet(fg),
  };
}

/** CSS custom properties for a scale: { "--primary": "194 65 12", "--primary-50": ..., "--primary-fg": ... }. */
export function primaryCssVars(hex: string, theme: ThemeMode = "light"): Record<string, string> {
  const s = primaryScale(hex, theme);
  const vars: Record<string, string> = { "--primary": s.DEFAULT, "--primary-fg": s.fg };
  for (const k of PRIMARY_SHADES) vars[`--primary-${k}`] = s[k];
  return vars;
}
