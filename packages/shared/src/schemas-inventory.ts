// Zod schemas & types for the inventory module (owned by that module's implementer).
import { z } from "zod";
import { gstinSchema } from "./india";

export const STOCK_UNITS = ["KG", "G", "L", "ML", "PIECE", "PACKET", "DOZEN", "BOX"] as const;
export type StockUnitCode = (typeof STOCK_UNITS)[number];

export const INVENTORY_TXN_TYPES = [
  "OPENING",
  "PURCHASE",
  "SALE",
  "SALE_REVERSAL",
  "WASTAGE",
  "ADJUSTMENT",
  "AUDIT",
  "TRANSFER_IN",
  "TRANSFER_OUT",
  "RETURN",
] as const;
export type InventoryTxnTypeCode = (typeof INVENTORY_TXN_TYPES)[number];

const id = z.string().min(1).max(40);
const paise = z.number().int().nonnegative();
const qty = z.number().finite().positive().max(10_000_000);
const optText = (max: number) => z.string().trim().max(max).optional().nullable();
const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD");
const stockUnit = z.enum(STOCK_UNITS);

// ---------- Items ----------
export const inventoryItemSchema = z.object({
  name: z.string().trim().min(2).max(120),
  sku: optText(60),
  barcode: optText(64),
  category: z.string().trim().min(1).max(60).default("General"),
  unit: stockUnit,
  /** Paise per unit */
  costPerUnit: paise.default(0),
  reorderLevel: z.number().finite().min(0).default(0),
  reorderQty: z.number().finite().min(0).default(0),
  /** Optional opening stock at the active outlet (posted as an OPENING transaction) */
  openingStock: z.number().finite().min(0).optional(),
});
export type InventoryItemInput = z.infer<typeof inventoryItemSchema>;

export const inventoryItemUpdateSchema = inventoryItemSchema
  .omit({ openingStock: true })
  .partial()
  .extend({ active: z.boolean().optional() });
export type InventoryItemUpdateInput = z.infer<typeof inventoryItemUpdateSchema>;

/** Opening stock / manual adjustment. Give either a signed `quantity` delta or an absolute `setTo`. */
export const stockAdjustSchema = z
  .object({
    quantity: z.number().finite().optional(),
    setTo: z.number().finite().min(0).optional(),
    reason: z.string().trim().min(2).max(200),
    /** Post as OPENING instead of ADJUSTMENT */
    opening: z.boolean().default(false),
    /** Optional cost for stock added (paise per unit); also updates the weighted average */
    unitCost: paise.optional(),
  })
  .refine((d) => (d.quantity === undefined) !== (d.setTo === undefined), {
    message: "Provide exactly one of quantity or setTo",
  })
  .refine((d) => d.quantity !== 0, { message: "quantity must not be zero", path: ["quantity"] });
export type StockAdjustInput = z.infer<typeof stockAdjustSchema>;

// ---------- Recipes ----------
export const recipeLineSchema = z.object({
  inventoryItemId: id,
  quantity: qty,
  /** Unit the quantity is entered in; converted to the item's unit (KG↔G, L↔ML, DOZEN→PIECE) */
  unit: stockUnit.optional(),
});
export const recipeUpsertSchema = z.object({
  /** null/omitted = default recipe for all variants without their own */
  variantId: id.nullable().optional(),
  /** Empty list removes the recipe */
  lines: z.array(recipeLineSchema).max(50),
});
export type RecipeLineInput = z.infer<typeof recipeLineSchema>;
export type RecipeUpsertInput = z.infer<typeof recipeUpsertSchema>;

// ---------- Vendors ----------
export const vendorSchema = z.object({
  name: z.string().trim().min(2).max(120),
  contactPerson: optText(120),
  phone: optText(20),
  email: z.string().trim().email().optional().nullable().or(z.literal("")),
  gstin: z.literal("").or(gstinSchema).optional().nullable(),
  address: optText(500),
  notes: optText(500),
});
export const vendorUpdateSchema = vendorSchema.partial().extend({ active: z.boolean().optional() });
export type VendorInput = z.infer<typeof vendorSchema>;
export type VendorUpdateInput = z.infer<typeof vendorUpdateSchema>;

// ---------- Purchases ----------
export const purchaseItemSchema = z.object({
  inventoryItemId: id,
  /** In the item's unit */
  quantity: qty,
  /** Pre-tax paise per unit */
  unitCost: paise,
  /** GST % on this line */
  taxRate: z.number().min(0).max(28).default(0),
});
export const purchaseCreateSchema = z.object({
  vendorId: id,
  invoiceNo: optText(60),
  invoiceDate: ymd.optional().nullable(),
  /** URL from the uploads module */
  invoiceImageUrl: z.string().trim().max(1000).optional().nullable(),
  notes: optText(500),
  items: z.array(purchaseItemSchema).min(1).max(200),
  /** Receive immediately (skip the draft step) */
  receive: z.boolean().default(false),
});
export const purchaseUpdateSchema = purchaseCreateSchema.omit({ receive: true }).partial();
export const purchasePaymentSchema = z.object({
  amount: z.number().int().positive(),
  mode: z.enum(["CASH", "UPI", "BANK", "CHEQUE"]).default("CASH"),
  reference: optText(100),
});
export const purchaseCancelSchema = z.object({ reason: z.string().trim().min(3).max(200) });
export type PurchaseItemInput = z.infer<typeof purchaseItemSchema>;
export type PurchaseCreateInput = z.infer<typeof purchaseCreateSchema>;
export type PurchaseUpdateInput = z.infer<typeof purchaseUpdateSchema>;
export type PurchasePaymentInput = z.infer<typeof purchasePaymentSchema>;

/** Purchase totals in paise. Line total includes GST. */
export function computePurchaseTotals(items: { quantity: number; unitCost: number; taxRate?: number }[]) {
  const lines = items.map((i) => {
    const net = Math.round(i.quantity * i.unitCost);
    const tax = Math.round((net * (i.taxRate ?? 0)) / 100);
    return { net, tax, total: net + tax };
  });
  const subtotal = lines.reduce((s, l) => s + l.net, 0);
  const tax = lines.reduce((s, l) => s + l.tax, 0);
  return { lines, subtotal, tax, total: subtotal + tax };
}

// ---------- Wastage ----------
export const wastageSchema = z.object({
  items: z
    .array(
      z.object({
        inventoryItemId: id,
        quantity: qty,
        unit: stockUnit.optional(),
        reason: z.string().trim().min(2).max(200),
      }),
    )
    .min(1)
    .max(100),
});
export type WastageInput = z.infer<typeof wastageSchema>;

// ---------- Stock audits ----------
export const stockAuditStartSchema = z.object({
  notes: optText(500),
  /** Only snapshot items in this category */
  category: z.string().trim().max(60).optional(),
});
export const stockAuditCountsSchema = z.object({
  counts: z
    .array(z.object({ inventoryItemId: id, countedQty: z.number().finite().min(0).nullable() }))
    .min(1)
    .max(2000),
});
export type StockAuditStartInput = z.infer<typeof stockAuditStartSchema>;
export type StockAuditCountsInput = z.infer<typeof stockAuditCountsSchema>;

// ---------- Inter-outlet transfers ----------
export const stockTransferCreateSchema = z
  .object({
    /** Send from the active outlet to this outlet */
    toOutletId: id.optional(),
    /** Request stock from this outlet into the active outlet */
    fromOutletId: id.optional(),
    notes: optText(500),
    items: z.array(z.object({ inventoryItemId: id, quantity: qty })).min(1).max(200),
  })
  .refine((d) => (d.toOutletId === undefined) !== (d.fromOutletId === undefined), {
    message: "Provide exactly one of toOutletId or fromOutletId",
  });
export const stockTransferRejectSchema = z.object({ reason: z.string().trim().min(3).max(200) });
export type StockTransferCreateInput = z.infer<typeof stockTransferCreateSchema>;

// ---------- Reports ----------
export const inventoryReportQuerySchema = z.object({
  from: ymd.optional(),
  to: ymd.optional(),
  itemId: id.optional(),
  format: z.enum(["json", "xlsx"]).default("json"),
});
export type InventoryReportQuery = z.infer<typeof inventoryReportQuerySchema>;
