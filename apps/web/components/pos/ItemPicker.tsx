"use client";

import { useEffect, useState } from "react";
import clsx from "clsx";
import { Check, Minus, Plus } from "@phosphor-icons/react";
import { formatINR } from "@canavo/shared";
import type { MenuItem } from "@/lib/types";
import { Dialog } from "@/components/ui/Dialog";
import { Button, IconButton } from "@/components/ui/Button";
import { FoodMark } from "@/components/ui/FoodMark";
import { makeLine, stockOutNote, variantUnavailable, type CartLine } from "./cart";

/** Quick picker for items with sizes (variants) and/or add-ons. */
export function ItemPicker({ item, onClose, onAdd }: { item: MenuItem | null; onClose: () => void; onAdd: (line: CartLine) => void }) {
  const [variantId, setVariantId] = useState<string | undefined>();
  const [addonIds, setAddonIds] = useState<string[]>([]);
  const [qty, setQty] = useState(1);

  useEffect(() => {
    // First size that is still in stock (others may have run out).
    setVariantId((item?.variants.find((v) => !variantUnavailable(item, v.id)) ?? item?.variants[0])?.id);
    setAddonIds([]);
    setQty(1);
  }, [item]);

  if (!item) return null;
  const line = makeLine(item, variantId, addonIds);
  const itemOut = item.status !== "AVAILABLE";
  const sizeOut = variantUnavailable(item, variantId);
  const blocked = itemOut || sizeOut;
  const toggleAddon = (id: string) => setAddonIds((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]));
  const add = () => {
    if (blocked) return;
    onAdd({ ...line, quantity: qty });
    onClose();
  };

  return (
    <Dialog
      open
      onClose={onClose}
      size="sm"
      title={
        <span className="flex items-center gap-2">
          <FoodMark type={item.foodType} /> {item.name}
        </span>
      }
      description={item.description || undefined}
      footer={
        <div className="flex w-full items-center gap-3">
          <div className="flex items-center rounded-xl border border-line">
            <IconButton label="Decrease" onClick={() => setQty((q) => Math.max(1, q - 1))}>
              <Minus size={18} />
            </IconButton>
            <span className="tabular w-8 text-center text-lg font-bold">{qty}</span>
            <IconButton label="Increase" onClick={() => setQty((q) => Math.min(999, q + 1))}>
              <Plus size={18} />
            </IconButton>
          </div>
          <Button className="flex-1" size="lg" onClick={add} disabled={blocked} data-autofocus>
            {blocked ? "Out of stock" : <>Add · <span className="tabular">{formatINR(line.unitPrice * qty)}</span></>}
          </Button>
        </div>
      }
    >
      {itemOut && (
        <p className="mb-4 rounded-xl bg-red-50 px-3 py-2 text-sm font-medium text-red-700 dark:bg-red-500/15 dark:text-red-200" role="alert">
          Out of stock{stockOutNote(item) ? ` — ${stockOutNote(item)}` : ""}
        </p>
      )}
      {item.variants.length > 0 && (
        <fieldset className="mb-4">
          <legend className="mb-2 text-sm font-bold uppercase tracking-wide text-muted">Size</legend>
          <div className="grid grid-cols-2 gap-2">
            {item.variants.map((v) => {
              const out = variantUnavailable(item, v.id);
              return (
                <button
                  key={v.id}
                  type="button"
                  onClick={() => setVariantId(v.id)}
                  disabled={out}
                  aria-pressed={variantId === v.id}
                  title={out ? `${v.name} is out of stock` : undefined}
                  className={clsx(
                    "flex min-h-[56px] flex-col items-start justify-center rounded-xl border px-3 text-left",
                    out
                      ? "cursor-not-allowed border-line opacity-50"
                      : variantId === v.id
                        ? "border-primary bg-primary-50 ring-1 ring-primary dark:bg-primary/15"
                        : "border-line hover:border-primary/60",
                  )}
                >
                  <span className="font-semibold">{v.name}</span>
                  {out ? (
                    <span className="text-xs font-bold uppercase tracking-wide text-red-700 dark:text-red-300">Out of stock</span>
                  ) : (
                    <span className="tabular text-sm font-bold">{formatINR(v.price)}</span>
                  )}
                </button>
              );
            })}
          </div>
        </fieldset>
      )}
      {item.addons.length > 0 && (
        <fieldset>
          <legend className="mb-2 text-sm font-bold uppercase tracking-wide text-muted">Add-ons</legend>
          <div className="space-y-2">
            {item.addons.map((a) => {
              const on = addonIds.includes(a.id);
              return (
                <button
                  key={a.id}
                  type="button"
                  onClick={() => toggleAddon(a.id)}
                  aria-pressed={on}
                  className={clsx(
                    "flex min-h-tap w-full items-center gap-3 rounded-xl border px-3",
                    on ? "border-primary bg-primary-50 dark:bg-primary/15" : "border-line hover:border-primary/60",
                  )}
                >
                  <span className={clsx("flex h-6 w-6 items-center justify-center rounded-md border-2", on ? "border-primary bg-primary text-primary-fg" : "border-line")}>
                    {on && <Check size={14} weight="bold" />}
                  </span>
                  <span className="flex-1 text-left font-medium">{a.name}</span>
                  <span className="tabular text-sm font-bold">{a.price ? `+${formatINR(a.price)}` : "Free"}</span>
                </button>
              );
            })}
          </div>
        </fieldset>
      )}
    </Dialog>
  );
}
