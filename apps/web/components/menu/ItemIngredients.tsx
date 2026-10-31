"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowRight, Plus, Trash } from "@phosphor-icons/react";
import { recipeUpsertSchema } from "@canavo/shared";
import { api, errorMessage } from "@/lib/api";
import type { RecipeRow, StockUnit } from "@/lib/types-inventory";
import { useSession } from "@/components/providers/SessionProvider";
import { Button, IconButton } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Badge } from "@/components/ui/Badge";
import { Spinner } from "@/components/ui/Spinner";
import { ItemSelect, UnitSelect, lineKey, useStockItems } from "@/components/inventory/common";
import { parseQty, qtyChars } from "@/components/inventory/units";

interface Line {
  key: string;
  itemId: string;
  qty: string;
  unit: StockUnit | undefined;
  /** Name of an ingredient that is no longer active */
  inactiveName?: string;
}

const blankLine = (): Line => ({ key: lineKey(), itemId: "", qty: "", unit: undefined });
const snapshot = (lines: Line[]) => JSON.stringify(lines.filter((l) => l.itemId || l.qty).map((l) => [l.itemId, l.qty, l.unit]));

/** Whether this session may edit recipes from the menu item form. */
export function useCanEditIngredients(): boolean {
  const { me, can } = useSession();
  const moduleOn = !me?.modules || me.modules.includes("INVENTORY");
  return moduleOn && can("inventory:manage");
}

/**
 * Default recipe (all sizes) of a menu item, edited inside the item form and
 * saved after the item itself via PUT /inventory/recipes/:menuItemId.
 */
export function useItemIngredients(open: boolean, itemId: string | undefined, enabled: boolean) {
  const stock = useStockItems(open && enabled);
  const [lines, setLines] = useState<Line[]>([]);
  const [loaded, setLoaded] = useState("[]");
  const [variantRecipes, setVariantRecipes] = useState(0);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !enabled) return;
    setLoadError(null);
    setVariantRecipes(0);
    if (!itemId) {
      setLines([]);
      setLoaded("[]");
      return;
    }
    let cancelled = false;
    setLoading(true);
    api
      .get<RecipeRow[]>("/inventory/recipes", { query: { menuItemId: itemId } })
      .then((rows) => {
        if (cancelled) return;
        const mine = rows.filter((r) => r.menuItemId === itemId);
        const next = mine
          .filter((r) => r.variantId === null)
          .map((r) => ({ key: lineKey(), itemId: r.inventoryItemId, qty: String(r.quantity), unit: r.item.unit, inactiveName: r.item.active ? undefined : r.item.name }));
        setLines(next);
        setLoaded(snapshot(next));
        setVariantRecipes(new Set(mine.filter((r) => r.variantId).map((r) => r.variantId)).size);
      })
      .catch((e) => !cancelled && setLoadError(errorMessage(e)))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [open, enabled, itemId]);

  const dirty = enabled && !loadError && snapshot(lines) !== loaded;

  /** Error message for the form, or null when the lines are fine. */
  const validate = (): string | null => {
    if (!dirty) return null;
    const filled = lines.filter((l) => l.itemId || l.qty);
    for (const [idx, l] of filled.entries()) {
      if (!l.itemId) return `Ingredient ${idx + 1}: choose a stock item`;
      if (l.inactiveName) return `${l.inactiveName} is inactive — remove it from the ingredients`;
      const q = parseQty(l.qty);
      if (q == null || q <= 0) return `Ingredient ${idx + 1}: enter the quantity used per item`;
    }
    return null;
  };

  /** Save when changed. Returns true when something was saved. */
  const save = async (menuItemId: string): Promise<boolean> => {
    if (!dirty) return false;
    const filled = lines.filter((l) => l.itemId);
    const body = recipeUpsertSchema.parse({
      variantId: null,
      lines: filled.map((l) => ({ inventoryItemId: l.itemId, quantity: parseQty(l.qty)!, unit: l.unit })),
    });
    await api.put(`/inventory/recipes/${menuItemId}`, { ...body, variantId: null });
    return true;
  };

  return { stock, lines, setLines, loading, loadError, variantRecipes, dirty, validate, save };
}

export type ItemIngredientsState = ReturnType<typeof useItemIngredients>;

export function ItemIngredients({ state }: { state: ItemIngredientsState }) {
  const { stock, lines, setLines, loading, loadError, variantRecipes } = state;
  const items = useMemo(() => stock.data?.items ?? [], [stock.data]);
  const byId = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);
  const update = (key: string, patch: Partial<Line>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const used = new Set(lines.map((l) => l.itemId).filter(Boolean));

  return (
    <fieldset className="space-y-2 border-t border-line pt-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <legend className="text-sm font-semibold">Ingredients used per item (auto-deducts stock on every sale)</legend>
        <Button variant="ghost" size="sm" icon={<Plus size={16} />} onClick={() => setLines((ls) => [...ls, blankLine()])} disabled={loading || !!loadError || lines.length >= 50}>
          Add
        </Button>
      </div>
      {loading || (stock.loading && !stock.data) ? (
        <p className="flex items-center gap-2 text-xs text-muted">
          <Spinner className="h-4 w-4" /> Loading ingredients…
        </p>
      ) : loadError ? (
        <p className="text-sm text-red-600">Couldn&apos;t load ingredients: {loadError}</p>
      ) : stock.error ? (
        <p className="text-sm text-red-600">Couldn&apos;t load stock items: {stock.error}</p>
      ) : items.length === 0 && lines.length === 0 ? (
        <p className="text-xs text-muted">
          No stock items yet.{" "}
          <Link href="/inventory" className="font-semibold text-primary-700 hover:underline dark:text-primary-200">
            Add them in Inventory
          </Link>{" "}
          first.
        </p>
      ) : lines.length === 0 ? (
        <p className="text-xs text-muted">None — stock isn&apos;t deducted when this item sells.</p>
      ) : (
        lines.map((l, idx) => {
          const item = byId.get(l.itemId);
          return (
            <div key={l.key} className="flex flex-wrap items-center gap-2 sm:flex-nowrap">
              <div className="min-w-0 flex-1 basis-full sm:basis-auto">
                {l.inactiveName ? (
                  <p className="flex min-h-tap items-center gap-2 text-sm font-medium">
                    {l.inactiveName} <Badge tone="danger">Inactive</Badge>
                  </p>
                ) : (
                  <ItemSelect
                    aria-label={`Ingredient ${idx + 1}`}
                    items={items}
                    value={l.itemId}
                    exclude={used}
                    onChange={(id) => update(l.key, { itemId: id, unit: byId.get(id)?.unit })}
                  />
                )}
              </div>
              <Input
                wrapperClassName="w-28"
                aria-label={`Quantity ${idx + 1}`}
                inputMode="decimal"
                placeholder="Qty"
                value={l.qty}
                onChange={(e) => update(l.key, { qty: qtyChars(e.target.value) })}
              />
              <UnitSelect aria-label={`Unit ${idx + 1}`} baseUnit={item?.unit} value={l.unit} onChange={(u) => update(l.key, { unit: u })} className="w-24" />
              <IconButton label={`Remove ingredient ${idx + 1}`} onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}>
                <Trash size={20} />
              </IconButton>
            </div>
          );
        })
      )}
      <p className="text-xs text-muted">
        {variantRecipes > 0 && (
          <>{variantRecipes === 1 ? "1 size has its own recipe, which is" : `${variantRecipes} sizes have their own recipes, which are`} used instead of this list. </>
        )}
        Different amounts per size?{" "}
        <Link href="/inventory/recipes" className="inline-flex items-center gap-0.5 font-semibold text-primary-700 hover:underline dark:text-primary-200">
          Set them in Inventory → Recipes <ArrowRight size={12} />
        </Link>
      </p>
    </fieldset>
  );
}
