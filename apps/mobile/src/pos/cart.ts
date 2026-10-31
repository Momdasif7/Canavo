/**
 * Cart model: state, reducer and the cart → POST /orders mapping. Pure (no
 * React / React Native imports) so node scripts can exercise it against the
 * real API. <CartProvider> in ./CartContext wires it to React + persistence.
 */
import type { OrderCreateInput } from "@canavo/shared";
import type { Menu, MenuItem, OrderType, Outlet, PricedOption } from "../lib/types";
import { computeLocalBill, type LocalBill } from "./localBill";

/** Marks a line the POS added automatically for a Buy-X-Get-Y offer. */
export interface FreeTag {
  offerId: string;
  offerName: string;
  /** Discount on this line, 100 = free */
  percent: number;
  label: string;
}

export interface CartLine {
  key: string;
  item: MenuItem;
  variant: PricedOption | null;
  addons: PricedOption[];
  quantity: number;
  /** paise, variant/base price + add-ons */
  unitPrice: number;
  /** Set on lines auto-added for an offer ("FREE · offer") */
  free?: FreeTag;
}

export interface DeliveryDraft {
  address: string;
  landmark: string;
  latitude?: number;
  longitude?: number;
  zoneId?: string;
  /** undefined = auto-assign to an available (on-duty) partner */
  agentId?: string;
  /** Cash on Delivery: nothing is paid now; the partner collects cash at the door */
  cod: boolean;
}

export interface CartState {
  lines: CartLine[];
  orderType: OrderType;
  tableLabel: string;
  customerPhone: string;
  customerName: string;
  /** Applied coupon (validated by the server preview / at charge) */
  couponCode: string;
  /** Loyalty points to redeem; 0 = none. The server caps it per bill. */
  redeemPoints: number;
  /** PRE_ORDER: ISO time the customer wants the food */
  scheduledFor: string | null;
  delivery: DeliveryDraft;
  /** Offers whose free line the cashier removed: not re-added until the cart is cleared */
  dismissedOffers: string[];
}

/** What the free-item sync wants in the cart for one offer. */
export interface FreeTarget {
  key: string;
  item: MenuItem;
  variant: PricedOption | null;
  quantity: number;
  free: FreeTag;
}

export type CartAction =
  | { type: "add"; item: MenuItem; variant: PricedOption | null; addons: PricedOption[]; quantity?: number }
  | { type: "qty"; key: string; delta: number }
  | { type: "remove"; key: string }
  | { type: "orderType"; value: OrderType }
  | { type: "table"; value: string }
  | { type: "phone"; value: string }
  | { type: "name"; value: string }
  | { type: "coupon"; value: string }
  | { type: "points"; value: number }
  | { type: "scheduledFor"; value: string | null }
  | { type: "delivery"; patch: Partial<DeliveryDraft> }
  | { type: "syncFree"; targets: FreeTarget[] }
  | { type: "refreshItems"; menu: Menu }
  | { type: "hydrate"; state: CartState }
  | { type: "clear" };

export const emptyDelivery: DeliveryDraft = { address: "", landmark: "", cod: false };
export const initialCart: CartState = {
  lines: [],
  orderType: "TAKEAWAY",
  tableLabel: "",
  customerPhone: "",
  customerName: "",
  couponCode: "",
  redeemPoints: 0,
  scheduledFor: null,
  delivery: emptyDelivery,
  dismissedOffers: [],
};

export const lineKey = (itemId: string, variantId: string | null, addonIds: string[]) =>
  [itemId, variantId ?? "-", [...addonIds].sort().join("+")].join("|");

/** Free lines never merge with lines the cashier added: one per offer + item + size. */
export const freeLineKey = (offerId: string, menuItemId: string, variantId: string | null) =>
  `free:${offerId}:${menuItemId}|${variantId ?? "-"}`;

const dismiss = (state: CartState, line: CartLine | undefined): string[] =>
  line?.free && !state.dismissedOffers.includes(line.free.offerId) ? [...state.dismissedOffers, line.free.offerId] : state.dismissedOffers;

/**
 * Make the free lines match the targets exactly (add / resize / remove).
 * Returns the same array when nothing changes, so the sync never loops.
 */
export function reconcileFreeLines(lines: CartLine[], targets: FreeTarget[], dismissed: string[]): CartLine[] {
  const wanted = new Map(targets.filter((t) => t.quantity > 0 && !dismissed.includes(t.free.offerId)).map((t) => [t.key, t]));
  let changed = false;
  const next: CartLine[] = [];
  for (const l of lines) {
    if (!l.free) {
      next.push(l);
      continue;
    }
    const t = wanted.get(l.key);
    if (!t) {
      changed = true; // no longer qualifies
      continue;
    }
    wanted.delete(l.key);
    if (t.quantity !== l.quantity || t.free.percent !== l.free.percent || t.free.label !== l.free.label) {
      changed = true;
      next.push({ ...l, quantity: t.quantity, free: t.free });
    } else next.push(l);
  }
  for (const t of wanted.values()) {
    changed = true;
    const unitPrice = t.variant?.price ?? t.item.price;
    next.push({ key: t.key, item: t.item, variant: t.variant, addons: [], quantity: t.quantity, unitPrice, free: t.free });
  }
  return changed ? next : lines;
}

/**
 * Re-price restored lines against the current menu: fresh item data and
 * prices; lines whose item / size / add-on is gone (or hidden) are dropped.
 * Returns the same array when nothing changes.
 */
export function refreshLines(lines: CartLine[], menu: Menu): CartLine[] {
  const byId = new Map(menu.items.map((i) => [i.id, i]));
  let changed = false;
  const next: CartLine[] = [];
  for (const l of lines) {
    const item = byId.get(l.item.id);
    const variant = l.variant ? item?.variants.find((v) => v.id === l.variant!.id) ?? null : null;
    const addons = item ? l.addons.map((a) => item.addons.find((x) => x.id === a.id)) : [];
    if (!item || item.status === "HIDDEN" || (l.variant && !variant) || addons.some((a) => !a)) {
      changed = true;
      continue;
    }
    const fresh = addons as PricedOption[];
    const unitPrice = (variant?.price ?? item.price) + fresh.reduce((s, a) => s + a.price, 0);
    const same = unitPrice === l.unitPrice && (item === l.item || JSON.stringify(item) === JSON.stringify(l.item));
    if (same) next.push(l);
    else {
      changed = true;
      next.push({ ...l, item, variant, addons: fresh, unitPrice });
    }
  }
  return changed ? next : lines;
}

export function cartReducer(state: CartState, a: CartAction): CartState {
  switch (a.type) {
    case "add": {
      const key = lineKey(a.item.id, a.variant?.id ?? null, a.addons.map((x) => x.id));
      const qty = a.quantity ?? 1;
      const existing = state.lines.find((l) => l.key === key);
      if (existing) {
        return { ...state, lines: state.lines.map((l) => (l.key === key ? { ...l, quantity: Math.min(999, l.quantity + qty) } : l)) };
      }
      const unitPrice = (a.variant?.price ?? a.item.price) + a.addons.reduce((s, x) => s + x.price, 0);
      return {
        ...state,
        lines: [...state.lines, { key, item: a.item, variant: a.variant, addons: a.addons, quantity: qty, unitPrice }],
      };
    }
    case "qty": {
      const line = state.lines.find((l) => l.key === a.key);
      if (!line) return state;
      const quantity = Math.min(999, line.quantity + a.delta);
      if (quantity <= 0) {
        return { ...state, lines: state.lines.filter((l) => l.key !== a.key), dismissedOffers: dismiss(state, line) };
      }
      return { ...state, lines: state.lines.map((l) => (l.key === a.key ? { ...l, quantity } : l)) };
    }
    case "remove": {
      const line = state.lines.find((l) => l.key === a.key);
      return { ...state, lines: state.lines.filter((l) => l.key !== a.key), dismissedOffers: dismiss(state, line) };
    }
    case "orderType":
      return { ...state, orderType: a.value };
    case "table":
      return { ...state, tableLabel: a.value };
    case "phone":
      // A different customer: their points no longer apply.
      return { ...state, customerPhone: a.value, redeemPoints: a.value === state.customerPhone ? state.redeemPoints : 0 };
    case "name":
      return { ...state, customerName: a.value };
    case "coupon":
      return { ...state, couponCode: a.value.trim().toUpperCase() };
    case "points":
      return { ...state, redeemPoints: Math.max(0, Math.floor(a.value)) };
    case "scheduledFor":
      return { ...state, scheduledFor: a.value };
    case "delivery":
      return { ...state, delivery: { ...state.delivery, ...a.patch } };
    case "syncFree": {
      const lines = reconcileFreeLines(state.lines, a.targets, state.dismissedOffers);
      return lines === state.lines ? state : { ...state, lines };
    }
    case "refreshItems": {
      const lines = refreshLines(state.lines, a.menu);
      return lines === state.lines ? state : { ...state, lines };
    }
    case "hydrate":
      return a.state;
    case "clear":
      return { ...initialCart, orderType: state.orderType };
  }
}

/** True when there's nothing worth keeping (persisted carts are deleted). */
export function isCartEmpty(s: CartState): boolean {
  return (
    !s.lines.length &&
    !s.customerPhone &&
    !s.customerName &&
    !s.couponCode &&
    !s.tableLabel &&
    !s.scheduledFor &&
    !s.delivery.address &&
    !s.delivery.landmark &&
    s.delivery.latitude == null
  );
}

export function billFor(state: Pick<CartState, "lines" | "orderType">, outlet: Outlet | null): LocalBill | null {
  if (!outlet || !state.lines.length) return null;
  return computeLocalBill(
    state.lines.map((l) => ({ item: l.item, unitPrice: l.unitPrice, quantity: l.quantity, discountPercent: l.free?.percent })),
    outlet,
    state.orderType,
  );
}

export const isIndianMobile = (v: string) => /^[6-9]\d{9}$/.test(v.trim());

/**
 * Cart → POST /orders body.
 * - `offline`: bills queued for /orders/sync carry no coupon/points (they
 *   can't be validated offline and would fail the sync).
 * - `preview`: body for POST /customers/preview-promotions while the cashier
 *   is still typing — incomplete delivery/pre-order details are priced as a
 *   takeaway so the preview doesn't error on every keystroke.
 * - `withoutFree`: leave out auto-added free lines (to ask the server how many
 *   free items the cart qualifies for in total).
 *
 * Free lines are ordinary items on the order: the server's offer engine
 * discounts them.
 */
export function toOrderInput(
  state: CartState,
  extra: { clientOrderId?: string; createdAt?: string; offline?: boolean; preview?: boolean; withoutFree?: boolean } = {},
): OrderCreateInput {
  const phone = state.customerPhone.trim();
  const name = state.customerName.trim();
  const validPhone = isIndianMobile(phone) ? phone : undefined;
  let orderType = state.orderType;
  const d = state.delivery;
  const deliveryReady = d.address.trim().length >= 5;
  if (extra.preview && orderType === "DELIVERY" && !deliveryReady) orderType = "TAKEAWAY";
  if (extra.preview && orderType === "PRE_ORDER" && !state.scheduledFor) orderType = "TAKEAWAY";
  const promos = !extra.offline;
  const lines = extra.withoutFree ? state.lines.filter((l) => !l.free) : state.lines;
  return {
    clientOrderId: extra.clientOrderId,
    createdAt: extra.createdAt,
    orderType,
    tableLabel: orderType === "DINE_IN" && state.tableLabel.trim() ? state.tableLabel.trim() : undefined,
    customerPhone: validPhone,
    customerName: name || (extra.preview && orderType === "DELIVERY" ? "Customer" : undefined),
    interState: false,
    items: lines.map((l) => ({
      menuItemId: l.item.id,
      variantId: l.variant?.id,
      addonIds: l.addons.map((x) => x.id),
      quantity: l.quantity,
    })),
    couponCode: promos && state.couponCode ? state.couponCode : undefined,
    redeemPoints: promos && validPhone && state.redeemPoints > 0 ? state.redeemPoints : undefined,
    scheduledFor: orderType === "PRE_ORDER" && state.scheduledFor ? state.scheduledFor : undefined,
    delivery:
      orderType === "DELIVERY"
        ? {
            address: d.address.trim(),
            landmark: d.landmark.trim() || undefined,
            latitude: d.latitude,
            longitude: d.longitude,
            zoneId: d.zoneId,
            // No agent → the server auto-assigns an on-duty partner.
            agentId: d.agentId,
            source: "PHONE",
            // COD needs a connection; never on a preview or an offline-queued bill.
            cod: d.cod && !extra.preview && !extra.offline,
          }
        : undefined,
  };
}
