/**
 * Delivery partner portal + cash handover shapes (apps/api/src/routes/delivery.ts).
 * Money is integer paise; dates are ISO strings, days are YYYY-MM-DD (outlet time).
 */
import type { Delivery } from "./types-service";

/** GET /delivery/mine/summary */
export interface DeliverySummary {
  from: string;
  to: string;
  onDuty: boolean;
  onDutySince: string | null;
  activeDeliveries: number;
  delivered: number;
  cancelled: number;
  orderValue: number;
  collected: {
    cash: number;
    upi: number;
    card: number;
    /** Paid before dispatch (counter / online) — nothing collected */
    prepaid: number;
    /** cash + upi + card */
    total: number;
  };
  /** Cash collected but not yet handed to the outlet (ledger: collected − handed over) */
  cashInHand: number;
  cashInHandOrders: number;
  /** Cash on Delivery still to collect on active runs (all time, paise) */
  codToCollect?: number;
  codOrders?: number;
  avgDeliveryMinutes: number | null;
  distanceKm: number;
  deliveryFees: number;
  byDay: { date: string; deliveries: number; collected: number }[];
}

/** POST /delivery/:id/complete */
export type DeliveryCompleteResult = Delivery & { cashCollected: number; customerMessage?: { waLink: string; text: string; autoSent?: boolean } };

export const DELIVERY_ISSUES = ["CUSTOMER_UNREACHABLE", "WRONG_ADDRESS", "CUSTOMER_REFUSED", "VEHICLE_PROBLEM", "OTHER"] as const;
export type DeliveryIssueReason = (typeof DELIVERY_ISSUES)[number];

export const DELIVERY_ISSUE_LABELS: Record<DeliveryIssueReason, string> = {
  CUSTOMER_UNREACHABLE: "Customer not reachable",
  WRONG_ADDRESS: "Wrong / incomplete address",
  CUSTOMER_REFUSED: "Customer refused the order",
  VEHICLE_PROBLEM: "Vehicle problem",
  OTHER: "Other problem",
};

// ---------- Cash ledger ----------

/** Cash collected on one order that's still with the partner (FIFO against handovers). */
export interface PendingCash {
  orderId: string;
  deliveryId: string | null;
  invoiceNumber: string;
  customerName: string | null;
  address: string | null;
  amount: number;
  collectedAt: string | null;
}

export interface CashHandover {
  id: string;
  outletId: string;
  agentId: string;
  amount: number;
  note: string | null;
  receivedAt: string;
  receivedById: string;
  receivedBy: { id: string; name: string } | null;
  agent?: { id: string; name: string } | null;
}

/** GET /delivery/mine/cash */
export interface MyCash {
  /** Cash in hand to give to the outlet */
  balance: number;
  collectedToday: number;
  handedOverToday: number;
  pending: PendingCash[];
  handovers: CashHandover[];
}

/** GET /delivery/cash — one row per partner */
export interface PartnerCash {
  agent: { id: string; name: string; phone: string; status?: string };
  balance: number;
  collectedToday: number;
  receivedToday: number;
  pending: PendingCash[];
  lastHandoverAt: string | null;
}

/** POST /delivery/cash/settle — "received everything" */
export interface CashSettleResult {
  settled: number;
  amount: number;
}

/** POST /delivery/cash/handovers, PATCH /delivery/cash/handovers/:id */
export interface HandoverResult {
  handover: CashHandover;
  balance: number;
  warnings?: string[];
}

// ---------- Partner activity (manager) ----------

export interface ActivityDay {
  date: string;
  clockIn: string | null;
  clockOut: string | null;
  onDutyMinutes: number;
  lateByMinutes: number;
  assigned: number;
  delivered: number;
  codDelivered: number;
  cancelled: number;
  issues: number;
  avgDeliveryMinutes: number | null;
  distanceKm: number;
  openingBalance: number;
  cashCollected: number;
  cashReceived: number;
  /** Cash still to be received at day end */
  closingBalance: number;
}

export interface PartnerActivity {
  agent: { id: string; name: string; phone: string; status: string };
  totals: {
    assigned: number;
    delivered: number;
    cancelled: number;
    onDutyMinutes: number;
    cashCollected: number;
    cashReceived: number;
    openingBalance: number;
    closingBalance: number;
  };
  currentBalance: number;
  days: ActivityDay[];
}

/** GET /delivery/partners/activity */
export interface PartnersActivity {
  from: string;
  to: string;
  partners: PartnerActivity[];
}

export type TimelineEventType = "CLOCK_IN" | "CLOCK_OUT" | "ASSIGNED" | "ACCEPTED" | "PICKED" | "DELIVERED" | "COLLECTED" | "HANDOVER" | "ISSUE";

/** GET /delivery/partners/:agentId/timeline */
export interface PartnerTimeline {
  agent: { id: string; name: string };
  date: string;
  openingBalance: number;
  closingBalance: number;
  events: { at: string; type: TimelineEventType; title: string; detail?: string; amount?: number }[];
}

// ---------- Attendance ----------

export interface AttendanceRecord {
  id: string;
  workDate: string;
  clockInAt: string;
  clockOutAt: string | null;
  workedMinutes?: number | null;
}

/** GET /attendance/me/status */
export interface AttendanceStatus {
  clockedIn: boolean;
  current: (AttendanceRecord & { outlet?: { id: string; name: string } }) | null;
  recent: AttendanceRecord[];
}
