import React, { createContext, useContext, useEffect, useMemo, useReducer, useRef } from "react";
import { AppState } from "react-native";
import { useAuth } from "../auth/AuthContext";
import { kvDel, kvGet, kvSet } from "../lib/db";
import type { Menu, MenuItem, OrderType, PricedOption } from "../lib/types";
import { cartReducer, initialCart, type CartState, type DeliveryDraft, type FreeTarget } from "./cart";
import { cartStorageKey, restoreCart, serializeCart } from "./cartPersist";

// The model lives in ./cart (pure, node-testable); re-exported for existing imports.
export {
  billFor,
  freeLineKey,
  isIndianMobile,
  lineKey,
  toOrderInput,
  type CartLine,
  type CartState,
  type DeliveryDraft,
  type FreeTag,
  type FreeTarget,
} from "./cart";

const SAVE_DEBOUNCE_MS = 400;

interface CartApi {
  state: CartState;
  count: number;
  /** False until the saved bill for this user + outlet has been restored */
  hydrated: boolean;
  add: (item: MenuItem, variant?: PricedOption | null, addons?: PricedOption[], quantity?: number) => void;
  changeQty: (key: string, delta: number) => void;
  remove: (key: string) => void;
  setOrderType: (t: OrderType) => void;
  setTable: (v: string) => void;
  setPhone: (v: string) => void;
  setName: (v: string) => void;
  setCoupon: (v: string) => void;
  setRedeemPoints: (v: number) => void;
  setScheduledFor: (v: string | null) => void;
  patchDelivery: (patch: Partial<DeliveryDraft>) => void;
  /** Make the auto-added free lines match the offers the cart qualifies for */
  syncFree: (targets: FreeTarget[]) => void;
  /** Re-price lines against a freshly loaded menu (restored carts) */
  refreshItems: (menu: Menu) => void;
  clear: () => void;
}

const CartContext = createContext<CartApi | null>(null);

/**
 * The in-progress bill. Survives tab switches (it lives above the navigator)
 * and app restarts: it's saved per user + outlet in SQLite and restored when
 * that user / outlet becomes active. Cleared after a charge or "Clear".
 */
export function CartProvider({ children }: { children: React.ReactNode }) {
  const { me, outlet } = useAuth();
  const storageKey = me && outlet ? cartStorageKey(me.id, outlet.id) : null;
  const [state, dispatch] = useReducer(cartReducer, initialCart);
  const [hydratedKey, setHydratedKey] = React.useState<string | null>(null);
  const latest = useRef({ state, key: hydratedKey });
  latest.current = { state, key: hydratedKey };
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flush = (key: string | null, s: CartState) => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (!key) return;
    const json = serializeCart(s);
    void (json ? kvSet(key, json) : kvDel(key)).catch(() => undefined);
  };

  // Restore when the user / outlet changes (saving the previous cart first).
  useEffect(() => {
    const prev = latest.current;
    if (prev.key && prev.key !== storageKey) flush(prev.key, prev.state);
    setHydratedKey(null);
    dispatch({ type: "hydrate", state: initialCart });
    if (!storageKey) return;
    let cancelled = false;
    kvGet<string>(storageKey)
      .then((row) => {
        if (cancelled) return;
        const restored = row ? restoreCart(row.value) : null;
        if (restored) dispatch({ type: "hydrate", state: restored });
        setHydratedKey(storageKey);
      })
      .catch(() => {
        if (!cancelled) setHydratedKey(storageKey);
      });
    return () => {
      cancelled = true;
    };
  }, [storageKey]);

  // Save (debounced) after every change once restored.
  useEffect(() => {
    if (!hydratedKey) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => flush(hydratedKey, state), SAVE_DEBOUNCE_MS);
  }, [state, hydratedKey]);

  // Going to the background: save now (the OS may kill the app).
  useEffect(() => {
    const sub = AppState.addEventListener("change", (s) => {
      if (s !== "active") flush(latest.current.key, latest.current.state);
    });
    return () => sub.remove();
  }, []);

  // Stable action functions (dispatch never changes), so effects can depend on them.
  const actions = useMemo(
    () => ({
      add: (item: MenuItem, variant: PricedOption | null = null, addons: PricedOption[] = [], quantity?: number) =>
        dispatch({ type: "add", item, variant, addons, quantity }),
      changeQty: (key: string, delta: number) => dispatch({ type: "qty", key, delta }),
      remove: (key: string) => dispatch({ type: "remove", key }),
      setOrderType: (value: OrderType) => dispatch({ type: "orderType", value }),
      setTable: (value: string) => dispatch({ type: "table", value }),
      setPhone: (value: string) => dispatch({ type: "phone", value }),
      setName: (value: string) => dispatch({ type: "name", value }),
      setCoupon: (value: string) => dispatch({ type: "coupon", value }),
      setRedeemPoints: (value: number) => dispatch({ type: "points", value }),
      setScheduledFor: (value: string | null) => dispatch({ type: "scheduledFor", value }),
      patchDelivery: (patch: Partial<DeliveryDraft>) => dispatch({ type: "delivery", patch }),
      syncFree: (targets: FreeTarget[]) => dispatch({ type: "syncFree", targets }),
      refreshItems: (menu: Menu) => dispatch({ type: "refreshItems", menu }),
      clear: () => {
        dispatch({ type: "clear" });
        // Delete right away: a charge followed by an app kill must not bring the bill back.
        const key = latest.current.key;
        if (timer.current) clearTimeout(timer.current);
        if (key) void kvDel(key).catch(() => undefined);
      },
    }),
    [],
  );

  const value = useMemo<CartApi>(
    () => ({ ...actions, state, count: state.lines.reduce((s, l) => s + l.quantity, 0), hydrated: !!hydratedKey }),
    [actions, state, hydratedKey],
  );
  return <CartContext.Provider value={value}>{children}</CartContext.Provider>;
}

export function useCart(): CartApi {
  const ctx = useContext(CartContext);
  if (!ctx) throw new Error("useCart must be used inside <CartProvider>");
  return ctx;
}
