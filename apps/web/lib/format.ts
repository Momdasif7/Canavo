import { formatINR } from "@canavo/shared";
import type { OrderType, PaymentMode } from "./types";

export { formatINR };

export const ORDER_TYPE_LABELS: Record<OrderType, string> = {
  DINE_IN: "Dine-In",
  TAKEAWAY: "Takeaway",
  DELIVERY: "Delivery",
  PRE_ORDER: "Pre-Order",
};

export const PAYMENT_MODE_LABELS: Record<PaymentMode, string> = {
  CASH: "Cash",
  UPI: "UPI",
  CARD: "Card",
  KHATA: "Khata",
  GIFT_CARD: "Gift card",
  CORPORATE: "Company",
  WALLET: "Wallet",
  MEAL_TOKEN: "Meal token",
  ONLINE: "Paid online",
};

/** ₹ amount entered by a user → paise, or null when blank/invalid. */
export function parseRupees(input: string): number | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const n = Number(trimmed);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : null;
}

/** Paise → editable rupee string ("45" or "45.50"). */
export function rupeesInput(paise: number): string {
  const r = paise / 100;
  return Number.isInteger(r) ? String(r) : r.toFixed(2);
}

export const formatTime = (iso: string) =>
  new Date(iso).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });

export const formatDateTime = (iso: string) =>
  new Date(iso).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });

export const formatDate = (iso: string) => new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });

export function formatMinutes(min: number | null | undefined): string {
  if (min == null) return "—";
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}m`;
}

export const titleCase = (s: string) =>
  s
    .toLowerCase()
    .split(/[_\s]+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
