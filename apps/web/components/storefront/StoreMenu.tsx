"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import clsx from "clsx";
import { MagnifyingGlass, Minus, Moon, Plus, Storefront, Sun } from "@phosphor-icons/react";
import { formatINR } from "@canavo/shared";
import { mediaUrl } from "@/lib/media";
import type { CartLine, PublicBrand, PublicMenu, PublicMenuItem } from "@/lib/storefront";
import { useTheme } from "@/components/providers/ThemeProvider";
import { Button, IconButton } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { FoodMark } from "@/components/ui/FoodMark";
import { Input } from "@/components/ui/Input";

/** Outlet branding at the top of a customer page. */
export function StoreHeader({ brand, subtitle }: { brand: PublicBrand; subtitle?: React.ReactNode }) {
  const { theme, toggle } = useTheme();
  return (
    <header className="border-b border-line bg-surface">
      <div className="mx-auto flex max-w-3xl items-center gap-3 px-4 py-3">
        {brand.logoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={mediaUrl(brand.logoUrl)} alt="" className="h-12 w-12 shrink-0 rounded-xl border border-line object-cover" />
        ) : (
          <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <Storefront size={26} />
          </span>
        )}
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-lg font-bold text-fg">{brand.name}</h1>
          {subtitle ? <div className="truncate text-sm text-muted">{subtitle}</div> : brand.address && <p className="truncate text-sm text-muted">{brand.address}</p>}
        </div>
        <IconButton label={theme === "dark" ? "Light mode" : "Dark mode"} onClick={toggle}>
          {theme === "dark" ? <Sun size={22} /> : <Moon size={22} />}
        </IconButton>
      </div>
    </header>
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

export function QtyStepper({ value, onChange, label }: { value: number; onChange: (v: number) => void; label: string }) {
  return (
    <div className="inline-flex items-center rounded-xl border border-primary/40 bg-primary/5">
      <IconButton label={`One less ${label}`} onClick={() => onChange(value - 1)} className="text-primary">
        <Minus size={18} weight="bold" />
      </IconButton>
      <span className="min-w-[2ch] text-center font-bold tabular-nums text-fg" aria-live="polite">
        {value}
      </span>
      <IconButton label={`One more ${label}`} onClick={() => onChange(value + 1)} disabled={value >= 20} className="text-primary">
        <Plus size={18} weight="bold" />
      </IconButton>
    </div>
  );
}

/** Digital menu: category chips, search, item cards; ordering adds to the cart. */
export function StoreMenu({ menu, brand, cart, canOrder }: { menu: PublicMenu; brand: PublicBrand; cart: Cart; canOrder: boolean }) {
  const [query, setQuery] = useState("");
  const [picking, setPicking] = useState<PublicMenuItem | null>(null);
  const q = query.trim().toLowerCase();
  const visible = useMemo(() => (q ? menu.items.filter((i) => i.name.toLowerCase().includes(q) || i.description.toLowerCase().includes(q)) : menu.items), [menu.items, q]);
  const groups = useMemo(
    () => menu.categories.map((c) => ({ ...c, items: visible.filter((i) => i.categoryId === c.id) })).filter((g) => g.items.length > 0),
    [menu.categories, visible],
  );
  const qtyOf = (id: string) => cart.lines.filter((l) => l.menuItemId === id).reduce((n, l) => n + l.quantity, 0);
  const simpleLine = (i: PublicMenuItem) => cart.lines.find((l) => l.menuItemId === i.id && !l.variantId && l.addonIds.length === 0);

  const onAdd = (i: PublicMenuItem) => {
    if (i.variants.length || i.addons.length) setPicking(i);
    else cart.add({ menuItemId: i.id, addonIds: [], quantity: 1, name: i.name, unitPrice: i.price });
  };

  return (
    <div>
      <div className="sticky top-0 z-20 border-b border-line bg-bg/95 backdrop-blur">
        <div className="mx-auto max-w-3xl space-y-2 px-4 py-2">
          <Input
            aria-label="Search the menu"
            placeholder="Search dishes"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            prefix={<MagnifyingGlass size={18} />}
          />
          {groups.length > 1 && (
            <nav aria-label="Menu categories" className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1">
              {groups.map((g) => (
                <a key={g.id} href={`#cat-${g.id}`} className="shrink-0 rounded-full border border-line bg-surface px-3 py-1.5 text-sm font-semibold text-fg hover:border-primary">
                  {g.name}
                </a>
              ))}
            </nav>
          )}
        </div>
      </div>

      <div className="mx-auto max-w-3xl px-4 pb-32 pt-2">
        {brand.gstEnabled && <p className="py-2 text-xs text-muted">{brand.pricesIncludeTax ? "Prices include GST." : "Prices are before GST; tax is added to the bill."}</p>}
        {groups.length === 0 && <p className="py-12 text-center text-muted">{q ? "Nothing matches your search." : "The menu is empty right now."}</p>}
        {groups.map((g) => (
          <section key={g.id} id={`cat-${g.id}`} className="scroll-mt-32 pt-4">
            <h2 className="mb-2 text-base font-bold text-fg">{g.name}</h2>
            <ul className="divide-y divide-line rounded-2xl border border-line bg-surface">
              {g.items.map((i) => {
                const qty = qtyOf(i.id);
                const simple = simpleLine(i);
                return (
                  <li key={i.id} className={clsx("flex gap-3 p-3", !i.available && "opacity-55")}>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <FoodMark type={i.foodType} />
                        <h3 className="font-semibold text-fg">{i.name}</h3>
                      </div>
                      <p className="mt-0.5 font-bold text-fg">
                        {i.variants.length ? `from ${formatINR(Math.min(...i.variants.map((v) => v.price)))}` : formatINR(i.price)}
                      </p>
                      {i.description && <p className="mt-1 line-clamp-2 text-sm text-muted">{i.description}</p>}
                      {!i.available && <p className="mt-1 text-sm font-semibold text-red-600 dark:text-red-400">{i.unavailableReason ?? "Not available"}</p>}
                    </div>
                    <div className="flex w-28 shrink-0 flex-col items-center gap-2">
                      {i.imageUrl && (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={mediaUrl(i.imageUrl)} alt="" loading="lazy" className="h-24 w-28 rounded-xl object-cover" />
                      )}
                      {canOrder && i.available && (
                        simple && !i.variants.length && !i.addons.length ? (
                          <QtyStepper value={simple.quantity} label={i.name} onChange={(v) => cart.setQty(simple.key, v)} />
                        ) : (
                          <Button size="sm" variant="outline" className="w-full border-primary/50 text-primary" onClick={() => onAdd(i)} aria-label={`Add ${i.name}`}>
                            {qty ? `Add more (${qty})` : "Add"}
                          </Button>
                        )
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </div>

      <ItemOptions item={picking} onClose={() => setPicking(null)} onAdd={(line) => cart.add(line)} />
    </div>
  );
}

/** Size and add-on picker. */
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
      title={item.name}
      footer={
        <div className="flex w-full items-center justify-between gap-3">
          <QtyStepper value={qty} label={item.name} onChange={(v) => setQty(Math.max(1, v))} />
          <Button onClick={add} disabled={item.variants.length > 0 && !variant}>
            Add · {formatINR(unit * qty)}
          </Button>
        </div>
      }
    >
      {item.variants.length > 0 && (
        <fieldset className="mb-4">
          <legend className="mb-2 text-sm font-bold text-fg">Size</legend>
          <div className="space-y-2">
            {item.variants.map((v) => (
              <label key={v.id} className={clsx("flex min-h-tap items-center justify-between gap-3 rounded-xl border px-3", variantId === v.id ? "border-primary bg-primary/5" : "border-line", !v.available && "opacity-50")}>
                <span className="flex items-center gap-2">
                  <input type="radio" name="size" checked={variantId === v.id} disabled={!v.available} onChange={() => setVariantId(v.id)} className="h-4 w-4 accent-primary" />
                  {v.name}
                  {!v.available && <span className="text-xs text-red-600">Out of stock</span>}
                </span>
                <span className="font-semibold">{formatINR(v.price)}</span>
              </label>
            ))}
          </div>
        </fieldset>
      )}
      {item.addons.length > 0 && (
        <fieldset>
          <legend className="mb-2 text-sm font-bold text-fg">Add-ons</legend>
          <div className="space-y-2">
            {item.addons.map((a) => (
              <label key={a.id} className={clsx("flex min-h-tap items-center justify-between gap-3 rounded-xl border px-3", addonIds.includes(a.id) ? "border-primary bg-primary/5" : "border-line")}>
                <span className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={addonIds.includes(a.id)}
                    onChange={(e) => setAddonIds((ids) => (e.target.checked ? [...ids, a.id] : ids.filter((x) => x !== a.id)))}
                    className="h-4 w-4 accent-primary"
                  />
                  {a.name}
                </span>
                <span className="font-semibold">+{formatINR(a.price)}</span>
              </label>
            ))}
          </div>
        </fieldset>
      )}
    </Dialog>
  );
}

/** Sticky bottom bar: cart summary → open the cart. */
export function CartBar({ cart, onOpen, label = "View cart" }: { cart: Cart; onOpen: () => void; label?: string }) {
  if (!cart.count) return null;
  return (
    <div className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-surface/95 p-3 backdrop-blur" style={{ paddingBottom: "max(0.75rem, env(safe-area-inset-bottom))" }}>
      <div className="mx-auto max-w-3xl">
        <Button block size="lg" onClick={onOpen}>
          <span className="flex w-full items-center justify-between">
            <span>
              {cart.count} item{cart.count === 1 ? "" : "s"} · {formatINR(cart.total)}
            </span>
            <span>{label} →</span>
          </span>
        </Button>
      </div>
    </div>
  );
}

/** Cart lines with quantity steppers and per-item notes. */
export function CartLines({ cart }: { cart: Cart }) {
  return (
    <ul className="divide-y divide-line">
      {cart.lines.map((l) => (
        <li key={l.key} className="py-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="font-semibold text-fg">{l.name}</p>
              <p className="text-sm text-muted">{formatINR(l.unitPrice * l.quantity)}</p>
            </div>
            <QtyStepper value={l.quantity} label={l.name} onChange={(v) => cart.setQty(l.key, v)} />
          </div>
          <input
            aria-label={`Note for ${l.name}`}
            placeholder="Note for the kitchen (optional)"
            maxLength={120}
            value={l.notes ?? ""}
            onChange={(e) => cart.setNotes(l.key, e.target.value)}
            className="mt-2 w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-fg placeholder:text-muted/70 focus:border-primary focus:outline-none"
          />
        </li>
      ))}
    </ul>
  );
}
