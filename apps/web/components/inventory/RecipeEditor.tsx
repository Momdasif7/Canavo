"use client";

import { useEffect, useMemo, useState } from "react";
import { MagnifyingGlass, Plus, Trash } from "@phosphor-icons/react";
import clsx from "clsx";
import { formatINR, recipeUpsertSchema, type RecipeUpsertInput } from "@canavo/shared";
import { api, errorMessage } from "@/lib/api";
import { fuzzyFilter } from "@/lib/fuzzy";
import type { Menu } from "@/lib/types";
import type { RecipeRow, RecipeSaveResult, StockUnit } from "@/lib/types-inventory";
import { useApiQuery } from "@/hooks/useApiQuery";
import { useSession } from "@/components/providers/SessionProvider";
import { useToast } from "@/components/providers/ToastProvider";
import { Card } from "@/components/ui/Card";
import { Button, IconButton } from "@/components/ui/Button";
import { Input, Select } from "@/components/ui/Input";
import { Badge } from "@/components/ui/Badge";
import { Alert, EmptyState, ErrorState, LoadingState } from "@/components/ui/States";
import { ItemSelect, UnitSelect, lineKey, useStockItems } from "./common";
import { UNIT_LABELS, convertQty, formatQty, parseQty, qtyChars } from "./units";

export interface RecipeSelection {
  menuItemId: string;
  /** null = default recipe (all variants without their own) */
  variantId: string | null;
}

interface Line {
  key: string;
  itemId: string;
  qty: string;
  unit: StockUnit | undefined;
  /** Name for items no longer in the active list (inactive) */
  fallbackName?: string;
}

const snapshot = (lines: Line[]) => JSON.stringify(lines.filter((l) => l.itemId).map((l) => [l.itemId, l.qty, l.unit]));

export function RecipeEditor({
  selection,
  onSelect,
  onSaved,
}: {
  selection: RecipeSelection | null;
  onSelect: (s: RecipeSelection | null) => void;
  onSaved: () => void;
}) {
  const { outletId, can } = useSession();
  const toast = useToast();
  const manage = can("inventory:manage");
  // Selling price and food cost % are profit data (owner / manager only).
  const showProfit = can("report:view");
  const menu = useApiQuery<Menu>(outletId ? `menu-recipes:${outletId}` : null, () => api.get<Menu>("/menu"));
  const stock = useStockItems();
  const allRecipes = useApiQuery<RecipeRow[]>(outletId ? `inv-recipes-all:${outletId}` : null, () => api.get<RecipeRow[]>("/inventory/recipes"));
  const [search, setSearch] = useState("");

  const items = useMemo(() => stock.data?.items ?? [], [stock.data]);
  const byId = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);
  const withRecipe = useMemo(() => new Set((allRecipes.data ?? []).map((r) => r.menuItemId)), [allRecipes.data]);
  const menuItems = useMemo(() => fuzzyFilter(menu.data?.items ?? [], search, (i) => i.name), [menu.data, search]);
  const menuItem = menu.data?.items.find((i) => i.id === selection?.menuItemId);
  const variant = menuItem?.variants.find((v) => v.id === selection?.variantId);

  const recipeKey = selection ? `inv-recipe:${selection.menuItemId}` : null;
  const recipe = useApiQuery<RecipeRow[]>(recipeKey, () => api.get<RecipeRow[]>("/inventory/recipes", { query: { menuItemId: selection!.menuItemId } }));

  const [lines, setLines] = useState<Line[]>([]);
  const [loaded, setLoaded] = useState("[]");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const rowsFor = (variantId: string | null) => (recipe.data ?? []).filter((r) => r.menuItemId === selection?.menuItemId && r.variantId === variantId);
  const toLines = (rows: RecipeRow[]): Line[] =>
    rows.map((r) => ({ key: lineKey(), itemId: r.inventoryItemId, qty: String(r.quantity), unit: r.item.unit, fallbackName: r.item.active ? undefined : r.item.name }));

  // Load lines whenever the selection or fetched recipe changes.
  useEffect(() => {
    if (!selection || !recipe.data) return;
    const next = toLines(rowsFor(selection.variantId));
    setLines(next.length ? next : [{ key: lineKey(), itemId: "", qty: "", unit: undefined }]);
    setLoaded(snapshot(next));
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection?.menuItemId, selection?.variantId, recipe.data]);

  const dirty = snapshot(lines) !== loaded;

  const confirmLeave = () => !dirty || window.confirm("Discard unsaved recipe changes?");
  const choose = (s: RecipeSelection | null) => {
    if (s?.menuItemId === selection?.menuItemId && s?.variantId === selection?.variantId) return;
    if (confirmLeave()) onSelect(s);
  };

  const update = (key: string, patch: Partial<Line>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));

  const lineCost = (l: Line) => {
    const item = byId.get(l.itemId);
    const q = parseQty(l.qty);
    if (!item || q == null || !l.unit) return 0;
    return Math.round(convertQty(q, l.unit, item.unit) * item.costPerUnit);
  };
  const totalCost = lines.reduce((s, l) => s + lineCost(l), 0);
  const price = variant?.price ?? menuItem?.price ?? 0;
  const gst = menuItem?.gstRate ?? 0;

  const save = async () => {
    if (!selection) return;
    setError(null);
    const filled = lines.filter((l) => l.itemId || l.qty);
    for (const [idx, l] of filled.entries()) {
      if (!l.itemId) return setError(`Line ${idx + 1}: choose an ingredient`);
      if (l.fallbackName) return setError(`${l.fallbackName} is inactive — remove it from the recipe`);
      const q = parseQty(l.qty);
      if (q == null || q <= 0) return setError(`Line ${idx + 1}: enter a quantity`);
    }
    const parsed = recipeUpsertSchema.safeParse({
      variantId: selection.variantId,
      lines: filled.map((l) => ({ inventoryItemId: l.itemId, quantity: parseQty(l.qty)!, unit: l.unit })),
    });
    if (!parsed.success) return setError(parsed.error.issues[0].message);
    const body: RecipeUpsertInput = parsed.data;
    setSaving(true);
    try {
      const res = await api.put<RecipeSaveResult>(`/inventory/recipes/${selection.menuItemId}`, body);
      toast(filled.length ? `Recipe saved · cost ${formatINR(res.cost)}` : "Recipe removed", "success");
      await Promise.all([recipe.reload(), allRecipes.reload()]);
      onSaved();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  if (menu.loading && !menu.data) return <LoadingState />;
  if (menu.error && !menu.data) return <ErrorState message={menu.error} onRetry={menu.reload} />;

  const usesDefault = !!selection?.variantId && rowsFor(selection.variantId).length === 0 && rowsFor(null).length > 0;

  return (
    <div className="grid gap-4 lg:grid-cols-[300px_1fr]">
      <Card className="flex max-h-[70vh] flex-col overflow-hidden">
        <div className="border-b border-line p-3">
          <Input
            type="search"
            aria-label="Search menu items"
            placeholder="Search menu items"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            prefix={<MagnifyingGlass size={18} />}
          />
        </div>
        <ul className="flex-1 overflow-y-auto" aria-label="Menu items">
          {menuItems.length === 0 && <li className="p-4 text-sm text-muted">No menu items found</li>}
          {menuItems.map((m) => (
            <li key={m.id}>
              <button
                type="button"
                onClick={() => choose({ menuItemId: m.id, variantId: null })}
                aria-current={selection?.menuItemId === m.id ? "true" : undefined}
                className={clsx(
                  "flex min-h-tap w-full items-center justify-between gap-2 border-b border-line px-4 py-2 text-left text-sm",
                  selection?.menuItemId === m.id ? "bg-primary-50 font-semibold text-primary-700 dark:bg-primary/15 dark:text-primary-200" : "hover:bg-surface-2",
                )}
              >
                <span className="truncate">{m.name}</span>
                {withRecipe.has(m.id) ? <Badge tone="success">Recipe</Badge> : <Badge>None</Badge>}
              </button>
            </li>
          ))}
        </ul>
      </Card>

      <Card>
        {!selection || !menuItem ? (
          <EmptyState title="Pick a menu item" description="Choose an item on the left to define the ingredients used per portion." />
        ) : (
          <div className="space-y-4 p-5">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div>
                <h2 className="text-lg font-bold">{menuItem.name}</h2>
                <p className="text-sm text-muted">
                  {showProfit ? `Price ${formatINR(price)} · GST ${gst}% · ` : ""}quantities are per portion sold
                </p>
              </div>
              {menuItem.variants.length > 0 && (
                <Select
                  label="Variant"
                  aria-label="Recipe variant"
                  value={selection.variantId ?? ""}
                  onChange={(e) => choose({ menuItemId: menuItem.id, variantId: e.target.value || null })}
                  wrapperClassName="w-full sm:w-64"
                >
                  <option value="">Default (all variants)</option>
                  {menuItem.variants.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.name}
                      {showProfit ? ` · ${formatINR(v.price)}` : ""}
                      {rowsFor(v.id).length ? " ✓" : ""}
                    </option>
                  ))}
                </Select>
              )}
            </div>

            {recipe.loading && !recipe.data ? (
              <LoadingState />
            ) : recipe.error ? (
              <ErrorState message={recipe.error} onRetry={recipe.reload} />
            ) : (
              <>
                {error && <Alert>{error}</Alert>}
                {usesDefault && (
                  <Alert tone="info">
                    This variant has no recipe of its own, so the default recipe is used when it sells.{" "}
                    {manage && (
                      <button type="button" className="font-semibold underline" onClick={() => setLines(toLines(rowsFor(null)))}>
                        Copy default lines
                      </button>
                    )}
                  </Alert>
                )}
                <div className="space-y-2">
                  {lines.map((l, idx) => {
                    const item = byId.get(l.itemId);
                    return (
                      <div key={l.key} className="grid grid-cols-12 items-center gap-2 rounded-xl border border-line p-3">
                        <div className="col-span-12 md:col-span-5">
                          {l.fallbackName ? (
                            <p className="flex min-h-tap items-center gap-2 text-sm font-medium">
                              {l.fallbackName} <Badge tone="danger">Inactive</Badge>
                            </p>
                          ) : (
                            <ItemSelect
                              aria-label={`Ingredient ${idx + 1}`}
                              items={items}
                              value={l.itemId}
                              exclude={new Set(lines.map((x) => x.itemId).filter(Boolean))}
                              onChange={(id) => update(l.key, { itemId: id, unit: byId.get(id)?.unit })}
                            />
                          )}
                        </div>
                        <Input
                          aria-label={`Ingredient quantity ${idx + 1}`}
                          placeholder="Qty"
                          inputMode="decimal"
                          disabled={!manage}
                          value={l.qty}
                          onChange={(e) => update(l.key, { qty: qtyChars(e.target.value) })}
                          wrapperClassName="col-span-4 md:col-span-2"
                        />
                        <UnitSelect aria-label={`Ingredient unit ${idx + 1}`} baseUnit={item?.unit} value={l.unit} onChange={(u) => update(l.key, { unit: u })} className="col-span-4 md:col-span-2" />
                        <div className="col-span-3 text-right text-sm md:col-span-2">
                          <p className="tabular font-semibold">{formatINR(lineCost(l))}</p>
                          {item && l.unit && l.unit !== item.unit && parseQty(l.qty) != null && (
                            <p className="tabular text-xs text-muted">
                              = {formatQty(convertQty(parseQty(l.qty)!, l.unit, item.unit))} {UNIT_LABELS[item.unit]}
                            </p>
                          )}
                        </div>
                        <div className="col-span-1 flex justify-end">
                          {manage && (
                            <IconButton label={`Remove ingredient ${idx + 1}`} onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}>
                              <Trash size={20} />
                            </IconButton>
                          )}
                        </div>
                      </div>
                    );
                  })}
                  {lines.length === 0 && <p className="rounded-xl border border-dashed border-line p-4 text-center text-sm text-muted">No ingredients — saving removes this recipe.</p>}
                </div>
                <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
                  {manage ? (
                    <Button
                      variant="outline"
                      icon={<Plus size={18} />}
                      onClick={() => setLines((ls) => [...ls, { key: lineKey(), itemId: "", qty: "", unit: undefined }])}
                      disabled={lines.length >= 50}
                    >
                      Add ingredient
                    </Button>
                  ) : (
                    <span />
                  )}
                  <div className="flex flex-wrap items-center gap-4">
                    <CostSummary cost={totalCost} price={price} gstRate={gst} showFoodCost={showProfit} />
                    {manage && (
                      <Button onClick={save} loading={saving} disabled={!dirty}>
                        Save recipe
                      </Button>
                    )}
                  </div>
                </div>
              </>
            )}
          </div>
        )}
      </Card>
    </div>
  );
}

/** Estimated cost per portion vs price. Net-of-GST assumes tax-inclusive pricing when the outlet uses it. */
function CostSummary({ cost, price, gstRate, showFoodCost }: { cost: number; price: number; gstRate: number; showFoodCost: boolean }) {
  const { outlet } = useSession();
  const net = outlet?.pricesIncludeTax === false ? price : Math.round((price * 100) / (100 + gstRate));
  const pct = net > 0 && cost > 0 ? Math.round((cost / net) * 1000) / 10 : null;
  return (
    <div className="text-right text-sm">
      <p>
        Ingredient cost <strong className="tabular text-base">{formatINR(cost)}</strong>
      </p>
      {showFoodCost && pct != null && (
        <p className="text-xs text-muted">
          <FoodCostText pct={pct} /> of {formatINR(net)} net price
        </p>
      )}
    </div>
  );
}

export function foodCostTone(pct: number | null): "success" | "warning" | "danger" | "neutral" {
  if (pct == null) return "neutral";
  return pct <= 30 ? "success" : pct <= 40 ? "warning" : "danger";
}

function FoodCostText({ pct }: { pct: number }) {
  const tone = foodCostTone(pct);
  return (
    <span
      className={clsx(
        "font-semibold",
        tone === "success" && "text-secondary dark:text-green-300",
        tone === "warning" && "text-amber-700 dark:text-amber-300",
        tone === "danger" && "text-red-600 dark:text-red-400",
      )}
    >
      {pct}% food cost
    </span>
  );
}
