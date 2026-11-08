// Zod schemas & types for the service module: tables, running tabs (KOT),
// reservations / pre-orders and delivery.
import { z } from "zod";
import { approvalSchema } from "./schemas";
import { indianPhone } from "./schemas";
import { gstinSchema, gstStateCode } from "./india";

const paise = z.number().int().nonnegative();
const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");

// ---------- Floor plan ----------
export const TABLE_STATUSES = ["AVAILABLE", "OCCUPIED", "NEEDS_ATTENTION", "RESERVED"] as const;
export const TABLE_SHAPES = ["SQUARE", "ROUND", "RECTANGLE"] as const;

export const diningAreaSchema = z.object({
  name: z.string().trim().min(1).max(60),
  sortOrder: z.number().int().default(0),
});
export type DiningAreaInput = z.infer<typeof diningAreaSchema>;

const tablePosition = {
  posX: z.number().int().min(0).max(500),
  posY: z.number().int().min(0).max(500),
  width: z.number().int().min(1).max(50),
  height: z.number().int().min(1).max(50),
  rotation: z.number().int().min(0).max(359),
};

export const diningTableSchema = z.object({
  label: z.string().trim().min(1).max(20),
  areaId: z.string().nullable().optional(),
  capacity: z.number().int().min(1).max(50).default(4),
  shape: z.enum(TABLE_SHAPES).default("SQUARE"),
  posX: tablePosition.posX.default(0),
  posY: tablePosition.posY.default(0),
  width: tablePosition.width.default(2),
  height: tablePosition.height.default(2),
  rotation: tablePosition.rotation.default(0),
  waiterId: z.string().nullable().optional(),
  active: z.boolean().default(true),
});
export type DiningTableInput = z.infer<typeof diningTableSchema>;
/** PATCH body: every field optional, no defaults applied */
export const diningTableUpdateSchema = z.object({
  label: z.string().trim().min(1).max(20),
  areaId: z.string().nullable(),
  capacity: z.number().int().min(1).max(50),
  shape: z.enum(TABLE_SHAPES),
  ...tablePosition,
  waiterId: z.string().nullable(),
  active: z.boolean(),
}).partial();

/** Drag-and-drop floor editor: bulk save positions */
export const tableLayoutSchema = z.object({
  tables: z
    .array(
      z.object({
        id: z.string(),
        areaId: z.string().nullable().optional(),
        shape: z.enum(TABLE_SHAPES).optional(),
        ...tablePosition,
      }),
    )
    .min(1)
    .max(500),
});
export type TableLayoutInput = z.infer<typeof tableLayoutSchema>;

export const tableStatusSchema = z.object({ status: z.enum(TABLE_STATUSES) });
export const tableWaiterSchema = z.object({ waiterId: z.string().nullable() });

// ---------- Running tabs ----------
export const sessionOpenSchema = z.object({
  guests: z.number().int().min(1).max(100).default(1),
  waiterId: z.string().optional(),
  customerName: z.string().trim().max(100).optional(),
  customerPhone: indianPhone.optional(),
});
export type SessionOpenInput = z.infer<typeof sessionOpenSchema>;

export const sessionItemInputSchema = z.object({
  menuItemId: z.string(),
  variantId: z.string().optional(),
  addonIds: z.array(z.string()).default([]),
  quantity: z.number().int().min(1).max(999),
  notes: z.string().max(200).optional(),
  seat: z.number().int().min(1).max(100).optional(),
});
export type SessionItemInput = z.infer<typeof sessionItemInputSchema>;

export const sessionItemsSchema = z.object({ items: z.array(sessionItemInputSchema).min(1).max(100) });
export const sessionUpdateSchema = z
  .object({
    guests: z.number().int().min(1).max(100),
    waiterId: z.string().nullable(),
    customerName: z.string().trim().max(100).nullable(),
    customerPhone: indianPhone.nullable(),
  })
  .partial();
export const sessionTransferSchema = z.object({ toTableId: z.string() });
export const sessionMergeSchema = z.object({ tableIds: z.array(z.string()).min(1).max(20) });
export const itemVoidSchema = z.object({ reason: z.string().trim().min(3).max(200) });

export const BILL_SPLIT_MODES = ["FULL", "BY_SEAT", "BY_ITEMS", "EQUAL"] as const;
export type BillSplitMode = (typeof BILL_SPLIT_MODES)[number];

export const sessionBillSchema = z
  .object({
    mode: z.enum(BILL_SPLIT_MODES).default("FULL"),
    /** Manager approval for a discount above the outlet's limit (APPROVAL_PINS) */
    approval: approvalSchema.optional(),
    /** BY_ITEMS: bill just these session items (one order) */
    itemIds: z.array(z.string()).optional(),
    /** BY_ITEMS: several bills at once, one order per group of session item ids */
    groups: z.array(z.array(z.string()).min(1)).optional(),
    /** BY_SEAT: only these seats (default: every seat with unbilled items) */
    seats: z.array(z.number().int().min(1)).optional(),
    /** EQUAL: number of people to split the single bill between */
    parts: z.number().int().min(2).max(50).optional(),
    discount: z
      .discriminatedUnion("type", [
        z.object({ type: z.literal("FLAT"), value: paise }),
        z.object({ type: z.literal("PERCENT"), value: z.number().min(0).max(100) }),
      ])
      .optional(),
    couponCode: z.string().trim().toUpperCase().max(30).optional(),
    redeemPoints: z.number().int().positive().optional(),
    customerPhone: indianPhone.optional(),
    customerName: z.string().trim().max(100).optional(),
    interState: z.boolean().default(false),
    /** QA 16b: B2B tax invoice for a registered buyer (see orderCreateSchema) */
    buyerGstin: gstinSchema.optional(),
    buyerName: z.string().trim().min(2).max(200).optional(),
    buyerAddress: z.string().trim().max(300).optional(),
    placeOfSupply: gstStateCode.optional(),
    notes: z.string().max(300).optional(),
  })
  .refine((v) => v.mode !== "BY_ITEMS" || (v.itemIds?.length ?? 0) > 0 || (v.groups?.length ?? 0) > 0, {
    message: "BY_ITEMS needs itemIds or groups",
  })
  .refine((v) => v.mode !== "EQUAL" || v.parts !== undefined, { message: "EQUAL needs parts" });
export type SessionBillInput = z.infer<typeof sessionBillSchema>;

// ---------- Reservations ----------
export const RESERVATION_STATUSES = ["BOOKED", "SEATED", "COMPLETED", "CANCELLED", "NO_SHOW"] as const;

export const preOrderItemSchema = sessionItemInputSchema.omit({ seat: true });
export type PreOrderItem = z.infer<typeof preOrderItemSchema>;

export const reservationCreateSchema = z.object({
  tableId: z.string().nullable().optional(),
  customerName: z.string().trim().min(1).max(100),
  customerPhone: indianPhone,
  partySize: z.number().int().min(1).max(100),
  reservedFor: z.string().datetime({ offset: true }),
  durationMin: z.number().int().min(15).max(600).default(90),
  notes: z.string().max(500).optional(),
  preOrderItems: z.array(preOrderItemSchema).max(100).default([]),
  advancePaid: paise.default(0),
});
export type ReservationCreateInput = z.infer<typeof reservationCreateSchema>;
export const reservationUpdateSchema = z
  .object({
    tableId: z.string().nullable(),
    customerName: z.string().trim().min(1).max(100),
    customerPhone: indianPhone,
    partySize: z.number().int().min(1).max(100),
    reservedFor: z.string().datetime({ offset: true }),
    durationMin: z.number().int().min(15).max(600),
    notes: z.string().max(500).nullable(),
    preOrderItems: z.array(preOrderItemSchema).max(100),
    advancePaid: paise,
  })
  .partial();
export const reservationListQuerySchema = z.object({
  date: ymd.optional(),
  status: z.enum(RESERVATION_STATUSES).optional(),
});
export const reservationSeatSchema = z.object({
  tableId: z.string().optional(),
  waiterId: z.string().optional(),
});
export const reservationCancelSchema = z.object({ reason: z.string().max(200).optional() });

// ---------- Delivery ----------
export const DELIVERY_STATUSES = ["PENDING", "ACCEPTED", "PREPARING", "OUT_FOR_DELIVERY", "DELIVERED", "CANCELLED"] as const;
export type DeliveryStatusValue = (typeof DELIVERY_STATUSES)[number];

export const deliveryZoneSchema = z.object({
  name: z.string().trim().min(1).max(60),
  radiusKm: z.number().positive().max(100),
  fee: paise.default(0),
  minOrder: paise.default(0),
  etaMinutes: z.number().int().min(5).max(300).default(30),
  active: z.boolean().default(true),
});
export type DeliveryZoneInput = z.infer<typeof deliveryZoneSchema>;
export const deliveryZoneUpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(60),
    radiusKm: z.number().positive().max(100),
    fee: paise,
    minOrder: paise,
    etaMinutes: z.number().int().min(5).max(300),
    active: z.boolean(),
  })
  .partial();

export const deliveryQuoteQuerySchema = z.object({
  lat: z.coerce.number().min(-90).max(90).optional(),
  lng: z.coerce.number().min(-180).max(180).optional(),
  address: z.string().max(500).optional(),
  /** Address-only delivery: PIN code / area to check against the outlet's allowed areas */
  pincode: z.string().trim().max(10).optional(),
  area: z.string().trim().max(60).optional(),
});
export const deliveryListQuerySchema = z.object({
  status: z.enum(DELIVERY_STATUSES).optional(),
  agentId: z.string().optional(),
  date: ymd.optional(),
  active: z.enum(["1", "0"]).optional(),
});
export const deliveryAssignSchema = z.object({
  agentId: z.string().nullable(),
  /** Managers only: assign even if the partner already has the maximum or is out on a run */
  force: z.boolean().optional(),
});
export const deliveryStatusSchema = z.object({
  status: z.enum(DELIVERY_STATUSES),
  note: z.string().max(200).optional(),
});
export const deliveryLocationSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});

// ---------- Delivery partner portal ----------

/** GET /delivery/mine?view=active|history&from&to */
export const deliveryMineQuerySchema = z.object({
  view: z.enum(["active", "history"]).default("active"),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

/** GET /delivery/mine/summary?from&to (defaults to today in outlet time) */
export const deliverySummaryQuerySchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

/** POST /delivery/:id/collect — payment received at the door (cash, GPay/UPI, card) */
export const deliveryCollectSchema = z.object({
  payments: z
    .array(
      z.object({
        mode: z.enum(["CASH", "UPI", "CARD"]),
        amount: z.number().int().positive(),
        reference: z.string().trim().max(100).optional(),
      }),
    )
    .min(1),
});
export type DeliveryCollectInput = z.infer<typeof deliveryCollectSchema>;

/** POST /delivery/:id/issue — couldn't deliver / problem on the way */
export const deliveryIssueSchema = z.object({
  reason: z.enum(["CUSTOMER_UNREACHABLE", "WRONG_ADDRESS", "CUSTOMER_REFUSED", "VEHICLE_PROBLEM", "OTHER"]),
  note: z.string().trim().max(300).optional(),
});

/** POST /delivery/cash/settle — manager confirms cash handed over by a delivery partner */
export const deliveryCashSettleSchema = z.object({
  agentId: z.string(),
  /** Specific deliveries; omit to settle everything the partner holds */
  deliveryIds: z.array(z.string()).optional(),
});

/** POST /delivery/cash/handovers — outlet records cash received from a delivery partner */
export const deliveryHandoverSchema = z.object({
  agentId: z.string(),
  amount: z.number().int().positive("Enter the amount received"),
  note: z.string().trim().max(300).optional(),
  /** Back-date a handover (corrections); defaults to now */
  receivedAt: z.string().datetime({ offset: true }).optional(),
});
export const deliveryHandoverUpdateSchema = z.object({
  amount: z.number().int().positive().optional(),
  note: z.string().trim().max(300).nullable().optional(),
  receivedAt: z.string().datetime({ offset: true }).optional(),
});

/** GET /delivery/partners/activity?from&to&agentId — manager view of partner days */
export const deliveryActivityQuerySchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  agentId: z.string().optional(),
});


/** POST /delivery/me/location — partner app reports GPS while on duty (detects return to the outlet) */
export const partnerLocationSchema = z.object({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  accuracy: z.number().nonnegative().optional(),
});
