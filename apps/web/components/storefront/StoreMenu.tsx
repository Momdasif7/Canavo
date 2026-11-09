"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import { CaretRight, ForkKnife, MagnifyingGlass, Minus, Moon, Plus, SealPercent, ShoppingCartSimple, Storefront, Sun, X } from "@phosphor-icons/react";
import { formatINR, primaryCssVars } from "@canavo/shared";
import { mediaUrl } from "@/lib/media";
import type { CartLine, PublicBrand, PublicMenu, PublicMenuItem } from "@/lib/storefront";
import { useTheme } from "@/components/providers/ThemeProvider";
import { Button, IconButton } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { FoodMark } from "@/components/ui/FoodMark";

/**
 * Customer storefront (online ordering page /o/<slug> and the QR table page /t/<token>):
 * Swiggy / Zomato-style hero, sticky search + veg filter + category tabs that follow the scroll,
 * item cards with the ADD button over the photo, a customisation sheet and a floating cart bar.
 */

/** The business brand colour as the page accent (wins over the signed-in user's own accent cache). */
export function BrandStyle({ accent }: { accent?: string | null }) {
  const css = useMemo(() => {
    if (!accent || !/^#[0-9a-f]{6}$/i.test(accent)) return null;
    const decl = (vars: Record<string, string>) =>
      Object.entries(vars)
        .map(([k, v]) => `${k}:${v} !important`)
        .join(";");
    // The default accent has a separate dark-theme scale (bright orange + dark text).
    return `html:root{${decl(primaryCssVars(accent, "light"))}}html.dark:root:not(.cinema){${decl(primaryCssVars(accent, "dark"))}}`;
  }, [accent]);
  return css ? <style data-brand-accent>{css}</style> : null;
}

function ThemeToggle({ className }: { className?: string }) {
  const { theme, toggle } = useTheme();
  return (
    <IconButton label={theme === "dark" ? "Light mode" : "Dark mode"} onClick={toggle} className={className}>
      {theme === "dark" ? <Sun size={20} /> : <Moon size={20} />}
    </IconButton>
  );
}

function Logo({ brand, size = 56 }: { brand: PublicBrand; size?: number }) {
  return brand.logoUrl ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={mediaUrl(brand.logoUrl)} alt="" className="shrink-0 rounded-2xl border border-line bg-surface object-cover shadow-sm" style={{ width: size, height: size }} />
  ) : (
    <span className="flex shrink-0 items-center justify-center rounded-2xl bg-primary text-primary-fg shadow-sm" style={{ width: size, height: size }} aria-hidden>
      <Storefront size={size * 0.5} weight="fill" />
    </span>
  );
}

/** Compact outlet header (order status page). */
export function StoreHeader({ brand, subtitle }: { brand: PublicBrand; subtitle?: React.ReactNode }) {
  return (
    <header className="border-b border-line bg-surface">
      <div className="mx-auto flex max-w-3xl items-center gap-3 px-4 py-3">
        <Logo brand={brand} size={44} />
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-lg font-bold text-fg">{brand.name}</h1>
          {subtitle ? <div className="truncate text-sm text-muted">{subtitle}</div> : brand.address && <p className="truncate text-sm text-muted">{brand.address}</p>}
        </div>
        <ThemeToggle />
      </div>
    </header>
  );
}

/**
 * Restaurant hero: logo, name, address, open / closed status pill; `children` holds the order-type
 * toggle and the ETA / fee chips, `offers` the offers strip.
 */
export function StoreHero({
  brand,
  open,
  status,
  tagline,
  offers,
  children,
}: {
  brand: PublicBrand;
  open: boolean;
  status: React.ReactNode;
  tagline?: React.ReactNode;
  offers?: { id: string; name: string; summary: string }[];
  children?: React.ReactNode;
}) {
  return (
    <header className="relative">
      <div className="absolute inset-x-0 top-0 h-28 bg-gradient-to-br from-primary-600 via-primary to-primary-200 sm:h-32" aria-hidden />
      <div className="relative mx-auto max-w-6xl px-4 pt-3">
        <div className="flex justify-end">
          <ThemeToggle className="rounded-full bg-black/15 text-white hover:bg-black/25" />
        </div>
        <div className="mt-2 rounded-3xl border border-line bg-surface p-4 shadow-lg shadow-black/5 sm:p-5">
          <div className="flex items-start gap-3 sm:gap-4">
            <Logo brand={brand} size={64} />
            <div className="min-w-0 flex-1">
              <h1 className="text-xl font-extrabold leading-tight tracking-tight text-fg sm:text-2xl">{brand.name}</h1>
              {tagline && <p className="mt-0.5 line-clamp-2 text-sm text-muted">{tagline}</p>}
              <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                <span
                  className={clsx(
                    "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-bold",
                    open ? "bg-secondary-50 text-secondary-700 dark:bg-green-500/15 dark:text-green-300" : "bg-red-50 text-red-700 dark:bg-red-500/15 dark:text-red-300",
                  )}
                  data-testid="store-status"
                >
                  <span className={clsx("h-1.5 w-1.5 rounded-full", open ? "bg-secondary-500 dark:bg-green-400" : "bg-red-500")} aria-hidden />
                  {open ? "Open now" : "Closed"}
                </span>
                <span className="text-muted">{status}</span>
              </p>
            </div>
          </div>
          {children && <div className="mt-4 space-y-3">{children}</div>}
        </div>
        {offers && offers.length > 0 && (
          <div className="-mx-4 mt-3 flex snap-x gap-2.5 overflow-x-auto px-4 pb-1 [scrollbar-width:none]" aria-label="Offers">
            {offers.map((o) => (
              <div key={o.id} className="flex min-w-[240px] max-w-[300px] snap-start items-center gap-3 rounded-2xl border border-primary/25 bg-primary-50 px-3 py-2.5 dark:bg-primary/10">
                <SealPercent size={28} weight="fill" className="shrink-0 text-primary" />
                <div className="min-w-0">
                  <p className="truncate text-sm font-extrabold text-fg">{o.name}</p>
                  <p className="line-clamp-2 text-xs text-muted">{o.summary}</p>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </header>
  );
}

/** Small info chip in the hero (ETA, fee, minimum order). */
export function InfoChip({ icon, children }: { icon?: React.ReactNode; children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-surface-2 px-3 py-1.5 text-xs font-semibold text-fg">
      {icon}
      {children}
    </span>
  );
}

/** Loading placeholder shaped like the page. */
export function MenuSkeleton() {
  const bar = "animate-pulse rounded-lg bg-surface-2";
  return (
    <div className="min-h-screen" role="status" aria-label="Opening the menu">
      <div className="h-28 bg-gradient-to-br from-primary-600 via-primary to-primary-200 opacity-70" />
      <div className="mx-auto -mt-16 max-w-6xl px-4">
        <div className="rounded-3xl border border-line bg-surface p-5">
          <div className="flex gap-4">
            <div className={clsx(bar, "h-16 w-16 rounded-2xl")} />
            <div className="flex-1 space-y-2">
              <div className={clsx(bar, "h-6 w-2/3")} />
              <div className={clsx(bar, "h-4 w-1/2")} />
              <div className={clsx(bar, "h-4 w-1/3")} />
            </div>
          </div>
          <div className={clsx(bar, "mt-4 h-11 w-full rounded-xl")} />
        </div>
        <div className={clsx(bar, "mt-4 h-11 w-full rounded-xl")} />
        <div className="mt-3 flex gap-2">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className={clsx(bar, "h-9 w-24 rounded-full")} />
          ))}
        </div>
        {[0, 1, 2].map((i) => (
          <div key={i} className="flex gap-4 border-b border-line py-6">
            <div className="flex-1 space-y-2">
              <div className={clsx(bar, "h-4 w-4")} />
              <div className={clsx(bar, "h-5 w-1/2")} />
              <div className={clsx(bar, "h-4 w-1/4")} />
              <div className={clsx(bar, "h-4 w-3/4")} />
            </div>
            <div className={clsx(bar, "h-28 w-32 rounded-2xl")} />
          </div>
        ))}
      </div>
      <span className="sr-only">Opening the menu…</span>
    </div>
  );
}

const lineKey = (l: Pick<CartLine, "menuItemId" | "variantId" | "addonIds">) => [l.menuItemId, l.variantId ?? "", ...[...l.addonIds].sort()].join("|");

/** Cart kept in this browser (per page), so a refresh doesn't lose it. */
export function useCart(storageKey: string) {
  const [lines, setLines] = useState<CartLine[]>([]);
  useEffect(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      if (raw) setLines(JSON.parse(raw) as CartLine[]);
    } catch {
      /* ignore */
    }
  }, [storageKey]);
  const save = useCallback(
    (next: CartLine[]) => {
      setLines(next);
      try {
        if (next.length) localStorage.setItem(storageKey, JSON.stringify(next));
        else localStorage.removeItem(storageKey);
      } catch {
        /* ignore */
      }
    },
    [storageKey],
  );
  const add = (line: Omit<CartLine, "key">) => {
    const key = lineKey(line);
    const found = lines.find((l) => l.key === key);
    save(found ? lines.map((l) => (l.key === key ? { ...l, quantity: Math.min(20, l.quantity + line.quantity) } : l)) : [...lines, { ...line, key }]);
  };
  const setQty = (key: string, qty: number) => save(qty <= 0 ? lines.filter((l) => l.key !== key) : lines.map((l) => (l.key === key ? { ...l, quantity: Math.min(20, qty) } : l)));
  const setNotes = (key: string, notes: string) => save(lines.map((l) => (l.key === key ? { ...l, notes } : l)));
  const clear = () => save([]);
  /** Drop lines whose item left the menu or ran out. */
  const prune = (menu: PublicMenu) => {
    const ok = new Set(menu.items.filter((i) => i.available).map((i) => i.id));
    if (lines.some((l) => !ok.has(l.menuItemId))) save(lines.filter((l) => ok.has(l.menuItemId)));
  };
  const count = lines.reduce((n, l) => n + l.quantity, 0);
  const total = lines.reduce((s, l) => s + l.unitPrice * l.quantity, 0);
  return { lines, add, setQty, setNotes, clear, prune, count, total };
}
export type Cart = ReturnType<typeof useCart>;

/** − qty + stepper (`onPlus` replaces the + action, e.g. to open the customisation sheet). */
export function QtyStepper({ value, onChange, label, onPlus, size = "md" }: { value: number; onChange: (v: number) => void; label: string; onPlus?: () => void; size?: "sm" | "md" }) {
  return (
    <div className={clsx("inline-flex items-center justify-between rounded-xl border border-primary/40 bg-surface font-extrabold text-primary shadow-sm", size === "sm" ? "h-9 w-[92px]" : "h-10 w-[104px]")}>
      <button type="button" aria-label={`One less ${label}`} onClick={() => onChange(value - 1)} className="flex h-full w-8 items-center justify-center rounded-l-xl hover:bg-primary/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary">
        <Minus size={16} weight="bold" />
      </button>
      <span className="min-w-[2ch] text-center tabular-nums" aria-live="polite">
        {value}
      </span>
      <button
        type="button"
        aria-label={`One more ${label}`}
        onClick={() => (onPlus ? onPlus() : onChange(value + 1))}
        disabled={value >= 20}
        className="flex h-full w-8 items-center justify-center rounded-r-xl hover:bg-primary/10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary disabled:opacity-40"
      >
        <Plus size={16} weight="bold" />
      </button>
    </div>
  );
}

const fromPrice = (i: PublicMenuItem) => (i.variants.length ? Math.min(...i.variants.map((v) => v.price)) : i.price);

/** Digital menu: sticky search + veg filter + category tabs, item cards; ordering adds to the cart. */
export function StoreMenu({
  menu,
  brand,
  cart,
  canOrder,
  closedLabel = "Not taking orders",
}: {
  menu: PublicMenu;
  brand: PublicBrand;
  cart: Cart;
  canOrder: boolean;
  closedLabel?: string;
}) {
  const [query, setQuery] = useState("");
  const [vegOnly, setVegOnly] = useState(false);
  const [picking, setPicking] = useState<PublicMenuItem | null>(null);
  const [active, setActive] = useState<string | null>(null);
  const navRef = useRef<HTMLElement>(null);
  const best = useMemo(() => new Set(menu.bestsellers ?? []), [menu.bestsellers]);
  const q = query.trim().toLowerCase();
  const visible = useMemo(
    () => menu.items.filter((i) => (!vegOnly || i.foodType === "VEG") && (!q || i.name.toLowerCase().includes(q) || i.description.toLowerCase().includes(q))),
    [menu.items, q, vegOnly],
  );
  const groups = useMemo(() => {
    const out = menu.categories.map((c) => ({ id: c.id, name: c.name, items: visible.filter((i) => i.categoryId === c.id) })).filter((g) => g.items.length > 0);
    // Bestsellers first (like the apps' "Recommended"), when there's no search.
    const picks = !q ? visible.filter((i) => best.has(i.id) && i.available) : [];
    return picks.length >= 2 ? [{ id: "recommended", name: "Recommended", items: picks }, ...out] : out;
  }, [menu.categories, visible, best, q]);

  // The tab of the section at the top follows the scroll: the last section whose heading passed under the sticky bar.
  useEffect(() => {
    const ids = groups.map((g) => g.id);
    if (!ids.length) return;
    let frame = 0;
    const update = () => {
      frame = 0;
      let current = ids[0];
      for (const id of ids) {
        const el = document.getElementById(`cat-${id}`);
        if (el && el.getBoundingClientRect().top <= 180) current = id;
      }
      setActive(current);
    };
    const onScroll = () => {
      if (!frame) frame = window.requestAnimationFrame(update);
    };
    update();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [groups]);
  useEffect(() => {
    if (!active || !navRef.current) return;
    const nav = navRef.current;
    const tab = nav.querySelector<HTMLElement>(`[data-cat="${active}"]`);
    if (tab) nav.scrollTo({ left: tab.offsetLeft - nav.clientWidth / 2 + tab.clientWidth / 2, behavior: "smooth" });
  }, [active]);

  const qtyOf = (id: string) => cart.lines.filter((l) => l.menuItemId === id).reduce((n, l) => n + l.quantity, 0);
  const customisable = (i: PublicMenuItem) => i.variants.length > 0 || i.addons.length > 0;
  const onAdd = (i: PublicMenuItem) => {
    if (customisable(i)) setPicking(i);
    else cart.add({ menuItemId: i.id, addonIds: [], quantity: 1, name: i.name, unitPrice: i.price });
  };
  /** − on a card: the most recently added line of that item. */
  const onLess = (i: PublicMenuItem) => {
    const line = [...cart.lines].reverse().find((l) => l.menuItemId === i.id);
    if (line) cart.setQty(line.key, line.quantity - 1);
  };
  const jump = (id: string) => {
    const el = document.getElementById(`cat-${id}`);
    if (!el) return;
    setActive(id);
    window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - 128, behavior: "smooth" });
  };

  return (
    <div>
      <div className="sticky top-0 z-20 -mx-4 border-b border-line bg-bg/95 px-4 backdrop-blur supports-[backdrop-filter]:bg-bg/85">
        <div className="space-y-2 py-2">
          <div className="flex items-center gap-2">
            <label className="relative flex-1">
              <span className="sr-only">Search the menu</span>
              <MagnifyingGlass size={18} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-muted" />
              <input
                type="search"
                placeholder="Search for dishes"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="min-h-[44px] w-full rounded-xl border border-line bg-surface pl-10 pr-9 text-[15px] text-fg shadow-sm placeholder:text-muted/70 focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/30 [&::-webkit-search-cancel-button]:hidden"
              />
              {query && (
                <button type="button" aria-label="Clear search" onClick={() => setQuery("")} className="absolute right-2 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-full text-muted hover:bg-surface-2">
                  <X size={16} />
                </button>
              )}
            </label>
            <button
              type="button"
              role="switch"
              aria-checked={vegOnly}
              onClick={() => setVegOnly((v) => !v)}
              className={clsx(
                "inline-flex min-h-[44px] shrink-0 items-center gap-2 rounded-xl border px-3 text-sm font-bold shadow-sm transition-colors",
                vegOnly ? "border-veg bg-green-50 text-veg dark:bg-green-500/15" : "border-line bg-surface text-fg",
              )}
            >
              <FoodMark type="VEG" size={14} />
              <span className="hidden min-[360px]:inline">Veg only</span>
              <span className={clsx("relative h-4 w-7 rounded-full transition-colors", vegOnly ? "bg-veg" : "bg-line")} aria-hidden>
                <span className={clsx("absolute top-0.5 h-3 w-3 rounded-full bg-white shadow transition-all", vegOnly ? "left-3.5" : "left-0.5")} />
              </span>
            </button>
          </div>
          {groups.length > 1 && (
            <nav ref={navRef} aria-label="Menu categories" className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-0.5 [scrollbar-width:none]">
              {groups.map((g) => (
                <button
                  key={g.id}
                  type="button"
                  data-cat={g.id}
                  aria-current={active === g.id ? "true" : undefined}
                  onClick={() => jump(g.id)}
                  className={clsx(
                    "shrink-0 rounded-full border px-3.5 py-1.5 text-sm font-semibold transition-colors",
                    active === g.id ? "border-primary bg-primary text-primary-fg shadow-sm" : "border-line bg-surface text-fg hover:border-primary/60",
                  )}
                >
                  {g.name}
                  <span className={clsx("ml-1.5 text-xs", active === g.id ? "text-primary-fg/80" : "text-muted")}>{g.items.length}</span>
                </button>
              ))}
            </nav>
          )}
        </div>
      </div>

      <div className="pb-32 lg:pb-12">
        {brand.gstEnabled && <p className="pt-3 text-xs text-muted">{brand.pricesIncludeTax ? "Prices include GST." : "Prices are before GST; tax is added to the bill."}</p>}
        {groups.length === 0 && (
          <div className="flex flex-col items-center py-16 text-center">
            <span className="flex h-16 w-16 items-center justify-center rounded-full bg-surface-2 text-muted">
              <ForkKnife size={30} />
            </span>
            <p className="mt-3 font-bold text-fg">{q || vegOnly ? "No dishes match" : "The menu is empty right now"}</p>
            {(q || vegOnly) && (
              <button
                type="button"
                className="mt-2 text-sm font-semibold text-primary"
                onClick={() => {
                  setQuery("");
                  setVegOnly(false);
                }}
              >
                Clear filters
              </button>
            )}
          </div>
        )}
        {groups.map((g) => (
          <section key={g.id} id={`cat-${g.id}`} aria-labelledby={`cat-h-${g.id}`} className="scroll-mt-36 pt-6">
            <h2 id={`cat-h-${g.id}`} className="flex items-baseline gap-2 text-lg font-extrabold tracking-tight text-fg">
              {g.name}
              <span className="text-sm font-semibold text-muted">({g.items.length})</span>
            </h2>
            <ul className="divide-y divide-dashed divide-line">
              {g.items.map((i) => (
                <ItemCard
                  key={i.id}
                  item={i}
                  bestseller={best.has(i.id)}
                  qty={qtyOf(i.id)}
                  canOrder={canOrder}
                  closedLabel={closedLabel}
                  onAdd={() => onAdd(i)}
                  onLess={() => onLess(i)}
                />
              ))}
            </ul>
          </section>
        ))}
      </div>

      <ItemOptions item={picking} onClose={() => setPicking(null)} onAdd={(line) => cart.add(line)} />
    </div>
  );
}

function ItemCard({
  item: i,
  bestseller,
  qty,
  canOrder,
  closedLabel,
  onAdd,
  onLess,
}: {
  item: PublicMenuItem;
  bestseller: boolean;
  qty: number;
  canOrder: boolean;
  closedLabel: string;
  onAdd: () => void;
  onLess: () => void;
}) {
  const [more, setMore] = useState(false);
  const custom = i.variants.length > 0 || i.addons.length > 0;
  const longDesc = i.description.length > 90;
  const action = !i.available ? (
    <span className="inline-flex h-10 w-[104px] items-center justify-center rounded-xl border border-line bg-surface-2 text-xs font-bold uppercase text-muted">Sold out</span>
  ) : !canOrder ? null : qty > 0 ? (
    <QtyStepper value={qty} label={i.name} onChange={() => onLess()} onPlus={onAdd} />
  ) : (
    <button
      type="button"
      onClick={onAdd}
      aria-label={`Add ${i.name}`}
      className="h-10 w-[104px] rounded-xl border border-primary/40 bg-surface text-[15px] font-extrabold uppercase tracking-wide text-primary shadow-md shadow-black/5 transition hover:bg-primary-50 active:scale-95 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary dark:hover:bg-primary/10"
    >
      Add
    </button>
  );
  return (
    <li className="flex gap-4 py-5" data-testid="menu-item">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <FoodMark type={i.foodType} size={15} />
          {bestseller && (
            <span className="inline-flex items-center gap-1 rounded-md bg-amber-100 px-1.5 py-0.5 text-[11px] font-extrabold uppercase tracking-wide text-amber-800 dark:bg-amber-500/20 dark:text-amber-200">★ Bestseller</span>
          )}
        </div>
        <h3 className="mt-1 text-base font-bold leading-snug text-fg">{i.name}</h3>
        <p className="mt-0.5 font-bold tabular-nums text-fg">
          {i.variants.length ? <span className="mr-1 text-xs font-semibold text-muted">from</span> : null}
          {formatINR(fromPrice(i))}
        </p>
        {i.description && <p className={clsx("mt-1.5 text-sm leading-relaxed text-muted", !more && "line-clamp-2")}>{i.description}</p>}
        {longDesc && (
          <button type="button" onClick={() => setMore((m) => !m)} className="mt-0.5 text-sm font-semibold text-fg underline-offset-2 hover:underline" aria-expanded={more}>
            {more ? "less" : "more"}
          </button>
        )}
        {!i.available && i.unavailableReason && <p className="mt-1.5 text-sm font-semibold text-red-600 dark:text-red-400">{i.unavailableReason}</p>}
      </div>
      <div className="relative flex w-[128px] shrink-0 flex-col items-center sm:w-[156px]">
        {i.imageUrl ? (
          <>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={mediaUrl(i.imageUrl)} alt="" loading="lazy" className={clsx("h-[118px] w-full rounded-2xl object-cover shadow-sm sm:h-[140px]", !i.available && "grayscale")} />
            {action && <div className="relative z-10 -mt-5">{action}</div>}
          </>
        ) : (
          action && <div className="mt-6">{action}</div>
        )}
        {custom && i.available && canOrder && <p className="mt-1 text-[11px] font-medium text-muted">Customisable</p>}
        {!canOrder && i.available && <p className="mt-2 text-center text-[11px] font-medium text-muted">{closedLabel}</p>}
      </div>
    </li>
  );
}

/** Size and add-on picker (bottom sheet on phones). */
function ItemOptions({ item, onClose, onAdd }: { item: PublicMenuItem | null; onClose: () => void; onAdd: (l: Omit<CartLine, "key">) => void }) {
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
    onAdd({
      menuItemId: item.id,
      variantId: variant?.id,
      addonIds,
      quantity: qty,
      name: [item.name, variant && `(${variant.name})`, addons.length ? `+ ${addons.map((a) => a.name).join(", ")}` : null].filter(Boolean).join(" "),
      unitPrice: unit,
    });
    onClose();
  };
  return (
    <Dialog
      open
      onClose={onClose}
      title={
        <span className="flex items-center gap-2">
          <FoodMark type={item.foodType} size={15} />
          {item.name}
        </span>
      }
      description={item.description ? <span className="line-clamp-2">{item.description}</span> : undefined}
      footer={
        <div className="flex w-full items-center gap-3">
          <QtyStepper value={qty} label={item.name} onChange={(v) => setQty(Math.max(1, v))} />
          <Button className="flex-1" size="lg" onClick={add} disabled={item.variants.length > 0 && !variant}>
            Add item · {formatINR(unit * qty)}
          </Button>
        </div>
      }
    >
      {item.imageUrl && (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={mediaUrl(item.imageUrl)} alt="" className="mb-4 h-40 w-full rounded-2xl object-cover" />
      )}
      {item.variants.length > 0 && (
        <fieldset className="mb-4 rounded-2xl border border-line p-3">
          <legend className="px-1 text-sm font-extrabold text-fg">
            Size <span className="ml-1 rounded bg-surface-2 px-1.5 py-0.5 text-[11px] font-bold uppercase text-muted">Required · pick 1</span>
          </legend>
          <div className="divide-y divide-line">
            {item.variants.map((v) => (
              <label key={v.id} className={clsx("flex min-h-tap cursor-pointer items-center justify-between gap-3", !v.available && "cursor-not-allowed opacity-50")}>
                <span className="flex items-center gap-2.5">
                  <FoodMark type={item.foodType} size={12} />
                  {v.name}
                  {!v.available && <span className="text-xs font-semibold text-red-600">Out of stock</span>}
                </span>
                <span className="flex items-center gap-3">
                  <span className="font-semibold tabular-nums">{formatINR(v.price)}</span>
                  <input type="radio" name="size" checked={variantId === v.id} disabled={!v.available} onChange={() => setVariantId(v.id)} className="h-5 w-5 accent-primary" />
                </span>
              </label>
            ))}
          </div>
        </fieldset>
      )}
      {item.addons.length > 0 && (
        <fieldset className="rounded-2xl border border-line p-3">
          <legend className="px-1 text-sm font-extrabold text-fg">
            Add-ons <span className="ml-1 rounded bg-surface-2 px-1.5 py-0.5 text-[11px] font-bold uppercase text-muted">Optional</span>
          </legend>
          <div className="divide-y divide-line">
            {item.addons.map((a) => (
              <label key={a.id} className="flex min-h-tap cursor-pointer items-center justify-between gap-3">
                <span>{a.name}</span>
                <span className="flex items-center gap-3">
                  <span className="font-semibold tabular-nums">+{formatINR(a.price)}</span>
                  <input
                    type="checkbox"
                    checked={addonIds.includes(a.id)}
                    onChange={(e) => setAddonIds((ids) => (e.target.checked ? [...ids, a.id] : ids.filter((x) => x !== a.id)))}
                    className="h-5 w-5 accent-primary"
                  />
                </span>
              </label>
            ))}
          </div>
        </fieldset>
      )}
    </Dialog>
  );
}

/** Floating cart bar on phones: "N items | ₹total — View cart". */
export function CartBar({ cart, onOpen, label = "View cart", className }: { cart: Cart; onOpen: () => void; label?: string; className?: string }) {
  if (!cart.count) return null;
  return (
    <div className={clsx("fixed inset-x-0 bottom-0 z-30 px-3 lg:hidden", className)} style={{ paddingBottom: "max(0.75rem, env(safe-area-inset-bottom))" }}>
      <button
        type="button"
        onClick={onOpen}
        data-testid="cart-bar"
        className="mx-auto flex min-h-[56px] w-full max-w-xl animate-pop-in items-center justify-between rounded-2xl bg-primary px-4 text-primary-fg shadow-xl shadow-primary/30 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary"
      >
        <span className="text-left leading-tight">
          <span className="block text-xs font-bold uppercase tracking-wide opacity-90">
            {cart.count} item{cart.count === 1 ? "" : "s"} added
          </span>
          <span className="block text-lg font-extrabold tabular-nums">{formatINR(cart.total)}</span>
        </span>
        <span className="flex items-center gap-1 text-base font-extrabold">
          {label} <CaretRight size={18} weight="bold" />
        </span>
      </button>
    </div>
  );
}

/** Cart lines with quantity steppers and per-item notes. */
export function CartLines({ cart, menu, notes = true }: { cart: Cart; menu?: PublicMenu; notes?: boolean }) {
  const typeOf = (id: string) => menu?.items.find((i) => i.id === id)?.foodType;
  return (
    <ul className="divide-y divide-line">
      {cart.lines.map((l) => {
        const ft = typeOf(l.menuItemId);
        return (
          <li key={l.key} className="py-3">
            <div className="flex items-start gap-3">
              {ft && <FoodMark type={ft} size={13} className="mt-1" />}
              <div className="min-w-0 flex-1">
                <p className="font-semibold leading-snug text-fg">{l.name}</p>
                <p className="text-xs tabular-nums text-muted">{formatINR(l.unitPrice)} each</p>
              </div>
              <QtyStepper size="sm" value={l.quantity} label={l.name} onChange={(v) => cart.setQty(l.key, v)} />
              <span className="w-16 shrink-0 text-right font-semibold tabular-nums text-fg">{formatINR(l.unitPrice * l.quantity)}</span>
            </div>
            {notes && (
              <input
                aria-label={`Note for ${l.name}`}
                placeholder="Add cooking note (optional)"
                maxLength={120}
                value={l.notes ?? ""}
                onChange={(e) => cart.setNotes(l.key, e.target.value)}
                className="ml-6 mt-2 w-[calc(100%-1.5rem)] rounded-lg border border-dashed border-line bg-transparent px-3 py-1.5 text-sm text-fg placeholder:text-muted/70 focus:border-primary focus:outline-none"
              />
            )}
          </li>
        );
      })}
    </ul>
  );
}

export interface BillRow {
  label: React.ReactNode;
  /** null = worked out when the order is placed */
  amount: number | null;
  hint?: string;
  tone?: "discount";
}

/** Bill details: item total, taxes, packaging, delivery fee, offers and the (estimated) amount to pay. */
export function BillDetails({ rows, total, note }: { rows: BillRow[]; total: number; note?: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-line bg-surface p-4" aria-label="Bill details" data-testid="bill-details">
      <h3 className="mb-2 text-xs font-extrabold uppercase tracking-wider text-muted">Bill details</h3>
      <dl className="space-y-1.5 text-sm">
        {rows.map((r, n) => (
          <div key={n} className={clsx("flex justify-between gap-3", r.tone === "discount" ? "text-secondary dark:text-green-300" : "text-fg")}>
            <dt>
              {r.label}
              {r.hint && <span className="block text-xs text-muted">{r.hint}</span>}
            </dt>
            <dd className="shrink-0 tabular-nums">{r.amount === null ? <span className="text-muted">at checkout</span> : r.tone === "discount" ? `−${formatINR(r.amount)}` : formatINR(r.amount)}</dd>
          </div>
        ))}
        <div className="mt-2 flex justify-between gap-3 border-t border-dashed border-line pt-2 text-base font-extrabold text-fg">
          <dt>To pay</dt>
          <dd className="tabular-nums">{formatINR(total)}</dd>
        </div>
      </dl>
      {note && <p className="mt-2 text-xs text-muted">{note}</p>}
    </section>
  );
}

/** Empty cart state (cart sheet and the desktop cart column). */
export function EmptyCart({ onBrowse }: { onBrowse?: () => void }) {
  return (
    <div className="flex flex-col items-center py-8 text-center">
      <span className="flex h-16 w-16 items-center justify-center rounded-full bg-primary-50 text-primary dark:bg-primary/10">
        <ShoppingCartSimple size={30} />
      </span>
      <p className="mt-3 font-bold text-fg">Your cart is empty</p>
      <p className="text-sm text-muted">Add dishes from the menu to get started.</p>
      {onBrowse && (
        <Button variant="outline" className="mt-3" onClick={onBrowse}>
          Browse the menu
        </Button>
      )}
    </div>
  );
}
