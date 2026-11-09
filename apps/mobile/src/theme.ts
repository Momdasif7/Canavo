import { useColorScheme } from "react-native";

export const brand = {
  /** CANAVO orange: 5.18:1 with white text (WCAG AA). */
  saffron: "#C2410C",
  /** Pressed / darker variant. */
  saffronDark: "#9A3412",
  /** Bright orange for dark backgrounds (use dark text on it: 6.3:1). */
  saffronBright: "#FF6B35",
  forest: "#2D6A4F",
  forestLight: "#40916C",
  veg: "#1B873F",
  nonVeg: "#B3261E",
  egg: "#E0A800",
};

export interface Palette {
  bg: string;
  surface: string;
  surfaceAlt: string;
  text: string;
  textMuted: string;
  border: string;
  primary: string;
  primaryText: string;
  success: string;
  danger: string;
  warning: string;
  info: string;
  dangerBg: string;
  successBg: string;
  warningBg: string;
}

const light: Palette = {
  bg: "#FAFAF8",
  surface: "#FFFFFF",
  surfaceAlt: "#F1EFEA",
  text: "#1A1A2E",
  textMuted: "#5F6070",
  border: "#E3E1DB",
  primary: brand.saffron,
  primaryText: "#FFFFFF",
  success: brand.forest,
  danger: "#C62828",
  warning: "#B26A00",
  info: "#1565C0",
  dangerBg: "#FDECEA",
  successBg: "#E3F2EA",
  warningBg: "#FFF4E0",
};

const dark: Palette = {
  bg: "#1A1A2E",
  surface: "#24243A",
  surfaceAlt: "#2E2E48",
  text: "#F5F5F2",
  textMuted: "#B0B0C0",
  border: "#3A3A55",
  primary: brand.saffronBright,
  primaryText: "#17171F",
  success: brand.forestLight,
  danger: "#EF5350",
  warning: "#FFB74D",
  info: "#64B5F6",
  dangerBg: "#3B2025",
  successBg: "#1E3A2E",
  warningBg: "#3A2E1A",
};

export function useTheme(): Palette {
  return useColorScheme() === "dark" ? dark : light;
}

/** Minimum touch target (dp) — counter staff tap with greasy fingers. */
export const TAP = 52;

export const radius = { sm: 8, md: 12, lg: 18, pill: 999 };
export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 };
export const font = { sm: 13, md: 15, lg: 18, xl: 22, xxl: 30, huge: 40 };
