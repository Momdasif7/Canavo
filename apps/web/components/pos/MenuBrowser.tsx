"use client";

import { useMemo, useState } from "react";
import clsx from "clsx";
import { MagnifyingGlass, X } from "@phosphor-icons/react";
import { fuzzyFilter } from "@/lib/fuzzy";
import { inServingWindow, nowMinutes } from "@/lib/dates";
import type { Menu, MenuItem } from "@/lib/types";
import { useNow } from "@/hooks/useNow";
import { useSession } from "@/components/providers/SessionProvider";
import { ItemCard } from "./ItemCard";

const ALL = "__all__";

/**
 * Search + category tabs + item grid. Shared by the POS, the "add to tab"
 * picker (tables) and reservation pre-orders.
 */
export function MenuBrowser({
  menu,
  qtyByItem,
  onSelect,
  timezone,
  searchRef,
  ignoreServingWindow = false,
  header,
  dense = false,
}: {
  menu: Menu;
  qtyByItem: Map<string, number>;
  onSelect: (item: MenuItem) => void;
  timezone?: string;
  searchRef?: React.RefObject<HTMLInputElement>;
  /** Pre-orders are for later — don't grey out items outside today's serving window */
  ignoreServingWindow?: boolean;
  /** Rendered between the category tabs and the grid (e.g. active offers) */
  header?: React.ReactNode;
  dense?: boolean;
}) {
  const { outlet } = useSession();
  // Outlet setting (default on): item photos on the cards, or fast text-only cards.
  const showImages = outlet?.posShowImages !== false;
  const [query, setQuery] = useState("");
  const [topCat, setTopCat] = useState<string>(ALL);
  const [subCat, setSubCat] = useState<string | null>(null);
  const now = useNow(60_000);
  const minutes = useMemo(() => nowMinutes(timezone), [timezone, now]); // eslint-disable-line react-hooks/exhaustive-deps

  const topCategories = useMemo(() => menu.categories.filter((c) => !c.parentId), [menu]);
  const subCategories = useMemo(() => menu.categories.filter((c) => c.parentId && c.parentId === topCat), [menu, topCat]);

  const visibleItems = useMemo(() => {
    const items = menu.items.filter((i) => i.status !== "HIDDEN");
    if (query.trim()) return fuzzyFilter(items, query, (i) => i.name);
    if (subCat) return items.filter((i) => i.categoryId === subCat);
    if (topCat === ALL) return items;
    const ids = new Set([topCat, ...subCategories.map((c) => c.id)]);
    return items.filter((i) => ids.has(i.categoryId));
  }, [menu, query, topCat, subCat, subCategories]);

  const outside = (i: MenuItem) => !ignoreServingWindow && !inServingWindow(i.availableFrom, i.availableTo, minutes);

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="space-y-2 border-b border-line bg-surface px-3 pb-2 pt-3">
        <div className="relative">
          <MagnifyingGlass size={20} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-muted" />
          <input
            ref={searchRef}
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape" && query) {
                e.stopPropagation();
                setQuery("");
              }
              if (e.key === "Enter" && visibleItems[0] && visibleItems[0].status === "AVAILABLE" && !outside(visibleItems[0])) onSelect(visibleItems[0]);
            }}
            placeholder="Search menu…  ( / )"
            aria-label="Search menu"
            className="min-h-tap w-full rounded-xl border border-line bg-surface-2 pl-11 pr-10 text-[15px] font-medium focus:border-primary focus:bg-surface focus:outline-none focus:ring-2 focus:ring-primary/30"
          />
          {query && (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => setQuery("")}
              className="absolute right-2 top-1/2 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-lg text-muted hover:bg-surface-2"
            >
              <X size={18} />
            </button>
          )}
        </div>
        <div className="scrollbar-thin -mx-3 flex gap-2 overflow-x-auto px-3 pb-1" role="tablist" aria-label="Categories">
          {[{ id: ALL, name: "All" }, ...topCategories].map((c) => (
            <CategoryTab
              key={c.id}
              active={!query && topCat === c.id}
              onClick={() => {
                setTopCat(c.id);
                setSubCat(null);
                setQuery("");
              }}
            >
              {c.name}
            </CategoryTab>
          ))}
        </div>
        {!query && subCategories.length > 0 && (
          <div className="scrollbar-thin -mx-3 flex gap-2 overflow-x-auto px-3 pb-1" aria-label="Sub-categories">
            <CategoryTab small active={!subCat} onClick={() => setSubCat(null)}>
              All {topCategories.find((t) => t.id === topCat)?.name}
            </CategoryTab>
            {subCategories.map((c) => (
              <CategoryTab small key={c.id} active={subCat === c.id} onClick={() => setSubCat(c.id)}>
                {c.name}
              </CategoryTab>
            ))}
          </div>
        )}
      </div>
      {header}
      <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto p-3">
        {visibleItems.length === 0 ? (
          <p className="py-16 text-center text-muted">{query ? `No items match “${query}”` : "No items in this category"}</p>
        ) : (
          // Columns follow the container width (the narrow "Add to table" dialog as well as the full POS).
          <div className={clsx("grid gap-3", dense ? "grid-cols-[repeat(auto-fill,minmax(140px,1fr))]" : "grid-cols-[repeat(auto-fill,minmax(150px,1fr))]")}>
            {visibleItems.map((item) => (
              <ItemCard key={item.id} item={item} inCart={qtyByItem.get(item.id) ?? 0} outsideWindow={outside(item)} onSelect={onSelect} showImage={showImages} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function CategoryTab({ active, small, onClick, children }: { active: boolean; small?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={clsx(
        "shrink-0 whitespace-nowrap rounded-xl border font-semibold transition-colors",
        small ? "min-h-[40px] px-3 text-sm" : "min-h-tap px-4",
        active ? (small ? "border-secondary bg-secondary text-white" : "border-primary bg-primary text-primary-fg") : "border-line bg-surface text-fg hover:border-primary/60",
      )}
    >
      {children}
    </button>
  );
}
