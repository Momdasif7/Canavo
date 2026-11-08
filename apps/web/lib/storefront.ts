/**
 * Phase 6.3 / 6.4: customer-facing QR table page and online ordering page (no login),
 * plus the staff types for settings and incoming orders.
 */
import type { StorefrontSettings } from "@canavo/shared";
import { ApiError, apiBase } from "./api";
import type { FoodType } from "./types";

/** Unauthenticated JSON call to the public storefront endpoints. */
export async function publicCall<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${apiBase()}${path}`, {
      method,
      headers: body !== undefined ? { "content-type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      cache: "no-store",
      credentials: "omit",
    });
  } catch {
    throw new ApiError(0, "No connection — check your internet and try again", undefined, true);
  }
  const text = await res.text();
  const data = text ? (JSON.parse(text) as unknown) : undefined;
  if (!res.ok) {
    const d = data as { error?: string; details?: unknown } | undefined;
    throw new ApiError(res.status, res.status === 404 ? "This page isn't available" : (d?.error ?? "Something went wrong"), d?.details);
  }
  return data as T;
}

export interface PublicBrand {
  name: string;
  /** Business brand colour (hex) — the customer pages' accent */
  accent?: string | null;
  address: string;
  phone: string | null;
  logoUrl: string | null;
  pricesIncludeTax: boolean;
  gstEnabled: boolean;
  packagingCharge: number;
}

export interface PublicMenuItem {
  id: string;
  name: string;
  description: string;
  categoryId: string;
  foodType: FoodType;
  imageUrl: string | null;
  price: number;
  gstRate: number;
  available: boolean;
  unavailableReason: string | null;
  variants: { id: string; name: string; price: number; available: boolean }[];
  addons: { id: string; name: string; price: number }[];
}

export interface PublicMenu {
  categories: { id: string; name: string; parentId: string | null; sortOrder: number }[];
  items: PublicMenuItem[];
  /** Most-sold items lately ("Bestseller" badge) */
  bestsellers?: string[];
}

export interface TablePage extends PublicMenu {
  outlet: PublicBrand;
  table: { label: string };
  ordering: boolean;
  notice: string | null;
  needsConfirmation: boolean;
  hours: { from: string; to: string } | null;
}

export interface OutletPage extends PublicMenu {
  outlet: PublicBrand;
  ordering: boolean;
  notice: string | null;
  hours: { from: string; to: string } | null;
  timezone: string;
  minOrder: number;
  takeaway: boolean;
  delivery: boolean;
  zones: { id: string; name: string; radiusKm: number; fee: number; minOrder: number; etaMinutes: number }[];
  /** MAP: map pin + zones; ADDRESS: typed address + PIN code, flat fee (no map) */
  deliveryMode?: "MAP" | "ADDRESS";
  /** ADDRESS mode: flat fee, minimum order, ETA and allowed PIN codes / areas (empty = anywhere) */
  deliveryFlat?: { fee: number; minOrder: number; etaMinutes: number; areas: string[] } | null;
  /** Offers running now (applied automatically to the bill) */
  offers?: { id: string; name: string; summary: string }[];
  payments: { COUNTER: boolean; COD: boolean; UPI: boolean };
  needsConfirmation: boolean;
  /** Customers verify their phone by OTP before ordering */
  verifyPhone: boolean;
  /** Outlet position for the delivery map (null: choose an area instead) */
  location: { lat: number; lng: number } | null;
}

/** Zone and fee for a delivery map pin, or the flat fee / area check of an address-only outlet. */
export interface DeliveryQuote {
  mode?: "MAP" | "ADDRESS";
  fee?: number | null;
  etaMinutes?: number | null;
  minOrder?: number | null;
  outletLocation: boolean;
  deliverable: boolean;
  distanceKm: number | null;
  zone: { id: string; name: string; fee: number; minOrder: number; etaMinutes: number } | null;
  message: string | null;
}

export type OnlineRefundStatus = "PROCESSED" | "PENDING" | "MANUAL" | "FAILED";

/** Customer-facing wording for a UPI refund. */
export const REFUND_LABEL: Record<OnlineRefundStatus, string> = {
  PROCESSED: "Refund sent to your UPI account — it usually shows up within 5–7 working days.",
  PENDING: "Refund started — it usually shows up in your UPI account within 5–7 working days.",
  MANUAL: "Your refund is being processed by the restaurant.",
  FAILED: "Your refund is being processed by the restaurant.",
};

export type OrderStage = "waiting" | "confirmed" | "received" | "preparing" | "ready" | "served" | "cancelled";

export const STAGE_LABEL: Record<OrderStage, string> = {
  waiting: "Waiting for the restaurant to confirm",
  confirmed: "Confirmed",
  received: "Sent to the kitchen",
  preparing: "Being prepared",
  ready: "Ready",
  served: "Served",
  cancelled: "Not accepted",
};

export interface TableOrder {
  id: string;
  createdAt: string;
  stage: OrderStage;
  rejectReason: string | null;
  total: number;
  items: { name: string; quantity: number }[];
}

export interface OnlineOrderView {
  outlet: PublicBrand;
  invoiceNumber: string;
  createdAt: string;
  orderType: "TAKEAWAY" | "DELIVERY";
  stage: OrderStage;
  rejectReason: string | null;
  payment: "COUNTER" | "COD" | "UPI" | null;
  status: "OPEN" | "PAID" | "CANCELLED";
  customerName: string | null;
  items: { name: string; quantity: number; total: number }[];
  subtotal: number;
  discount: number;
  tax: number;
  charges: { label: string; amount: number }[];
  grandTotal: number;
  balance: number;
  upi: { amount: number; qrPayload: string } | null;
  delivery: { status: string } | null;
  refund: { status: OnlineRefundStatus; amount: number } | null;
  receiptUrl: string | null;
}

/** One cart line (prices are for display only — the server prices the order). */
export interface CartLine {
  key: string;
  menuItemId: string;
  variantId?: string;
  addonIds: string[];
  quantity: number;
  notes?: string;
  name: string;
  unitPrice: number;
}

// ---------- Staff ----------

export interface StorefrontSettingsView {
  settings: StorefrontSettings;
  slug: string | null;
  outletName: string;
  deliveryAvailable: boolean;
  deliveryMode?: "MAP" | "ADDRESS";
  tablesAvailable: boolean;
  upiReady: boolean;
}

export interface TableQr {
  id: string;
  label: string;
  qrToken: string;
  area: { name: string } | null;
}

export interface ChannelRequestRow {
  id: string;
  channel: "QR" | "ONLINE";
  status: "PENDING" | "ACCEPTED" | "REJECTED";
  createdAt: string;
  tableId: string | null;
  tableLabel: string | null;
  order: { id: string; invoiceNumber: string; orderType: string; grandTotal: number; status: string; notes: string | null } | null;
  items: { name: string; quantity: number; unitPrice: number; notes?: string }[];
  total: number;
  customerName: string | null;
  customerPhone: string | null;
  notes: string | null;
  payment: string | null;
  rejectReason: string | null;
  refund: { status: OnlineRefundStatus; amount: number; ref: string | null; error: string | null } | null;
}

/** Public web address of a page (this web app's origin). */
export const publicPageUrl = (path: string) => (typeof window === "undefined" ? path : `${window.location.origin}${path}`);
