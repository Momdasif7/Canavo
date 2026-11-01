import { z } from "zod";
import { newPasswordSchema } from "./password";
import { ROLES } from "./rbac";

export const indianPhone = z
  .string()
  .trim()
  .regex(/^[6-9]\d{9}$/, "Enter a valid 10-digit Indian mobile number");

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM (24h)");
const paise = z.number().int().nonnegative();

// ---------- Auth ----------
export const passwordLoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});
export const otpRequestSchema = z.object({ phone: indianPhone });
export const otpVerifySchema = z.object({
  phone: indianPhone,
  code: z.string().regex(/^\d{6}$/),
  deviceId: z.string().max(200).optional(),
});
export const refreshSchema = z.object({ refreshToken: z.string().min(10) });

// ---------- Outlets ----------
export const outletSchema = z.object({
  name: z.string().min(2).max(120),
  address: z.string().max(500).default(""),
  stateCode: z.string().regex(/^\d{2}$/, "Two-digit GST state code, e.g. 29 for Karnataka"),
  gstin: z
    .string()
    .regex(/^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/, "Invalid GSTIN")
    .optional()
    .or(z.literal("")),
  fssai: z.string().regex(/^\d{14}$/, "FSSAI licence is 14 digits").optional().or(z.literal("")),
  phone: z.string().max(20).optional(),
  logoUrl: z.string().url().optional().or(z.literal("")),
  latitude: z.number().min(-90).max(90).optional(),
  longitude: z.number().min(-180).max(180).optional(),
  geofenceMeters: z.number().int().min(20).max(5000).default(150),
  timezone: z.string().default("Asia/Kolkata"),
  invoicePrefix: z.string().regex(/^[A-Z0-9]{1,5}$/).default("INV"),
  pricesIncludeTax: z.boolean().default(true),
  compositionScheme: z.boolean().default(false),
  serviceChargeEnabled: z.boolean().default(false),
  serviceChargePercent: z.number().min(0).max(20).default(0),
  roundOff: z.boolean().default(true),
  /** Flat charge added to every takeaway / delivery bill, in paise (0 = none) */
  packagingCharge: z.number().int().min(0).max(100_000, "Packaging charge can be at most ₹1,000").default(0),
  /** Most orders one delivery partner can carry at a time */
  maxDeliveriesPerPartner: z.number().int().min(1).max(10).default(2),
  /** POS item cards show menu photos */
  posShowImages: z.boolean().default(true),
  upiVpa: z.string().max(100).optional(),
  /** false = not GST registered: plain bills (documentType BILL) with no tax */
  gstEnabled: z.boolean().default(true),
  /** Registered legal name printed on tax invoices; empty clears it */
  legalName: z.string().trim().max(200).nullable().optional(),
  /** D1: flat ₹ discounts (coupons, flat offers, points, manual flat) are GST-inclusive */
  flatDiscountsIncludeTax: z.boolean().optional(),
  /** Manual discount above this % of the bill needs a manager PIN (APPROVAL_PINS); owner only */
  approvalDiscountPercent: z.number().int().min(0).max(100).optional(),
});
export type OutletInput = z.infer<typeof outletSchema>;

// ---------- Staff & attendance ----------
const staffBaseSchema = z.object({
  name: z.string().min(2).max(100),
  phone: indianPhone,
  email: z.string().email().optional(),
  password: newPasswordSchema.optional(),
  pin: z.string().regex(/^\d{4,6}$/).optional(),
  role: z.enum(ROLES),
  /** Business owners work across all outlets and need none */
  outletIds: z.array(z.string()).default([]),
  salaryType: z.enum(["DAILY", "MONTHLY"]).default("MONTHLY"),
  salaryAmount: paise.default(0),
  shiftId: z.string().optional(),
});
export const staffCreateSchema = staffBaseSchema.refine(
  (s) => s.role === "BUSINESS_OWNER" || s.role === "SUPER_ADMIN" || s.outletIds.length > 0,
  { message: "Assign at least one outlet", path: ["outletIds"] },
);
export const staffUpdateSchema = staffBaseSchema
  .partial()
  .extend({ status: z.enum(["ACTIVE", "INACTIVE", "SUSPENDED"]).optional() });

export const shiftSchema = z.object({
  name: z.string().min(1).max(50),
  startTime: hhmm,
  endTime: hhmm,
  graceMinutes: z.number().int().min(0).max(120).default(10),
});

export const clockSchema = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  accuracy: z.number().nonnegative().optional(),
  pin: z.string().regex(/^\d{4,6}$/).optional(),
  outletId: z.string().optional(),
  /** The phone says the location is fake (Android "mock location" apps) */
  mocked: z.boolean().optional(),
  /** Selfie uploaded via POST /uploads/image just before clocking in (feature CLOCK_IN_SELFIE) */
  selfieUrl: z.string().url().max(500).optional(),
});

/** Manager / owner attendance entry for one employee on one day. Times are HH:MM in outlet time. */
export const ATTENDANCE_STATUSES = ["PRESENT", "HALF_DAY", "ABSENT", "LEAVE"] as const;
const manualEntryFields = {
  userId: z.string(),
  status: z.enum(ATTENDANCE_STATUSES),
  clockIn: hhmm.optional(),
  clockOut: hhmm.optional(),
  note: z.string().trim().max(300).optional(),
};
const needsTimes = (e: { status: string; clockIn?: string }) => !(e.status === "PRESENT" || e.status === "HALF_DAY") || Boolean(e.clockIn);
export const attendanceManualSchema = z
  .object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), ...manualEntryFields })
  .refine(needsTimes, { message: "Enter the clock-in time for Present / Half day", path: ["clockIn"] });
export type AttendanceManualInput = z.infer<typeof attendanceManualSchema>;

/** Daily register: mark every employee of the outlet for one date in one go. */
export const attendanceRegisterSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  entries: z
    .array(z.object(manualEntryFields).refine(needsTimes, { message: "Enter the clock-in time for Present / Half day", path: ["clockIn"] }))
    .min(1)
    .max(300),
});

/** Edit an attendance record (self clock-in or manual). */
export const attendanceUpdateSchema = z.object({
  status: z.enum(ATTENDANCE_STATUSES).optional(),
  clockIn: hhmm.optional(),
  clockOut: hhmm.nullable().optional(),
  note: z.string().trim().max(300).nullable().optional(),
});

export const leaveRequestSchema = z
  .object({
    fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    type: z.enum(["CASUAL", "SICK", "UNPAID", "HALF_DAY"]),
    reason: z.string().max(500).default(""),
  })
  .refine((v) => v.toDate >= v.fromDate, { message: "toDate must be on or after fromDate" });

// ---------- Menu ----------
export const categorySchema = z.object({
  name: z.string().min(1).max(60),
  parentId: z.string().nullable().optional(),
  sortOrder: z.number().int().default(0),
});

export const variantSchema = z.object({
  name: z.string().min(1).max(40),
  price: paise,
});
export const addonSchema = z.object({
  name: z.string().min(1).max(60),
  price: paise,
});

export const menuItemSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).default(""),
  categoryId: z.string(),
  price: paise,
  foodType: z.enum(["VEG", "NON_VEG", "EGG"]).default("VEG"),
  /** Effective GST % (cgst + sgst). Kept in sync by the server when taxRateId is set. */
  gstRate: z.number().min(0).max(100).default(0),
  /** Custom tax rate of the business; null = business default rate */
  taxRateId: z.string().nullable().optional(),
  hsnCode: z.string().max(8).default("996331"),
  imageUrl: z.string().url().optional().or(z.literal("")),
  status: z.enum(["AVAILABLE", "OUT_OF_STOCK", "HIDDEN"]).default("AVAILABLE"),
  allergens: z.array(z.string()).default([]),
  availableFrom: hhmm.nullable().optional(),
  availableTo: hhmm.nullable().optional(),
  kitchenStation: z.string().max(40).default("MAIN"),
  variants: z.array(variantSchema).default([]),
  addons: z.array(addonSchema).default([]),
});
export type MenuItemInput = z.infer<typeof menuItemSchema>;

// ---------- Tax rates ----------
const taxPercent = z
  .number()
  .min(0)
  .max(100)
  .refine((v) => Math.abs(v * 1000 - Math.round(v * 1000)) < 1e-6, "Use at most 3 decimals");

export const taxExtraSchema = z.object({
  label: z.string().trim().min(1).max(40),
  percent: taxPercent.refine((v) => v > 0, "Must be more than 0"),
});

const taxRateFields = {
  name: z.string().trim().min(1).max(60),
  cgst: taxPercent,
  sgst: taxPercent,
  /** Defaults to cgst + sgst */
  igst: taxPercent.optional(),
  cess: taxPercent,
  extras: z.array(taxExtraSchema).max(10),
  isDefault: z.boolean(),
  active: z.boolean(),
};
export const taxRateSchema = z.object({
  ...taxRateFields,
  cess: taxRateFields.cess.default(0),
  extras: taxRateFields.extras.default([]),
  isDefault: taxRateFields.isDefault.default(false),
  active: taxRateFields.active.default(true),
});
export const taxRateUpdateSchema = z.object(taxRateFields).partial();
export type TaxRateInput = z.infer<typeof taxRateSchema>;

// ---------- Orders & payments ----------
export const ORDER_TYPES = ["DINE_IN", "TAKEAWAY", "DELIVERY", "PRE_ORDER"] as const;
export const PAYMENT_MODES = ["CASH", "UPI", "CARD", "KHATA", "GIFT_CARD"] as const;

export const orderItemInputSchema = z.object({
  menuItemId: z.string(),
  variantId: z.string().optional(),
  addonIds: z.array(z.string()).default([]),
  quantity: z.number().int().min(1).max(999),
  notes: z.string().max(200).optional(),
  discount: paise.optional(),
});

/** A manager's approval typed on the cashier's device (Phase 3.3, feature APPROVAL_PINS). */
export const approvalSchema = z.object({ approverId: z.string().min(1), pin: z.string().regex(/^\d{4,6}$/) });
export type ApprovalInputBody = z.infer<typeof approvalSchema>;

export const orderCreateSchema = z.object({
  /** Client-generated UUID; makes offline sync idempotent */
  clientOrderId: z.string().uuid().optional(),
  orderType: z.enum(ORDER_TYPES),
  tableLabel: z.string().max(20).optional(),
  customerName: z.string().max(100).optional(),
  customerPhone: indianPhone.optional(),
  interState: z.boolean().default(false),
  items: z.array(orderItemInputSchema).min(1),
  discount: z
    .discriminatedUnion("type", [
      z.object({ type: z.literal("FLAT"), value: paise }),
      z.object({ type: z.literal("PERCENT"), value: z.number().min(0).max(100) }),
    ])
    .optional(),
  notes: z.string().max(300).optional(),
  /** When offline, the time the bill was actually raised */
  createdAt: z.string().datetime().optional(),
  /** Manager approval for a discount above the outlet's limit (APPROVAL_PINS) */
  approval: approvalSchema.optional(),
  /** Promotions & loyalty */
  couponCode: z.string().trim().toUpperCase().max(30).optional(),
  redeemPoints: z.number().int().positive().optional(),
  /** PRE_ORDER: when the customer wants the food (KOT is held until shortly before) */
  scheduledFor: z.string().datetime().optional(),
  /** DELIVERY details */
  delivery: z
    .object({
      address: z.string().min(5).max(500),
      landmark: z.string().max(200).optional(),
      latitude: z.number().min(-90).max(90).optional(),
      longitude: z.number().min(-180).max(180).optional(),
      zoneId: z.string().optional(),
      agentId: z.string().optional(),
      source: z.enum(["PHONE", "IN_APP", "WALK_IN", "AGGREGATOR"]).default("PHONE"),
      notes: z.string().max(300).optional(),
      /** Cash on Delivery: nothing is paid now; the delivery partner collects cash at the door */
      cod: z.boolean().default(false),
      /** Managers only: assign even if the chosen partner is full / out on a run */
      forceAssign: z.boolean().optional(),
    })
    .optional(),
});
export type OrderCreateInput = z.infer<typeof orderCreateSchema>;

export const paymentSchema = z.object({
  payments: z
    .array(
      z.object({
        mode: z.enum(PAYMENT_MODES),
        amount: paise.refine((v) => v > 0, "Amount must be positive"),
        reference: z.string().max(100).optional(),
        /** Phase 3.8: tip on top (not part of the bill), paise */
        tip: paise.optional(),
        /** CARD: last 4 digits and the terminal's approval code */
        cardLast4: z.string().regex(/^\d{4}$/, "Last 4 digits of the card").optional(),
        authCode: z.string().trim().max(20).optional(),
        /** GIFT_CARD: the card's code */
        giftCardCode: z.string().trim().toUpperCase().max(30).optional(),
      }),
    )
    .min(1),
  /** Cash handed over by customer, to compute change */
  tendered: paise.optional(),
});

export const kotStatusSchema = z.object({
  status: z.enum(["RECEIVED", "PREPARING", "READY", "SERVED"]),
});

export const receiptShareSchema = z.object({
  phone: indianPhone,
});

// ---------- Refunds / credit notes (Phase 3.1) ----------
export const REFUND_REASONS = ["WRONG_ITEM", "QUALITY", "NOT_DELIVERED", "OVERCHARGED", "CUSTOMER_CHANGED_MIND", "OTHER"] as const;
export type RefundReason = (typeof REFUND_REASONS)[number];
export const REFUND_REASON_LABELS: Record<RefundReason, string> = {
  WRONG_ITEM: "Wrong item served",
  QUALITY: "Food quality",
  NOT_DELIVERED: "Not delivered / not served",
  OVERCHARGED: "Overcharged",
  CUSTOMER_CHANGED_MIND: "Customer changed mind",
  OTHER: "Other",
};
export const REFUND_MODES = ["CASH", "UPI", "CARD", "KHATA", "GIFT_CARD"] as const;

/** Refund some items (and quantities) of a paid bill, or a value only (e.g. overcharge). */
export const refundSchema = z
  .object({
    reason: z.enum(REFUND_REASONS),
    note: z.string().trim().max(300).optional(),
    refundMode: z.enum(REFUND_MODES),
    items: z.array(z.object({ orderItemId: z.string().min(1), quantity: z.number().int().positive() })).optional(),
    /** Value-only credit (no items), paise incl. tax */
    amount: paise.optional(),
    /** Put the refunded items' ingredients back into stock (food not made / returned unopened) */
    restock: z.boolean().default(false),
    approval: approvalSchema.optional(),
  })
  .refine((v) => Boolean(v.items?.length) !== Boolean(v.amount), "Refund either items or an amount")
  .refine((v) => v.reason !== "OTHER" || (v.note?.length ?? 0) >= 3, "Describe the reason");
export type RefundInput = z.infer<typeof refundSchema>;

// ---------- Cash shifts (Phase 3.2) ----------
export const shiftOpenSchema = z.object({ openingFloat: paise });
export const cashMovementSchema = z.object({
  type: z.enum(["PAY_IN", "PAY_OUT"]),
  amount: z.number().int().positive(),
  reason: z.string().trim().min(3).max(200),
  approval: approvalSchema.optional(),
});
export const shiftCloseSchema = z.object({
  countedCash: paise,
  /** Optional count by note/coin value in rupees, e.g. { "500": 3, "10": 12 } */
  denominations: z.record(z.string().regex(/^\d+$/), z.number().int().nonnegative()).optional(),
  note: z.string().trim().max(300).optional(),
});

// ---------- Gift cards (Phase 3.8, closed-loop) ----------
export const giftCardIssueSchema = z.object({
  /** Value loaded on the card, paise (₹50 – ₹50,000) */
  value: z.number().int().min(5000).max(5_000_000),
  /** How the customer paid for it */
  soldMode: z.enum(["CASH", "UPI", "CARD"]),
  /** Leave empty to generate one */
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9-]{6,30}$/, "6–30 letters, digits or -").optional(),
  customerName: z.string().trim().max(100).optional(),
  customerPhone: indianPhone.optional(),
  expiresAt: z.string().datetime().optional(),
});
export type GiftCardIssueInput = z.infer<typeof giftCardIssueSchema>;

/** Settlement file rows from the bank / card acquirer (Phase 3.8): date, amount (₹), reference. */
export const settlementUploadSchema = z.object({
  mode: z.enum(["CARD", "UPI"]),
  rows: z
    .array(z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), amount: paise, reference: z.string().trim().max(100).optional() }))
    .min(1)
    .max(5000),
});
