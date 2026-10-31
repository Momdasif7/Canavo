/**
 * In-progress bill persistence (per user + outlet). Pure serialise / restore
 * so it can be round-trip tested from node; <CartProvider> stores the string
 * in the SQLite key/value table.
 */
import type { OrderType } from "../lib/types";
import { emptyDelivery, initialCart, isCartEmpty, type CartLine, type CartState } from "./cart";

export const CART_STORE_VERSION = 1;
/** Carts older than this are dropped on restore (yesterday's half-bill is noise). */
export const CART_MAX_AGE_MS = 24 * 60 * 60_000;

export const cartStorageKey = (userId: string, outletId: string) => `cart:v${CART_STORE_VERSION}:${userId}:${outletId}`;

interface StoredCart {
  v: number;
  savedAt: number;
  state: CartState;
}

/** Cart → JSON for storage; null when the cart is empty (delete the key instead). */
export function serializeCart(state: CartState, now = Date.now()): string | null {
  if (isCartEmpty(state)) return null;
  const stored: StoredCart = { v: CART_STORE_VERSION, savedAt: now, state };
  return JSON.stringify(stored);
}

const ORDER_TYPES: OrderType[] = ["DINE_IN", "TAKEAWAY", "DELIVERY", "PRE_ORDER"];
const str = (v: unknown, d = "") => (typeof v === "string" ? v : d);
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

function validLine(l: unknown): l is CartLine {
  if (!l || typeof l !== "object") return false;
  const x = l as Partial<CartLine>;
  return (
    typeof x.key === "string" &&
    !!x.item &&
    typeof x.item.id === "string" &&
    typeof x.quantity === "number" &&
    x.quantity > 0 &&
    typeof x.unitPrice === "number" &&
    Array.isArray(x.addons)
  );
}

/**
 * Stored JSON (string or already-parsed value) → cart state, or null when it
 * is missing, corrupt, from another version or too old. Unknown / missing
 * fields fall back to defaults so an older save never crashes the POS.
 */
export function restoreCart(raw: unknown, now = Date.now()): CartState | null {
  let parsed: unknown = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!parsed || typeof parsed !== "object") return null;
  const stored = parsed as Partial<StoredCart>;
  if (stored.v !== CART_STORE_VERSION || !stored.state || typeof stored.state !== "object") return null;
  if (typeof stored.savedAt === "number" && now - stored.savedAt > CART_MAX_AGE_MS) return null;
  const s = stored.state as Partial<CartState>;
  const d = (s.delivery ?? {}) as Partial<CartState["delivery"]>;
  const state: CartState = {
    ...initialCart,
    lines: Array.isArray(s.lines) ? s.lines.filter(validLine).map((l) => ({ ...l, variant: l.variant ?? null })) : [],
    orderType: ORDER_TYPES.includes(s.orderType as OrderType) ? (s.orderType as OrderType) : initialCart.orderType,
    tableLabel: str(s.tableLabel),
    customerPhone: str(s.customerPhone),
    customerName: str(s.customerName),
    couponCode: str(s.couponCode),
    redeemPoints: Math.max(0, Math.floor(num(s.redeemPoints) ?? 0)),
    scheduledFor: typeof s.scheduledFor === "string" ? s.scheduledFor : null,
    delivery: {
      ...emptyDelivery,
      address: str(d.address),
      landmark: str(d.landmark),
      latitude: num(d.latitude),
      longitude: num(d.longitude),
      zoneId: typeof d.zoneId === "string" ? d.zoneId : undefined,
      agentId: typeof d.agentId === "string" ? d.agentId : undefined,
      cod: d.cod === true,
    },
    dismissedOffers: Array.isArray(s.dismissedOffers) ? s.dismissedOffers.filter((x): x is string => typeof x === "string") : [],
  };
  return isCartEmpty(state) ? null : state;
}
