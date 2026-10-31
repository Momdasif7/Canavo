/**
 * Response shapes of the CANAVO API (apps/api). Kept in sync by hand with the
 * route handlers; money fields are integer paise.
 */
import type {
  AppliedPromotion,
  ATTENDANCE_STATUSES,
  DocumentKind,
  ModuleKey,
  CustomerLookup,
  DeliveryStatusValue,
  LoyaltyTierName,
  Paise,
  Permission,
  ReceiptData,
  Role,
  StockUnitCode,
  TaxDetail,
} from "@canavo/shared";

export interface Tokens {
  accessToken: string;
  refreshToken: string;
  /** seconds */
  expiresIn: number;
}

export interface OtpRequestResponse {
  ok: boolean;
  expiresIn: number;
  devCode?: string;
}

export interface Shift {
  id: string;
  outletId: string;
  name: string;
  startTime: string;
  endTime: string;
  graceMinutes: number;
}

export interface OutletRef {
  id: string;
  name: string;
  /** Present on /auth/me outlets (multi-business). Older cached profiles lack them. */
  businessId?: string;
  businessName?: string;
}

export interface BusinessRef {
  id: string;
  name: string;
  status: "ACTIVE" | "SUSPENDED" | string;
  modules: ModuleKey[];
}

export interface Me {
  id: string;
  name: string;
  phone: string;
  email: string | null;
  role: Role;
  photoUrl: string | null;
  shift: Shift | null;
  /** Platform super admin (no business of their own); manages businesses on the web console */
  platformAdmin?: boolean;
  /** Business the session is acting in; null for platform admins until an outlet is chosen */
  business?: BusinessRef | null;
  /** Enabled modules of that business; null = platform context (everything) */
  modules?: ModuleKey[] | null;
  outlets: OutletRef[];
  /** Effective permissions = role permissions ∩ the business's modules. Gate UI on these. */
  permissions: Permission[];
}

export interface Outlet {
  id: string;
  name: string;
  address: string;
  stateCode: string;
  gstin: string | null;
  fssai: string | null;
  phone: string | null;
  latitude: number | null;
  longitude: number | null;
  geofenceMeters: number;
  timezone: string;
  invoicePrefix: string;
  pricesIncludeTax: boolean;
  compositionScheme: boolean;
  serviceChargeEnabled: boolean;
  serviceChargePercent: number;
  roundOff: boolean;
  upiVpa: string | null;
  /** false = not GST-registered: plain "BILL", no tax, no GSTIN. Missing on older servers → treat as true. */
  gstEnabled?: boolean;
  legalName?: string | null;
  /** Orders one delivery partner may hold at a time (1–10). Missing on older servers → 2. */
  maxDeliveriesPerPartner?: number;
  /** Uploaded logo — pass through mediaUrl() before showing */
  logoUrl?: string | null;
  /** POS item tiles show menu photos. Missing (older servers / staff without settings:view) → true. */
  posShowImages?: boolean;
}

// ---------- Attendance ----------
export type AttendanceRecordStatus = "PRESENT" | "HALF_DAY" | "ABSENT" | "LEAVE";

export interface AttendanceRecord {
  id: string;
  userId: string;
  outletId: string;
  workDate: string;
  clockInAt: string;
  clockOutAt: string | null;
  clockInDistance: number;
  workedMinutes: number | null;
  overtimeMinutes: number;
  lateByMinutes: number;
  earlyByMinutes: number;
  status: AttendanceRecordStatus;
}

export interface AttendanceStatus {
  clockedIn: boolean;
  current: (AttendanceRecord & { outlet: OutletRef }) | null;
  recent: AttendanceRecord[];
}

export type CalendarDayStatus = "PRESENT" | "HALF_DAY" | "LEAVE" | "ABSENT" | "UPCOMING";

export interface CalendarDay {
  date: string;
  status: CalendarDayStatus;
  workedMinutes: number;
  lateByMinutes: number;
  overtimeMinutes: number;
  records: AttendanceRecord[];
}

export interface AttendanceCalendar {
  month: string;
  userId: string;
  days: CalendarDay[];
}

export type LeaveType = "CASUAL" | "SICK" | "UNPAID" | "HALF_DAY";

// ---------- Staff attendance register (attendance:manage) ----------
/** Statuses a manager can set (shared `ATTENDANCE_STATUSES`). */
export type ManualStatus = (typeof ATTENDANCE_STATUSES)[number];

export interface RegisterRecord extends AttendanceRecord {
  source: "SELF" | "MANUAL";
  note: string | null;
  editedAt: string | null;
  markedById: string | null;
  markedBy: { id: string; name: string } | null;
}

export interface RegisterStaff {
  id: string;
  name: string;
  phone: string;
  role: Role;
  status: string;
  shift: { name: string; startTime: string; endTime: string; graceMinutes: number } | null;
}

export interface AttendanceRegisterRow {
  user: RegisterStaff;
  /** false for yourself and for people at or above your level */
  canMark: boolean;
  /** Day outcome (records, else approved leave); null = not marked */
  status: ManualStatus | null;
  leave: { type: LeaveType; reason: string } | null;
  records: RegisterRecord[];
}

export interface AttendanceRegister {
  date: string;
  staff: AttendanceRegisterRow[];
}

export interface RegisterSaveResult {
  date: string;
  saved: number;
  skipped: { userId: string; reason: string }[];
}

export interface LeaveRequest {
  id: string;
  userId: string;
  fromDate: string;
  toDate: string;
  type: LeaveType;
  reason: string;
  status: "PENDING" | "APPROVED" | "REJECTED";
  createdAt: string;
}

// ---------- Menu ----------
export type FoodType = "VEG" | "NON_VEG" | "EGG";
export type ItemStatus = "AVAILABLE" | "OUT_OF_STOCK" | "HIDDEN";

export interface MenuCategory {
  id: string;
  name: string;
  parentId: string | null;
  sortOrder: number;
}

export interface PricedOption {
  id: string;
  name: string;
  price: Paise;
}

export interface MenuItem {
  id: string;
  name: string;
  description: string;
  categoryId: string;
  price: Paise;
  basePrice: Paise;
  foodType: FoodType;
  gstRate: number;
  /** Tax-rate master (GST + cess + extra taxes); absent on older servers */
  taxRateId?: string | null;
  taxRate?: TaxRateRef | null;
  hsnCode: string;
  imageUrl: string | null;
  /** Effective status: "OUT_OF_STOCK" also when an ingredient ran out (see stockOut) */
  status: ItemStatus;
  /** Status the manager set (without automatic out-of-stock). Missing on older servers. */
  manualStatus?: ItemStatus;
  /** An ingredient can't cover one portion (automatic out-of-stock) */
  stockOut?: boolean;
  /** Names of the ingredients that ran out, e.g. "Pav buns" */
  stockOutReason?: string | null;
  /** Sizes that are out of stock (the item itself may still be available) */
  unavailableVariantIds?: string[];
  availableFrom: string | null;
  availableTo: string | null;
  kitchenStation: string;
  variants: PricedOption[];
  addons: PricedOption[];
}

export interface TaxRateRef {
  id?: string;
  name?: string;
  cgst: number;
  sgst: number;
  igst: number;
  cess?: number | null;
  /** Additional taxes, e.g. [{ label: "VAT", percent: 14.5 }] (JSON from the server; parsed defensively) */
  extras?: unknown;
}

export type { TaxDetail, ReceiptTaxBreakup } from "@canavo/shared";

export type DocumentType = DocumentKind;

export interface Menu {
  categories: MenuCategory[];
  items: MenuItem[];
}

// ---------- Orders ----------
export type OrderType = "DINE_IN" | "TAKEAWAY" | "DELIVERY" | "PRE_ORDER";
export type PaymentMode = "CASH" | "UPI" | "CARD" | "KHATA";
export type KotStatus = "RECEIVED" | "PREPARING" | "READY" | "SERVED";

export interface Payment {
  id: string;
  orderId: string;
  mode: PaymentMode;
  amount: Paise;
  status: "PENDING" | "SUCCESS" | "FAILED";
  reference: string | null;
  qrPayload: string | null;
  createdAt: string;
}

export interface KotItem {
  name: string;
  quantity: number;
  addons?: string[];
  notes?: string | null;
  /** Running-tab KOTs: the session item this line came from */
  sessionItemId?: string;
  /** Item voided after the KOT was fired (strike it through) */
  voided?: boolean;
}

export interface Kot {
  id: string;
  orderId: string;
  outletId: string;
  kotNumber: number;
  station: string;
  status: KotStatus;
  items: KotItem[];
  printedAt: string | null;
  createdAt: string;
  updatedAt: string;
  sessionId?: string | null;
  releaseAt?: string | null;
  /** null for running-tab KOTs until the tab is billed */
  order?: {
    id: string;
    invoiceNumber: string;
    orderType: OrderType;
    tableLabel: string | null;
    notes: string | null;
    status: string;
    scheduledFor?: string | null;
    customerName?: string | null;
  } | null;
  /** Running tab (table) this KOT belongs to */
  session?: { id: string; tableLabel: string; table?: { label: string } } | null;
}

export interface OrderItem {
  id: string;
  name: string;
  quantity: number;
  unitPrice: Paise;
  total: Paise;
}

export interface Order {
  id: string;
  clientOrderId: string | null;
  invoiceNumber: string;
  orderType: OrderType;
  status: "OPEN" | "PAID" | "CANCELLED";
  tableLabel: string | null;
  customerName: string | null;
  customerPhone: string | null;
  grandTotal: Paise;
  cess?: Paise;
  otherTaxes?: Paise;
  taxDetails?: TaxDetail[];
  createdAt: string;
  items: OrderItem[];
  kots: Kot[];
  payments: Payment[];
  /** Only on GET /orders/:id (and POST /orders/:id/cod) */
  amountPaid?: Paise;
  balance?: Paise;
  /** Delivery orders only; null / absent otherwise */
  delivery?: OrderDelivery | null;
}

/** `order.delivery` on order responses. */
export interface OrderDelivery {
  id: string;
  status: DeliveryStatus;
  /** Cash on Delivery: nothing paid now, the partner collects cash at the door */
  cod: boolean;
  agentId: string | null;
  cashSettledAt: string | null;
  agent: { id: string; name: string } | null;
}

export interface PaymentResult {
  order: Order;
  paid: boolean;
  balance: Paise;
  change: Paise;
}

export interface UpiQrResponse {
  paymentId: string;
  amount: Paise;
  gatewayRef: string;
  qrPayload: string;
  imageUrl?: string;
  mock: boolean;
}

export interface PaymentStatusResponse {
  status: Order["status"];
  amountPaid: Paise;
  balance: Paise;
  payments: Payment[];
}

/** GET /orders/:id/receipt — the GST fields (cess, extras, gstEnabled…) are optional for older orders. */
export type Receipt = ReceiptData & { publicUrl?: string };

/**
 * Result of a WhatsApp action (receipt share, khata reminder…): "sent" = delivered through the
 * business's WhatsApp provider (don't open wa.me); "link" = open `waLink` (with `error` when the
 * provider failed and the server fell back to a link).
 */
export interface WhatsAppResult {
  method: "sent" | "link";
  /** WhatsApp provider configured on the web console ("NONE" = links only). Missing on older servers. */
  provider?: string;
  waLink: string;
  error?: string;
}

export interface WhatsAppShareResponse extends WhatsAppResult {
  receiptUrl: string;
}

/** Customer status message on delivery responses (wa.me link, or already sent automatically). */
export interface DeliveryCustomerMessage {
  waLink: string;
  text: string;
  /** Sent to the customer on WhatsApp automatically — no need to send it manually */
  autoSent?: boolean;
}

export interface SyncResult {
  clientOrderId?: string;
  ok: boolean;
  duplicate?: boolean;
  orderId?: string;
  invoiceNumber?: string;
  grandTotal?: Paise;
  error?: string;
}

// ---------- Reports ----------
export interface DailyReport {
  date: string;
  grossSales: Paise;
  netSales: Paise;
  discounts: Paise;
  tax: { cgst: Paise; sgst: Paise; igst: Paise };
  serviceCharge: Paise;
  orders: number;
  cancelledOrders: number;
  averageOrderValue: Paise;
  byOrderType: Record<string, { orders: number; amount: Paise }>;
  byPaymentMode: Record<string, { count: number; amount: Paise }>;
  topItems: { menuItemId: string; name: string; quantity: number; amount: Paise }[];
  staff: { id: string; name: string; bills: number; amount: Paise }[];
  hourly: { hour: number; orders: number; amount: Paise }[];
  comparison: {
    yesterday: { gross: Paise; orders: number; changePercent: number | null };
    lastWeek: { gross: Paise; orders: number; changePercent: number | null };
  };
}

// ---------- Tables & running tabs ----------
export type TableStatus = "AVAILABLE" | "OCCUPIED" | "NEEDS_ATTENTION" | "RESERVED";
export interface StaffRef {
  id: string;
  name: string;
}

export interface FloorSession {
  id: string;
  primaryTableId: string;
  label: string;
  guests: number;
  waiter: StaffRef | null;
  customerName: string | null;
  openedAt: string;
  openedMinutes: number;
  itemsCount: number;
  unbilledCount: number;
  runningTotal: Paise;
  unbilledTotal: Paise;
  kotStatus: Partial<Record<KotStatus, number>>;
  orders: { id: string; status: Order["status"]; grandTotal: Paise }[];
  readyToClose: boolean;
}

export interface FloorTable {
  id: string;
  label: string;
  capacity: number;
  areaId: string | null;
  status: TableStatus;
  waiter: StaffRef | null;
  session: FloorSession | null;
  upcomingReservation: {
    id: string;
    customerName: string;
    partySize: number;
    reservedFor: string;
    minutesAway: number;
  } | null;
}

export interface FloorArea {
  id: string | null;
  name: string;
  tables: FloorTable[];
}

export interface Floor {
  areas: FloorArea[];
  stats: { tables: number; occupied: number; available: number; openSessions: number };
}

export interface SessionItem {
  id: string;
  menuItemId: string;
  variantId: string | null;
  addonIds: string[];
  quantity: number;
  notes: string | null;
  seat: number | null;
  kotId: string | null;
  billedOrderId: string | null;
  createdAt: string;
  name: string;
  addons: string[];
  unitPrice: Paise;
  amount: Paise;
  kotNumber?: number;
  kotStatus?: KotStatus;
}

export interface SessionEstimate {
  subtotal: Paise;
  tax: Paise;
  serviceCharge: Paise;
  grandTotal: Paise;
}

export interface SessionOrder {
  id: string;
  invoiceNumber: string;
  status: Order["status"];
  grandTotal: Paise;
  createdAt: string;
  payments: { amount: Paise; status: Payment["status"]; mode: PaymentMode }[];
}

export interface SessionDetail {
  id: string;
  tableId: string;
  mergedTableIds: string[];
  status: "OPEN" | "CLOSED";
  guests: number;
  customerName: string | null;
  customerPhone: string | null;
  openedAt: string;
  label: string;
  table: { id: string; label: string; capacity: number };
  waiter: StaffRef | null;
  items: SessionItem[];
  kots: Kot[];
  orders: SessionOrder[];
  openedMinutes: number;
  estimate: SessionEstimate;
  unbilledEstimate: SessionEstimate;
  unbilledCount: number;
  readyToClose: boolean;
  advancePaid: Paise;
  reservationId: string | null;
}

export interface SessionBillResponse {
  orders: { group: string; seat?: number | null; itemIds: string[]; order: Order }[];
  equalSplit?: Paise[];
  advancePaid: Paise;
  session: SessionDetail;
}

// ---------- Delivery ----------
export type DeliveryStatus = DeliveryStatusValue;

export interface DeliveryZone {
  id: string;
  name: string;
  radiusKm: number;
  fee: Paise;
  minOrder: Paise;
  etaMinutes: number;
  active: boolean;
}

export interface DeliveryQuote {
  deliveryEnabled: boolean;
  packagingCharge: Paise;
  needsCoordinates?: boolean;
  zones: DeliveryZone[];
  distanceKm?: number;
  deliverable?: boolean;
  zone?: DeliveryZone | null;
  fee?: Paise | null;
  minOrder?: Paise | null;
  etaMinutes?: number | null;
  etaAt?: string | null;
}

/**
 * Dispatch availability of one delivery partner (GET /delivery/agents rows,
 * GET /delivery/me/status, POST /delivery/agents/:id/back).
 */
export interface PartnerAvailability {
  id: string;
  name: string;
  phone: string;
  onDuty: boolean;
  /** GPS (or clock-in) says they're inside the outlet geofence */
  atOutlet: boolean;
  /** Picked up an order and hasn't come back yet */
  onRunSince: string | null;
  /** Orders held (assigned, not yet delivered) */
  active: number;
  outForDelivery: number;
  /** Outlet.maxDeliveriesPerPartner */
  max: number;
  available: boolean;
  /** Why not available: "Not clocked in" | "Out for delivery" | "Returning to the outlet" | "Has 2 of 2 orders" */
  reason: string | null;
  lastAssignedAt?: string | null;
  lastLocation?: { lat: number; lng: number; at: string } | null;
}

export interface DeliveryAgent extends PartnerAvailability {
  activeDeliveries: number;
  clockedIn: boolean;
  clockedInAt?: string | null;
  location: { lat: number; lng: number; at: string } | null;
}

/** POST /delivery/me/location */
export interface PartnerLocationResult {
  /** Metres to the outlet; null when the outlet has no coordinates */
  distanceToOutlet: number | null;
  atOutlet: boolean;
  /** This report brought the partner back from a run (new orders unlocked) */
  backNow: boolean;
}

/** 409 details from assign / POST /orders when the chosen partner can't take the order. */
export interface PartnerUnavailableDetails {
  code: "PARTNER_UNAVAILABLE";
  reason: string;
  /** Manager / owner: may assign anyway with `force` */
  canForce: boolean;
}

export interface Delivery {
  id: string;
  orderId: string;
  agentId: string | null;
  status: DeliveryStatus;
  customerName: string;
  customerPhone: string;
  address: string;
  landmark: string | null;
  latitude: number | null;
  longitude: number | null;
  distanceKm: number | null;
  etaAt: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  assignedAt?: string | null;
  acceptedAt?: string | null;
  pickedAt?: string | null;
  deliveredAt?: string | null;
  cashSettledAt?: string | null;
  /** Cash on Delivery: collect the amount due in cash at the door */
  cod?: boolean;
  order: {
    id: string;
    invoiceNumber: string;
    grandTotal: Paise;
    status: Order["status"];
    notes?: string | null;
    items: { name: string; quantity: number; notes?: string | null }[];
    payments?: DeliveryPayment[];
  };
  agent: (StaffRef & { phone: string }) | null;
  amountDue: Paise;
  amountPaid?: Paise;
}

/** Payment rows embedded in a delivery's order (GET /delivery/*). */
export interface DeliveryPayment {
  id: string;
  amount: Paise;
  status: Payment["status"];
  mode: PaymentMode;
  /** The partner who took it at the door; null = paid at the counter / online before dispatch */
  collectedById: string | null;
  reference: string | null;
  confirmedAt: string | null;
  qrPayload: string | null;
}

/** PATCH /delivery/:id/status (and GET /delivery/:id) */
export type DeliveryStatusResult = Delivery & { customerMessage?: DeliveryCustomerMessage };

/** POST /delivery/:id/complete — one tap at the door */
export type DeliveryCompleteResult = Delivery & {
  /** Cash recorded as collected by the partner (0 when already paid) */
  cashCollected: Paise;
  customerMessage?: DeliveryCustomerMessage;
};

export type DeliveryIssueReason = "CUSTOMER_UNREACHABLE" | "WRONG_ADDRESS" | "CUSTOMER_REFUSED" | "VEHICLE_PROBLEM" | "OTHER";

/** GET /delivery/mine/summary */
export interface DeliverySummary {
  from: string;
  to: string;
  onDuty: boolean;
  onDutySince: string | null;
  activeDeliveries: number;
  delivered: number;
  cancelled: number;
  orderValue: Paise;
  collected: { cash: Paise; upi: Paise; card: Paise; prepaid: Paise; total: Paise };
  cashInHand: Paise;
  cashInHandOrders: number;
  /** Cash still to collect on active COD orders (paise) */
  codToCollect?: Paise;
  codOrders?: number;
  avgDeliveryMinutes: number | null;
  distanceKm: number;
  deliveryFees: Paise;
  byDay: { date: string; deliveries: number; collected: Paise }[];
}

/** Cash collected at the door and not yet covered by handovers (oldest first). */
export interface CashPending {
  orderId: string;
  deliveryId: string | null;
  invoiceNumber: string;
  customerName: string | null;
  address: string | null;
  amount: Paise;
  collectedAt: string | null;
}

/** Cash a partner handed to the outlet (entered by the cashier / manager). */
export interface CashHandover {
  id: string;
  agentId: string;
  amount: Paise;
  note: string | null;
  receivedAt: string;
  receivedById?: string;
  receivedBy: StaffRef | null;
  /** GET /delivery/cash/handovers only */
  agent?: StaffRef | null;
}

/** GET /delivery/mine/cash (partner) */
export interface MyCash {
  balance: Paise;
  collectedToday: Paise;
  handedOverToday: Paise;
  pending: CashPending[];
  handovers: CashHandover[];
}

export interface PartnerRef {
  id: string;
  name: string;
  phone: string;
  status: string;
}

/** GET /delivery/cash (manager) */
export interface PartnerCash {
  agent: PartnerRef;
  /** Cash still to be received from the partner */
  balance: Paise;
  collectedToday: Paise;
  receivedToday: Paise;
  pending: CashPending[];
  lastHandoverAt: string | null;
}

/** POST/PATCH /delivery/cash/handovers */
export interface HandoverResult {
  handover?: CashHandover;
  balance: Paise;
  warnings?: string[];
}

export interface PartnerActivityDay {
  date: string;
  clockIn: string | null;
  clockOut: string | null;
  onDutyMinutes: number;
  lateByMinutes?: number;
  assigned: number;
  delivered: number;
  codDelivered: number;
  cancelled: number;
  issues: number;
  avgDeliveryMinutes: number | null;
  distanceKm: number;
  openingBalance: Paise;
  cashCollected: Paise;
  cashReceived: Paise;
  /** Cash still to be received at the end of the day */
  closingBalance: Paise;
}

export interface PartnerActivityRow {
  agent: PartnerRef;
  totals: {
    assigned: number;
    delivered: number;
    cancelled: number;
    onDutyMinutes: number;
    cashCollected: Paise;
    cashReceived: Paise;
    openingBalance: Paise;
    closingBalance: Paise;
  };
  currentBalance: Paise;
  days: PartnerActivityDay[];
}

/** GET /delivery/partners/activity */
export interface PartnerActivity {
  from: string;
  to: string;
  partners: PartnerActivityRow[];
}

export type TimelineEventType = "CLOCK_IN" | "CLOCK_OUT" | "ASSIGNED" | "ACCEPTED" | "PICKED" | "DELIVERED" | "COLLECTED" | "HANDOVER" | "ISSUE";

/** GET /delivery/partners/:agentId/timeline */
export interface PartnerTimeline {
  agent?: StaffRef;
  date?: string;
  openingBalance: Paise;
  closingBalance: Paise;
  events: { at: string; type: TimelineEventType | string; title: string; detail?: string; amount?: Paise }[];
}

// ---------- Customers & offers ----------
export type CustomerLookupResult = CustomerLookup & {
  loyalty: { pointValuePaise: number; minRedeemPoints: number; maxRedeemPercent: number };
};

export interface Customer {
  id: string;
  phone: string;
  name: string | null;
  email: string | null;
  tier: LoyaltyTierName;
  points: number;
  totalSpend: Paise;
  visitCount: number;
  lastVisitAt: string | null;
  khataBalance: Paise;
  khataLimit: Paise;
  blocked: boolean;
}

export interface CustomerList {
  items: Customer[];
  total: number;
}

export interface KhataTxn {
  id: string;
  type: "DEBIT" | "CREDIT";
  amount: Paise;
  mode: string | null;
  note: string | null;
  createdAt: string;
}

export interface CustomerProfile {
  customer: Customer;
  stats: {
    totalSpend: Paise;
    visitCount: number;
    avgBill: Paise;
    lastVisitAt: string | null;
    points: number;
    pointsValue: Paise;
    redeemablePoints: number;
    tier: LoyaltyTierName;
    nextTier: { tier: LoyaltyTierName; at: Paise; remaining: Paise } | null;
    khataBalance: Paise;
    khataLimit: Paise;
  };
  recentOrders: { id: string; invoiceNumber: string; createdAt: string; status: Order["status"]; grandTotal: Paise }[];
  khataLedger: KhataTxn[];
  favouriteItems: { menuItemId: string; name: string; quantity: number }[];
}

export interface KhataRemindResponse extends WhatsAppResult {
  text: string;
}

export interface ActiveOffer {
  id: string;
  name: string;
  type: string;
  summary: string;
  endTime: string | null;
  endsAt: string | null;
}

/** A Buy-X-Get-Y item the cart qualifies for but doesn't contain yet (POST /customers/preview-promotions). */
export interface FreeItemSuggestion {
  offerId: string;
  offerName: string;
  menuItemId: string;
  variantId: string | null;
  variantName: string | null;
  name: string;
  /** paise, cheapest size */
  unitPrice: Paise;
  /** Units missing for the sets already bought */
  quantity: number;
  /** 100 = free */
  getDiscountPercent: number;
  label: string;
}

export interface PromotionPreview {
  /** Coupon / points / delivery problems; the totals are still valid (a preview never 400s for these). Older servers omit it. */
  warnings?: string[];
  /** Free items to add (Buy X Get Y). Older servers omit it. */
  suggestions?: FreeItemSuggestion[];
  applied: AppliedPromotion[];
  promoDiscount: Paise;
  couponCode: string | null;
  pointsRedeemed: number;
  pointsValue: Paise;
  charges: { label: string; amount: Paise }[];
  bill: {
    documentType: DocumentType;
    subtotal: Paise;
    discount: Paise;
    serviceCharge: Paise;
    extraCharges: Paise;
    cgst: Paise;
    sgst: Paise;
    igst: Paise;
    cess?: Paise;
    otherTaxes?: Paise;
    taxDetails?: TaxDetail[];
    roundOff: Paise;
    grandTotal: Paise;
  };
}

// ---------- Inventory ----------
export interface InventoryItem {
  id: string;
  name: string;
  sku: string | null;
  barcode: string | null;
  category: string;
  unit: StockUnitCode;
  costPerUnit: Paise;
  reorderLevel: number;
  reorderQty: number;
  quantity: number;
  lowStock: boolean;
}

export interface InventoryList {
  items: InventoryItem[];
  totals: { count: number; value: Paise; lowStock: number };
}

export interface LowStockAlerts {
  count: number;
  outOfStock: number;
  items: (InventoryItem & { outOfStock: boolean; suggestedOrderQty: number })[];
}

export type AuditStatus = "IN_PROGRESS" | "COMPLETED" | "CANCELLED";

export interface StockAuditSummaryRow {
  id: string;
  status: AuditStatus;
  notes: string | null;
  createdAt: string;
  completedAt: string | null;
  _count: { lines: number };
}

export interface StockAuditLine {
  inventoryItemId: string;
  systemQty: number;
  countedQty: number | null;
  variance: number | null;
  varianceValue: Paise | null;
  item: { id: string; name: string; unit: StockUnitCode; category: string; costPerUnit: Paise; barcode: string | null; sku: string | null };
}

export interface StockAudit {
  id: string;
  status: AuditStatus;
  notes: string | null;
  createdAt: string;
  completedAt: string | null;
  lines: StockAuditLine[];
  summary: { items: number; counted: number; withVariance: number; varianceValue: Paise };
}

export type PurchaseStatus = "DRAFT" | "RECEIVED" | "CANCELLED";

export interface PurchaseRow {
  id: string;
  status: PurchaseStatus;
  invoiceNo: string | null;
  invoiceDate: string | null;
  total: Paise;
  paidAmount: Paise;
  balance: Paise;
  createdAt: string;
  vendor: { id: string; name: string };
  _count?: { items: number };
}

export interface PurchaseDetail extends PurchaseRow {
  notes: string | null;
  items: {
    id: string;
    inventoryItemId: string;
    quantity: number;
    unitCost: Paise;
    taxRate: number;
    total: Paise;
    item: { id: string; name: string; unit: StockUnitCode } | null;
  }[];
}

export interface LowStockEvent {
  items: { id: string; name: string; unit: StockUnitCode; quantity: number; reorderLevel: number }[];
}

// ---------- Notifications ----------
export interface AppNotification {
  id: string;
  title: string;
  body: string;
  kind: string;
  /** Web route to open (e.g. "/delivery"); the app maps it to its own screen. */
  link?: string | null;
  /** Outlet the event belongs to; switch to it before opening. */
  outletId?: string | null;
  read: boolean;
  createdAt: string;
}

export interface NotificationList {
  items: AppNotification[];
  unread: number;
  hasMore?: boolean;
  /** Pass as `before` for the next page */
  nextBefore?: string | null;
}

/** Socket `notification` payload (no id — the inbox row is created at the same time). */
export interface NotificationEvent {
  title: string;
  body: string;
  kind?: string;
  link?: string | null;
  outletId?: string | null;
  createdAt?: string;
}

// ---------- Multi-day / multi-outlet reports ----------
export interface SalesPeriod {
  period: string;
  orders: number;
  gross: Paise;
  net: Paise;
  aov: Paise;
  cancelled: number;
}

export interface SalesReport {
  from: string;
  to: string;
  groupBy: "day" | "week" | "month";
  totals: SalesPeriod;
  periods: SalesPeriod[];
}

export interface OutletOverviewRow {
  outletId: string;
  name: string;
  gross: Paise;
  orders: number;
  aov: Paise;
  cancelled: number;
  openBills: number;
  openBillsValue: Paise;
  lowStock: number;
  staffClockedIn: number;
}

export interface OutletsOverview {
  date: string;
  outlets: OutletOverviewRow[];
  totals: Omit<OutletOverviewRow, "outletId" | "name">;
}
