/**
 * Response shapes for the service module (tables, running tabs, reservations,
 * delivery) and POS promotions. Dates are ISO strings; money is integer paise.
 */
import type { AppliedPromotion, BillDiscount, CustomerLookup, DeliveryStatusValue, OfferTypeName } from "@canavo/shared";
import type { DocumentType, KotStatus, Order, OrderStatus, OrderType, PaymentMode, PaymentStatus, TaxDetail } from "./types";

// ---------- POS: customers & promotions ----------
export interface LoyaltyRules {
  pointValuePaise: number;
  minRedeemPoints: number;
  maxRedeemPercent: number;
}

export type CustomerLookupResult = CustomerLookup & { loyalty: LoyaltyRules };

/** A free item the cart qualifies for but doesn't contain (POST /customers/preview-promotions). */
export interface FreeItemSuggestion {
  offerId: string;
  offerName: string;
  menuItemId: string;
  variantId: string | null;
  variantName: string | null;
  name: string;
  unitPrice: number;
  quantity: number;
  getDiscountPercent: number;
  label: string;
}

export interface PromotionPreview {
  /** Coupon / points / incomplete-details problems; the rest of the bill is still priced (newer APIs) */
  warnings?: string[];
  /** Free items the cart qualifies for but doesn't contain (Buy X Get Y) */
  suggestions?: FreeItemSuggestion[];
  applied: AppliedPromotion[];
  /** Phase 3.7: every offer / coupon checked, its saving alone, and why it was (not) used */
  comparison?: OfferComparison[];
  promoDiscount: number;
  couponCode: string | null;
  pointsRedeemed: number;
  pointsValue: number;
  lines: {
    menuItemId: string;
    name: string;
    quantity: number;
    unitPrice: number;
    manualDiscount: number;
    promoDiscount: number;
    taxableValue: number;
    total: number;
  }[];
  billDiscounts: BillDiscount[];
  charges: { label: string; amount: number }[];
  bill: {
    documentType: DocumentType;
    cess?: number;
    otherTaxes?: number;
    taxDetails?: TaxDetail[];
    subtotal: number;
    discount: number;
    taxableValue: number;
    serviceCharge: number;
    extraCharges: number;
    cgst: number;
    sgst: number;
    igst: number;
    totalTax: number;
    roundOff: number;
    grandTotal: number;
  };
  customer: (Partial<CustomerLookup> & { found: boolean; phone: string }) | null;
}

export interface ActiveOffer {
  id: string;
  name: string;
  type: OfferTypeName;
  priority: number;
  startTime: string | null;
  endTime: string | null;
  endsAt: string | null;
  summary: string;
}

// ---------- Delivery ----------
export interface DeliveryZone {
  id: string;
  outletId: string;
  name: string;
  radiusKm: number;
  fee: number;
  minOrder: number;
  etaMinutes: number;
  active: boolean;
}

export interface DeliveryQuote {
  deliveryEnabled: boolean;
  packagingCharge: number;
  /** MAP: pin / zones; ADDRESS: typed address + PIN code, flat fee (Delivery → Settings) */
  addressMode?: "MAP" | "ADDRESS";
  /** ADDRESS mode: why the PIN code / area is refused */
  message?: string | null;
  /** ADDRESS mode: allowed PIN codes / area names (empty = anywhere) */
  areas?: string[];
  needsCoordinates?: boolean;
  distanceKm?: number;
  deliverable?: boolean;
  zone?: DeliveryZone | null;
  fee?: number | null;
  minOrder?: number | null;
  etaMinutes?: number | null;
  etaAt?: string | null;
  zones: DeliveryZone[];
}

export interface AgentLocation {
  lat: number;
  lng: number;
  at: string;
  deliveryId: string;
  outletId?: string;
}

/** Can a delivery partner take a new order right now (GET /delivery/agents, /delivery/me/status). */
export interface PartnerAvailability {
  id: string;
  name: string;
  phone: string;
  /** Clocked in */
  onDuty: boolean;
  /** Last GPS fix (or clock-in) is inside the outlet geofence */
  atOutlet: boolean;
  /** Picked up their first order of the current run at; null = not on a run */
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
  photoUrl?: string | null;
  activeDeliveries: number;
  clockedIn: boolean;
  clockedInAt: string | null;
  location: AgentLocation | null;
}

/** POST /delivery/me/location */
export interface PartnerLocationResult {
  distanceToOutlet: number | null;
  atOutlet: boolean;
  /** This fix ended the partner's run: they can take orders again */
  backNow: boolean;
}

export interface DeliveryPayment {
  id?: string;
  amount: number;
  status: PaymentStatus;
  mode: PaymentMode;
  /** Delivery partner who took the money at the door (null = paid at the counter / online) */
  collectedById?: string | null;
  /** UTR / card approval code */
  reference?: string | null;
  confirmedAt?: string | null;
  qrPayload?: string | null;
}

export interface Delivery {
  id: string;
  orderId: string;
  outletId: string;
  agentId: string | null;
  status: DeliveryStatusValue;
  source: string;
  customerName: string;
  customerPhone: string;
  address: string;
  landmark: string | null;
  /** PIN code (address-only delivery) */
  pincode?: string | null;
  latitude: number | null;
  longitude: number | null;
  distanceKm: number | null;
  zoneId: string | null;
  etaAt: string | null;
  assignedAt: string | null;
  acceptedAt?: string | null;
  pickedAt: string | null;
  deliveredAt: string | null;
  cashSettledAt?: string | null;
  /** Cash on Delivery: the partner collects the bill in cash at the door */
  cod?: boolean;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  order: {
    id: string;
    invoiceNumber: string;
    grandTotal: number;
    status: OrderStatus;
    notes?: string | null;
    items?: { name: string; quantity: number; notes?: string | null }[];
    payments?: DeliveryPayment[];
  };
  agent?: { id: string; name: string; phone: string } | null;
  amountDue?: number;
  amountPaid?: number;
  agentLocation?: AgentLocation | null;
  /** WhatsApp status update for the customer; autoSent = already sent through the business's provider */
  customerMessage?: { waLink: string; text: string; autoSent?: boolean };
}

// ---------- Tables ----------
export type TableStatus = "AVAILABLE" | "OCCUPIED" | "NEEDS_ATTENTION" | "RESERVED";
export type TableShape = "SQUARE" | "ROUND" | "RECTANGLE";

export interface DiningArea {
  id: string;
  outletId: string;
  name: string;
  sortOrder: number;
}

export interface DiningTable {
  id: string;
  outletId: string;
  areaId: string | null;
  label: string;
  capacity: number;
  shape: TableShape;
  posX: number;
  posY: number;
  width: number;
  height: number;
  rotation: number;
  status: TableStatus;
  waiterId: string | null;
  active: boolean;
  waiter?: { id: string; name: string } | null;
}

export interface FloorSession {
  id: string;
  primaryTableId: string;
  label: string;
  guests: number;
  waiter: { id: string; name: string } | null;
  customerName: string | null;
  openedAt: string;
  openedMinutes: number;
  itemsCount: number;
  unbilledCount: number;
  runningTotal: number;
  unbilledTotal: number;
  kotStatus: Partial<Record<KotStatus, number>>;
  orders: { id: string; status: OrderStatus; grandTotal: number }[];
  readyToClose: boolean;
}

export interface FloorTable extends DiningTable {
  session: FloorSession | null;
  upcomingReservation: { id: string; customerName: string; partySize: number; reservedFor: string; minutesAway: number } | null;
}

export interface FloorArea {
  id: string | null;
  name: string;
  sortOrder: number;
  tables: FloorTable[];
}

export interface FloorResponse {
  areas: FloorArea[];
  stats: { tables: number; occupied: number; available: number; openSessions: number };
  unassignedReservations: Reservation[];
}

export interface SessionItem {
  id: string;
  sessionId: string;
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
  unitPrice: number;
  gstRate: number;
  amount: number;
  kotNumber?: number;
  kotStatus?: KotStatus;
}

export interface Estimate {
  subtotal: number;
  tax: number;
  serviceCharge: number;
  grandTotal: number;
}

export interface SessionOrder {
  id: string;
  invoiceNumber: string;
  status: OrderStatus;
  grandTotal: number;
  createdAt: string;
  payments: { amount: number; status: PaymentStatus; mode: PaymentMode }[];
}

export interface TableSessionDetail {
  id: string;
  outletId: string;
  tableId: string;
  mergedTableIds: string[];
  status: "OPEN" | "CLOSED";
  guests: number;
  waiterId: string | null;
  customerName: string | null;
  customerPhone: string | null;
  openedAt: string;
  closedAt: string | null;
  label: string;
  items: SessionItem[];
  kots: { id: string; kotNumber: number; status: KotStatus; station: string; createdAt: string }[];
  orders: SessionOrder[];
  table: { id: string; label: string; capacity: number };
  waiter: { id: string; name: string } | null;
  openedMinutes: number;
  estimate: Estimate;
  unbilledEstimate: Estimate;
  unbilledCount: number;
  readyToClose: boolean;
  advancePaid: number;
  reservationId: string | null;
}

export interface SessionBillResult {
  orders: { group: string; seat?: number | null; itemIds: string[]; order: Order }[];
  equalSplit?: number[];
  advancePaid: number;
  session: TableSessionDetail;
}

// ---------- Reservations ----------
export type ReservationStatus = "BOOKED" | "SEATED" | "COMPLETED" | "CANCELLED" | "NO_SHOW";

export interface PreOrderLine {
  menuItemId: string;
  variantId?: string;
  addonIds: string[];
  quantity: number;
  notes?: string;
}

export interface Reservation {
  id: string;
  outletId: string;
  tableId: string | null;
  customerName: string;
  customerPhone: string;
  partySize: number;
  reservedFor: string;
  durationMin: number;
  status: ReservationStatus;
  notes: string | null;
  preOrderItems: PreOrderLine[];
  advancePaid: number;
  sessionId: string | null;
  createdAt: string;
  table?: { id: string; label: string; capacity: number } | null;
}

export interface PreOrder {
  id: string;
  invoiceNumber: string;
  orderType: OrderType;
  status: OrderStatus;
  customerName: string | null;
  customerPhone: string | null;
  scheduledFor: string;
  grandTotal: number;
  notes: string | null;
  items: { name: string; quantity: number; notes: string | null }[];
  kots: { id: string; kotNumber: number; station: string; status: KotStatus; releaseAt: string | null }[];
  kitchenReleased: boolean;
  releaseAt: string | null;
  amountPaid: number;
}

/** Minimal staff row for pickers (GET /staff needs staff:view). */
export interface StaffOption {
  id: string;
  name: string;
  role: string;
  status?: string;
}

export interface OfferComparison {
  kind: "OFFER" | "COUPON";
  id: string;
  label: string;
  saving: number;
  applied: boolean;
  note: string;
}
