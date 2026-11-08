import { computeBill, gstinProblem, withTaxMode, type BillDiscount, type BillResult, type OrderCreateInput, type TaxConfig } from "@canavo/shared";
import type { DocumentType, FoodType, MenuItem, OrderType, Outlet, TaxDetail, TaxExtra } from "@/lib/types";
import type { FreeItemSuggestion } from "@/lib/types-service";

export type { FreeItemSuggestion };

/** Per-line tax split from the item's tax rate (percentages). */
export interface LineTax {
  cgst: number;
  sgst: number;
  igst: number;
  cess: number;
  extras: TaxExtra[];
}

export interface CartLine {
  /** Identity of an item+variant+addons combination, so repeats increment */
  key: string;
  itemId: string;
  name: string;
  foodType: FoodType;
  gstRate: number;
  /** Item's tax rate (cess / extra taxes) when the API provides one */
  tax?: LineTax;
  variantId?: string;
  variantName?: string;
  addonIds: string[];
  addonNames: string[];
  /** Paise, variant/base price + add-ons */
  unitPrice: number;
  quantity: number;
  notes: string;
  /**
   * Added automatically because the cart qualifies for a Buy X Get Y offer.
   * The server applies the discount; the POS keeps the quantity in sync.
   */
  free?: FreeOffer;
}

export interface FreeOffer {
  offerId: string;
  offerName: string;
  /** 100 = free */
  percent: number;
}

export type DiscountMode = "FLAT" | "PERCENT";

export type DeliverySource = "PHONE" | "IN_APP" | "WALK_IN" | "AGGREGATOR";

export interface DeliveryMeta {
  address: string;
  landmark: string;
  /** 6-digit PIN code (required when the outlet takes addresses without a map) */
  pincode?: string;
  /** Send map coordinates (enables distance-based zone & fee) */
  useCoords: boolean;
  lat: string;
  lng: string;
  /** Manually chosen zone (when no coordinates) */
  zoneId: string;
  agentId: string;
  source: DeliverySource;
  notes: string;
  /** Cash on Delivery: no payment at the counter; the partner collects cash at the door */
  cod: boolean;
}

export const EMPTY_DELIVERY: DeliveryMeta = {
  address: "",
  landmark: "",
  pincode: "",
  useCoords: false,
  lat: "",
  lng: "",
  zoneId: "",
  agentId: "",
  source: "PHONE",
  notes: "",
  cod: false,
};

export interface CartMeta {
  orderType: OrderType;
  tableLabel: string;
  customerName: string;
  customerPhone: string;
  discountMode: DiscountMode;
  /** Raw user input: rupees for FLAT, percent for PERCENT */
  discountInput: string;
  couponCode: string;
  /** Raw points input ("" = don't redeem) */
  redeemPoints: string;
  /** PRE_ORDER: `datetime-local` value (outlet-local wall time) */
  scheduledFor: string;
  delivery: DeliveryMeta;
  /** Phase 5 (CANTEEN): scanned member ("" = none); the company's share is added at billing */
  memberId?: string;
  /** QA 16b: B2B tax invoice — registered buyer's GSTIN and legal name ("" = B2C) */
  buyerGstin?: string;
  buyerName?: string;
}

export const EMPTY_META: CartMeta = {
  orderType: "TAKEAWAY",
  tableLabel: "",
  customerName: "",
  customerPhone: "",
  discountMode: "FLAT",
  discountInput: "",
  couponCode: "",
  redeemPoints: "",
  scheduledFor: "",
  delivery: EMPTY_DELIVERY,
};

/** Parsed coordinates when "use coordinates" is on and both values are valid. */
export function deliveryCoords(d: DeliveryMeta): { lat: number; lng: number } | null {
  if (!d.useCoords) return null;
  const lat = Number(d.lat);
  const lng = Number(d.lng);
  if (!d.lat.trim() || !d.lng.trim() || !Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng };
}

export const pointsToRedeem = (meta: CartMeta): number | undefined => {
  const n = Math.floor(Number(meta.redeemPoints));
  return meta.redeemPoints.trim() && Number.isFinite(n) && n > 0 ? n : undefined;
};

/** Reasons the order can't be charged yet (order-type specific), or null. */
export function metaError(meta: CartMeta): string | null {
  const gstin = meta.buyerGstin?.trim();
  if (gstin) {
    const problem = gstinProblem(gstin);
    if (problem) return problem;
    if ((meta.buyerName?.trim().length ?? 0) < 2) return "Enter the buyer's legal name for a B2B invoice";
  }
  if (meta.orderType === "DELIVERY") {
    if (!meta.customerName.trim() || !meta.customerPhone.trim()) return "Delivery needs the customer's name and phone";
    if (meta.delivery.address.trim().length < 5) return "Enter the delivery address";
    if (meta.delivery.useCoords && !deliveryCoords(meta.delivery)) return "Enter valid latitude and longitude";
    if (meta.delivery.pincode?.trim() && !/^[1-9]\d{5}$/.test(meta.delivery.pincode.trim())) return "Enter a valid 6-digit PIN code";
  }
  if (meta.orderType === "PRE_ORDER") {
    if (!meta.scheduledFor) return "Choose when the pre-order is for";
    const at = new Date(meta.scheduledFor).getTime();
    if (!Number.isFinite(at) || at <= Date.now()) return "Pre-order time must be in the future";
  }
  return null;
}

export function lineKey(itemId: string, variantId: string | undefined, addonIds: string[]) {
  return [itemId, variantId ?? "", [...addonIds].sort().join("+")].join("|");
}

export function makeLine(item: MenuItem, variantId?: string, addonIds: string[] = []): CartLine {
  const variant = variantId ? item.variants.find((v) => v.id === variantId) : undefined;
  const addons = item.addons.filter((a) => addonIds.includes(a.id));
  return {
    key: lineKey(item.id, variant?.id, addons.map((a) => a.id)),
    itemId: item.id,
    name: item.name,
    foodType: item.foodType,
    gstRate: item.taxRate ? Math.round((item.taxRate.cgst + item.taxRate.sgst) * 100) / 100 : item.gstRate,
    tax: item.taxRate
      ? { cgst: item.taxRate.cgst, sgst: item.taxRate.sgst, igst: item.taxRate.igst, cess: item.taxRate.cess, extras: item.taxRate.extras ?? [] }
      : undefined,
    variantId: variant?.id,
    variantName: variant?.name,
    addonIds: addons.map((a) => a.id),
    addonNames: addons.map((a) => a.name),
    // Same rule as the server: variant price replaces the base price.
    unitPrice: (variant?.price ?? item.price) + addons.reduce((s, a) => s + a.price, 0),
    quantity: 1,
    notes: "",
  };
}

/** "Pav buns ran out" for an item that went out of stock automatically, else null. */
export const stockOutNote = (item: Pick<MenuItem, "stockOut" | "stockOutReason">): string | null =>
  item.stockOut ? (item.stockOutReason ? `${item.stockOutReason} ran out` : "An ingredient ran out") : null;

/** The size is out of stock while others still sell. */
export const variantUnavailable = (item: Pick<MenuItem, "unavailableVariantIds">, variantId: string | undefined) =>
  !!variantId && !!item.unavailableVariantIds?.includes(variantId);

/**
 * Warning for a cart line whose item (or size) can't be billed any more
 * (e.g. a restored cart after an ingredient ran out). Null when it's fine.
 */
export function lineStockWarning(line: CartLine, items: MenuItem[]): string | null {
  const item = items.find((i) => i.id === line.itemId);
  if (!item) return null;
  if (item.status === "HIDDEN") return "No longer on the menu — remove it";
  if (item.status === "OUT_OF_STOCK") {
    const note = stockOutNote(item);
    return `Out of stock${note ? ` (${note})` : ""} — remove it`;
  }
  if (variantUnavailable(item, line.variantId)) return `${line.variantName ?? "This size"} is out of stock — remove it or pick another size`;
  return null;
}

/** Badge text for an auto-added offer line. */
export const freeBadge = (f: FreeOffer) => `${f.percent >= 100 ? "FREE" : `${f.percent}% OFF`} · ${f.offerName}`;

/** Discount the server will give an auto-added line (menu-price terms) — used by the local estimate. */
const freeLineDiscount = (l: CartLine) => (l.free ? Math.round((l.unitPrice * l.quantity * Math.min(100, l.free.percent)) / 100) : 0);

/**
 * Bring the auto-added offer lines in line with the server's free-item suggestions.
 * `suggestions` must be computed for the cart *without* the auto-added lines, so each
 * quantity is the full number of free units the cart earns. Offers the cashier removed
 * (`dismissed`) are never re-added. Returns null when nothing changes.
 */
export function reconcileFreeLines(lines: CartLine[], suggestions: FreeItemSuggestion[], dismissed: string[], items: MenuItem[]): CartLine[] | null {
  const wanted = suggestions.filter((s) => s.quantity > 0 && !dismissed.includes(s.offerId));
  let changed = false;
  const out: CartLine[] = [];
  for (const l of lines) {
    if (!l.free) {
      out.push(l);
      continue;
    }
    const sug = wanted.find((s) => s.offerId === l.free!.offerId);
    if (!sug || sug.menuItemId !== l.itemId || (sug.variantId ?? undefined) !== l.variantId) {
      changed = true; // no longer qualifies (or a different free item): drop / re-add below
      continue;
    }
    const qty = Math.min(999, sug.quantity);
    if (qty !== l.quantity || sug.unitPrice !== l.unitPrice || sug.getDiscountPercent !== l.free.percent) {
      changed = true;
      out.push({ ...l, quantity: qty, unitPrice: sug.unitPrice, free: { ...l.free, percent: sug.getDiscountPercent, offerName: sug.offerName } });
    } else out.push(l);
  }
  for (const sug of wanted) {
    if (out.some((l) => l.free?.offerId === sug.offerId)) continue;
    const item = items.find((i) => i.id === sug.menuItemId);
    if (!item) continue;
    const base = makeLine(item, sug.variantId ?? undefined);
    out.push({
      ...base,
      key: `free|${sug.offerId}`,
      variantName: base.variantName ?? sug.variantName ?? undefined,
      unitPrice: sug.unitPrice,
      quantity: Math.min(999, sug.quantity),
      free: { offerId: sug.offerId, offerName: sug.offerName, percent: sug.getDiscountPercent },
    });
    changed = true;
  }
  return changed ? out : null;
}

export function addLine(lines: CartLine[], line: CartLine): CartLine[] {
  const existing = lines.find((l) => l.key === line.key);
  if (existing) return lines.map((l) => (l.key === line.key ? { ...l, quantity: Math.min(999, l.quantity + line.quantity) } : l));
  return [...lines, line];
}

/** Parsed bill discount, or an error message for invalid input. */
export function parseDiscount(meta: CartMeta): { discount?: BillDiscount; error?: string } {
  const raw = meta.discountInput.trim();
  if (!raw) return {};
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return { error: "Enter a valid discount" };
  if (meta.discountMode === "PERCENT") {
    if (n > 100) return { error: "Discount can't exceed 100%" };
    return n ? { discount: { type: "PERCENT", value: n } } : {};
  }
  const paise = Math.round(n * 100);
  return paise ? { discount: { type: "FLAT", value: paise } } : {};
}

export const DEFAULT_TAX: Omit<TaxConfig, "interState"> = {
  pricesIncludeTax: true,
  compositionScheme: false,
  serviceChargeEnabled: false,
  serviceChargePercent: 0,
  roundOff: true,
};

export function taxConfig(outlet: Outlet | null, orderType: OrderType): TaxConfig {
  const base = outlet ?? DEFAULT_TAX;
  return {
    pricesIncludeTax: base.pricesIncludeTax,
    compositionScheme: base.compositionScheme,
    // Mirrors the API: service charge applies to dine-in only.
    serviceChargeEnabled: base.serviceChargeEnabled && orderType === "DINE_IN",
    serviceChargePercent: base.serviceChargePercent,
    roundOff: base.roundOff,
    interState: false,
  };
}

/** Is the outlet GST registered? Older APIs don't send the flag: treat as registered. */
export const gstEnabled = (outlet: Outlet | null) => outlet?.gstEnabled !== false;

/** Local bill result, including the tax fields newer `computeBill` versions add (cess, extra taxes). */
export type LocalBill = Omit<BillResult, "documentType"> & {
  documentType: DocumentType;
  cess?: number;
  otherTaxes?: number;
  taxDetails?: TaxDetail[];
};

/**
 * Local (offline) bill: no promotions; packaging/delivery fee passed in as `extraCharges`.
 * Passes per-line `tax` and `taxEnabled` for the shared computeBill versions that support
 * them; for older versions a GST-off outlet is priced with a zero rate so the totals match.
 */
export function previewBill(lines: CartLine[], outlet: Outlet | null, meta: CartMeta, extraCharges: { label: string; amount: number }[] = []): LocalBill {
  const gstOn = gstEnabled(outlet);
  const input = lines.map((l) => {
    const base = { unitPrice: l.unitPrice, quantity: l.quantity, gstRate: gstOn ? l.gstRate : 0, lineDiscount: freeLineDiscount(l) };
    return gstOn && l.tax ? { ...base, tax: l.tax } : base;
  });
  const config = { ...taxConfig(outlet, meta.orderType), extraCharges: extraCharges.filter((c) => c.amount > 0), taxEnabled: gstOn };
  const d = parseDiscount(meta).discount;
  const bill: LocalBill = computeBill(input, config, d && withTaxMode(d, outlet?.flatDiscountsIncludeTax));
  return gstOn ? bill : { ...bill, documentType: "BILL" };
}

/**
 * Preview body for POST /customers/preview-promotions. Unlike an order it is sent
 * while details are still incomplete (the server reports those as warnings), so
 * free-item suggestions and coupon feedback appear as soon as items are added.
 */
export function toPreviewInput(lines: CartLine[], meta: CartMeta, validPhone: (p: string) => boolean): OrderCreateInput | null {
  if (!lines.length) return null;
  const input = toOrderInput(lines, meta, undefined, true);
  if (input.customerPhone && !validPhone(input.customerPhone)) {
    input.customerPhone = undefined;
    input.redeemPoints = undefined;
  }
  if (input.delivery && input.delivery.address.length < 5) input.delivery = undefined;
  if (input.scheduledFor && new Date(input.scheduledFor).getTime() <= Date.now()) input.scheduledFor = undefined;
  return input;
}

// ---------- In-progress bill persistence (per user + outlet) ----------

export interface SavedCart {
  v: 1;
  userId: string;
  outletId: string;
  lines: CartLine[];
  meta: CartMeta;
  /** Offers whose auto-added free line the cashier removed */
  dismissedOffers: string[];
  /** Idempotency key of the last charge attempt for exactly this cart */
  attempt?: { key: string; id: string | null };
  savedAt: string;
}

const cartStorageKey = (userId: string, outletId: string) => `canavo:pos-cart:${userId}:${outletId}`;

/** Nothing worth keeping: no items and no details typed in. */
export function isBlankCart(lines: CartLine[], meta: CartMeta, dismissed: string[]): boolean {
  return !lines.length && !dismissed.length && JSON.stringify({ ...meta, orderType: EMPTY_META.orderType }) === JSON.stringify(EMPTY_META);
}

export function loadSavedCart(userId: string, outletId: string): SavedCart | null {
  try {
    const raw = window.localStorage.getItem(cartStorageKey(userId, outletId));
    if (!raw) return null;
    const c = JSON.parse(raw) as Partial<SavedCart>;
    // A cart belongs to one user in one outlet.
    if (c.v !== 1 || c.userId !== userId || c.outletId !== outletId || !Array.isArray(c.lines) || !c.meta) return null;
    const lines = c.lines.filter((l): l is CartLine => !!l && typeof l.key === "string" && typeof l.itemId === "string" && Number.isInteger(l.quantity) && l.quantity > 0);
    return {
      v: 1,
      userId,
      outletId,
      lines: lines.map((l) => ({ ...l, addonIds: l.addonIds ?? [], addonNames: l.addonNames ?? [], notes: l.notes ?? "" })),
      meta: { ...EMPTY_META, ...c.meta, delivery: { ...EMPTY_DELIVERY, ...(c.meta.delivery ?? {}) } },
      dismissedOffers: Array.isArray(c.dismissedOffers) ? c.dismissedOffers.filter((x) => typeof x === "string") : [],
      attempt: c.attempt,
      savedAt: c.savedAt ?? "",
    };
  } catch {
    return null;
  }
}

export function saveCart(cart: Omit<SavedCart, "v" | "savedAt">) {
  try {
    window.localStorage.setItem(cartStorageKey(cart.userId, cart.outletId), JSON.stringify({ ...cart, v: 1, savedAt: new Date().toISOString() }));
  } catch {
    /* storage full / blocked: the cart just isn't kept */
  }
}

export function clearSavedCart(userId: string, outletId: string) {
  try {
    window.localStorage.removeItem(cartStorageKey(userId, outletId));
  } catch {
    /* ignore */
  }
}

/**
 * POST /orders body. `withPromotions: false` drops coupon/points (offline bills
 * are priced locally without promotions, so the queued total must match).
 * `cod` sends the cart's Cash on Delivery choice (online bills only — offline bills can't be COD).
 */
export function toOrderInput(lines: CartLine[], meta: CartMeta, clientOrderId?: string, withPromotions = true, cod = false): OrderCreateInput {
  const { discount } = parseDiscount(meta);
  const coords = deliveryCoords(meta.delivery);
  const d = meta.delivery;
  return {
    clientOrderId,
    orderType: meta.orderType,
    tableLabel: meta.orderType === "DINE_IN" && meta.tableLabel.trim() ? meta.tableLabel.trim() : undefined,
    customerName: meta.customerName.trim() || undefined,
    customerPhone: meta.customerPhone.trim() || undefined,
    memberId: meta.memberId || undefined,
    interState: false,
    buyerGstin: meta.buyerGstin?.trim().toUpperCase() || undefined,
    buyerName: meta.buyerGstin?.trim() ? meta.buyerName?.trim() : undefined,
    items: lines.map((l) => ({
      menuItemId: l.itemId,
      variantId: l.variantId,
      addonIds: l.addonIds,
      quantity: l.quantity,
      notes: l.notes.trim() || undefined,
    })),
    discount,
    couponCode: withPromotions && meta.couponCode.trim() ? meta.couponCode.trim().toUpperCase() : undefined,
    redeemPoints: withPromotions && meta.customerPhone.trim() ? pointsToRedeem(meta) : undefined,
    scheduledFor: meta.orderType === "PRE_ORDER" && meta.scheduledFor ? new Date(meta.scheduledFor).toISOString() : undefined,
    delivery:
      meta.orderType === "DELIVERY"
        ? {
            address: d.address.trim(),
            landmark: d.landmark.trim() || undefined,
            pincode: d.pincode?.trim() || undefined,
            latitude: coords?.lat,
            longitude: coords?.lng,
            zoneId: !coords && d.zoneId ? d.zoneId : undefined,
            agentId: d.agentId || undefined,
            source: d.source,
            notes: d.notes.trim() || undefined,
            cod: cod && d.cod,
          }
        : undefined,
  };
}
