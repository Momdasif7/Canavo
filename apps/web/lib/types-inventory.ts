/**
 * Response shapes of the inventory API (`/inventory/*`) as consumed by the web app.
 * Dates arrive as ISO strings; money is integer paise; quantities are in the item's unit.
 */
import type { InventoryTxnTypeCode, StockUnitCode } from "@canavo/shared";

export type StockUnit = StockUnitCode;
export type InventoryTxnType = InventoryTxnTypeCode;
export type PurchaseStatus = "DRAFT" | "RECEIVED" | "CANCELLED";
export type AuditStatus = "IN_PROGRESS" | "COMPLETED" | "CANCELLED";
export type TransferStatus = "REQUESTED" | "APPROVED" | "DISPATCHED" | "RECEIVED" | "REJECTED" | "CANCELLED";
export type PurchasePaymentMode = "CASH" | "UPI" | "BANK" | "CHEQUE";

// ---------- Items ----------
export interface InventoryItem {
  id: string;
  name: string;
  sku: string | null;
  barcode: string | null;
  category: string;
  unit: StockUnit;
  /** Weighted-average cost, paise per unit */
  costPerUnit: number;
  reorderLevel: number;
  reorderQty: number;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Item with stock at the active outlet (GET /inventory/items). */
export interface StockItem extends InventoryItem {
  quantity: number;
  value: number;
  lowStock: boolean;
}

export interface StockItemList {
  items: StockItem[];
  totals: { count: number; value: number; lowStock: number };
}

export interface ItemCategory {
  category: string;
  count: number;
}

/** GET /inventory/items/lookup */
export interface LookupItem extends InventoryItem {
  quantity: number;
  lowStock: boolean;
}

export interface InventoryTransaction {
  id: string;
  outletId: string;
  inventoryItemId: string;
  type: InventoryTxnType;
  /** Signed, in the item's unit */
  quantity: number;
  unitCost: number | null;
  balanceAfter: number;
  refType: string | null;
  refId: string | null;
  note: string | null;
  createdById: string | null;
  createdAt: string;
}

export interface ItemUsedIn {
  menuItemId: string;
  menuItemName: string;
  variantId: string | null;
  variantName: string | null;
  quantity: number;
}

/** GET /inventory/items/:id */
export interface StockItemDetail extends StockItem {
  outletStocks: { outletId: string; quantity: number }[];
  usedIn: ItemUsedIn[];
  transactions: InventoryTransaction[];
}

export interface LowStockAlertItem extends InventoryItem {
  quantity: number;
  outOfStock: boolean;
  suggestedOrderQty: number;
}

/** GET /inventory/alerts */
export interface LowStockAlerts {
  count: number;
  outOfStock: number;
  items: LowStockAlertItem[];
}

/** Socket `inventory:low` */
export interface InventoryLowEvent {
  items: { id: string; name: string; unit: StockUnit; quantity: number; reorderLevel: number }[];
}

export interface WastageResult {
  transactions: InventoryTransaction[];
  value: number;
}

// ---------- Recipes ----------
export interface RecipeRow {
  id: string;
  menuItemId: string;
  variantId: string | null;
  inventoryItemId: string;
  /** In the inventory item's unit */
  quantity: number;
  item: { id: string; name: string; unit: StockUnit; costPerUnit: number; active: boolean };
  cost: number;
}

export interface RecipeSaveResult {
  menuItemId: string;
  variantId: string | null;
  cost: number;
}

export interface CostingRow {
  menuItemId: string;
  name: string;
  category: string;
  variantId: string | null;
  variantName: string | null;
  price: number;
  netPrice: number;
  hasRecipe: boolean;
  cost: number;
  foodCostPercent: number | null;
  margin: number;
  lines: { inventoryItemId: string; name: string; unit: StockUnit; quantity: number; cost: number }[];
}

export interface Costing {
  items: CostingRow[];
  summary: { menuRows: number; withRecipe: number; avgFoodCostPercent: number | null };
}

// ---------- Vendors ----------
export interface VendorSummary {
  purchases: number;
  totalSpend: number;
  paid: number;
  outstanding: number;
  lastPurchaseAt: string | null;
}

export interface Vendor {
  id: string;
  name: string;
  contactPerson: string | null;
  phone: string | null;
  email: string | null;
  gstin: string | null;
  address: string | null;
  notes: string | null;
  active: boolean;
  createdAt: string;
}

export interface VendorWithSummary extends Vendor {
  summary: VendorSummary;
}

export interface VendorDetail extends VendorWithSummary {
  purchases: PurchaseBase[];
}

// ---------- Purchases ----------
export interface PurchaseBase {
  id: string;
  outletId: string;
  vendorId: string;
  invoiceNo: string | null;
  invoiceDate: string | null;
  invoiceImageUrl: string | null;
  status: PurchaseStatus;
  subtotal: number;
  tax: number;
  total: number;
  paidAmount: number;
  notes: string | null;
  createdById: string | null;
  receivedAt: string | null;
  createdAt: string;
}

export interface PurchaseListRow extends PurchaseBase {
  vendor: { id: string; name: string };
  _count: { items: number };
  balance: number;
}

export interface PurchaseLine {
  id: string;
  purchaseId: string;
  inventoryItemId: string;
  quantity: number;
  unitCost: number;
  taxRate: number;
  total: number;
  item: { id: string; name: string; unit: StockUnit } | null;
}

export interface PurchaseDetail extends PurchaseBase {
  vendor: { id: string; name: string; phone: string | null; gstin: string | null };
  items: PurchaseLine[];
  balance: number;
}

// ---------- Audits ----------
export interface AuditListRow {
  id: string;
  outletId: string;
  status: AuditStatus;
  notes: string | null;
  startedById: string | null;
  completedAt: string | null;
  createdAt: string;
  _count: { lines: number };
}

export interface AuditLine {
  id: string;
  auditId: string;
  inventoryItemId: string;
  systemQty: number;
  countedQty: number | null;
  item: { id: string; name: string; unit: StockUnit; category: string; costPerUnit: number; barcode: string | null; sku: string | null };
  variance: number | null;
  varianceValue: number | null;
}

export interface AuditDetail extends Omit<AuditListRow, "_count"> {
  lines: AuditLine[];
  summary: { items: number; counted: number; withVariance: number; varianceValue: number };
}

// ---------- Transfers ----------
export interface TransferBase {
  id: string;
  fromOutletId: string;
  toOutletId: string;
  status: TransferStatus;
  notes: string | null;
  requestedById: string | null;
  approvedById: string | null;
  createdAt: string;
  updatedAt: string;
  fromOutletName: string | null;
  toOutletName: string | null;
}

export interface TransferListRow extends TransferBase {
  _count: { items: number };
  direction: "incoming" | "outgoing";
}

export interface TransferDetail extends TransferBase {
  items: {
    id: string;
    transferId: string;
    inventoryItemId: string;
    quantity: number;
    item: { id: string; name: string; unit: StockUnit; costPerUnit: number } | null;
  }[];
  value: number;
}

// ---------- Reports ----------
export interface ConsumptionReport {
  from: string;
  to: string;
  rows: { date: string; inventoryItemId: string; name: string; unit: StockUnit; category: string; sale: number; wastage: number; total: number; value: number }[];
  totalValue: number;
}

export interface MovementReport {
  from: string;
  to: string;
  rows: {
    inventoryItemId: string;
    name: string;
    unit: StockUnit;
    category: string;
    opening: number;
    in: number;
    out: number;
    closing: number;
    closingValue: number;
    byType: Partial<Record<InventoryTxnType, number>>;
  }[];
}

export interface ValuationReport {
  rows: { inventoryItemId: string; name: string; category: string; unit: StockUnit; quantity: number; costPerUnit: number; value: number }[];
  byCategory: { category: string; value: number }[];
  totalValue: number;
}

export interface WastageReport {
  from: string;
  to: string;
  rows: {
    id: string;
    date: string;
    createdAt: string;
    inventoryItemId: string;
    name: string;
    unit: StockUnit;
    quantity: number;
    value: number;
    reason: string | null;
    by: string | null;
  }[];
  byItem: { inventoryItemId: string; name: string; unit: StockUnit; quantity: number; value: number }[];
  totalValue: number;
}

export interface VendorSpendReport {
  from: string;
  to: string;
  rows: { vendorId: string; vendor: string; purchases: number; subtotal: number; tax: number; total: number; paid: number; outstanding: number }[];
  total: number;
  outstanding: number;
}

export interface PurchasesReport {
  from: string;
  to: string;
  rows: {
    id: string;
    date: string;
    invoiceNo: string | null;
    invoiceDate: string | null;
    vendor: string;
    status: PurchaseStatus;
    items: number;
    subtotal: number;
    tax: number;
    total: number;
    paid: number;
    balance: number;
  }[];
  totals: { received: number; total: number; tax: number; balance: number };
}
