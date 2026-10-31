/** Response shapes for the CRM module (customers, khata, loyalty, offers, coupons). Money is integer paise. */
import type { LoyaltyTierName, OfferTypeName } from "@canavo/shared";
import type { OrderStatus, OrderType } from "./types";

export type LoyaltyTxnType = "EARN" | "REDEEM" | "ADJUST" | "EXPIRE" | "REVERSE";
export type KhataTxnType = "DEBIT" | "CREDIT";
export type DiscountType = "FLAT" | "PERCENT";

export interface Customer {
  id: string;
  phone: string;
  name: string | null;
  email: string | null;
  /** "MM-DD" */
  birthday: string | null;
  anniversary: string | null;
  totalSpend: number;
  visitCount: number;
  lastVisitAt: string | null;
  points: number;
  tier: LoyaltyTierName;
  /** Positive = customer owes */
  khataBalance: number;
  /** 0 = no limit */
  khataLimit: number;
  blocked: boolean;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CustomerList {
  items: Customer[];
  total: number;
  page: number;
  limit: number;
}

export interface LoyaltyTransaction {
  id: string;
  customerId: string;
  orderId: string | null;
  type: LoyaltyTxnType;
  points: number;
  note: string | null;
  createdAt: string;
}

export interface KhataTransaction {
  id: string;
  customerId: string;
  outletId: string;
  orderId: string | null;
  type: KhataTxnType;
  amount: number;
  mode: string | null;
  note: string | null;
  createdById: string | null;
  createdAt: string;
}

export interface CustomerRecentOrder {
  id: string;
  invoiceNumber: string;
  outletId: string;
  createdAt: string;
  status: OrderStatus;
  orderType: OrderType;
  grandTotal: number;
  promoDiscount: number;
  couponCode: string | null;
  pointsRedeemed: number;
  _count: { items: number };
}

export interface CustomerStats {
  totalSpend: number;
  visitCount: number;
  avgBill: number;
  lastVisitAt: string | null;
  firstVisitAt: string | null;
  paidOrders: number;
  cancelledOrders: number;
  openOrders: number;
  points: number;
  pointsValue: number;
  redeemablePoints: number;
  tier: LoyaltyTierName;
  nextTier: { tier: LoyaltyTierName; at: number; remaining: number } | null;
  khataBalance: number;
  khataLimit: number;
}

export interface CustomerProfile {
  customer: Customer;
  stats: CustomerStats;
  recentOrders: CustomerRecentOrder[];
  loyaltyLedger: LoyaltyTransaction[];
  khataLedger: KhataTransaction[];
  couponRedemptions: { code: string; orderId: string; amount: number; createdAt: string }[];
  favouriteItems: { menuItemId: string; name: string; quantity: number; orders: number; amount: number }[];
  /** [weekday 0=Sun][hour 0–23] = paid visits, outlet timezone */
  visitHeatmap: number[][];
}

export interface KhataOutstandingRow {
  id: string;
  name: string | null;
  phone: string;
  khataBalance: number;
  khataLimit: number;
  blocked: boolean;
  tier: LoyaltyTierName;
  /** Due at the active outlet */
  outletDue: number;
  lastTxnAt: string | null;
  lastDebitAt: string | null;
}

export interface KhataOutstanding {
  items: KhataOutstandingRow[];
  totalOutstanding: number;
  customers: number;
}

export interface KhataSettleResult {
  customer: Customer;
  transaction: KhataTransaction;
}

export interface LoyaltyAdjustResult {
  customer: Customer;
  transaction: LoyaltyTransaction;
}

export interface KhataRemindResult {
  /** "sent" via WhatsApp Business API; "link" = open the wa.me link */
  method: "sent" | "link";
  waLink: string;
  balance: number;
  text: string;
}

export interface Offer {
  id: string;
  name: string;
  type: OfferTypeName;
  active: boolean;
  outletIds: string[];
  startsAt: string | null;
  endsAt: string | null;
  daysOfWeek: number[];
  startTime: string | null;
  endTime: string | null;
  priority: number;
  /** Type-specific config (see offer config schemas in @canavo/shared) */
  config: unknown;
  createdAt: string;
  updatedAt: string;
  /** Human-readable description (list/detail responses only) */
  summary?: string;
}

export interface Coupon {
  id: string;
  code: string;
  description: string;
  discountType: DiscountType;
  /** Paise for FLAT, percent for PERCENT */
  value: number;
  maxDiscount: number | null;
  minOrder: number;
  usageLimit: number | null;
  perCustomerLimit: number | null;
  usedCount: number;
  startsAt: string | null;
  expiresAt: string | null;
  active: boolean;
  createdAt: string;
}

/** DELETE /offers/coupons/:id → 204 (deleted) or this body when it had redemptions. */
export interface CouponDeleteResult {
  deleted: false;
  deactivated: true;
}

export interface CouponReportRow {
  couponId: string;
  code: string;
  description: string;
  active: boolean;
  usageLimit: number | null;
  usedCount: number;
  redemptions: number;
  discount: number;
  sales: number;
  uniqueCustomers: number;
}

export interface CouponReport {
  from: string | null;
  to: string | null;
  rows: CouponReportRow[];
  totals: { redemptions: number; discount: number; sales: number };
}
