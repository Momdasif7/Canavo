import { z } from "zod";
import { indianPhone, orderItemInputSchema } from "./schemas";

/** Phase 5.3 / 5.4 (CANTEEN): meal slots, slot menus, next-day pre-orders, meal subscriptions. */
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM (24h)");
const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");
const paise = z.number().int().nonnegative();

export const mealSlotSchema = z
  .object({
    name: z.string().trim().min(1).max(40),
    startTime: hhmm,
    endTime: hhmm,
    /** Pre-orders for a day close at this time on the previous day; null = this slot takes no pre-orders */
    preorderCutoff: hhmm.nullable().default(null),
    active: z.boolean().default(true),
    sortOrder: z.number().int().min(0).max(999).default(0),
  })
  .refine((s) => s.startTime !== s.endTime, { message: "Start and end time can't be the same", path: ["endTime"] });
export type MealSlotInput = z.infer<typeof mealSlotSchema>;
export const mealSlotUpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(40),
    startTime: hhmm,
    endTime: hhmm,
    preorderCutoff: hhmm.nullable(),
    active: z.boolean(),
    sortOrder: z.number().int().min(0).max(999),
  })
  .partial();

/** Replace the slot's menu: items sold in this slot, with an optional slot price (paise). */
export const mealSlotItemsSchema = z.object({
  items: z
    .array(z.object({ menuItemId: z.string().min(1), price: paise.nullable().default(null) }))
    .max(500)
    .refine((a) => new Set(a.map((i) => i.menuItemId)).size === a.length, "An item is listed twice"),
});

/** Book a meal for a date + slot (before the slot's cutoff on the previous day). */
export const canteenPreorderSchema = z.object({
  date: ymd,
  slotId: z.string().min(1),
  items: z.array(orderItemInputSchema).min(1).max(50),
  customerName: z.string().trim().max(100).optional(),
  customerPhone: indianPhone.optional(),
  notes: z.string().max(300).optional(),
  /** Managers only: book after the cutoff */
  override: z.boolean().optional(),
});
export type CanteenPreorderInput = z.infer<typeof canteenPreorderSchema>;

/** Modes a subscription can be paid with upfront (existing payment modes). */
export const SUBSCRIPTION_PAY_MODES = ["CASH", "UPI", "CARD", "KHATA"] as const;

export const mealSubscriptionSchema = z
  .object({
    customerId: z.string().min(1),
    slotId: z.string().min(1),
    menuItemId: z.string().min(1),
    /** 0 = Monday … 6 = Sunday */
    daysOfWeek: z.array(z.number().int().min(0).max(6)).min(1).max(7),
    startDate: ymd,
    endDate: ymd,
    /** Paise per meal; default = the item's price in that slot */
    pricePerMeal: paise.optional(),
    paymentMode: z.enum(SUBSCRIPTION_PAY_MODES),
    reference: z.string().max(100).optional(),
    notes: z.string().max(300).optional(),
  })
  .refine((s) => s.startDate <= s.endDate, { message: "End date is before the start date", path: ["endDate"] });
export type MealSubscriptionInput = z.infer<typeof mealSubscriptionSchema>;

export const mealSubscriptionCancelSchema = z.object({
  /** How the unused meals' money goes back (credit note on the upfront bill) */
  refundMode: z.enum(SUBSCRIPTION_PAY_MODES),
  note: z.string().trim().max(300).optional(),
});

export const WEEKDAY_SHORT = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;
