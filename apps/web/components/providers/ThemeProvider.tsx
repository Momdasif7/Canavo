"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { normalizeBrand, normalizeUserPreferences, primaryCssVars, type Brand, type UserPreferences } from "@canavo/shared";

type Theme = "light" | "dark";
/** light | dark | system (older builds stored only light / dark) */
const THEME_KEY = "canavo.theme";
/** Cached look { prefs, brand, vars } so the first paint already has the right colours and sizes */
const LOOK_KEY = "canavo.look";

/**
 * Runs before hydration (inlined in <head>) so the first paint uses the right theme, accent
 * colour (CSS variables), text size, density and corners from the last session on this device.
 */
export const themeInitScript = `(function(){try{var d=document.documentElement,t=localStorage.getItem("${THEME_KEY}");if(t==="dark"||((!t||t==="system")&&matchMedia("(prefers-color-scheme: dark)").matches))d.classList.add("dark");var l=JSON.parse(localStorage.getItem("${LOOK_KEY}")||"null");if(l){for(var k in l.vars)d.style.setProperty(k,l.vars[k]);d.dataset.text=l.prefs.textSize;d.dataset.density=l.prefs.density;d.dataset.corners=l.brand.corners}}catch(e){}})()`;

interface ThemeValue {
  /** The resolved light / dark theme on screen */
  theme: Theme;
  /** Flip light ↔ dark (saved as the user's appearance preference when signed in) */
  toggle: () => void;
  /** This user's own preferences (applied on screen) */
  prefs: UserPreferences;
  /** The business brand on screen (may be an unsaved preview) */
  brand: Brand;
  /** Accent on screen: the user's own, else the business brand's */
  accent: string;
  /** Change own preferences: applied at once and saved to the account when signed in */
  setPrefs: (patch: Partial<UserPreferences>) => void;
  /** Show a brand (saved, or a live preview); saving it is the caller's job */
  setBrand: (brand: Brand) => void;
  /** Load what the server says (sign-in, /auth/me) without saving anything back */
  hydrate: (prefs: UserPreferences, brand: Brand) => void;
  /** The signed-in session registers how to save preference changes (null when signed out) */
  setPersister: (fn: ((patch: Partial<UserPreferences>) => void) | null) => void;
}

const DEFAULT_PREFS = normalizeUserPreferences({});
const DEFAULT_BRAND = normalizeBrand({});

const ThemeContext = createContext<ThemeValue>({
  theme: "light",
  toggle: () => {},
  prefs: DEFAULT_PREFS,
  brand: DEFAULT_BRAND,
  accent: DEFAULT_BRAND.accent,
  setPrefs: () => {},
  setBrand: () => {},
  hydrate: () => {},
  setPersister: () => {},
});

const systemDark = () => typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches;
const resolve = (prefs: UserPreferences): Theme => (prefs.appearance === "dark" || (prefs.appearance === "system" && systemDark()) ? "dark" : "light");

/** Put the look on <html> and cache it for the next first paint. */
function applyLook(prefs: UserPreferences, brand: Brand): Theme {
  const theme = resolve(prefs);
  const root = document.documentElement;
  root.classList.toggle("dark", theme === "dark");
  const vars = primaryCssVars(prefs.accent ?? brand.accent);
  for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
  root.dataset.text = prefs.textSize;
  root.dataset.density = prefs.density;
  root.dataset.corners = brand.corners;
  try {
    localStorage.setItem(THEME_KEY, prefs.appearance);
    localStorage.setItem(LOOK_KEY, JSON.stringify({ prefs, brand, vars }));
  } catch {
    /* ignore */
  }
  return theme;
}

function readCache(): { prefs: UserPreferences; brand: Brand } {
  try {
    const look = JSON.parse(localStorage.getItem(LOOK_KEY) ?? "null") as { prefs?: unknown; brand?: unknown } | null;
    const t = localStorage.getItem(THEME_KEY);
    const prefs = normalizeUserPreferences(look?.prefs);
    // The light / dark choice from before this build (or made on the login page) lives in THEME_KEY.
    if (t === "light" || t === "dark" || t === "system") prefs.appearance = t;
    return { prefs, brand: normalizeBrand(look?.brand) };
  } catch {
    return { prefs: DEFAULT_PREFS, brand: DEFAULT_BRAND };
  }
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setTheme] = useState<Theme>("light");
  const [prefs, setPrefsState] = useState<UserPreferences>(DEFAULT_PREFS);
  const [brand, setBrandState] = useState<Brand>(DEFAULT_BRAND);
  const persister = useRef<((patch: Partial<UserPreferences>) => void) | null>(null);
  // Latest values for the callbacks below (stable callbacks, no stale closures).
  const look = useRef({ prefs: DEFAULT_PREFS, brand: DEFAULT_BRAND });

  const show = useCallback((p: UserPreferences, b: Brand) => {
    look.current = { prefs: p, brand: b };
    setPrefsState(p);
    setBrandState(b);
    setTheme(applyLook(p, b));
  }, []);

  useEffect(() => {
    const cached = readCache();
    show(cached.prefs, cached.brand);
  }, [show]);

  // "System" follows the device switching between light and dark.
  useEffect(() => {
    if (prefs.appearance !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => setTheme(applyLook(look.current.prefs, look.current.brand));
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [prefs.appearance]);

  const setPrefs = useCallback(
    (patch: Partial<UserPreferences>) => {
      show({ ...look.current.prefs, ...patch }, look.current.brand);
      persister.current?.(patch);
    },
    [show],
  );
  const setBrand = useCallback((b: Brand) => show(look.current.prefs, b), [show]);
  const hydrate = useCallback((p: UserPreferences, b: Brand) => show(p, b), [show]);
  const setPersister = useCallback((fn: ((patch: Partial<UserPreferences>) => void) | null) => {
    persister.current = fn;
  }, []);
  const toggle = useCallback(() => setPrefs({ appearance: resolve(look.current.prefs) === "dark" ? "light" : "dark" }), [setPrefs]);

  const value = useMemo(
    () => ({ theme, toggle, prefs, brand, accent: prefs.accent ?? brand.accent, setPrefs, setBrand, hydrate, setPersister }),
    [theme, toggle, prefs, brand, setPrefs, setBrand, hydrate, setPersister],
  );
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export const useTheme = () => useContext(ThemeContext);
