import { z } from "zod";
import { qrOrderSchema } from "./schemas-storefront";

/**
 * Cinema seat ordering (THEATRE module). A screen is a dining area of kind SCREEN and every seat
 * is a dining table in it (label like "S2-F12", with its own QR), so table QR ordering, KOTs and
 * reports keep working. Showtimes per screen drive the interval and the order cut-off.
 * API contract: docs/build/theatre-contract.md.
 */

/** When the guest wants the food. */
export const SEAT_TIMINGS = ["NOW", "INTERVAL", "COUNTER"] as const;
export type SeatTiming = (typeof SEAT_TIMINGS)[number];
export const SEAT_TIMING_LABELS: Record<SeatTiming, string> = {
  NOW: "Deliver to my seat now",
  INTERVAL: "Deliver at the interval",
  COUNTER: "I'll collect at the counter",
};

/** Row letters A–Z, then AA–ZZ for very large halls. */
const rowLabel = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{1,2}$/, "Rows are letters: A–Z (or AA–ZZ)");

export const screenSchema = z.object({
  name: z.string().trim().min(1, "Name the screen").max(40),
  sortOrder: z.number().int().min(0).max(999).optional(),
});
export const screenUpdateSchema = screenSchema.partial();

/** Bulk-create seats: every row in `rows` gets seats `from`…`to`, except the labels in `skip`. Existing seats are kept. */
export const seatBulkSchema = z
  .object({
    rows: z.array(rowLabel).min(1).max(60),
    from: z.number().int().min(1).max(200),
    to: z.number().int().min(1).max(200),
    /** Seat codes to leave out, e.g. ["F13", "A1"] (gangways, broken seats) */
    skip: z.array(z.string().trim().toUpperCase().regex(/^[A-Z]{1,2}\d{1,3}$/)).max(500).default([]),
  })
  .refine((s) => s.to >= s.from, { message: "'to' must be at least 'from'", path: ["to"] })
  .refine((s) => s.rows.length * (s.to - s.from + 1) <= 1500, { message: "At most 1,500 seats at a time", path: ["rows"] });
export type SeatBulkInput = z.infer<typeof seatBulkSchema>;

const isoInstant = z.string().datetime({ offset: true });

export const showTimeSchema = z
  .object({
    screenId: z.string().min(1).max(40),
    title: z.string().trim().min(1, "Enter the movie / show name").max(120),
    startsAt: isoInstant,
    /** Interval start; null = no interval */
    intervalAt: isoInstant.nullable().default(null),
    endsAt: isoInstant,
    /** Ordering closes this many minutes before the show ends */
    orderCutoffMin: z.number().int().min(0).max(120).default(15),
  })
  .refine((s) => Date.parse(s.endsAt) > Date.parse(s.startsAt), { message: "The show must end after it starts", path: ["endsAt"] })
  .refine((s) => !s.intervalAt || (Date.parse(s.intervalAt) > Date.parse(s.startsAt) && Date.parse(s.intervalAt) < Date.parse(s.endsAt)), {
    message: "The interval must be during the show",
    path: ["intervalAt"],
  })
  .refine((s) => Date.parse(s.endsAt) - Date.parse(s.startsAt) <= 8 * 3600_000, { message: "A show can be at most 8 hours", path: ["endsAt"] });
export type ShowTimeInput = z.infer<typeof showTimeSchema>;
export const showTimeUpdateSchema = z.object({
  title: z.string().trim().min(1).max(120).optional(),
  startsAt: isoInstant.optional(),
  intervalAt: isoInstant.nullable().optional(),
  endsAt: isoInstant.optional(),
  orderCutoffMin: z.number().int().min(0).max(120).optional(),
});

/** Outlet theatre settings (stored with the storefront settings). */
export const theatreSettingsSchema = z.object({
  /** Seat QR codes take orders */
  seatOrdering: z.boolean().default(false),
  /** Interval orders go to the kitchen this many minutes before the interval */
  intervalLeadMin: z.number().int().min(0).max(60).default(10),
  /** Offer "collect at the counter" with a token number */
  counterPickup: z.boolean().default(true),
  /** Offer "deliver to my seat now" during the show */
  deliverDuringShow: z.boolean().default(true),
});
export type TheatreSettings = z.infer<typeof theatreSettingsSchema>;

/** A guest's order from a seat QR: the table QR order plus timing. Payment is always UPI up front. */
export const seatOrderSchema = qrOrderSchema.extend({
  timing: z.enum(SEAT_TIMINGS),
});
export type SeatOrderInput = z.infer<typeof seatOrderSchema>;

/** Seat code from row + number: "F" + 12 → "F12"; full label adds the screen code: "S2-F12". */
export const seatCode = (row: string, n: number) => `${row}${n}`;
