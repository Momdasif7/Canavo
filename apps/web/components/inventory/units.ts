import { STOCK_UNITS } from "@canavo/shared";
import type { InventoryTxnType, StockUnit } from "@/lib/types-inventory";

export { STOCK_UNITS };

export const UNIT_LABELS: Record<StockUnit, string> = {
  KG: "kg",
  G: "g",
  L: "L",
  ML: "ml",
  PIECE: "pcs",
  PACKET: "pkt",
  DOZEN: "dozen",
  BOX: "box",
};

export const UNIT_NAMES: Record<StockUnit, string> = {
  KG: "Kilogram (kg)",
  G: "Gram (g)",
  L: "Litre (L)",
  ML: "Millilitre (ml)",
  PIECE: "Piece (pcs)",
  PACKET: "Packet (pkt)",
  DOZEN: "Dozen",
  BOX: "Box",
};

/** Mirrors the API's unit families (services/inventory.ts UNIT_BASE). */
const UNIT_BASE: Record<StockUnit, { base: string; factor: number }> = {
  KG: { base: "G", factor: 1000 },
  G: { base: "G", factor: 1 },
  L: { base: "ML", factor: 1000 },
  ML: { base: "ML", factor: 1 },
  DOZEN: { base: "PIECE", factor: 12 },
  PIECE: { base: "PIECE", factor: 1 },
  PACKET: { base: "PACKET", factor: 1 },
  BOX: { base: "BOX", factor: 1 },
};

/** Units a quantity can be entered in for an item stocked in `unit` (item unit first). */
export function compatibleUnits(unit: StockUnit): StockUnit[] {
  return [unit, ...STOCK_UNITS.filter((u) => u !== unit && UNIT_BASE[u].base === UNIT_BASE[unit].base)];
}

export const round3 = (n: number) => Math.round((n + Number.EPSILON) * 1000) / 1000;

/** Convert between compatible units (returns the input unchanged if incompatible). */
export function convertQty(quantity: number, from: StockUnit, to: StockUnit): number {
  if (from === to || UNIT_BASE[from].base !== UNIT_BASE[to].base) return quantity;
  return round3((quantity * UNIT_BASE[from].factor) / UNIT_BASE[to].factor);
}

/** Up to 3 decimals, trailing zeros trimmed, Indian digit grouping. */
export function formatQty(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return n.toLocaleString("en-IN", { maximumFractionDigits: 3 });
}

export const qtyWithUnit = (n: number | null | undefined, unit: StockUnit) => `${formatQty(n)} ${UNIT_LABELS[unit]}`;

/** Parse a user-entered quantity; null when blank/invalid. */
export function parseQty(input: string): number | null {
  const t = input.trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** Keep only characters valid in a decimal quantity. */
export const qtyChars = (s: string) => s.replace(/[^\d.]/g, "");

export const TXN_LABELS: Record<InventoryTxnType, string> = {
  OPENING: "Opening",
  PURCHASE: "Purchase",
  SALE: "Sale",
  SALE_REVERSAL: "Sale reversal",
  WASTAGE: "Wastage",
  ADJUSTMENT: "Adjustment",
  AUDIT: "Audit",
  TRANSFER_IN: "Transfer in",
  TRANSFER_OUT: "Transfer out",
  RETURN: "Return",
};

export const TXN_TONES: Record<InventoryTxnType, "neutral" | "primary" | "success" | "warning" | "danger" | "info"> = {
  OPENING: "info",
  PURCHASE: "success",
  SALE: "neutral",
  SALE_REVERSAL: "info",
  WASTAGE: "danger",
  ADJUSTMENT: "warning",
  AUDIT: "warning",
  TRANSFER_IN: "success",
  TRANSFER_OUT: "primary",
  RETURN: "danger",
};

export const GST_RATES = [0, 5, 12, 18, 28] as const;

export const formatDate = (iso: string) => new Date(iso).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });

/** "2026-10-02" → "02 Oct 2026" without timezone drift. */
export function formatYmd(ymd: string | null | undefined): string {
  if (!ymd) return "—";
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric", timeZone: "UTC" });
}
