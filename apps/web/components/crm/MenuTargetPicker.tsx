"use client";

import { useId, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import { FolderSimple, MagnifyingGlass, Plus, X } from "@phosphor-icons/react";
import { formatINR, type OfferTarget } from "@canavo/shared";
import { fuzzyFilter } from "@/lib/fuzzy";
import type { Menu } from "@/lib/types";
import { Field } from "@/components/ui/Input";
import { FoodMark } from "@/components/ui/FoodMark";

type Option = { kind: "item" | "category"; id: string; name: string; sub: string };

/**
 * Pick menu items and/or categories for an offer target. Selected entries show
 * as removable chips; empty selection means "all items" (unless `single`).
 */
export function MenuTargetPicker({
  label,
  value,
  onChange,
  menu,
  itemsOnly,
  emptyHint = "No selection — applies to all items",
  error,
}: {
  label: string;
  value: OfferTarget;
  onChange: (v: OfferTarget) => void;
  menu: Menu | undefined;
  /** Hide categories (e.g. combo rows) */
  itemsOnly?: boolean;
  emptyHint?: string;
  error?: string;
}) {
  const id = useId();
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const blurTimer = useRef<number>();

  const catName = useMemo(() => new Map((menu?.categories ?? []).map((c) => [c.id, c.name])), [menu]);
  const itemById = useMemo(() => new Map((menu?.items ?? []).map((i) => [i.id, i])), [menu]);
  const itemIds = value.menuItemIds ?? [];
  const categoryIds = value.categoryIds ?? [];

  const options = useMemo<Option[]>(() => {
    if (!menu) return [];
    const cats: Option[] = itemsOnly
      ? []
      : menu.categories.map((c) => ({
          kind: "category",
          id: c.id,
          name: c.name,
          sub: c.parentId ? `Sub-category of ${catName.get(c.parentId) ?? "—"}` : "Category · includes sub-categories",
        }));
    const items: Option[] = menu.items.map((i) => ({ kind: "item", id: i.id, name: i.name, sub: `${catName.get(i.categoryId) ?? ""} · ${formatINR(i.price)}` }));
    const all = [...cats, ...items].filter((o) => !(o.kind === "item" ? itemIds : categoryIds).includes(o.id));
    return fuzzyFilter(all, query, (o) => o.name).slice(0, 30);
  }, [menu, itemsOnly, catName, query, itemIds, categoryIds]);

  const add = (o: Option) => {
    if (o.kind === "item") onChange({ ...value, menuItemIds: [...itemIds, o.id] });
    else onChange({ ...value, categoryIds: [...categoryIds, o.id] });
    setQuery("");
  };
  const remove = (kind: Option["kind"], rid: string) => {
    if (kind === "item") onChange({ ...value, menuItemIds: itemIds.filter((x) => x !== rid) });
    else onChange({ ...value, categoryIds: categoryIds.filter((x) => x !== rid) });
  };

  const empty = !itemIds.length && !categoryIds.length;

  return (
    <Field label={label} htmlFor={id} error={error} hint={empty ? emptyHint : undefined}>
      {!empty && (
        <div className="flex flex-wrap gap-1.5">
          {categoryIds.map((cid) => (
            <Chip key={cid} label={catName.get(cid) ?? "Unknown category"} icon={<FolderSimple size={14} weight="fill" />} onRemove={() => remove("category", cid)} tone="category" />
          ))}
          {itemIds.map((iid) => {
            const it = itemById.get(iid);
            return <Chip key={iid} label={it?.name ?? "Unknown item"} icon={it && <FoodMark type={it.foodType} size={12} />} onRemove={() => remove("item", iid)} />;
          })}
        </div>
      )}
      <div
        className="relative"
        onBlur={() => {
          blurTimer.current = window.setTimeout(() => setOpen(false), 120);
        }}
        onFocus={() => window.clearTimeout(blurTimer.current)}
      >
        <MagnifyingGlass size={18} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-muted" />
        <input
          id={id}
          type="search"
          role="combobox"
          aria-expanded={open}
          aria-controls={`${id}-list`}
          autoComplete="off"
          placeholder={menu ? (itemsOnly ? "Search menu items" : "Search items or categories") : "Loading menu…"}
          disabled={!menu}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              if (options[0]) add(options[0]);
            } else if (e.key === "Escape" && open) {
              e.stopPropagation();
              setOpen(false);
            }
          }}
          className="min-h-tap w-full rounded-xl border border-line bg-surface pl-10 pr-3.5 text-[15px] text-fg placeholder:text-muted/70 focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/30 disabled:opacity-60"
        />
        {open && menu && (
          <ul
            id={`${id}-list`}
            role="listbox"
            className="absolute left-0 right-0 top-full z-20 mt-1 max-h-64 overflow-y-auto rounded-xl border border-line bg-surface py-1 shadow-xl"
          >
            {options.length === 0 ? (
              <li className="px-4 py-3 text-sm text-muted">No matches</li>
            ) : (
              options.map((o) => (
                <li key={`${o.kind}:${o.id}`} role="option" aria-selected={false}>
                  <button
                    type="button"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => add(o)}
                    className="flex min-h-tap w-full items-center gap-3 px-4 py-1.5 text-left hover:bg-surface-2 focus:bg-surface-2 focus:outline-none"
                  >
                    {o.kind === "category" ? (
                      <FolderSimple size={18} weight="duotone" className="shrink-0 text-secondary dark:text-green-300" />
                    ) : (
                      itemById.get(o.id) && <FoodMark type={itemById.get(o.id)!.foodType} />
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-semibold">{o.name}</span>
                      <span className="block truncate text-xs text-muted">{o.sub}</span>
                    </span>
                    <Plus size={16} className="shrink-0 text-muted" />
                  </button>
                </li>
              ))
            )}
          </ul>
        )}
      </div>
    </Field>
  );
}

function Chip({ label, icon, onRemove, tone }: { label: string; icon?: React.ReactNode; onRemove: () => void; tone?: "category" }) {
  return (
    <span
      className={clsx(
        "inline-flex items-center gap-1.5 rounded-full border py-0.5 pl-2.5 pr-0.5 text-sm font-medium",
        tone === "category"
          ? "border-secondary-100 bg-secondary-50 text-secondary-700 dark:border-secondary/40 dark:bg-secondary/25 dark:text-green-200"
          : "border-line bg-surface-2 text-fg",
      )}
    >
      {icon}
      {label}
      <button type="button" aria-label={`Remove ${label}`} onClick={onRemove} className="inline-flex h-8 w-8 items-center justify-center rounded-full hover:bg-black/10 dark:hover:bg-white/10">
        <X size={14} weight="bold" />
      </button>
    </span>
  );
}
