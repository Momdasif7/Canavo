import { z } from "zod";
import { indianPhone } from "./schemas";

/**
 * Phase 6.3 / 6.4 (CHANNELS module): QR table ordering and the outlet's own online
 * ordering page. Customers order from their phones without logging in.
 */

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM (24h)");

/** Limits for one public order (abuse guard; a big party orders in rounds). */
export const PUBLIC_ORDER_LIMITS = { lines: 25, quantityPerLine: 20, totalQuantity: 60 } as const;

/** Outlet settings for QR ordering and the online ordering page. */
export const storefrontSettingsSchema = z.object({
  /** Guests can order from the QR code on their table */
  qrOrdering: z.boolean().default(false),
  /** QR orders wait for a waiter / cashier to accept them before the kitchen sees them */
  qrNeedsConfirmation: z.boolean().default(true),
  /** The online ordering page takes takeaway / delivery orders */
  onlineOrdering: z.boolean().default(false),
  /** Online orders wait for staff to accept them before the kitchen sees them */
  onlineNeedsConfirmation: z.boolean().default(true),
  /** With ordering off, the public page still shows the menu (digital menu card) */
  menuView: z.boolean().default(true),
  /** Accepting hours (outlet time); both empty = whenever the outlet is set up to take orders */
  acceptFrom: hhmm.nullable().default(null),
  acceptTo: hhmm.nullable().default(null),
  /** Minimum online order (item total), paise */
  minOrder: z.number().int().nonnegative().max(10_000_000).default(0),
  /** Online page: order types and payment options */
  takeaway: z.boolean().default(true),
  delivery: z.boolean().default(false),
  payAtCounter: z.boolean().default(true),
  cashOnDelivery: z.boolean().default(true),
  upiPrepaid: z.boolean().default(false),
  /**
   * Online orders need the customer's phone verified by an OTP. Stored default is off so
   * outlets set up before this existed keep working as they did; a new online page set up
   * from the settings screen starts with it on (see the staff settings route).
   */
  verifyPhoneOtp: z.boolean().default(false),
});
export type StorefrontSettings = z.infer<typeof storefrontSettingsSchema>;

export const storefrontUpdateSchema = storefrontSettingsSchema.partial().extend({
  /** Address of the online page: /o/<slug> */
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/, "3–40 letters, numbers or dashes")
    .nullable()
    .optional(),
});
export type StorefrontUpdateInput = z.infer<typeof storefrontUpdateSchema>;

const publicLineSchema = z.object({
  menuItemId: z.string().min(1).max(40),
  variantId: z.string().max(40).optional(),
  addonIds: z.array(z.string().max(40)).max(10).default([]),
  quantity: z.number().int().min(1).max(PUBLIC_ORDER_LIMITS.quantityPerLine),
  notes: z.string().trim().max(120).optional(),
});

const publicCart = {
  items: z
    .array(publicLineSchema)
    .min(1, "Add something to your order")
    .max(PUBLIC_ORDER_LIMITS.lines)
    .refine((l) => l.reduce((n, i) => n + i.quantity, 0) <= PUBLIC_ORDER_LIMITS.totalQuantity, `At most ${PUBLIC_ORDER_LIMITS.totalQuantity} items in one order`),
  notes: z.string().trim().max(200).optional(),
};

/** A guest's order from the QR code on their table. Name and phone are optional. */
export const qrOrderSchema = z.object({
  ...publicCart,
  customerName: z.string().trim().max(60).optional(),
  customerPhone: indianPhone.optional(),
});
export type QrOrderInput = z.infer<typeof qrOrderSchema>;

export const PUBLIC_PAYMENT_OPTIONS = ["COUNTER", "COD", "UPI"] as const;
export type PublicPaymentOption = (typeof PUBLIC_PAYMENT_OPTIONS)[number];

/** An order from the online ordering page. Name and phone are required. */
export const onlineOrderSchema = z.object({
  ...publicCart,
  orderType: z.enum(["TAKEAWAY", "DELIVERY"]),
  customerName: z.string().trim().min(2, "Enter your name").max(60),
  customerPhone: indianPhone,
  /** Signed proof the phone was verified by OTP (required when the outlet turns OTP on) */
  phoneToken: z.string().max(400).optional(),
  /** Pickup / delivery time; empty = as soon as possible */
  pickupAt: z.string().datetime().optional(),
  payment: z.enum(PUBLIC_PAYMENT_OPTIONS),
  delivery: z
    .object({
      address: z.string().trim().min(5).max(500),
      landmark: z.string().trim().max(200).optional(),
      zoneId: z.string().max(40).optional(),
      latitude: z.number().min(-90).max(90).optional(),
      longitude: z.number().min(-180).max(180).optional(),
    })
    .optional(),
});
export type OnlineOrderInput = z.infer<typeof onlineOrderSchema>;

export const tableCallSchema = z.object({ kind: z.enum(["WAITER", "BILL"]) });

export const channelRejectSchema = z.object({ reason: z.string().trim().min(3, "Give a reason").max(200) });

/** Customer phone OTP on the online ordering page. */
export const CUSTOMER_OTP = { ttlSeconds: 300, cooldownSeconds: 30, maxAttempts: 5, tokenTtlSeconds: 1800 } as const;
export const customerOtpRequestSchema = z.object({ phone: indianPhone });
export const customerOtpVerifySchema = z.object({ phone: indianPhone, code: z.string().trim().regex(/^\d{6}$/, "Enter the 6-digit code") });

/** Delivery quote for a map pin on the online ordering page. */
export const publicDeliveryQuoteSchema = z.object({
  lat: z.coerce.number().min(-90).max(90),
  lng: z.coerce.number().min(-180).max(180),
});

/** Refund status of a rejected / cancelled online order paid by UPI. */
export const ONLINE_REFUND_STATUSES = ["PROCESSED", "PENDING", "MANUAL", "FAILED"] as const;
export type OnlineRefundStatus = (typeof ONLINE_REFUND_STATUSES)[number];
