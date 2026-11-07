/**
 * Phase 6 online / aggregator order board: pure helpers (no React Native imports).
 */
import type { ChannelBoardOrder, ChannelBoardStage, ChannelRequest } from "../lib/types";

/** Board sections, in order. Cancelled orders are not shown as a section. */
export const BOARD_SECTIONS: { stage: Exclude<ChannelBoardStage, "CANCELLED">; label: string }[] = [
  { stage: "NEW", label: "New" },
  { stage: "PREPARING", label: "Preparing" },
  { stage: "PACKED", label: "Packed" },
  { stage: "HANDED_OVER", label: "Handed over" },
];

/** Badge label + colour per channel (Zomato red, Swiggy orange…). */
export function channelBadge(channel: string): { label: string; color: string } {
  switch (channel) {
    case "ZOMATO":
      return { label: "Zomato", color: "#E23744" };
    case "SWIGGY":
      return { label: "Swiggy", color: "#FC8019" };
    case "ONDC":
      return { label: "ONDC", color: "#1D4ED8" };
    case "ONLINE":
      return { label: "Online", color: "#2D6A4F" };
    case "QR":
      return { label: "QR", color: "#6D28D9" };
    case "POS":
      return { label: "POS", color: "#5F6070" };
    default:
      return { label: "Other", color: "#5F6070" };
  }
}

/** First name only (privacy on a shared screen). */
export const firstName = (name: string | null | undefined) => (name ?? "").trim().split(/\s+/)[0] || null;

export function countByStage(orders: ChannelBoardOrder[]): Record<ChannelBoardStage, number> {
  const out: Record<ChannelBoardStage, number> = { NEW: 0, PREPARING: 0, PACKED: 0, HANDED_OVER: 0, CANCELLED: 0 };
  for (const o of orders) out[o.stage] = (out[o.stage] ?? 0) + 1;
  return out;
}

/** Oldest first for work still to do; latest first once handed over. */
export function ordersInStage(orders: ChannelBoardOrder[], stage: ChannelBoardStage): ChannelBoardOrder[] {
  const list = orders.filter((o) => o.stage === stage);
  const at = (o: ChannelBoardOrder) => new Date(stage === "HANDED_OVER" ? (o.handedOverAt ?? o.placedAt) : o.placedAt).getTime();
  return list.sort((a, b) => (stage === "HANDED_OVER" ? at(b) - at(a) : at(a) - at(b)));
}

/** "5m", "1h 05m" since an ISO time. */
export function ageLabel(iso: string, now: number): string {
  const min = Math.max(0, Math.floor((now - new Date(iso).getTime()) / 60_000));
  if (min < 1) return "just now";
  if (min < 60) return `${min}m`;
  return `${Math.floor(min / 60)}h ${String(min % 60).padStart(2, "0")}m`;
}

/** Reasons offered when rejecting a QR / online order (the API needs at least 3 characters). */
export const REJECT_REASONS = ["Out of stock", "Too busy", "Closed", "Other"] as const;
export type RejectReason = (typeof REJECT_REASONS)[number];

export function rejectReasonText(choice: RejectReason | null, other: string): string | null {
  if (!choice) return null;
  if (choice !== "Other") return choice;
  const text = other.trim();
  return text.length >= 3 ? text.slice(0, 200) : null;
}

export const REQUEST_PAYMENT_LABEL: Record<NonNullable<ChannelRequest["payment"]>, string> = {
  COUNTER: "Pay at counter",
  COD: "Cash on delivery",
  UPI: "UPI prepaid",
};
