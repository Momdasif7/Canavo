"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import { ForkKnife, MagnifyingGlass, Minus, Plus, X } from "@phosphor-icons/react";
import { formatINR } from "@canavo/shared";
import { mediaUrl } from "@/lib/media";
import type { CartLine, PublicBrand, PublicMenu, PublicMenuItem } from "@/lib/storefront";
import type { Cart } from "@/components/storefront/StoreMenu";
import { FoodMark } from "@/components/ui/FoodMark";
import { BottomSheet } from "./BottomSheet";

const MAX_QTY = 20;
const lineName = (item: PublicMenuItem, variant?: { name: string }, addons: { name: string }[] = []) =>
  [item.name, variant && `(${variant.name})`, addons.length ? `+ ${addons.map((a) => a.name).join(", ")}` : null].filter(Boolean).join(" ");

/** "− 2 +" stepper; keyboard usable (real buttons), count announced. */
export function Stepper({ value, onMinus, onPlus, label, plusDisabled, size = "md" }: { value: number; onMinus: () => void; onPlus: () => void; label: string; plusDisabled?: boolean; size?: "sm" | "md" }) {
  const btn = clsx("flex items-center justify-center text-primary hover:bg-primary/10 disabled:opacity-40", size === "sm" ? "h-8 w-8" : "h-9 w-9");
  return (
    <div className="inline-flex items-center rounded-xl border border-primary/50 bg-surface shadow-sm" data-testid="qty-stepper">
      <button type="button" className={clsx(btn, "rounded-l-xl")} aria-label={`One less ${label}`} onClick={onMinus}>
        <Minus size={16} weight="bold" />
      </button>
      <span className="min-w-[2ch] text-center font-extrabold tabular-nums text-primary" aria-live="polite" aria-label={`${value} in cart`}>
        {value}
      </span>
      <button type="button" className={clsx(btn, "rounded-r-xl")} aria-label={`One more ${label}`} onClick={onPlus} disabled={plusDisabled}>
        <Plus size={16} weight="bold" />
      </button>
    </div>
  );
}

function ItemImage({ src }: { src: string | null }) {
  const [broken, setBroken] = useState(false);
  if (!src || broken)
    return (
      <span className="flex aspect-square w-full items-center justify-center rounded-2xl bg-surface-2 text-muted" aria-hidden>
        <ForkKnife size={28} />
      </span>
    );
  return (
    // Fixed square box + explicit size: no layout shift while the photo loads.
    // eslint-disable-next-line @next/next/no-img-element
    <img src={mediaUrl(src)} alt="" width={128} height={128} loading="lazy" onError={() => setBroken(true)} className="aspect-square w-full rounded-2xl bg-surface-2 object-cover" />
  );
}

/** Online menu: search, veg-only, sticky category tabs (scroll-spy), item cards with ADD / stepper. */
export function OnlineMenu({ menu, brand, cart, canOrder }: { menu: PublicMenu; brand: PublicBrand; cart: Cart; canOrder: boolean }) {
  const [query, setQuery] = useState("");
  const [vegOnly, setVegOnly] = useState(false);
  const [picking, setPicking] = useState<PublicMenuItem | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const tabsRef = useRef<HTMLDivElement>(null);
  const q = query.trim().toLowerCase();
  const hasVeg = menu.items.some((i) => i.foodType === "VEG");
  const hasNonVeg = menu.items.some((i) => i.foodType !== "VEG");

  const visible = useMemo(
    () => menu.items.filter((i) => (!vegOnly || i.foodType === "VEG") && (!q || i.name.toLowerCase().includes(q) || i.description.toLowerCase().includes(q))),
    [menu.items, q, vegOnly],
  );
  const groups = useMemo(
    () => menu.categories.map((c) => ({ ...c, items: visible.filter((i) => i.categoryId === c.id) })).filter((g) => g.items.length > 0),
    [menu.categories, visible],
  );

  // Scroll-spy: the category section nearest the top (under the sticky bar) is the active tab.
  useEffect(() => {
    setActive((cur) => (cur && groups.some((g) => g.id === cur) ? cur : (groups[0]?.id ?? null)));
  }, [groups]);
  useEffect(() => {
    const sections = groups.map((g) => document.getElementById(`cat-${g.id}`)).filter((x): x is HTMLElement => Boolean(x));
    if (!sections.length) return;
    const seen = new Map<string, boolean>();
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) seen.set(e.target.id, e.isIntersecting);
        const first = sections.find((s) => seen.get(s.id));
        if (first) setActive(first.id.slice(4));
      },
      { rootMargin: "-150px 0px -55% 0px" },
    );
    sections.forEach((s) => io.observe(s));
    return () => io.disconnect();
  }, [groups]);
  // Keep the active tab in view in the tab strip.
  useEffect(() => {
    const el = active ? tabsRef.current?.querySelector<HTMLElement>(`[data-cat="${active}"]`) : null;
    if (el && tabsRef.current) tabsRef.current.scrollTo({ left: el.offsetLeft - 16, behavior: "smooth" });
  }, [active]);

  const linesOf = (id: string) => cart.lines.filter((l) => l.menuItemId === id);
  const customisable = (i: PublicMenuItem) => i.variants.length > 0 || i.addons.length > 0;
  const add = (i: PublicMenuItem) => {
    if (customisable(i)) setPicking(i);
    else cart.add({ menuItemId: i.id, addonIds: [], quantity: 1, name: i.name, unitPrice: i.price });
  };
  const less = (i: PublicMenuItem) => {
    const lines = linesOf(i.id);
    const last = lines[lines.length - 1];
    if (last) cart.setQty(last.key, last.quantity - 1);
  };
  const jump = (id: string) => {
    setActive(id);
    document.getElementById(`cat-${id}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <div>
      <div className="sticky top-0 z-20 -mx-4 border-b border-line bg-bg/95 px-4 backdrop-blur lg:mx-0 lg:rounded-b-2xl lg:px-0">
        <div className="flex items-center gap-2 pt-3">
          <label className="relative flex-1">
            <span className="sr-only">Search the menu</span>
            <MagnifyingGlass size={18} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" aria-hidden />
            <input
              type="search"
              placeholder="Search dishes"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              className="h-11 w-full rounded-xl border border-line bg-surface pl-10 pr-10 text-sm text-fg placeholder:text-muted focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/30"
            />
            {query && (
              <button type="button" aria-label="Clear search" onClick={() => setQuery("")} className="absolute right-1 top-1/2 flex h-9 w-9 -translate-y-1/2 items-center justify-center rounded-lg text-muted hover:text-fg">
                <X size={16} />
              </button>
            )}
          </label>
          {hasVeg && hasNonVeg && (
            <button
              type="button"
              role="switch"
              aria-checked={vegOnly}
              onClick={() => setVegOnly((v) => !v)}
              className={clsx(
                "flex h-11 shrink-0 items-center gap-2 rounded-xl border px-3 text-sm font-bold",
                vegOnly ? "border-green-600 bg-green-50 text-green-800 dark:bg-green-500/15 dark:text-green-200" : "border-line bg-surface text-fg",
              )}
            >
              <FoodMark type="VEG" size={14} />
              Veg only
            </button>
          )}
        </div>
        {groups.length > 1 ? (
          <nav aria-label="Menu categories">
            <div ref={tabsRef} className="relative [scrollbar-width:none] [&::-webkit-scrollbar]:hidden -mx-4 flex gap-1 overflow-x-auto px-4 lg:mx-0 lg:px-0">
              {groups.map((g) => (
                <button
                  key={g.id}
                  type="button"
                  data-cat={g.id}
                  aria-current={active === g.id ? "true" : undefined}
                  onClick={() => jump(g.id)}
                  className={clsx(
                    "shrink-0 whitespace-nowrap border-b-[3px] px-3 py-3 text-sm font-bold transition-colors",
                    active === g.id ? "border-primary text-primary" : "border-transparent text-muted hover:text-fg",
                  )}
                >
                  {g.name}
                  <span className="ml-1 text-xs font-semibold opacity-70">{g.items.length}</span>
                </button>
              ))}
            </div>
          </nav>
        ) : (
          <div className="h-3" />
        )}
      </div>

      {brand.gstEnabled && <p className="pt-3 text-xs text-muted">{brand.pricesIncludeTax ? "Prices include GST." : "Prices are before GST; tax is added to the bill."}</p>}
      {groups.length === 0 && (
        <p className="py-16 text-center text-muted">{q || vegOnly ? "No dishes match. Try another search or turn off Veg only." : "The menu is empty right now."}</p>
      )}

      {groups.map((g) => (
        <section key={g.id} id={`cat-${g.id}`} aria-labelledby={`cat-h-${g.id}`} className="scroll-mt-[120px] pt-5">
          <h2 id={`cat-h-${g.id}`} className="text-lg font-extrabold text-fg">
            {g.name} <span className="text-sm font-semibold text-muted">({g.items.length})</span>
          </h2>
          <ul className="mt-1 divide-y divide-dashed divide-line">
            {g.items.map((i) => {
              const qty = linesOf(i.id).reduce((n, l) => n + l.quantity, 0);
              const custom = customisable(i);
              const price = i.variants.length ? Math.min(...i.variants.map((v) => v.price)) : i.price;
              const control =
                canOrder && i.available ? (
                  qty > 0 ? (
                    <Stepper value={qty} label={i.name} onMinus={() => less(i)} onPlus={() => (custom ? setPicking(i) : add(i))} plusDisabled={!custom && qty >= MAX_QTY} />
                  ) : (
                    <button
                      type="button"
                      onClick={() => add(i)}
                      aria-label={`Add ${i.name}`}
                      className="h-9 w-24 rounded-xl border border-primary/50 bg-surface text-sm font-extrabold tracking-wide text-primary shadow-sm hover:bg-primary/10"
                    >
                      ADD
                    </button>
                  )
                ) : null;
              return (
                <li key={i.id} className="flex gap-4 py-5" data-testid="menu-item" data-food={i.foodType}>
                  <div className={clsx("min-w-0 flex-1", !i.available && "opacity-60")}>
                    <FoodMark type={i.foodType} />
                    <h3 className="mt-1 font-bold text-fg">{i.name}</h3>
                    <p className="mt-0.5 font-semibold text-fg">
                      {i.variants.length > 0 && <span className="text-sm font-normal text-muted">from </span>}
                      {formatINR(price)}
                    </p>
                    {i.description && <p className="mt-1.5 line-clamp-2 text-sm text-muted">{i.description}</p>}
                    {!i.available && <p className="mt-1.5 text-sm font-semibold text-red-700 dark:text-red-300">{i.unavailableReason ?? "Not available"}</p>}
                  </div>
                  <div className="flex w-28 shrink-0 flex-col items-center sm:w-32">
                    {i.imageUrl ? (
                      <div className={clsx("relative w-full", !i.available && "opacity-60 grayscale")}>
                        <ItemImage src={i.imageUrl} />
                        {control && <div className="absolute inset-x-0 -bottom-4 flex justify-center">{control}</div>}
                      </div>
                    ) : (
                      control && <div className="pt-6">{control}</div>
                    )}
                    {control && custom && <span className={clsx("text-[11px] text-muted", i.imageUrl ? "mt-5" : "mt-1")}>Customisable</span>}
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      ))}

      <CustomiseSheet item={picking} onClose={() => setPicking(null)} onAdd={(line) => cart.add(line)} />
    </div>
  );
}

/** Sizes and add-ons for an item, then "Add item · ₹…". */
function CustomiseSheet({ item, onClose, onAdd }: { item: PublicMenuItem | null; onClose: () => void; onAdd: (l: Omit<CartLine, "key">) => void }) {
  const [variantId, setVariantId] = useState<string | undefined>();
  const [addonIds, setAddonIds] = useState<string[]>([]);
  const [qty, setQty] = useState(1);
  useEffect(() => {
    setVariantId(item?.variants.find((v) => v.available)?.id);
    setAddonIds([]);
    setQty(1);
  }, [item]);
  if (!item) return null;
  const variant = item.variants.find((v) => v.id === variantId);
  const addons = item.addons.filter((a) => addonIds.includes(a.id));
  const unit = (variant?.price ?? item.price) + addons.reduce((s, a) => s + a.price, 0);
  const add = () => {
    onAdd({ menuItemId: item.id, variantId: variant?.id, addonIds, quantity: qty, name: lineName(item, variant, addons), unitPrice: unit });
    onClose();
  };
  const option = (on: boolean, disabled?: boolean) =>
    clsx("flex min-h-[48px] cursor-pointer items-center justify-between gap-3 rounded-xl border px-3", on ? "border-primary bg-primary/5" : "border-line", disabled && "cursor-not-allowed opacity-50");
  return (
    <BottomSheet
      open
      onClose={onClose}
      title={
        <span className="flex items-center gap-2">
          <FoodMark type={item.foodType} /> {item.name}
        </span>
      }
      footer={
        <div className="flex items-center gap-3">
          <Stepper value={qty} label={item.name} onMinus={() => setQty((n) => Math.max(1, n - 1))} onPlus={() => setQty((n) => Math.min(MAX_QTY, n + 1))} plusDisabled={qty >= MAX_QTY} />
          <button
            type="button"
            onClick={add}
            disabled={item.variants.length > 0 && !variant}
            className="flex h-12 flex-1 items-center justify-center rounded-xl bg-primary px-4 font-extrabold text-primary-fg hover:bg-primary-600 disabled:opacity-50"
            data-autofocus
          >
            Add item · {formatINR(unit * qty)}
          </button>
        </div>
      }
    >
      {item.description && <p className="mb-4 text-sm text-muted">{item.description}</p>}
      {item.variants.length > 0 && (
        <fieldset className="mb-5">
          <legend className="mb-2 font-bold text-fg">
            Size <span className="text-xs font-semibold text-muted">· choose 1</span>
          </legend>
          <div className="space-y-2">
            {item.variants.map((v) => (
              <label key={v.id} className={option(variantId === v.id, !v.available)}>
                <span className="flex items-center gap-3">
                  <input type="radio" name="size" checked={variantId === v.id} disabled={!v.available} onChange={() => setVariantId(v.id)} className="h-5 w-5 accent-primary" />
                  <span className="font-semibold text-fg">{v.name}</span>
                  {!v.available && <span className="text-xs font-semibold text-red-700 dark:text-red-300">Out of stock</span>}
                </span>
                <span className="font-semibold text-fg">{formatINR(v.price)}</span>
              </label>
            ))}
          </div>
        </fieldset>
      )}
      {item.addons.length > 0 && (
        <fieldset>
          <legend className="mb-2 font-bold text-fg">
            Add-ons <span className="text-xs font-semibold text-muted">· optional</span>
          </legend>
          <div className="space-y-2">
            {item.addons.map((a) => (
              <label key={a.id} className={option(addonIds.includes(a.id))}>
                <span className="flex items-center gap-3">
                  <input
                    type="checkbox"
                    checked={addonIds.includes(a.id)}
                    onChange={(e) => setAddonIds((ids) => (e.target.checked ? [...ids, a.id] : ids.filter((x) => x !== a.id)))}
                    className="h-5 w-5 accent-primary"
                  />
                  <span className="font-semibold text-fg">{a.name}</span>
                </span>
                <span className="font-semibold text-fg">+{formatINR(a.price)}</span>
              </label>
            ))}
          </div>
        </fieldset>
      )}
    </BottomSheet>
  );
}
