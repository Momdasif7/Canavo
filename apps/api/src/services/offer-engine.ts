/**
 * Pure offer / coupon / loyalty engine (no DB, no I/O) — unit tested in
 * promotions.test.ts. All money is integer paise.
 *
 * Terms:
 *  - "menu-price terms": amounts as printed on the menu (tax-inclusive when the
 *    outlet's prices include GST). Line discounts returned here are in these
 *    terms; computeBill() converts them to pre-tax.
 *  - "pre-tax": bill-level FLAT discounts handed to computeBill() reduce the
 *    pre-tax value directly, so bill offers / coupons / points are computed on
 *    the pre-tax remaining value (see preTaxRemaining()).
 *
 * Offer config shapes are the zod schemas in @canavo/shared (schemas-crm.ts):
 *  - HAPPY_HOUR / ITEM_DISCOUNT { target:{menuItemIds?,categoryIds?}, discountType:"PERCENT"|"FLAT", value }  (FLAT = paise per unit)
 *  - BUY_X_GET_Y { buy:{menuItemIds?,categoryIds?,quantity}, get:{…,quantity}, getDiscountPercent (100 = free), maxSets? }
 *  - COMBO { items:[{menuItemId,quantity}], price }
 *  - BILL_DISCOUNT { minOrder, discountType, value, maxDiscount? }
 */
import {
  allocate,
  billDiscountConfigSchema,
  buyXGetYConfigSchema,
  comboConfigSchema,
  formatINR,
  itemDiscountConfigSchema,
  type BillDiscount,
  type LoyaltyConfig,
  type LoyaltyTierName,
  type OfferTarget,
  type OfferTypeName,
} from "@canavo/shared";

export interface EngineOffer {
  id: string;
  name: string;
  type: OfferTypeName;
  active: boolean;
  outletIds: string[];
  startsAt: Date | null;
  endsAt: Date | null;
  daysOfWeek: number[];
  startTime: string | null;
  endTime: string | null;
  priority: number;
  config: unknown;
  /** Phase 3.7: also applies on top of the best offer */
  combinable?: boolean;
}

export interface EngineLine {
  menuItemId: string;
  /** The item's category and all its ancestors */
  categoryIds: string[];
  /** Menu-price terms, incl. variant + add-ons */
  unitPrice: number;
  quantity: number;
  /** Cashier's manual discount for the whole line, menu-price terms */
  manualDiscount: number;
}

export interface OfferApplication {
  offerId: string;
  name: string;
  type: OfferTypeName;
  /** Total discount, menu-price terms */
  amount: number;
  /** Discount per cart line (same order as the input lines) */
  perLine: number[];
}

// ---------------------------------------------------------------------------
// Time eligibility
// ---------------------------------------------------------------------------

const hhmm = (t: string) => {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
};

/** Local wall clock (date, weekday 0=Sun, minutes since midnight) in `timeZone`. */
export function localClock(at: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  const date = `${get("year")}-${get("month")}-${get("day")}`;
  return {
    date,
    weekday: new Date(`${date}T00:00:00Z`).getUTCDay(),
    minutes: Number(get("hour")) * 60 + Number(get("minute")),
  };
}

/**
 * Is `minutes` inside the [start, end) window? Windows may cross midnight
 * (22:00–02:00). Returns which day the window started on: 0 = today,
 * -1 = yesterday (after-midnight tail), or null when outside.
 */
export function windowDayOffset(minutes: number, start: string, end: string): 0 | -1 | null {
  const s = hhmm(start);
  const e = hhmm(end);
  if (s === e) return 0; // whole day
  if (s < e) return minutes >= s && minutes < e ? 0 : null;
  if (minutes >= s) return 0;
  if (minutes < e) return -1;
  return null;
}

export function isOfferActive(offer: EngineOffer, ctx: { outletId: string; at: Date; timezone: string }): boolean {
  if (!offer.active) return false;
  if (offer.outletIds.length && !offer.outletIds.includes(ctx.outletId)) return false;
  if (offer.startsAt && ctx.at < offer.startsAt) return false;
  if (offer.endsAt && ctx.at >= offer.endsAt) return false;
  const clock = localClock(ctx.at, ctx.timezone);
  let weekday = clock.weekday;
  if (offer.startTime && offer.endTime) {
    const off = windowDayOffset(clock.minutes, offer.startTime, offer.endTime);
    if (off === null) return false;
    // 01:00 Saturday inside a Friday 22:00–02:00 window counts as Friday's offer
    weekday = (weekday + 7 + off) % 7;
  }
  if (offer.daysOfWeek.length && !offer.daysOfWeek.includes(weekday)) return false;
  return true;
}

/** Validate an offer's config against its type. Returns an error message or null. */
export function offerConfigError(type: OfferTypeName, config: unknown): string | null {
  const schema = {
    HAPPY_HOUR: itemDiscountConfigSchema,
    ITEM_DISCOUNT: itemDiscountConfigSchema,
    BUY_X_GET_Y: buyXGetYConfigSchema,
    COMBO: comboConfigSchema,
    BILL_DISCOUNT: billDiscountConfigSchema,
  }[type];
  const r = schema.safeParse(config);
  return r.success ? null : r.error.issues.map((i) => `${i.path.join(".") || "config"}: ${i.message}`).join("; ");
}

// ---------------------------------------------------------------------------
// Line offers (HAPPY_HOUR, ITEM_DISCOUNT, BUY_X_GET_Y, COMBO)
// ---------------------------------------------------------------------------

export function matchesTarget(target: OfferTarget | undefined, line: EngineLine): boolean {
  const ids = target?.menuItemIds ?? [];
  const cats = target?.categoryIds ?? [];
  if (!ids.length && !cats.length) return true;
  return ids.includes(line.menuItemId) || line.categoryIds.some((c) => cats.includes(c));
}

interface Unit {
  line: number;
  price: number;
}

const LINE_TYPES: OfferTypeName[] = ["HAPPY_HOUR", "ITEM_DISCOUNT", "BUY_X_GET_Y", "COMBO"];

/**
 * Apply line-level offers by priority (highest first; ties keep input order).
 * Each unit is used by at most one offer, and a line is never discounted below
 * zero after the cashier's manual discount.
 */
export function evaluateLineOffers(
  offers: EngineOffer[],
  lines: EngineLine[],
): { lineDiscounts: number[]; applied: OfferApplication[] } {
  const consumed = lines.map(() => 0);
  const cap = lines.map((l) => Math.max(0, l.unitPrice * l.quantity - (l.manualDiscount ?? 0)));
  const lineDiscounts = lines.map(() => 0);
  const applied: OfferApplication[] = [];

  const freeUnits = (filter: (l: EngineLine) => boolean): Unit[] => {
    const out: Unit[] = [];
    lines.forEach((l, i) => {
      if (!filter(l)) return;
      for (let k = consumed[i]; k < l.quantity; k++) out.push({ line: i, price: l.unitPrice });
    });
    return out;
  };

  /** Commit per-line discounts (clamped to the line cap) and unit consumption. */
  const commit = (offer: EngineOffer, wanted: number[], used: number[]) => {
    const actual = wanted.map((w, i) => Math.max(0, Math.min(Math.round(w), cap[i])));
    const total = actual.reduce((a, b) => a + b, 0);
    if (total <= 0) return;
    actual.forEach((a, i) => {
      cap[i] -= a;
      lineDiscounts[i] += a;
      consumed[i] += used[i];
    });
    applied.push({ offerId: offer.id, name: offer.name, type: offer.type, amount: total, perLine: actual });
  };

  const sorted = offers
    .map((o, idx) => ({ o, idx }))
    .filter(({ o }) => LINE_TYPES.includes(o.type))
    .sort((a, b) => b.o.priority - a.o.priority || a.idx - b.idx)
    .map(({ o }) => o);

  for (const offer of sorted) {
    const wanted = lines.map(() => 0);
    const used = lines.map(() => 0);

    if (offer.type === "HAPPY_HOUR" || offer.type === "ITEM_DISCOUNT") {
      const cfg = itemDiscountConfigSchema.safeParse(offer.config);
      if (!cfg.success) continue;
      const c = cfg.data;
      lines.forEach((l, i) => {
        const free = l.quantity - consumed[i];
        if (free <= 0 || !matchesTarget(c.target, l)) return;
        const perUnit =
          c.discountType === "PERCENT" ? Math.round((l.unitPrice * c.value) / 100) : Math.min(Math.round(c.value), l.unitPrice);
        wanted[i] = perUnit * free;
        used[i] = free;
      });
    } else if (offer.type === "BUY_X_GET_Y") {
      const cfg = buyXGetYConfigSchema.safeParse(offer.config);
      if (!cfg.success) continue;
      const c = cfg.data;
      const taken = new Set<Unit>();
      const pool = freeUnits(() => true);
      const buyOk = (u: Unit) => !taken.has(u) && matchesTarget(c.buy, lines[u.line]);
      const getOk = (u: Unit) => !taken.has(u) && matchesTarget(c.get, lines[u.line]);
      const asc = (a: Unit, b: Unit) => a.price - b.price;
      const desc = (a: Unit, b: Unit) => b.price - a.price;
      let sets = 0;
      while (!c.maxSets || sets < c.maxSets) {
        // Try "cheapest units free, priciest units as the buy" first; fall back to buy-first.
        let G = pool.filter(getOk).sort(asc).slice(0, c.get.quantity);
        let B = pool.filter((u) => buyOk(u) && !G.includes(u)).sort(desc).slice(0, c.buy.quantity);
        if (G.length < c.get.quantity || B.length < c.buy.quantity) {
          B = pool.filter(buyOk).sort(desc).slice(0, c.buy.quantity);
          G = pool.filter((u) => getOk(u) && !B.includes(u)).sort(asc).slice(0, c.get.quantity);
          if (G.length < c.get.quantity || B.length < c.buy.quantity) break;
        }
        for (const u of B) {
          taken.add(u);
          used[u.line]++;
        }
        for (const u of G) {
          taken.add(u);
          used[u.line]++;
          wanted[u.line] += Math.round((u.price * c.getDiscountPercent) / 100);
        }
        sets++;
      }
    } else if (offer.type === "COMBO") {
      const cfg = comboConfigSchema.safeParse(offer.config);
      if (!cfg.success) continue;
      const c = cfg.data;
      const perItem = c.items.map((it) =>
        freeUnits((l) => l.menuItemId === it.menuItemId).sort((a, b) => a.price - b.price),
      );
      const maxSets = Math.min(...c.items.map((it, k) => Math.floor(perItem[k].length / it.quantity)));
      for (let s = 0; s < maxSets; s++) {
        const units = c.items.flatMap((it, k) => perItem[k].slice(s * it.quantity, (s + 1) * it.quantity));
        const setTotal = units.reduce((a, u) => a + u.price, 0);
        const disc = setTotal - c.price;
        if (disc <= 0) break;
        const shares = allocate(disc, units.map((u) => u.price));
        units.forEach((u, k) => {
          wanted[u.line] += shares[k];
          used[u.line]++;
        });
      }
    }
    commit(offer, wanted, used);
  }
  return { lineDiscounts, applied };
}

// ---------------------------------------------------------------------------
// Pre-tax helpers (mirror computeBill so FLAT amounts match exactly)
// ---------------------------------------------------------------------------

export interface TaxMode {
  pricesIncludeTax: boolean;
  compositionScheme: boolean;
  /** false = outlet not GST registered: prices are never reduced */
  taxEnabled?: boolean;
}

export const exclusiveOf = (inclusive: number, rate: number) => Math.round((inclusive * 100) / (100 + rate));

/**
 * Convert a menu-price amount on a line to pre-tax, as computeBill does.
 * `gstRate` is the line's TOTAL inclusive rate (GST + cess + extras).
 */
export function toPreTax(amount: number, gstRate: number, mode: TaxMode): number {
  return mode.pricesIncludeTax && !mode.compositionScheme && mode.taxEnabled !== false ? exclusiveOf(amount, gstRate) : amount;
}

/**
 * Pre-tax value left after line discounts and the given bill discounts, using
 * exactly computeBill's arithmetic.
 */
export function preTaxRemaining(
  lines: { unitPrice: number; quantity: number; gstRate: number; lineDiscount: number }[],
  mode: TaxMode,
  billDiscounts: BillDiscount[] = [],
): number {
  let subtotal = 0;
  for (const l of lines) {
    const gross = toPreTax(l.unitPrice * l.quantity, l.gstRate, mode);
    subtotal += gross - Math.min(toPreTax(l.lineDiscount, l.gstRate, mode), gross);
  }
  let disc = 0;
  for (const d of billDiscounts) {
    const remaining = subtotal - disc;
    const amount = d.type === "FLAT" ? d.value : Math.round((remaining * d.value) / 100);
    disc += Math.max(0, Math.min(amount, remaining));
  }
  return subtotal - disc;
}

// ---------------------------------------------------------------------------
// Bill offers & coupons
// ---------------------------------------------------------------------------

function discountAmount(type: "FLAT" | "PERCENT", value: number, base: number, max?: number | null): number {
  let amount = type === "FLAT" ? Math.round(value) : Math.round((base * value) / 100);
  if (max != null) amount = Math.min(amount, max);
  return Math.max(0, Math.min(amount, base));
}

/**
 * Pick the bill-discount offer to apply: highest priority first, then biggest
 * saving. `menuSubtotal` (menu prices after line discounts) is checked against
 * minOrder; the discount is computed on the pre-tax `remaining`.
 */
export function evaluateBillOffer(
  offers: EngineOffer[],
  menuSubtotal: number,
  remaining: number,
): { offer: EngineOffer; amount: number } | null {
  const candidates = offers
    .filter((o) => o.type === "BILL_DISCOUNT")
    .map((offer) => {
      const cfg = billDiscountConfigSchema.safeParse(offer.config);
      if (!cfg.success || menuSubtotal < cfg.data.minOrder) return null;
      const amount = discountAmount(cfg.data.discountType, cfg.data.value, remaining, cfg.data.maxDiscount);
      return amount > 0 ? { offer, amount } : null;
    })
    .filter((x): x is { offer: EngineOffer; amount: number } => x !== null)
    .sort((a, b) => b.offer.priority - a.offer.priority || b.amount - a.amount);
  return candidates[0] ?? null;
}

// ---------------------------------------------------------------------------
// One offer per bill
// ---------------------------------------------------------------------------

export interface BestOffer {
  offer: EngineOffer;
  /** Pre-tax saving (same basis as bill discounts) */
  saving: number;
  /** Line offers: per-line discount, menu-price terms (same order as the lines); bill offers: undefined */
  lineDiscounts?: number[];
}

/**
 * Every offer that would save something on this cart, evaluated one offer at a time, best
 * first (ties: higher priority, then the earlier offer). Used for "why this offer won".
 */
export function rankOffers(
  offers: EngineOffer[],
  lines: EngineLine[],
  rates: number[],
  mode: TaxMode,
  manualDiscount?: BillDiscount,
): BestOffer[] {
  const billLines = lines.map((l, i) => ({ unitPrice: l.unitPrice, quantity: l.quantity, gstRate: rates[i] ?? 0, lineDiscount: l.manualDiscount }));
  const menuSubtotal = lines.reduce((s, l) => s + Math.max(0, l.unitPrice * l.quantity - l.manualDiscount), 0);
  const remaining = preTaxRemaining(billLines, mode, manualDiscount ? [manualDiscount] : []);
  const out: BestOffer[] = [];
  for (const offer of offers) {
    if (offer.type === "BILL_DISCOUNT") {
      const b = evaluateBillOffer([offer], menuSubtotal, remaining);
      if (b) out.push({ offer, saving: b.amount });
    } else {
      const r = evaluateLineOffers([offer], lines);
      // Pre-tax value actually removed, exactly as the bill will compute it
      const saving = remaining - preTaxRemaining(billLines.map((l, i) => ({ ...l, lineDiscount: l.lineDiscount + r.lineDiscounts[i] })), mode, manualDiscount ? [manualDiscount] : []);
      if (saving > 0) out.push({ offer, saving, lineDiscounts: r.lineDiscounts });
    }
  }
  // Stable sort keeps the earlier offer first on a full tie.
  return out.sort((a, b) => b.saving - a.saving || b.offer.priority - a.offer.priority);
}

/** The single offer that saves the customer the most on this cart. */
export function bestOffer(
  offers: EngineOffer[],
  lines: EngineLine[],
  rates: number[],
  mode: TaxMode,
  manualDiscount?: BillDiscount,
): BestOffer | null {
  return rankOffers(offers, lines, rates, mode, manualDiscount)[0] ?? null;
}

export interface EngineCoupon {
  code: string;
  discountType: "FLAT" | "PERCENT";
  value: number;
  maxDiscount: number | null;
  minOrder: number;
  usageLimit: number | null;
  perCustomerLimit: number | null;
  usedCount: number;
  startsAt: Date | null;
  expiresAt: Date | null;
  active: boolean;
  customerId?: string | null;
}

/** Returns a user-facing error message, or null when the coupon can be used. */
export function couponError(
  coupon: EngineCoupon | null,
  ctx: { at: Date; subtotal: number; hasCustomer: boolean; customerUses: number; customerId?: string | null },
): string | null {
  if (!coupon) return "Invalid coupon code";
  if (coupon.customerId && ctx.customerId !== coupon.customerId) return `Coupon ${coupon.code} is for a different customer`;
  if (!coupon.active) return `Coupon ${coupon.code} is not active`;
  if (coupon.startsAt && ctx.at < coupon.startsAt) return `Coupon ${coupon.code} is not valid yet`;
  if (coupon.expiresAt && ctx.at >= coupon.expiresAt) return `Coupon ${coupon.code} has expired`;
  if (coupon.usageLimit != null && coupon.usedCount >= coupon.usageLimit) {
    return `Coupon ${coupon.code} has reached its usage limit`;
  }
  if (coupon.perCustomerLimit != null) {
    if (!ctx.hasCustomer) return `Coupon ${coupon.code} needs the customer's phone number`;
    if (ctx.customerUses >= coupon.perCustomerLimit) return `Coupon ${coupon.code} already used by this customer`;
  }
  if (ctx.subtotal < coupon.minOrder) {
    return `Coupon ${coupon.code} needs a minimum order of ${formatINR(coupon.minOrder)}`;
  }
  return null;
}

/** Coupon discount on a base value (pre-tax remaining at checkout), capped at maxDiscount and the base. */
export function couponAmount(coupon: Pick<EngineCoupon, "discountType" | "value" | "maxDiscount">, base: number): number {
  return discountAmount(coupon.discountType, coupon.value, base, coupon.maxDiscount);
}

// ---------------------------------------------------------------------------
// Loyalty
// ---------------------------------------------------------------------------

export function tierForSpend(totalSpend: number, cfg: LoyaltyConfig): LoyaltyTierName {
  const t = cfg.tierThresholds;
  if (totalSpend >= t.PLATINUM) return "PLATINUM";
  if (totalSpend >= t.GOLD) return "GOLD";
  if (totalSpend >= t.SILVER) return "SILVER";
  return "BRONZE";
}

/** Points earned on a paid bill: 1 per `earnRupeesPerPoint` of grand total × tier multiplier. */
export function pointsToEarn(grandTotal: number, tier: LoyaltyTierName, cfg: LoyaltyConfig): number {
  if (!cfg.enabled || grandTotal <= 0) return 0;
  return Math.floor((grandTotal / (cfg.earnRupeesPerPoint * 100)) * cfg.tierMultipliers[tier] + 1e-9);
}

/**
 * Redeem points against the pre-tax `remaining` bill value. The request is
 * capped to `maxRedeemPercent` of the bill; the result must still meet the minimum.
 */
export function redeemPoints(
  cfg: LoyaltyConfig,
  opts: { balance: number; requested: number; remaining: number },
): { ok: true; points: number; value: number } | { ok: false; error: string } {
  if (!cfg.enabled) return { ok: false, error: "Loyalty programme is disabled" };
  if (opts.requested < cfg.minRedeemPoints) return { ok: false, error: `Minimum ${cfg.minRedeemPoints} points to redeem` };
  if (opts.requested > opts.balance) return { ok: false, error: `Only ${opts.balance} points available` };
  const capValue = Math.floor((opts.remaining * cfg.maxRedeemPercent) / 100);
  const maxPoints = Math.floor(capValue / cfg.pointValuePaise);
  const points = Math.min(opts.requested, maxPoints);
  if (points < cfg.minRedeemPoints || points <= 0) {
    return {
      ok: false,
      error: `This bill allows at most ${maxPoints} points (${cfg.maxRedeemPercent}% of bill); minimum is ${cfg.minRedeemPoints}`,
    };
  }
  return { ok: true, points, value: points * cfg.pointValuePaise };
}

/** Points the customer could redeem ignoring per-bill caps (0 if below the minimum). */
export function redeemableNow(points: number, cfg: LoyaltyConfig): number {
  return cfg.enabled && points >= cfg.minRedeemPoints ? points : 0;
}

// ---------------------------------------------------------------------------
// Free-item suggestions (Buy X Get Y)
// ---------------------------------------------------------------------------

export interface FreeItemSuggestion {
  offerId: string;
  offerName: string;
  menuItemId: string;
  /** Units to add so every qualifying set gets its free item */
  quantity: number;
  getDiscountPercent: number;
}

/**
 * For BUY_X_GET_Y offers whose "get" side is a specific item, work out how many
 * of that item the cart is missing for the sets the customer has already
 * bought (e.g. 2 samosas bought, no chai in the cart → add 1 chai). Offers where
 * the same item is both "buy" and "get" are skipped (nothing to add).
 */
export function suggestFreeItems(offers: EngineOffer[], lines: EngineLine[]): FreeItemSuggestion[] {
  const out: FreeItemSuggestion[] = [];
  for (const offer of offers) {
    if (offer.type !== "BUY_X_GET_Y") continue;
    const cfg = buyXGetYConfigSchema.safeParse(offer.config);
    if (!cfg.success) continue;
    const c = cfg.data;
    const getItem = c.get.menuItemIds?.[0];
    if (!getItem || (c.get.categoryIds?.length ?? 0) > 0) continue;
    const buyUnits = lines.filter((l) => matchesTarget(c.buy, l) && !matchesTarget(c.get, l)).reduce((s, l) => s + l.quantity, 0);
    if (lines.some((l) => matchesTarget(c.buy, l) && matchesTarget(c.get, l))) continue;
    let sets = Math.floor(buyUnits / c.buy.quantity);
    if (c.maxSets) sets = Math.min(sets, c.maxSets);
    if (sets <= 0) continue;
    const getUnits = lines.filter((l) => matchesTarget(c.get, l)).reduce((s, l) => s + l.quantity, 0);
    const missing = sets * c.get.quantity - getUnits;
    if (missing > 0) {
      out.push({ offerId: offer.id, offerName: offer.name, menuItemId: getItem, quantity: missing, getDiscountPercent: c.getDiscountPercent });
    }
  }
  return out;
}
