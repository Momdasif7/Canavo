import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: "class",
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}", "./hooks/**/*.{ts,tsx}", "./lib/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Accent scale backed by CSS variables (globals.css; set at runtime from the business brand or the
        // user's own accent — see primaryScale in @canavo/shared). `fg` is readable text on a solid accent.
        primary: {
          DEFAULT: "rgb(var(--primary) / <alpha-value>)",
          50: "rgb(var(--primary-50) / <alpha-value>)",
          100: "rgb(var(--primary-100) / <alpha-value>)",
          200: "rgb(var(--primary-200) / <alpha-value>)",
          500: "rgb(var(--primary-500) / <alpha-value>)",
          600: "rgb(var(--primary-600) / <alpha-value>)",
          700: "rgb(var(--primary-700) / <alpha-value>)",
          fg: "rgb(var(--primary-fg) / <alpha-value>)",
        },
        secondary: {
          DEFAULT: "#2D6A4F",
          50: "#EAF4EF",
          100: "#D2E8DC",
          500: "#2D6A4F",
          600: "#245740",
          700: "#1B4332",
        },
        // Semantic surface tokens backed by CSS variables (see globals.css) so dark mode is one class flip.
        bg: "rgb(var(--bg) / <alpha-value>)",
        surface: "rgb(var(--surface) / <alpha-value>)",
        "surface-2": "rgb(var(--surface-2) / <alpha-value>)",
        fg: "rgb(var(--fg) / <alpha-value>)",
        muted: "rgb(var(--muted) / <alpha-value>)",
        line: "rgb(var(--line) / <alpha-value>)",
        veg: "#16A34A",
        nonveg: "#DC2626",
        egg: "#A16207",
      },
      fontFamily: {
        sans: ["var(--font-inter)", "system-ui", "sans-serif"],
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "Consolas", "monospace"],
      },
      // Touch target; 40px in the compact density (globals.css)
      minHeight: { tap: "var(--tap)" },
      minWidth: { tap: "var(--tap)" },
      // Corner radii as variables so the business's "square" corner style can tighten them all at once.
      borderRadius: {
        sm: "var(--radius-sm)",
        DEFAULT: "var(--radius)",
        md: "var(--radius-md)",
        lg: "var(--radius-lg)",
        xl: "var(--radius-xl)",
        "2xl": "var(--radius-2xl)",
        "3xl": "var(--radius-3xl)",
      },
      keyframes: {
        "draw-check": { from: { strokeDashoffset: "48" }, to: { strokeDashoffset: "0" } },
        "pop-in": { "0%": { transform: "scale(0.6)", opacity: "0" }, "100%": { transform: "scale(1)", opacity: "1" } },
        "slide-in-right": { from: { transform: "translateX(100%)" }, to: { transform: "translateX(0)" } },
        "fade-in": { from: { opacity: "0" }, to: { opacity: "1" } },
      },
      animation: {
        "draw-check": "draw-check 0.45s ease-out 0.25s both",
        "pop-in": "pop-in 0.3s cubic-bezier(.2,1.4,.4,1) both",
        "slide-in-right": "slide-in-right 0.2s ease-out both",
        "fade-in": "fade-in 0.15s ease-out both",
      },
    },
  },
  plugins: [],
};

export default config;
