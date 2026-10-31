"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import clsx from "clsx";
import type { Icon } from "@phosphor-icons/react";

export interface TabLink {
  href: string;
  label: string;
  icon?: Icon;
}

/** Horizontally scrollable sub-navigation (reports / admin sections). */
export function TabNav({ tabs, label, className = "-mx-4 mb-5 px-4 md:-mx-6 md:px-6" }: { tabs: TabLink[]; label: string; className?: string }) {
  const pathname = usePathname();
  const active = tabs
    .filter((t) => pathname === t.href || pathname.startsWith(`${t.href}/`))
    .sort((a, b) => b.href.length - a.href.length)[0]?.href;
  return (
    <nav aria-label={label} className={clsx("scrollbar-thin overflow-x-auto print:hidden", className)}>
      <ul className="flex min-w-max gap-1 border-b border-line">
        {tabs.map((t) => {
          const on = t.href === active;
          const I = t.icon;
          return (
            <li key={t.href}>
              <Link
                href={t.href}
                aria-current={on ? "page" : undefined}
                className={clsx(
                  "-mb-px flex min-h-[44px] items-center gap-2 border-b-2 px-3 text-sm font-semibold transition-colors",
                  on ? "border-primary text-primary" : "border-transparent text-muted hover:text-fg",
                )}
              >
                {I && <I size={18} weight={on ? "fill" : "regular"} />}
                {t.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
