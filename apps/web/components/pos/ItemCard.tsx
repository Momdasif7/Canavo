"use client";

import { memo, useState } from "react";
import clsx from "clsx";
import { Clock, Plus } from "@phosphor-icons/react";
import { formatINR } from "@canavo/shared";
import { mediaUrl } from "@/lib/media";
import type { MenuItem } from "@/lib/types";
import { FoodMark } from "@/components/ui/FoodMark";
import { stockOutNote } from "./cart";

export const ItemCard = memo(function ItemCard({
  item,
  inCart,
  outsideWindow,
  onSelect,
  showImage = true,
}: {
  item: MenuItem;
  inCart: number;
  outsideWindow: boolean;
  onSelect: (item: MenuItem) => void;
  /** Outlet setting `posShowImages`: off = text-only cards */
  showImage?: boolean;
}) {
  const [broken, setBroken] = useState(false);
  const photo = showImage && !broken ? mediaUrl(item.imageUrl) : "";
  const outOfStock = item.status !== "AVAILABLE";
  /** "Pav buns ran out" when an ingredient ran out (automatic, comes back when restocked) */
  const stockNote = outOfStock ? stockOutNote(item) : null;
  const disabled = outOfStock || outsideWindow;
  const hasOptions = item.variants.length > 0 || item.addons.length > 0;
  const fromPrice = item.variants.length ? Math.min(...item.variants.map((v) => v.price)) : item.price;

  return (
    <button
      type="button"
      onClick={() => onSelect(item)}
      disabled={disabled}
      title={outOfStock ? `${item.name} — out of stock${stockNote ? ` (${stockNote})` : ""}` : undefined}
      aria-label={outOfStock ? `${item.name}, out of stock${stockNote ? `, ${stockNote}` : ""}` : undefined}
      data-testid="item-card"
      className={clsx(
        "group relative flex min-h-[108px] w-full min-w-0 flex-col overflow-hidden rounded-2xl border bg-surface p-3 text-left shadow-sm transition",
        "focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary active:scale-[0.98]",
        inCart ? "border-primary ring-1 ring-primary" : "border-line hover:border-primary/60",
        disabled && "cursor-not-allowed opacity-45 grayscale active:scale-100",
      )}
    >
      {photo && (
        // Fixed aspect so the grid doesn't jump while photos load; only cards with a photo get the band.
        <div className="-mx-3 -mt-3 mb-2 aspect-[16/9] overflow-hidden rounded-t-2xl bg-surface-2">
          {/* eslint-disable-next-line @next/next/no-img-element -- arbitrary upload/CDN hosts */}
          <img src={photo} alt="" loading="lazy" decoding="async" draggable={false} className="h-full w-full object-cover" onError={() => setBroken(true)} />
        </div>
      )}
      <div className={clsx("flex min-w-0 items-start gap-2", inCart > 0 && !photo && "pr-6")}>
        <FoodMark type={item.foodType} className="mt-0.5 shrink-0" />
        <span className="line-clamp-2 min-w-0 flex-1 break-words text-[15px] font-semibold leading-snug text-fg">{item.name}</span>
      </div>
      {/* Price on its own line; the status pill wraps below it when the card is narrow */}
      <div className="mt-auto flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 pt-2">
        <span className="tabular whitespace-nowrap text-base font-extrabold text-fg">
          {item.variants.length > 1 && <span className="mr-0.5 text-xs font-medium text-muted">from </span>}
          {formatINR(fromPrice)}
        </span>
        {outOfStock ? (
          <span className="whitespace-nowrap rounded-full bg-red-100 px-2 py-0.5 text-[10px] font-bold uppercase leading-4 tracking-wide text-red-700 dark:bg-red-500/20 dark:text-red-200" data-testid="item-badge">
            Out of stock
          </span>
        ) : outsideWindow ? (
          <span
            className="tabular inline-flex items-center gap-0.5 whitespace-nowrap rounded-full bg-surface-2 px-1.5 py-0.5 text-[10px] font-semibold leading-4 text-muted"
            title={`Served ${item.availableFrom}–${item.availableTo}`}
            data-testid="item-badge"
          >
            <Clock size={11} className="shrink-0" /> {item.availableFrom}–{item.availableTo}
          </span>
        ) : hasOptions ? (
          <span className="whitespace-nowrap rounded-full bg-primary-50 px-2 py-0.5 text-[10px] font-bold uppercase leading-4 tracking-wide text-primary dark:bg-primary/15" data-testid="item-badge">
            Options
          </span>
        ) : (
          <Plus size={18} className="ml-auto shrink-0 text-muted group-hover:text-primary" />
        )}
      </div>
      {stockNote && (
        <span className="mt-1 line-clamp-2 break-words text-[11px] font-medium leading-tight text-red-700 dark:text-red-300" data-testid="item-stock-note">
          {stockNote}
        </span>
      )}
      {inCart > 0 && (
        <span className="absolute right-1.5 top-1.5 flex h-6 min-w-6 items-center justify-center rounded-full bg-primary px-1.5 text-xs font-bold text-white shadow">
          {inCart}
        </span>
      )}
    </button>
  );
});
