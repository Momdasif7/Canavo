import type { ModuleKey } from "./modules";

/**
 * Per-hotel feature flags. Modules are what a hotel pays for; flags switch on
 * individual capabilities (new behaviour) and are controlled by the platform
 * Super Admin. Every flag is OFF unless explicitly enabled for a business, so
 * shipping a new capability never changes behaviour for existing hotels.
 */
export interface FeatureInfo {
  label: string;
  description: string;
  /** Modules the business must have for the flag to take effect */
  requires: ModuleKey[];
}

export const FEATURES = {
  AUTO_STOCK_OUT: {
    label: "Automatic out of stock",
    description: "Menu items (or sizes) whose ingredient stock can't cover one portion become unavailable on the POS, and come back when restocked.",
    requires: ["INVENTORY"],
  },
} as const satisfies Record<string, FeatureInfo>;

export type FeatureKey = keyof typeof FEATURES;
export const FEATURE_KEYS = Object.keys(FEATURES) as FeatureKey[];

export type FeatureFlags = Partial<Record<FeatureKey, boolean>>;

/** Keep only known flags with boolean values (stored JSON may contain anything). */
export function normalizeFeatures(raw: unknown): FeatureFlags {
  const out: FeatureFlags = {};
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    for (const k of FEATURE_KEYS) if (typeof (raw as Record<string, unknown>)[k] === "boolean") out[k] = (raw as Record<string, boolean>)[k];
  }
  return out;
}

/** A flag is effective when it's on AND every module it requires is enabled (modules null = platform scope). */
export function featureEnabled(flags: FeatureFlags | null | undefined, key: FeatureKey, modules: readonly string[] | null | undefined): boolean {
  if (!flags?.[key]) return false;
  return !modules || FEATURES[key].requires.every((m) => modules.includes(m));
}
