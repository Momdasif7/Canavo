/**
 * Buy-X-Get-Y free items: turn the preview's `suggestions` into cart targets.
 * Pure (no React Native), shared by the POS and the node verification script.
 *
 * The preview is asked twice when the cart already holds free lines: once
 * with them (for the totals) and once without (so `suggestions` gives the
 * TOTAL number of free units the cart qualifies for). With no free lines the
 * two bodies are identical and one call does both.
 */
import type { FreeItemSuggestion, Menu } from "../lib/types";
import { freeLineKey, type FreeTarget } from "./cart";

/** Badge text on a free line, e.g. "FREE · Samosa combo" or "50% OFF · Samosa combo". */
export const freeBadge = (percent: number, offerName: string) => `${percent >= 100 ? "FREE" : `${percent}% OFF`} · ${offerName}`;

/** Suggestions (computed without free lines) → the free lines the cart should hold. */
export function freeTargets(suggestions: FreeItemSuggestion[] | undefined, menu: Menu | null): FreeTarget[] {
  if (!suggestions?.length || !menu) return [];
  const byId = new Map(menu.items.map((i) => [i.id, i]));
  const out: FreeTarget[] = [];
  for (const s of suggestions) {
    const item = byId.get(s.menuItemId);
    if (!item || item.status !== "AVAILABLE" || s.quantity <= 0) continue;
    const variant = s.variantId ? item.variants.find((v) => v.id === s.variantId) ?? null : null;
    if (s.variantId && !variant) continue;
    out.push({
      key: freeLineKey(s.offerId, s.menuItemId, s.variantId),
      item,
      variant,
      quantity: Math.min(999, s.quantity),
      free: { offerId: s.offerId, offerName: s.offerName, percent: s.getDiscountPercent, label: s.label },
    });
  }
  return out;
}
