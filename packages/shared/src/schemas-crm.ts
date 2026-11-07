// Zod schemas & types for the CRM module: customers, loyalty, khata (credit),
// offers and coupons. All money is integer paise.
import { z } from "zod";
import { indianPhone, orderCreateSchema } from "./schemas";

const paise = z.number().int().nonnegative();
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM (24h)");
const mmdd = z.string().regex(/^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/, "Use MM-DD");

export const LOYALTY_TIERS = ["BRONZE", "SILVER", "GOLD", "PLATINUM"] as const;
export type LoyaltyTierName = (typeof LOYALTY_TIERS)[number];
export const OFFER_TYPES = ["COMBO", "HAPPY_HOUR", "BUY_X_GET_Y", "ITEM_DISCOUNT", "BILL_DISCOUNT"] as const;
export type OfferTypeName = (typeof OFFER_TYPES)[number];

// ---------- Customers ----------
export const customerCreateSchema = z.object({
  phone: indianPhone,
  name: z.string().trim().max(100).optional(),
  email: z.string().email().optional().or(z.literal("")),
  birthday: mmdd.nullable().optional(),
  anniversary: mmdd.nullable().optional(),
  /** Max outstanding khata, paise. 0 = no limit */
  khataLimit: paise.optional(),
  notes: z.string().max(500).nullable().optional(),
});
export type CustomerCreateInput = z.infer<typeof customerCreateSchema>;
export const customerUpdateSchema = customerCreateSchema.partial();
export type CustomerUpdateInput = z.infer<typeof customerUpdateSchema>;

export const customerListQuerySchema = z.object({
  search: z.string().trim().optional(),
  tier: z.enum(LOYALTY_TIERS).optional(),
  sort: z.enum(["spend", "recent", "points", "khata", "name"]).default("recent"),
  hasKhata: z.enum(["0", "1"]).optional(),
  blocked: z.enum(["0", "1"]).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const customerBlockSchema = z.object({
  blocked: z.boolean(),
  reason: z.string().max(200).optional(),
});

export const loyaltyAdjustSchema = z.object({
  /** Signed: positive adds points, negative removes */
  points: z.number().int().refine((v) => v !== 0, "Points must be non-zero"),
  note: z.string().trim().min(3).max(200),
});

export const KHATA_SETTLE_MODES = ["CASH", "UPI", "CARD", "BANK", "OTHER"] as const;
export const khataSettleSchema = z.object({
  amount: paise.refine((v) => v > 0, "Amount must be positive"),
  mode: z.enum(KHATA_SETTLE_MODES),
  note: z.string().max(200).optional(),
});

// ---------- Loyalty config (Setting GLOBAL/"loyalty") ----------
export const loyaltyConfigSchema = z.object({
  enabled: z.boolean().default(true),
  /** Earn 1 point per this many rupees of grand total (after discounts) */
  earnRupeesPerPoint: z.number().positive().default(10),
  /** Value of one point on redemption, paise (25 = ₹0.25) */
  pointValuePaise: z.number().int().positive().default(25),
  minRedeemPoints: z.number().int().nonnegative().default(100),
  /** Max share of the (pre-tax, post-discount) bill payable with points */
  maxRedeemPercent: z.number().min(0).max(100).default(50),
  /** totalSpend thresholds, paise */
  tierThresholds: z
    .object({ SILVER: paise, GOLD: paise, PLATINUM: paise })
    .default({ SILVER: 500_000, GOLD: 1_500_000, PLATINUM: 4_000_000 }),
  tierMultipliers: z
    .object({ BRONZE: z.number().min(0), SILVER: z.number().min(0), GOLD: z.number().min(0), PLATINUM: z.number().min(0) })
    .default({ BRONZE: 1, SILVER: 1.25, GOLD: 1.5, PLATINUM: 2 }),
  /** Points expire this many months after being earned (0 = never) */
  pointsExpiryMonths: z.number().int().min(0).max(120).default(12),
  /** Birthday / anniversary auto-coupon */
  birthdayCouponEnabled: z.boolean().default(true),
  birthdayCouponType: z.enum(["FLAT", "PERCENT"]).default("PERCENT"),
  birthdayCouponValue: z.number().int().positive().default(20),
  birthdayCouponMaxDiscount: paise.nullable().default(10_000),
});
export type LoyaltyConfig = z.infer<typeof loyaltyConfigSchema>;

// ---------- Offer configs ----------
/** Items an offer applies to; empty/omitted on both = every item. Category ids include sub-categories. */
export const offerTargetSchema = z.object({
  menuItemIds: z.array(z.string()).optional(),
  categoryIds: z.array(z.string()).optional(),
});
export type OfferTarget = z.infer<typeof offerTargetSchema>;

const discountValue = z.object({
  discountType: z.enum(["PERCENT", "FLAT"]),
  /** PERCENT: 0–100. FLAT: paise off per unit */
  value: z.number().positive(),
});

/** HAPPY_HOUR / ITEM_DISCOUNT: `{ target, discountType, value }` — FLAT value = paise off each unit. */
export const itemDiscountConfigSchema = z
  .object({ target: offerTargetSchema.default({}) })
  .merge(discountValue)
  .refine((c) => c.discountType === "FLAT" || c.value <= 100, { message: "Percent must be ≤ 100" });
export type ItemDiscountConfig = z.infer<typeof itemDiscountConfigSchema>;

/**
 * BUY_X_GET_Y: buy `buy.quantity` eligible units, get `get.quantity` eligible
 * units at `getDiscountPercent` off (100 = free). Cheapest qualifying units are
 * discounted; repeats as many times as the cart qualifies (optional `maxSets`).
 */
export const buyXGetYConfigSchema = z.object({
  buy: offerTargetSchema.extend({ quantity: z.number().int().min(1).max(50) }),
  get: offerTargetSchema.extend({ quantity: z.number().int().min(1).max(50) }),
  getDiscountPercent: z.number().min(1).max(100).default(100),
  maxSets: z.number().int().min(1).optional(),
});
export type BuyXGetYConfig = z.infer<typeof buyXGetYConfigSchema>;

/** COMBO: when every item is in the cart, the set costs `price` (paise, menu-price terms). Repeats per full set. */
export const comboConfigSchema = z.object({
  items: z
    .array(z.object({ menuItemId: z.string(), quantity: z.number().int().min(1).max(20) }))
    .min(1),
  price: paise,
});
export type ComboConfig = z.infer<typeof comboConfigSchema>;

/** BILL_DISCOUNT: when the cart (after item discounts, menu prices) ≥ `minOrder`, take FLAT paise / PERCENT off, capped at `maxDiscount`. */
export const billDiscountConfigSchema = z
  .object({ minOrder: paise.default(0), maxDiscount: paise.optional() })
  .merge(discountValue)
  .refine((c) => c.discountType === "FLAT" || c.value <= 100, { message: "Percent must be ≤ 100" });
export type BillDiscountConfig = z.infer<typeof billDiscountConfigSchema>;

export const offerConfigSchemas = {
  HAPPY_HOUR: itemDiscountConfigSchema,
  ITEM_DISCOUNT: itemDiscountConfigSchema,
  BUY_X_GET_Y: buyXGetYConfigSchema,
  COMBO: comboConfigSchema,
  BILL_DISCOUNT: billDiscountConfigSchema,
} as const;

const offerBase = z.object({
  name: z.string().trim().min(2).max(100),
  type: z.enum(OFFER_TYPES),
  active: z.boolean().default(true),
  /** Empty = all outlets */
  outletIds: z.array(z.string()).default([]),
  startsAt: z.string().datetime().nullable().optional(),
  endsAt: z.string().datetime().nullable().optional(),
  /** 0 = Sunday … 6 = Saturday; empty = every day */
  daysOfWeek: z.array(z.number().int().min(0).max(6)).default([]),
  /** Daily window in outlet time; may cross midnight (e.g. 22:00–02:00) */
  startTime: hhmm.nullable().optional(),
  endTime: hhmm.nullable().optional(),
  /** Higher runs first; units consumed by one line offer aren't discounted again */
  priority: z.number().int().min(-1000).max(1000).default(0),
  /** Phase 3.7: also applies on top of the bill's best offer (only on items no other offer discounted). Default: one offer per bill. */
  combinable: z.boolean().default(false),
  config: z.unknown(),
});

function refineOffer(o: Partial<z.infer<typeof offerBase>>, ctx: z.RefinementCtx) {
  if (o.type && o.config !== undefined) {
    const r = offerConfigSchemas[o.type].safeParse(o.config);
    if (!r.success) {
      for (const issue of r.error.issues) ctx.addIssue({ ...issue, path: ["config", ...issue.path] });
    }
  }
  if (Boolean(o.startTime) !== Boolean(o.endTime)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Give both startTime and endTime", path: ["endTime"] });
  }
  if (o.startsAt && o.endsAt && o.endsAt <= o.startsAt) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "endsAt must be after startsAt", path: ["endsAt"] });
  }
}

export const offerCreateSchema = offerBase.superRefine(refineOffer);
export type OfferCreateInput = z.infer<typeof offerCreateSchema>;
/** PATCH: when changing `config`, also send `type` (or the stored type is used server-side). */
export const offerUpdateSchema = offerBase.partial().superRefine(refineOffer);
export type OfferUpdateInput = z.infer<typeof offerUpdateSchema>;

// ---------- Coupons ----------
const couponBase = z.object({
  code: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9_-]{3,30}$/, "3–30 letters, digits, - or _"),
  description: z.string().max(200).default(""),
  discountType: z.enum(["FLAT", "PERCENT"]),
  /** Paise for FLAT, percent for PERCENT */
  value: z.number().int().positive(),
  maxDiscount: paise.nullable().optional(),
  /** Subtotal after item discounts (menu prices), paise */
  minOrder: paise.default(0),
  usageLimit: z.number().int().positive().nullable().optional(),
  perCustomerLimit: z.number().int().positive().nullable().optional(),
  startsAt: z.string().datetime().nullable().optional(),
  expiresAt: z.string().datetime().nullable().optional(),
  active: z.boolean().default(true),
});
const refineCoupon = (c: Partial<z.infer<typeof couponBase>>, ctx: z.RefinementCtx) => {
  if (c.discountType === "PERCENT" && c.value !== undefined && c.value > 100) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Percent must be ≤ 100", path: ["value"] });
  }
};
export const couponCreateSchema = couponBase.superRefine(refineCoupon);
export type CouponCreateInput = z.infer<typeof couponCreateSchema>;
export const couponUpdateSchema = couponBase.partial().superRefine(refineCoupon);
export type CouponUpdateInput = z.infer<typeof couponUpdateSchema>;

export const couponValidateSchema = z.object({
  code: z.string().trim().toUpperCase().min(1).max(30),
  /** Cart subtotal after item discounts, paise */
  subtotal: paise,
  customerPhone: indianPhone.optional(),
});
export type CouponValidateInput = z.infer<typeof couponValidateSchema>;

/** POST /customers/preview-promotions — same body as POST /orders. */
export const promotionPreviewSchema = orderCreateSchema;

// ---------- Response shapes ----------
export interface AppliedPromotion {
  kind: "OFFER" | "COUPON" | "POINTS";
  id?: string;
  label: string;
  /** Pre-tax discount value, paise */
  amount: number;
}

export interface CustomerLookup {
  found: boolean;
  id?: string;
  phone: string;
  name?: string | null;
  tier?: LoyaltyTierName;
  points?: number;
  /** Max points usable right now (ignores the per-bill cap) */
  redeemablePoints?: number;
  /** Paise value of redeemablePoints */
  redeemableValue?: number;
  khataBalance?: number;
  khataLimit?: number;
  blocked?: boolean;
  visitCount?: number;
  lastVisitAt?: string | null;
}
