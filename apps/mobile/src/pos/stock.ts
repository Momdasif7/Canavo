/**
 * Out-of-stock helpers for the POS. GET /menu items carry the effective
 * `status` ("OUT_OF_STOCK" when a manager switched it off or an ingredient ran
 * out), `stockOutReason` (ingredient names) and `unavailableVariantIds`
 * (sizes that can't be made). Pure (no React Native).
 */
import type { MenuItem } from "../lib/types";

/** Item can't be sold at all right now (manual or automatic). */
export const isItemOut = (item: MenuItem) => item.status === "OUT_OF_STOCK" || (item.status === "AVAILABLE" && !!item.stockOut);

/** This size of the item ran out (other sizes may still be available). */
export const isVariantOut = (item: MenuItem, variantId: string | null | undefined) =>
  !!variantId && !!item.unavailableVariantIds?.includes(variantId);

/** "Pav buns ran out", or null when there's no ingredient reason. */
export const ranOut = (item: MenuItem) => (item.stockOutReason?.trim() ? `${item.stockOutReason.trim()} ran out` : null);

/** "Out of stock · Pav buns ran out" / "Out of stock", or null when the item is available. */
export function stockLabel(item: MenuItem): string | null {
  if (!isItemOut(item)) return null;
  const reason = ranOut(item);
  return reason ? `Out of stock · ${reason}` : "Out of stock";
}

/** A cart line the server would refuse (item or its size out of stock, per the latest menu). */
export const isLineOut = (line: { item: MenuItem; variant: { id: string } | null }) =>
  isItemOut(line.item) || isVariantOut(line.item, line.variant?.id);

/** 400 from billing / add-items: "Vada Pav is out of stock (Pav buns ran out)" / "X is not available". */
export const isStockError = (e: unknown) =>
  !!e && typeof e === "object" && (e as { status?: number }).status === 400 && /out of stock|is not available/i.test(String((e as { message?: string }).message ?? ""));
