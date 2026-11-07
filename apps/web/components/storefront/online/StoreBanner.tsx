"use client";

import clsx from "clsx";
import { Moon, Moped, ShoppingBag, Storefront, Sun, Tag } from "@phosphor-icons/react";
import { formatINR } from "@canavo/shared";
import { mediaUrl } from "@/lib/media";
import type { OutletPage, PublicBrand } from "@/lib/storefront";
import { useTheme } from "@/components/providers/ThemeProvider";

/** "21:30" → "9:30 PM" */
export function clock(hhmm: string) {
  const [h, m] = hhmm.split(":").map(Number);
  const d = new Date(2000, 0, 1, h, m);
  return d.toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit" }).toUpperCase();
}

const range = (values: number[], fmt: (n: number) => string) => {
  if (!values.length) return null;
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  return lo === hi ? fmt(lo) : `${fmt(lo)}–${fmt(hi)}`;
};

/** Delivery time and fee for the banner, from the active delivery mode. */
export function deliverySummary(page: Pick<OutletPage, "delivery" | "deliveryMode" | "zones">): { eta: string | null; fee: string | null } | null {
  if (!page.delivery || !page.deliveryMode) return null;
  if (page.deliveryMode.mode === "ADDRESS") {
    const m = page.deliveryMode;
    return { eta: `${m.etaMinutes} min`, fee: m.fee ? `${formatINR(m.fee)} delivery` : "Free delivery" };
  }
  const zones = page.zones;
  if (!zones.length) return { eta: null, fee: null };
  const eta = range(zones.map((z) => z.etaMinutes), String);
  const fees = zones.map((z) => z.fee);
  const fee = Math.max(...fees) === 0 ? "Free delivery" : `${range(fees, (n) => formatINR(n))} delivery`;
  return { eta: eta ? `${eta} min` : null, fee };
}

/** Small round logo (or a storefront icon in the brand colour). */
export function StoreLogo({ brand, size = "md" }: { brand: Pick<PublicBrand, "logoUrl">; size?: "sm" | "md" }) {
  const box = size === "sm" ? "h-10 w-10" : "h-16 w-16 sm:h-20 sm:w-20";
  return brand.logoUrl ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={mediaUrl(brand.logoUrl)} alt="" width={80} height={80} className={clsx(box, "shrink-0 rounded-2xl border border-line bg-white object-cover")} />
  ) : (
    <span className={clsx(box, "flex shrink-0 items-center justify-center rounded-2xl bg-primary text-primary-fg")} aria-hidden>
      <Storefront size={size === "sm" ? 22 : 34} weight="fill" />
    </span>
  );
}

export function ThemeToggle() {
  const { theme, toggle } = useTheme();
  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={theme === "dark" ? "Light mode" : "Dark mode"}
      className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-surface/90 text-fg shadow-sm ring-1 ring-line hover:bg-surface-2"
    >
      {theme === "dark" ? <Sun size={20} /> : <Moon size={20} />}
    </button>
  );
}

/** Store banner: name, logo, info line, open / closed, delivery time and fee. */
export function StoreBanner({ page }: { page: OutletPage }) {
  const brand = page.outlet;
  const allVeg = page.items.length > 0 && page.items.every((i) => i.foodType === "VEG");
  const services = [page.takeaway && "Takeaway", page.delivery && "Delivery"].filter(Boolean).join(" · ");
  const info = [allVeg && "Pure veg", services, brand.address].filter(Boolean).join(" · ");
  const delivery = deliverySummary(page);
  const open = page.ordering;
  const closedText = page.opensAt ? `Opens ${page.opensAt.day === "tomorrow" ? "tomorrow " : ""}at ${clock(page.opensAt.at)}` : page.notice;

  return (
    <header className="relative">
      <div className="h-24 bg-gradient-to-br from-primary to-primary-700 sm:h-32" aria-hidden />
      <div className="absolute right-3 top-3">
        <ThemeToggle />
      </div>
      <div className="mx-auto max-w-6xl px-4">
        <div className="relative -mt-12 rounded-3xl border border-line bg-surface p-4 shadow-lg sm:-mt-16 sm:p-5">
          <div className="flex items-start gap-3 sm:gap-4">
            <StoreLogo brand={brand} />
            <div className="min-w-0 flex-1">
              <h1 className="text-xl font-extrabold leading-tight text-fg sm:text-2xl">{brand.name}</h1>
              {info && <p className="mt-0.5 line-clamp-2 text-sm text-muted">{info}</p>}
              <p className="mt-2 flex flex-wrap items-center gap-2 text-sm font-semibold" data-testid="store-status">
                <span
                  className={clsx(
                    "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5",
                    open ? "bg-green-100 text-green-800 dark:bg-green-500/20 dark:text-green-200" : "bg-red-100 text-red-800 dark:bg-red-500/20 dark:text-red-200",
                  )}
                >
                  <span className={clsx("h-2 w-2 rounded-full", open ? "bg-green-600" : "bg-red-600")} aria-hidden />
                  {open ? "Open now" : "Closed"}
                </span>
                {open && page.hours && <span className="text-muted">till {clock(page.hours.to)}</span>}
                {!open && closedText && <span className="text-muted">{closedText}</span>}
              </p>
            </div>
          </div>
          {(delivery || page.takeaway) && open && (
            <dl className="mt-4 grid grid-cols-2 gap-2 border-t border-dashed border-line pt-3 text-sm sm:flex sm:gap-6" data-testid="store-delivery">
              {delivery && (
                <div className="flex items-center gap-2">
                  <Moped size={20} className="shrink-0 text-primary" aria-hidden />
                  <div>
                    <dt className="sr-only">Delivery</dt>
                    <dd className="font-bold text-fg">{delivery.eta ?? "Delivery"}</dd>
                    {delivery.fee && <dd className="text-xs text-muted">{delivery.fee}</dd>}
                  </div>
                </div>
              )}
              {page.takeaway && (
                <div className="flex items-center gap-2">
                  <ShoppingBag size={20} className="shrink-0 text-primary" aria-hidden />
                  <div>
                    <dt className="sr-only">Takeaway</dt>
                    <dd className="font-bold text-fg">Takeaway</dd>
                    <dd className="text-xs text-muted">Pick up at the counter</dd>
                  </div>
                </div>
              )}
              {page.minOrder > 0 && (
                <div className="flex items-center gap-2">
                  <Tag size={20} className="shrink-0 text-primary" aria-hidden />
                  <div>
                    <dt className="sr-only">Minimum order</dt>
                    <dd className="font-bold text-fg">{formatINR(page.minOrder)}</dd>
                    <dd className="text-xs text-muted">Minimum order</dd>
                  </div>
                </div>
              )}
            </dl>
          )}
        </div>
      </div>
    </header>
  );
}
