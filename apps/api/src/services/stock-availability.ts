import type { Prisma } from "@prisma/client";
import { prisma } from "../db";
import { emitToOutlet } from "../realtime";
import { notify, outletManagers } from "./notify";

type Db = Prisma.TransactionClient | typeof prisma;

/**
 * Automatic out-of-stock for menu items (per outlet).
 *
 * A menu item (or one of its sizes) is out of stock at an outlet when any
 * ingredient in its recipe has less stock than one portion needs. A size uses
 * its own recipe if it has one, otherwise the item's default recipe. The item
 * itself is out when it has no sizes and its recipe can't be made, or when
 * every size is out.
 *
 * The result is stored on OutletItemOverride (stockOut, stockOutVariantIds,
 * stockOutReason) so it never touches the manager's manual status: the item
 * comes back by itself when stock is added, unless a manager switched it off.
 */

export interface RecipeLine {
  variantId: string | null;
  inventoryItemId: string;
  quantity: number;
  itemName: string;
}

export interface Availability {
  stockOut: boolean;
  stockOutVariantIds: string[];
  /** Names of the ingredients that ran out, or null */
  reason: string | null;
}

/** Pure decision for one menu item (unit-tested). `stock` = quantity on hand per inventory item at the outlet. */
export function computeAvailability(variantIds: string[], recipes: RecipeLine[], stock: Map<string, number>): Availability {
  const short = (lines: RecipeLine[]) => lines.filter((l) => (stock.get(l.inventoryItemId) ?? 0) + 1e-9 < l.quantity);
  const defaults = recipes.filter((r) => r.variantId === null);
  const missing = new Set<string>();
  if (!variantIds.length) {
    const s = short(defaults);
    s.forEach((l) => missing.add(l.itemName));
    return { stockOut: s.length > 0, stockOutVariantIds: [], reason: s.length ? [...missing].join(", ") : null };
  }
  const outVariants: string[] = [];
  for (const v of variantIds) {
    const own = recipes.filter((r) => r.variantId === v);
    const s = short(own.length ? own : defaults);
    if (s.length) {
      outVariants.push(v);
      s.forEach((l) => missing.add(l.itemName));
    }
  }
  const all = outVariants.length === variantIds.length;
  return {
    stockOut: all,
    stockOutVariantIds: all ? [] : outVariants,
    reason: outVariants.length ? [...missing].join(", ") : null,
  };
}

/**
 * Recompute availability at an outlet for the menu items that use the given
 * inventory items (or every item with a recipe when omitted). Returns the
 * menu items whose state changed, with their names and new state.
 */
export async function refreshMenuAvailability(
  db: Db,
  outletId: string,
  inventoryItemIds?: string[],
): Promise<{ id: string; name: string; stockOut: boolean; partial: boolean; reason: string | null }[]> {
  const menuItemIds = (
    await db.recipe.findMany({
      where: inventoryItemIds ? { inventoryItemId: { in: inventoryItemIds } } : {},
      select: { menuItemId: true },
      distinct: ["menuItemId"],
    })
  ).map((r) => r.menuItemId);
  // Items whose recipe was removed may still carry an old flag: include them on full refreshes.
  const flagged = inventoryItemIds
    ? []
    : (await db.outletItemOverride.findMany({ where: { outletId, OR: [{ stockOut: true }, { NOT: { stockOutVariantIds: { isEmpty: true } } }] }, select: { menuItemId: true } })).map((o) => o.menuItemId);
  const ids = [...new Set([...menuItemIds, ...flagged])];
  if (!ids.length) return [];

  const items = await db.menuItem.findMany({
    where: { id: { in: ids } },
    select: {
      id: true,
      name: true,
      variants: { select: { id: true } },
      recipes: { select: { variantId: true, inventoryItemId: true, quantity: true, item: { select: { name: true } } } },
      overrides: { where: { outletId }, select: { stockOut: true, stockOutVariantIds: true, stockOutReason: true } },
    },
  });
  const invIds = [...new Set(items.flatMap((i) => i.recipes.map((r) => r.inventoryItemId)))];
  const stockRows = invIds.length
    ? await db.inventoryStock.findMany({ where: { outletId, inventoryItemId: { in: invIds } }, select: { inventoryItemId: true, quantity: true } })
    : [];
  const stock = new Map(stockRows.map((s) => [s.inventoryItemId, s.quantity]));

  const changed: { id: string; name: string; stockOut: boolean; partial: boolean; reason: string | null }[] = [];
  for (const item of items) {
    const next = computeAvailability(
      item.variants.map((v) => v.id),
      item.recipes.map((r) => ({ variantId: r.variantId, inventoryItemId: r.inventoryItemId, quantity: r.quantity, itemName: r.item.name })),
      stock,
    );
    const cur = item.overrides[0];
    const same =
      (cur?.stockOut ?? false) === next.stockOut &&
      [...(cur?.stockOutVariantIds ?? [])].sort().join(",") === [...next.stockOutVariantIds].sort().join(",") &&
      (cur?.stockOutReason ?? null) === next.reason;
    if (same) continue;
    await db.outletItemOverride.upsert({
      where: { outletId_menuItemId: { outletId, menuItemId: item.id } },
      create: { outletId, menuItemId: item.id, stockOut: next.stockOut, stockOutVariantIds: next.stockOutVariantIds, stockOutReason: next.reason },
      update: { stockOut: next.stockOut, stockOutVariantIds: next.stockOutVariantIds, stockOutReason: next.reason },
    });
    changed.push({ id: item.id, name: item.name, stockOut: next.stockOut, partial: next.stockOutVariantIds.length > 0, reason: next.reason });
  }
  return changed;
}

/**
 * Tell POS screens the menu changed and tell managers what went out / came back.
 * Called from inside stock transactions, so it is deferred a little to land after
 * the commit (POS screens also re-check when a bill is refused as out of stock).
 */
export function announceAvailability(outletId: string, changed: Awaited<ReturnType<typeof refreshMenuAvailability>>) {
  if (!changed.length) return;
  const timer = setTimeout(() => {
    emitToOutlet(outletId, "menu:changed", { ids: changed.map((c) => c.id), stock: true });
    void (async () => {
      const managers = await outletManagers(outletId);
      const out = changed.filter((c) => c.stockOut || c.partial);
      const back = changed.filter((c) => !c.stockOut && !c.partial);
      if (out.length) {
        const names = out.map((c) => (c.partial ? `${c.name} (some sizes)` : c.name)).join(", ");
        const reasons = [...new Set(out.map((c) => c.reason).filter(Boolean))].join(", ");
        await notify(managers, `Out of stock: ${names}`, `${reasons} ran out. Removed from the POS until restocked.`, "inventory.menu_stock_out", { outletId, link: "/inventory" });
      }
      if (back.length) {
        await notify(managers, `Back on the menu: ${back.map((c) => c.name).join(", ")}`, "Ingredients restocked. Available on the POS again.", "inventory.menu_back", { outletId, link: "/menu" });
      }
    })().catch((e) => console.error("[stock] availability notification failed", e));
  }, 1500);
  timer.unref?.();
}
