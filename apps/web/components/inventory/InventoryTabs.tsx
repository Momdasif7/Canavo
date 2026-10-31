"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import clsx from "clsx";
import { useSession } from "@/components/providers/SessionProvider";

const TABS = [
  { href: "/inventory", label: "Stock" },
  { href: "/inventory/purchases", label: "Purchases" },
  { href: "/inventory/vendors", label: "Vendors" },
  { href: "/inventory/recipes", label: "Recipes" },
  { href: "/inventory/audits", label: "Audits" },
  { href: "/inventory/transfers", label: "Transfers" },
  { href: "/inventory/reports", label: "Reports", permission: "inventory:manage" as const },
];

/** In-page sub navigation shared by every inventory screen. */
export function InventoryTabs() {
  const pathname = usePathname();
  const { can } = useSession();
  const active = TABS.filter((t) => pathname === t.href || pathname.startsWith(`${t.href}/`)).sort((a, b) => b.href.length - a.href.length)[0];
  return (
    <nav aria-label="Inventory sections" className="-mx-4 mb-5 overflow-x-auto px-4 md:-mx-6 md:px-6">
      <div className="inline-flex min-w-full gap-1 border-b border-line">
        {TABS.filter((t) => !t.permission || can(t.permission)).map((t) => {
          const on = active?.href === t.href;
          return (
            <Link
              key={t.href}
              href={t.href}
              aria-current={on ? "page" : undefined}
              className={clsx(
                "-mb-px inline-flex min-h-tap items-center whitespace-nowrap border-b-2 px-4 text-sm font-semibold transition-colors",
                on ? "border-primary text-primary-700 dark:text-primary-200" : "border-transparent text-muted hover:text-fg",
              )}
            >
              {t.label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
