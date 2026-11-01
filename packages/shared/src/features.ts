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
  STRICT_CLOCK_IN: {
    label: "Strict clock-in location",
    description: "Refuse clock-ins from fake (mock) GPS locations and from weak GPS fixes, instead of widening the outlet's allowed distance by the phone's GPS error.",
    requires: ["ATTENDANCE"],
  },
  CLOCK_IN_SELFIE: {
    label: "Selfie at clock-in",
    description: "Staff take a selfie when they clock in on the app. Managers can see it with the attendance record. (No face matching.)",
    requires: ["ATTENDANCE"],
  },
  APPROVAL_PINS: {
    label: "Manager approval PINs",
    description: "Voids, refunds and discounts above the outlet's limit need a manager's or owner's PIN at the counter. Cashiers can then void or refund with that approval. Every approval appears in the exceptions report.",
    requires: ["BILLING"],
  },
  REQUIRE_CASH_SHIFT: {
    label: "Cash shift required",
    description: "Cash payments can only be taken while a cash shift is open at the outlet (opening float counted). Closing the shift prints the Z-report with the cash difference.",
    requires: ["BILLING"],
  },
  GIFT_CARDS: {
    label: "Gift cards",
    description: "Sell closed-loop gift cards (usable only at this hotel, no cash-out) and accept them as payment. GST applies when the card is spent, not when it's sold.",
    requires: ["BILLING"],
  },
  OFFLINE_INVOICE_SERIES: {
    label: "Final invoice numbers offline",
    description: "Each billing device gets its own invoice series (e.g. INVA1-2026-00007), so bills raised offline print their final GST invoice number instead of a provisional one.",
    requires: ["BILLING"],
  },
  REQUIRE_2FA: {
    label: "Require two-step login for owners and managers",
    description: "Owners and outlet managers must turn on two-step login (authenticator app) before they can use the app. Other staff can still choose to.",
    requires: [],
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
