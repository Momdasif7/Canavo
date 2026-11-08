"use client";

import clsx from "clsx";
import { WarningOctagon } from "@phosphor-icons/react";
import { formatINR, type DeliveryStatusValue } from "@canavo/shared";
import { ApiError } from "@/lib/api";
import type { Delivery, DeliveryPayment, PartnerAvailability } from "@/lib/types-service";

export const DELIVERY_FLOW: DeliveryStatusValue[] = ["PENDING", "ACCEPTED", "PREPARING", "OUT_FOR_DELIVERY", "DELIVERED"];

export const STATUS_LABEL: Record<DeliveryStatusValue, string> = {
  PENDING: "Pending",
  ACCEPTED: "Accepted",
  PREPARING: "Preparing",
  OUT_FOR_DELIVERY: "Out for delivery",
  DELIVERED: "Delivered",
  CANCELLED: "Cancelled",
};

export const NEXT_ACTION: Partial<Record<DeliveryStatusValue, { to: DeliveryStatusValue; label: string }>> = {
  PENDING: { to: "ACCEPTED", label: "Accept" },
  ACCEPTED: { to: "PREPARING", label: "Start preparing" },
  PREPARING: { to: "OUT_FOR_DELIVERY", label: "Dispatch" },
  OUT_FOR_DELIVERY: { to: "DELIVERED", label: "Mark delivered" },
};

export const ACCENT: Record<DeliveryStatusValue, string> = {
  PENDING: "bg-sky-500",
  ACCEPTED: "bg-indigo-500",
  PREPARING: "bg-primary",
  OUT_FOR_DELIVERY: "bg-amber-500",
  DELIVERED: "bg-secondary",
  CANCELLED: "bg-red-500",
};

/** Minutes (signed) until the ETA; negative = late. */
export function EtaCountdown({ etaAt, now, done, className }: { etaAt: string | null; now: number; done?: boolean; className?: string }) {
  if (!etaAt || done) return null;
  const diff = Math.round((new Date(etaAt).getTime() - now) / 60_000);
  return (
    <span
      className={clsx(
        "tabular rounded-md px-1.5 py-0.5 text-xs font-extrabold",
        diff < 0 ? "bg-red-600 text-white" : diff <= 10 ? "bg-amber-400 text-black" : "bg-surface-2 text-fg",
        className,
      )}
      title={`ETA ${new Date(etaAt).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}`}
    >
      {diff < 0 ? `${-diff}m late` : `${diff}m`}
    </span>
  );
}

export const mapsLink = (lat: number, lng: number) => `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;
export const mapsAddressLink = (address: string) => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`;

/** Typed address as one line for a maps search (address, landmark, PIN code). */
const typedAddress = (d: Pick<Delivery, "address" | "landmark" | "pincode">) => [d.address, d.landmark, d.pincode].filter((x) => x && x.trim()).join(", ");

/** "Open in Google Maps": the pin when there is one, else a search for the typed address (address-only delivery). */
export const deliveryMapsLink = (d: Pick<Delivery, "latitude" | "longitude" | "address" | "landmark" | "pincode">) =>
  d.latitude != null && d.longitude != null ? mapsLink(d.latitude, d.longitude) : mapsAddressLink(typedAddress(d));

/** Turn-by-turn directions (Google Maps) to the drop: coordinates when known, else the typed address. */
export const directionsLink = (d: Pick<Delivery, "latitude" | "longitude" | "address" | "landmark" | "pincode">) =>
  `https://www.google.com/maps/dir/?api=1&destination=${d.latitude != null && d.longitude != null ? `${d.latitude},${d.longitude}` : encodeURIComponent(typedAddress(d))}`;

/** Split delivery notes into problems reported by the partner ("ISSUE: …") and the rest. */
export function splitNotes(notes: string | null | undefined): { issues: string[]; other: string[] } {
  const lines = (notes ?? "").split("\n").map((l) => l.trim()).filter(Boolean);
  return {
    issues: lines.filter((l) => l.startsWith("ISSUE:")).map((l) => l.slice(6).trim()),
    other: lines.filter((l) => !l.startsWith("ISSUE:")),
  };
}

/** Partner-reported problems, shown prominently to the outlet. */
export function IssueList({ issues, compact }: { issues: string[]; compact?: boolean }) {
  if (!issues.length) return null;
  return (
    <div
      className={clsx(
        "rounded-lg border border-red-300 bg-red-50 text-red-800 dark:border-red-500/40 dark:bg-red-500/15 dark:text-red-200",
        compact ? "mt-2 px-2 py-1.5 text-xs" : "px-3 py-2 text-sm",
      )}
      role="alert"
      data-testid="delivery-issue"
    >
      {issues.map((t, i) => (
        <p key={i} className="flex items-start gap-1.5 font-semibold">
          <WarningOctagon size={compact ? 14 : 18} weight="fill" className="mt-0.5 shrink-0" />
          <span>Problem: {t}</span>
        </p>
      ))}
    </div>
  );
}

/** Successful payments on a delivery's order. */
export const successfulPayments = (d: Delivery): DeliveryPayment[] => (d.order.payments ?? []).filter((p) => p.status === "SUCCESS");

export interface PaidHow {
  cash: number;
  upi: number;
  card: number;
  prepaid: number;
  /** UTRs / approval codes of payments taken at the door */
  references: string[];
}

/** How an order was paid, from the partner's point of view (mirrors the API's summary). */
export function paidHow(d: Delivery, agentId: string): PaidHow {
  const out: PaidHow = { cash: 0, upi: 0, card: 0, prepaid: 0, references: [] };
  for (const p of successfulPayments(d)) {
    if (p.collectedById === agentId && (p.mode === "CASH" || p.mode === "UPI" || p.mode === "CARD")) {
      out[p.mode === "CASH" ? "cash" : p.mode === "UPI" ? "upi" : "card"] += p.amount;
      if (p.reference) out.references.push(p.reference);
    } else out.prepaid += p.amount;
  }
  return out;
}

export function paidHowLabel(h: PaidHow): string {
  const parts = [
    h.cash && `Cash ${formatINR(h.cash)}`,
    h.upi && `UPI ${formatINR(h.upi)}`,
    h.card && `Card ${formatINR(h.card)}`,
    h.prepaid && `Prepaid ${formatINR(h.prepaid)}`,
  ].filter(Boolean);
  return parts.join(" + ") || "Unpaid";
}

// ---------- Dispatch limit / partner availability ----------

export type PartnerStatusTone = "success" | "info" | "warning" | "neutral";

/** Board / POS label for a partner's dispatch state: Available / At outlet x/y / Out for delivery / Returning to outlet / Off duty. */
export function partnerStatus(a: Pick<PartnerAvailability, "onDuty" | "atOutlet" | "active" | "outForDelivery" | "max" | "available">): {
  label: string;
  tone: PartnerStatusTone;
} {
  if (!a.onDuty) return { label: "Off duty", tone: "neutral" };
  if (a.outForDelivery > 0) return { label: "Out for delivery", tone: "warning" };
  if (!a.atOutlet) return { label: "Returning to outlet", tone: "info" };
  if (a.active === 0) return { label: "Available", tone: "success" };
  return { label: `At outlet ${a.active}/${a.max}`, tone: a.available ? "success" : "warning" };
}

/** One-line option text for partner pickers: "Ravi — available (1/2)", "Deepak — out for delivery". */
export function partnerOptionLabel(a: Pick<PartnerAvailability, "name" | "available" | "active" | "max" | "reason">): string {
  if (a.available) return `${a.name} — available (${a.active}/${a.max})`;
  const why = a.reason ?? "unavailable";
  return `${a.name} — ${why.charAt(0).toLowerCase()}${why.slice(1)}`;
}

/** 409 from assign / order create when the chosen partner can't take another order. */
export function partnerUnavailable(e: unknown): { message: string; canForce: boolean } | null {
  if (!(e instanceof ApiError) || e.status !== 409) return null;
  const d = e.details as { code?: string; canForce?: boolean } | undefined;
  if (d?.code !== "PARTNER_UNAVAILABLE") return null;
  return { message: e.message, canForce: d.canForce === true };
}

/** "<error>. Assign anyway?" — for managers / owners overriding the dispatch limit. */
export const confirmForceAssign = (message: string) => window.confirm(`${message.replace(/[.\s]+$/, "")}. Assign anyway?`);
