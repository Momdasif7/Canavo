/**
 * Response shapes of the CANAVO API as consumed by the web app.
 * Dates arrive as ISO strings; all money is integer paise.
 */
import type { DeliveryStatusValue, ModuleKey, Permission, Role } from "@canavo/shared";

export type FoodType = "VEG" | "NON_VEG" | "EGG";
export type ItemStatus = "AVAILABLE" | "OUT_OF_STOCK" | "HIDDEN";
export type OrderType = "DINE_IN" | "TAKEAWAY" | "DELIVERY" | "PRE_ORDER";
export type OrderStatus = "OPEN" | "PAID" | "CANCELLED";
export type PaymentMode = "CASH" | "UPI" | "CARD" | "KHATA" | "GIFT_CARD";
export type PaymentStatus = "PENDING" | "SUCCESS" | "FAILED";
export type KotStatus = "RECEIVED" | "PREPARING" | "READY" | "SERVED";
export type StaffStatus = "ACTIVE" | "INACTIVE" | "SUSPENDED";
export type SalaryType = "DAILY" | "MONTHLY";

export interface Session {
  /** In cookie mode: memory only, re-obtained from the httpOnly cookie after a reload */
  accessToken: string;
  /** Storage mode only; in cookie mode the refresh token lives in an httpOnly cookie */
  refreshToken?: string;
  expiresIn: number;
  /** "cookie" = refresh token in an httpOnly cookie (Phase 2.7) */
  sessionMode?: "cookie";
}

export interface OutletRef {
  id: string;
  name: string;
  businessId?: string;
  businessName?: string;
}

export type BusinessStatus = "ACTIVE" | "SUSPENDED";

export interface BusinessRef {
  id: string;
  name: string;
  status: BusinessStatus;
  modules: ModuleKey[];
}

/** Invoice document kind: GST tax invoice, composition bill of supply, or a plain bill (not GST registered). */
export type DocumentType = "TAX_INVOICE" | "BILL_OF_SUPPLY" | "BILL";

/** A named extra tax on a rate, e.g. { label: "VAT", percent: 2 } */
export interface TaxExtra {
  label: string;
  percent: number;
}

/** Calculated tax line on an order / bill (cess, extras). */
export interface TaxDetail {
  label: string;
  percent: number;
  amount: number;
}

/** Tax rate as embedded on a menu item. */
export interface TaxRateRef {
  id: string;
  name: string;
  cgst: number;
  sgst: number;
  igst: number;
  cess: number;
  extras: TaxExtra[];
}

/** GET /tax-rates row. */
export interface TaxRate extends TaxRateRef {
  isDefault: boolean;
  active: boolean;
  itemCount: number;
}

export interface Shift {
  id: string;
  outletId: string;
  name: string;
  startTime: string;
  endTime: string;
  graceMinutes: number;
}

export interface Me {
  id: string;
  name: string;
  phone: string;
  email: string | null;
  role: Role;
  photoUrl: string | null;
  shift: Shift | null;
  /** Platform operator (super admin or platform support, outside any business) */
  platformAdmin: boolean;
  /** Which platform role (support users can only look); null inside a business */
  platformRole?: "SUPER_ADMIN" | "PLATFORM_SUPPORT" | null;
  /** The business's custom role this user has, if any (narrows `role`) */
  customRole?: { id: string; name: string; baseRole: Role } | null;
  /** Business the session acts in; always null for a platform admin (they never open a hotel) */
  business: BusinessRef | null;
  /** Enabled modules; null = platform context */
  modules: ModuleKey[] | null;
  /** Outlets the user works in; empty for a platform admin */
  outlets: OutletRef[];
  /** Effective permissions = role ∩ enabled modules. Gate UI on these. */
  permissions: Permission[];
  /** Effective per-hotel feature flags (on + required modules enabled) */
  features?: Partial<Record<string, boolean>>;
  /** Two-step login is on for this account */
  twoFactorEnabled?: boolean;
  /** Platform admin inside a hotel under the owner's support grant (read-only) */
  support?: { grantId: string; businessId: string; businessName: string; expiresAt: string; readOnly: true } | null;
  /** The hotel requires two-step login for this role and it isn't on yet (only Account → Security works) */
  twoFactorSetupRequired?: boolean;
}

/** First step of sign-in when two-step login is on: exchange the ticket + a code at /auth/2fa/verify. */
export interface MfaChallenge {
  mfaRequired: true;
  mfaToken: string;
  expiresIn: number;
}

export interface Outlet {
  id: string;
  name: string;
  address: string;
  stateCode: string;
  gstin: string | null;
  /** Registered legal name printed on tax invoices */
  legalName?: string | null;
  /** false = not GST registered: plain bills, no tax lines (missing on older APIs = true) */
  gstEnabled?: boolean;
  fssai: string | null;
  phone: string | null;
  logoUrl: string | null;
  latitude: number | null;
  longitude: number | null;
  geofenceMeters: number;
  timezone: string;
  invoicePrefix: string;
  /** D1 (Phase 3.6): flat ₹ discounts are GST-inclusive (default: pre-tax) */
  flatDiscountsIncludeTax?: boolean;
  /** Phase 3.3: manual discount above this % needs a manager PIN (APPROVAL_PINS) */
  approvalDiscountPercent?: number;
  pricesIncludeTax: boolean;
  compositionScheme: boolean;
  serviceChargeEnabled: boolean;
  serviceChargePercent: number;
  roundOff: boolean;
  upiVpa: string | null;
  deliveryEnabled?: boolean;
  /** Flat packaging charge per takeaway/delivery order, paise */
  packagingCharge?: number;
  /** Most orders one delivery partner may hold at a time (1–10, default 2) */
  maxDeliveriesPerPartner?: number;
  /** POS item cards show menu photos (default true; off = text-only cards) */
  posShowImages?: boolean;
}

export interface MenuCategory {
  id: string;
  name: string;
  parentId: string | null;
  sortOrder: number;
}

export interface Variant {
  id: string;
  name: string;
  price: number;
}

export interface Addon {
  id: string;
  name: string;
  price: number;
}

export interface MenuItem {
  id: string;
  name: string;
  description: string;
  categoryId: string;
  /** Effective price for the active outlet (override applied) */
  price: number;
  basePrice: number;
  foodType: FoodType;
  gstRate: number;
  /** Assigned tax rate; null = business default */
  taxRateId?: string | null;
  taxRate?: TaxRateRef | null;
  hsnCode: string;
  imageUrl: string | null;
  /** Effective status at this outlet: OUT_OF_STOCK also when an ingredient ran out (see stockOut) */
  status: ItemStatus;
  /** Status a manager set (outlet override or the item's own) — edit this, never the effective `status` */
  manualStatus?: ItemStatus;
  /** Automatically out of stock because an ingredient ran out; comes back when restocked */
  stockOut?: boolean;
  /** Ingredient names that ran out, e.g. "Pav buns" */
  stockOutReason?: string | null;
  /** Sizes that are out of stock while the others still sell */
  unavailableVariantIds?: string[];
  hasOverride: boolean;
  allergens: string[];
  availableFrom: string | null;
  availableTo: string | null;
  kitchenStation: string;
  variants: Variant[];
  addons: Addon[];
}

/** Raw item from GET /menu/items/:id (no outlet override applied). */
export type RawMenuItem = Omit<MenuItem, "basePrice" | "hasOverride">;

export interface Menu {
  categories: MenuCategory[];
  items: MenuItem[];
  /** POS menu with CANTEEN meal slots: the slot open now (null between slots); absent without slots */
  mealSlot?: { id: string; name: string; startTime: string; endTime: string } | null;
}

export interface Payment {
  id: string;
  orderId: string;
  mode: PaymentMode;
  amount: number;
  status: PaymentStatus;
  reference: string | null;
  qrPayload: string | null;
  createdAt: string;
  confirmedAt: string | null;
}

export interface OrderItem {
  id: string;
  menuItemId: string;
  name: string;
  variantName: string | null;
  addons: { name: string; price: number }[];
  quantity: number;
  unitPrice: number;
  gstRate: number;
  hsnCode: string;
  discount: number;
  taxableValue: number;
  serviceCharge: number;
  cgst: number;
  sgst: number;
  igst: number;
  total: number;
  notes: string | null;
}

export interface KotItem {
  name: string;
  quantity: number;
  addons?: string[];
  notes?: string | null;
  /** Running-tab KOTs: the table-session item this line came from */
  sessionItemId?: string;
  /** Item was voided after the KOT was fired */
  voided?: boolean;
}

export interface Kot {
  id: string;
  /** Null for running dine-in tabs until billed */
  orderId: string | null;
  sessionId?: string | null;
  /** Pre-orders: hidden from the kitchen until this time */
  releaseAt?: string | null;
  outletId: string;
  kotNumber: number;
  station: string;
  status: KotStatus;
  items: KotItem[];
  printedAt: string | null;
  createdAt: string;
  updatedAt: string;
  order?: {
    id: string;
    invoiceNumber: string;
    orderType: OrderType;
    tableLabel: string | null;
    notes: string | null;
    status: OrderStatus;
    scheduledFor?: string | null;
    customerName?: string | null;
  } | null;
  /** Running-tab KOTs */
  session?: { id: string; tableLabel: string; table?: { label: string } } | null;
}

export interface Order {
  id: string;
  clientOrderId: string | null;
  /** Total of credit notes issued against this bill (Phase 3.1) */
  refundedAmount?: number;
  outletId: string;
  cashierId: string;
  invoiceNumber: string;
  documentType: DocumentType;
  orderType: OrderType;
  status: OrderStatus;
  tableLabel: string | null;
  customerName: string | null;
  customerPhone: string | null;
  notes: string | null;
  subtotal: number;
  discount: number;
  taxableValue: number;
  serviceCharge: number;
  cgst: number;
  sgst: number;
  igst: number;
  cess?: number;
  /** Extra named taxes total (VAT etc.), paise */
  otherTaxes?: number;
  taxDetails?: TaxDetail[];
  roundOff: number;
  grandTotal: number;
  paidAt: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  syncedOffline: boolean;
  createdAt: string;
  /** Promotions, coupon and loyalty redemption (pre-tax), paise */
  promoDiscount?: number;
  appliedOffers?: { kind: "OFFER" | "COUPON" | "POINTS"; id?: string; label: string; amount: number }[];
  couponCode?: string | null;
  pointsRedeemed?: number;
  /** Delivery fee, packaging etc. (pre-tax), paise */
  extraCharges?: number;
  chargesBreakup?: { label: string; amount: number }[];
  customerId?: string | null;
  scheduledFor?: string | null;
  tableSessionId?: string | null;
  items: OrderItem[];
  payments: Payment[];
  kots?: Kot[];
  cashier: { id: string; name: string };
  /** Present on GET /orders/:id */
  amountPaid?: number;
  balance?: number;
  /** Delivery orders only (null otherwise) */
  delivery?: OrderDelivery | null;
}

/** The delivery attached to an order (GET /orders, GET /orders/:id, POST /orders, POST /orders/:id/cod). */
export interface OrderDelivery {
  id: string;
  status: DeliveryStatusValue;
  /** Cash on Delivery: the partner collects the bill in cash at the door */
  cod: boolean;
  agentId: string | null;
  /** Cash collected by the partner was handed over to the outlet */
  cashSettledAt: string | null;
  agent: { id: string; name: string } | null;
}

export interface PaymentResult {
  order: Order;
  paid: boolean;
  balance: number;
  change: number;
}

export interface UpiQr {
  paymentId: string;
  amount: number;
  gatewayRef: string;
  qrPayload: string;
  imageUrl?: string;
  mock: boolean;
}

export interface PaymentStatusResponse {
  status: OrderStatus;
  amountPaid: number;
  balance: number;
  payments: Payment[];
}

export type WhatsAppProvider = "NONE" | "META" | "WATI";

/** Any WhatsApp send: "sent" by the business's provider, or "link" = open waLink (click-to-chat). */
export interface WhatsAppSendResult {
  method: "sent" | "link";
  provider?: WhatsAppProvider;
  waLink: string;
  messageId?: string;
  /** Provider error when the API send failed and the link is the fallback */
  error?: string;
}

export interface ShareResult extends WhatsAppSendResult {
  receiptUrl: string;
}

export interface SyncResult {
  clientOrderId?: string;
  ok: boolean;
  duplicate?: boolean;
  orderId?: string;
  invoiceNumber?: string;
  grandTotal?: number;
  error?: string;
}

export interface DailyReport {
  date: string;
  grossSales: number;
  netSales: number;
  discounts: number;
  tax: { cgst: number; sgst: number; igst: number };
  serviceCharge: number;
  orders: number;
  cancelledOrders: number;
  /** Bills voided on this day */
  voids: { count: number; amount: number };
  /** Credit notes issued on this day */
  refunds: { count: number; amount: number };
  salesAfterRefunds: number;
  /** Cash shifts closed on this day: counted − expected (negative = short) */
  cashDifference: { shifts: number; amount: number };
  averageOrderValue: number;
  byOrderType: Record<string, { orders: number; amount: number }>;
  byPaymentMode: Record<string, { count: number; amount: number }>;
  topItems: { menuItemId: string; name: string; quantity: number; amount: number }[];
  staff: { id: string; name: string; bills: number; amount: number }[];
  hourly: { hour: number; orders: number; amount: number }[];
  comparison: {
    yesterday: { gross: number; orders: number; changePercent: number | null };
    lastWeek: { gross: number; orders: number; changePercent: number | null };
  };
}

export interface Staff {
  id: string;
  name: string;
  phone: string;
  email: string | null;
  role: Role;
  status: StaffStatus;
  photoUrl: string | null;
  salaryType: SalaryType;
  salaryAmount: number;
  shiftId: string | null;
  createdAt: string;
  /** Two-step login turned on (null = off) */
  totpEnabledAt?: string | null;
  /** Custom role narrowing `role` (Phase 4.2) */
  customRoleId?: string | null;
  outlets: { outletId: string }[];
}

/** A business's own role: a named subset of a built-in base role's permissions. */
export interface CustomRole {
  id: string;
  name: string;
  baseRole: Role;
  permissions: Permission[];
  staffCount?: number;
}

export interface StaffPerformance {
  days: number;
  billsRaised: number;
  salesValue: number;
  itemsSold: number;
  presentDays: number;
  attendancePercent: number;
  lateDays: number;
  overtimeMinutes: number;
}

export interface AttendanceRecord {
  id: string;
  userId: string;
  outletId: string;
  workDate: string;
  clockInAt: string;
  clockOutAt: string | null;
  clockInDistance: number;
  /** GPS accuracy (m) at clock-in */
  clockInAccuracy?: number | null;
  clockInMocked?: boolean;
  clockInSelfieUrl?: string | null;
  /** MOCK_LOCATION, LOW_ACCURACY, NO_ACCURACY — for the manager to review */
  clockInFlags?: string[];
  workedMinutes: number | null;
  overtimeMinutes: number;
  lateByMinutes: number;
  earlyByMinutes: number;
  status: AttendanceStatus;
  /** SELF = employee clocked in (GPS); MANUAL = added by a manager / owner */
  source?: AttendanceSource;
  note?: string | null;
  markedById?: string | null;
  editedAt?: string | null;
  user?: { id: string; name: string; role: Role; phone: string };
}

export type AttendanceStatus = "PRESENT" | "HALF_DAY" | "ABSENT" | "LEAVE";
export type AttendanceSource = "SELF" | "MANUAL";

/** GET /attendance/register row. */
export interface RegisterRow {
  user: {
    id: string;
    name: string;
    phone: string;
    role: Role;
    status: StaffStatus;
    shift: { name: string; startTime: string; endTime: string; graceMinutes: number } | null;
  };
  canMark: boolean;
  status: AttendanceStatus | null;
  leave: { type: LeaveRequest["type"]; reason: string } | null;
  records: (AttendanceRecord & { markedBy: { id: string; name: string } | null })[];
}

export interface AttendanceRegister {
  date: string;
  staff: RegisterRow[];
}

export interface AttendanceEntryInput {
  userId: string;
  status: AttendanceStatus;
  clockIn?: string;
  clockOut?: string;
  note?: string;
}

export interface RegisterSaveResult {
  date: string;
  saved: number;
  skipped: { userId: string; reason: string }[];
}

export type CalendarStatus = "PRESENT" | "HALF_DAY" | "LEAVE" | "ABSENT" | "UPCOMING";

export interface AttendanceCalendar {
  month: string;
  userId: string;
  days: {
    date: string;
    status: CalendarStatus;
    workedMinutes: number;
    lateByMinutes: number;
    overtimeMinutes: number;
    records?: Pick<AttendanceRecord, "id" | "status" | "source" | "note" | "editedAt">[];
  }[];
}

export interface LeaveRequest {
  id: string;
  userId: string;
  fromDate: string;
  toDate: string;
  type: "CASUAL" | "SICK" | "UNPAID" | "HALF_DAY";
  reason: string;
  status: "PENDING" | "APPROVED" | "REJECTED";
  createdAt: string;
  user?: { id: string; name: string; role: Role };
}

export interface SalarySheet {
  month: string;
  daysInMonth: number;
  rows: {
    userId: string;
    name: string;
    role: Role;
    salaryType: SalaryType;
    salaryAmount: number;
    presentDays: number;
    halfDays: number;
    paidLeaveDays: number;
    payableDays: number;
    overtimeMinutes: number;
    dailyRate: number;
    grossPay: number;
  }[];
}

export interface Notification {
  id: string;
  title: string;
  body: string;
  kind: string;
  /** Web route to open when tapped (the API fills a default by kind) */
  link: string | null;
  /** Outlet the event belongs to; switch to it before opening the link */
  outletId: string | null;
  read: boolean;
  createdAt: string;
}

/** Live `notification` socket payload (no id — the row is fetched on refresh). */
export interface NotificationEvent {
  title: string;
  body: string;
  kind: string;
  link: string | null;
  outletId: string | null;
  createdAt: string;
}

export interface NotificationPage {
  items: Notification[];
  unread: number;
  hasMore: boolean;
  nextBefore: string | null;
}

/** Credit note (refund) against a paid bill (Phase 3.1). */
export interface CreditNote {
  id: string;
  orderId: string;
  number: string;
  reason: string;
  note: string | null;
  refundMode: "CASH" | "UPI" | "CARD" | "KHATA";
  items: { orderItemId: string; name: string; quantity: number; total: number }[];
  amount: number;
  restocked: boolean;
  createdAt: string;
}
