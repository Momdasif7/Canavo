/** Response shapes of the /reports/* endpoints (format=json). Money is in paise. */

export type GroupBy = "day" | "week" | "month";

export interface SalesBucket {
  period: string;
  orders: number;
  gross: number;
  net: number;
  tax: number;
  discounts: number;
  promoDiscounts: number;
  extraCharges: number;
  serviceCharge: number;
  roundOff: number;
  aov: number;
  cancelled: number;
  cancelledValue: number;
}

export interface SalesReport {
  from: string;
  to: string;
  groupBy: GroupBy;
  totals: SalesBucket;
  periods: SalesBucket[];
  byOrderType: { orderType: string; orders: number; gross: number; net: number; share: number }[];
  byPaymentMode: { mode: string; count: number; amount: number; share: number }[];
  /** Phase 6.1 (CHANNELS only): sales by channel with the estimated aggregator commission */
  byChannel?: { channel: string; label: string; orders: number; gross: number; net: number; share: number; commissionPercent: number; commission: number; afterCommission: number }[];
}

export interface ItemRow {
  menuItemId: string;
  name: string;
  categoryId: string;
  category: string;
  status: string;
  quantity: number;
  revenue: number;
  netRevenue: number;
  share: number;
  qtyShare: number;
}

export interface ItemsReport {
  from: string;
  to: string;
  totalRevenue: number;
  totalQuantity: number;
  items: ItemRow[];
  bestSellers: ItemRow[];
  slowMovers: ItemRow[];
  zeroSales: { menuItemId: string; name: string }[];
}

export interface CategoryRow {
  categoryId: string;
  category: string;
  items: number;
  itemsSold: number;
  quantity: number;
  revenue: number;
  netRevenue: number;
  share: number;
}

export interface CategoriesReport {
  from: string;
  to: string;
  totalRevenue: number;
  categories: CategoryRow[];
}

export interface PeakCell {
  weekday: string;
  hour: number;
  orders: number;
  revenue: number;
  avgOrders: number;
}

export interface PeakHoursReport {
  from: string;
  to: string;
  weekdays: string[];
  /** [weekday][hour] */
  orders: number[][];
  revenue: number[][];
  cells: PeakCell[];
  peaks: PeakCell[];
  byHour: { hour: number; orders: number; revenue: number }[];
  byWeekday: { weekday: string; days: number; orders: number; revenue: number }[];
}

export interface GstReport {
  from: string;
  to: string;
  gstin: string | null;
  stateCode: string;
  compositionScheme: boolean;
  byRate: { rate: number; supply: string; taxable: number; cgst: number; sgst: number; igst: number; totalTax: number; invoices: number }[];
  totals: { taxable: number; cgst: number; sgst: number; igst: number; totalTax: number; invoiceValue: number; roundOff: number };
  billOfSupplyTurnover: number;
  documentTypes: { documentType: string; issued: number; paid: number; open: number; cancelled: number; value: number }[];
  cancelledInvoices: { invoiceNumber: string; documentType: string; date: string; value: number; reason: string }[];
  notes: string[];
}

export interface Gstr1Response {
  month: string;
  financialYear: string;
  excluded: boolean;
  gstr1: {
    gstin: string;
    fp: string;
    /** Rupees (2 decimals), as in the GSTN schema */
    b2cs: { sply_ty: string; pos: string; typ: string; rt: number; txval: number; iamt: number; camt: number; samt: number; csamt: number }[];
    hsn: { data: { num: number; hsn_sc: string; desc: string; uqc: string; qty: number; rt: number; txval: number; iamt: number; camt: number; samt: number; csamt: number }[] };
    doc_issue: { doc_det: { doc_num: number; doc_typ: string; docs: { num: number; from: string; to: string; totnum: number; cancel: number; net_issue: number }[] }[] };
  };
  totals: { invoices: number; txval: number; iamt: number; camt: number; samt: number; paise: { taxable: number; cgst: number; sgst: number; igst: number } };
  notes: string[];
  warnings: string[];
}

export interface ProfitItem {
  menuItemId: string;
  variantId: string | null;
  name: string;
  price: number;
  recipeCost: number | null;
  foodCostPercent: number | null;
  quantitySold: number;
  netRevenue: number;
  estimatedCogs: number | null;
  marginPercent: number | null;
  hasRecipe: boolean;
}

export interface ProfitReport {
  from: string;
  to: string;
  revenue: number;
  cogs: number;
  cogsFromStock: number;
  cogsEstimated: number;
  estimatedOrders: number;
  grossProfit: number;
  grossMarginPercent: number;
  foodCostPercent: number;
  purchases: number;
  purchaseBills: number;
  wastageValue: number;
  wastagePercent: number;
  items: ProfitItem[];
  notes: string[];
}

export interface StaffRow {
  userId: string;
  name: string;
  role: string;
  bills: number;
  sales: number;
  avgBill: number;
  cancellations: number;
  cancelledValue: number;
  presentDays: number;
  halfDays: number;
  paidLeaveDays: number;
  lateCount: number;
  lateMinutes: number;
  overtimeMinutes: number;
  workedHours: number;
  payableDays: number;
  estimatedPay: number;
}

export interface StaffReport {
  from: string;
  to: string;
  staff: StaffRow[];
  notes: string[];
}

export interface CustomersReport {
  from: string;
  to: string;
  uniqueCustomers: number;
  newCustomers: number;
  returningCustomers: number;
  repeatCustomers: number;
  repeatRate: number;
  customerOrders: number;
  walkInOrders: number;
  identifiedOrderShare: number;
  customerAov: number;
  overallAov: number;
  pointsIssued: number;
  pointsRedeemed: number;
  khataDebits: number;
  khataCredits: number;
  khataOutstanding: number;
  khataCustomersWithDues: number;
  topCustomers: { customerId: string; name: string; phone: string; tier: string; orders: number; spend: number; avgOrder: number; points: number }[];
  notes: string[];
}

export interface InventoryRow {
  inventoryItemId: string;
  name: string;
  category: string;
  unit: string;
  opening: number;
  purchased: number;
  otherIn: number;
  in: number;
  sold: number;
  wasted: number;
  otherOut: number;
  out: number;
  closing: number;
  closingValue: number;
  wastageValue: number;
  currentStock: number;
}

export interface InventoryReport {
  from: string;
  to: string;
  items: InventoryRow[];
  vendors: { vendorId: string; vendor: string; bills: number; subtotal: number; tax: number; total: number; paid: number; due: number }[];
  totals: { wastageValue: number; closingValue: number; purchases: number };
}

export interface DeliveryAgentRow {
  agentId: string;
  agent: string;
  deliveries: number;
  delivered: number;
  cancelled: number;
  value: number;
  avgDeliveryMinutes: number | null;
  onTimePercent: number | null;
  distanceKm: number;
}

export interface DeliveryReport extends DeliveryAgentRow {
  from: string;
  to: string;
  avgOrderToDeliveryMinutes: number | null;
  byStatus: Record<string, number>;
  agents: DeliveryAgentRow[];
  notes: string[];
}

export interface OutletOverviewRow {
  outletId: string;
  name: string;
  gross: number;
  orders: number;
  aov: number;
  cancelled: number;
  openBills: number;
  openBillsValue: number;
  lowStock: number;
  staffClockedIn: number;
}

export interface OutletsOverview {
  date: string;
  outlets: OutletOverviewRow[];
  totals: Omit<OutletOverviewRow, "outletId" | "name">;
}
