"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import clsx from "clsx";
import { ROLE_LABELS } from "@canavo/shared";
import { CaretDown, CaretLeft, List, LockSimple, Moon, ShieldCheck, ShieldStar, SignOut, Storefront, Sun } from "@phosphor-icons/react";
import { errorMessage } from "@/lib/api";
import { mediaUrl } from "@/lib/media";
import { useToast } from "@/components/providers/ToastProvider";
import { useSession } from "@/components/providers/SessionProvider";
import { useTheme } from "@/components/providers/ThemeProvider";
import { SocketProvider } from "@/components/providers/SocketProvider";
import { NotificationsProvider } from "@/components/providers/NotificationsProvider";
import { Button, IconButton } from "@/components/ui/Button";
import { EmptyState, ErrorState, LoadingState, ModuleOffState } from "@/components/ui/States";
import { Logo } from "./Logo";
import { activeNavGroup, firstAllowedRoute, isDeliveryPartner, isNavActive, navGroupsFor, navItemFor, routeAccess, type NavGroup } from "./nav";
import { TabNav } from "@/components/reports/TabNav";
import { NotificationBell } from "./NotificationBell";
import { ConnectivityPill } from "./ConnectivityPill";

const COLLAPSE_KEY = "canavo.sidebarCollapsed";

export function AppShell({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const session = useSession();
  const { status, me } = session;

  useEffect(() => {
    if (status === "anonymous") router.replace(`/login`);
  }, [status, router]);

  // The hotel requires two-step login for this role (REQUIRE_2FA): only Account → Security works until it's on.
  const mustSetUp2fa = Boolean(me?.twoFactorSetupRequired) && pathname !== "/account/security";
  useEffect(() => {
    if (mustSetUp2fa) router.replace("/account/security");
  }, [mustSetUp2fa, router]);

  if (status === "loading" || status === "anonymous" || mustSetUp2fa) return <LoadingState label="Loading your workspace…" />;
  if (status === "error" || !me) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-2">
        <ErrorState message={session.error ?? "Could not load your account"} onRetry={session.retry} />
        <Button variant="ghost" onClick={() => void session.logout()}>
          Log out
        </Button>
      </div>
    );
  }

  return (
    <SocketProvider>
      <NotificationsProvider>
        <Shell pathname={pathname}>
          <RouteGate pathname={pathname}>{children}</RouteGate>
        </Shell>
      </NotificationsProvider>
    </SocketProvider>
  );
}

/** Page guard: role, business modules and (for platform admins) platform-only screens. */
function RouteGate({ pathname, children }: { pathname: string; children: React.ReactNode }) {
  const { me, outletId, switching } = useSession();
  if (!me) return null;
  if (switching) return <LoadingState label="Switching…" />;
  const access = routeAccess(pathname, { me, outletId });
  if (access === "ok") return <>{children}</>;
  if (access === "module") return <ModuleOffState feature={navItemFor(pathname, { me, outletId })?.label} />;
  if (access === "needs-business") {
    return (
      <EmptyState
        title="Not available in the platform console"
        description="Hotel data (sales, bills, staff, customers, reports) is private to each hotel. The hotel's owner or manager can open this screen from their own login."
        action={
          <Link href="/platform" className="inline-flex min-h-tap items-center rounded-xl bg-primary px-4 font-semibold text-white hover:bg-primary-600">
            Go to the platform console
          </Link>
        }
      />
    );
  }
  return <NotAvailableState home={firstAllowedRoute({ me, outletId })} />;
}

/** Direct URL to a screen the role can't use (e.g. /bills for kitchen staff). */
function NotAvailableState({ home }: { home: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-16 text-center" role="status" data-testid="not-available">
      <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-surface-2 text-muted">
        <LockSimple size={30} weight="duotone" />
      </span>
      <p className="mt-1 font-bold text-fg">This page isn&apos;t available for your role</p>
      <p className="max-w-sm text-sm text-muted">Ask your outlet manager if you need access.</p>
      <Link href={home} className="mt-2 inline-flex min-h-tap items-center rounded-xl bg-primary px-5 font-semibold text-white hover:bg-primary-600">
        Go to my home screen
      </Link>
    </div>
  );
}

function Shell({ pathname, children }: { pathname: string; children: React.ReactNode }) {
  const toast = useToast();
  const { me, outletId, outlet, setOutlet, logout, switching } = useSession();
  const { theme, toggle } = useTheme();
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(COLLAPSE_KEY);
      setCollapsed(saved ? saved === "1" : window.innerWidth < 1280);
    } catch {
      setCollapsed(window.innerWidth < 1280);
    }
  }, []);

  useEffect(() => setMobileOpen(false), [pathname]);

  // Ctrl/⌘ + \ toggles the sidebar.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "\\") {
        e.preventDefault();
        toggleCollapsed();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const toggleCollapsed = () => {
    setCollapsed((c) => {
      try {
        localStorage.setItem(COLLAPSE_KEY, c ? "0" : "1");
      } catch {
        /* ignore */
      }
      return !c;
    });
  };

  if (!me) return null;
  const groups = navGroupsFor({ me, outletId });
  // Delivery partners mostly use a phone browser: bottom tabs instead of hunting in the drawer.
  const partnerTabs = isDeliveryPartner({ me, outletId }) ? (groups.find((g) => g.id === "partner")?.items ?? []) : [];
  const roleLabel = me.platformAdmin ? "Platform admin" : ROLE_LABELS[me.role];
  // Hotel staff see their own hotel's logo and name; the platform console keeps CANAVO's.
  // `outlet` reloads on outlet switch and after Settings saves (reloadOutlet).
  const brand: Brand =
    me.platformAdmin || !me.business
      ? { name: "CANAVO", logoUrl: null, canavo: true }
      : { name: me.business.name, logoUrl: outlet?.id === outletId ? (outlet?.logoUrl ?? null) : null, canavo: false };

  const changeOutlet = async (value: string) => {
    const next = value || null;
    try {
      await setOutlet(next);
    } catch (e) {
      toast(errorMessage(e), "error");
    }
  };

  const nav = (compact: boolean) => <SidebarNav groups={groups} pathname={pathname} compact={compact} />;

  return (
    <div className="flex h-screen overflow-hidden bg-bg print:block print:h-auto">
      {/* Desktop / tablet sidebar */}
      <aside
        className={clsx(
          "group/side relative hidden shrink-0 flex-col border-r border-line bg-surface transition-[width] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] md:flex print:hidden",
          collapsed ? "w-[76px]" : "w-60",
        )}
      >
        <div className="flex h-16 items-center gap-2.5 overflow-hidden border-b border-line px-[21px]">
          <button
            type="button"
            onClick={toggleCollapsed}
            title={collapsed ? "Expand sidebar" : undefined}
            aria-hidden
            tabIndex={-1}
            className={clsx("shrink-0 transition-transform duration-500 ease-[cubic-bezier(0.34,1.56,0.64,1)]", collapsed ? "rotate-[360deg] hover:scale-110" : "rotate-0")}
          >
            <BrandMark brand={brand} size={34} />
          </button>
          <span
            title={brand.name}
            className={clsx(
              "min-w-0 truncate whitespace-nowrap text-lg font-extrabold tracking-tight transition-all duration-300",
              collapsed ? "pointer-events-none -translate-x-3 opacity-0" : "translate-x-0 opacity-100 delay-100",
            )}
          >
            {brand.name}
          </span>
        </div>
        <SidebarToggle collapsed={collapsed} onToggle={toggleCollapsed} />
        {nav(collapsed)}
      </aside>

      {/* Phone drawer */}
      {mobileOpen && (
        <div className="fixed inset-0 z-40 md:hidden print:hidden">
          <div className="absolute inset-0 bg-black/40" onClick={() => setMobileOpen(false)} />
          <aside className="relative flex h-full w-64 animate-fade-in flex-col bg-surface">
            <div className="flex h-16 items-center gap-2.5 border-b border-line px-4">
              <BrandMark brand={brand} size={34} />
              <span className="min-w-0 truncate text-lg font-extrabold" title={brand.name}>
                {brand.name}
              </span>
            </div>
            {nav(false)}
          </aside>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-16 shrink-0 items-center gap-2 border-b border-line bg-surface px-3 md:px-5 print:hidden">
          <IconButton label="Open menu" className="md:hidden" onClick={() => setMobileOpen(true)}>
            <List size={24} />
          </IconButton>
          <OutletSwitcher value={outletId} disabled={switching} onChange={(v) => void changeOutlet(v)} />
          <div className="ml-auto flex items-center gap-1 md:gap-2">
            <ConnectivityPill />
            <NotificationBell />
            <IconButton label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"} onClick={toggle}>
              {theme === "dark" ? <Sun size={24} /> : <Moon size={24} />}
            </IconButton>
            <UserMenu name={me.name} role={roleLabel} email={me.email} photoUrl={me.photoUrl} onLogout={() => void logout()} />
          </div>
        </header>
        <main className="flex min-h-0 flex-1 flex-col print:block">
          <CategoryTabs groups={groups} pathname={pathname} />
          <div className={clsx("min-h-0 flex-1 overflow-y-auto print:overflow-visible", partnerTabs.length > 0 && "pb-[76px] md:pb-0")}>{children}</div>
        </main>
        {partnerTabs.length > 0 && (
          <nav
            aria-label="Delivery partner"
            className="fixed inset-x-0 bottom-0 z-30 grid border-t border-line bg-surface pb-[env(safe-area-inset-bottom)] shadow-[0_-4px_16px_rgba(0,0,0,0.06)] md:hidden print:hidden"
            style={{ gridTemplateColumns: `repeat(${partnerTabs.length}, minmax(0, 1fr))` }}
          >
            {partnerTabs.map((item) => {
              const active = isNavActive(pathname, item);
              const Icon = item.icon;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  className={clsx("flex min-h-[64px] flex-col items-center justify-center gap-0.5 text-xs font-bold", active ? "text-primary" : "text-muted")}
                >
                  <Icon size={26} weight={active ? "fill" : "regular"} />
                  {item.label}
                </Link>
              );
            })}
          </nav>
        )}
      </div>
    </div>
  );
}

interface Brand {
  name: string;
  logoUrl: string | null;
  /** Platform console: CANAVO's own logo */
  canavo: boolean;
}

/** Sidebar logo: CANAVO's for the platform console, else the outlet's uploaded logo or the business initials. */
function BrandMark({ brand, size }: { brand: Brand; size: number }) {
  const [failed, setFailed] = useState(false);
  const src = brand.logoUrl ? mediaUrl(brand.logoUrl) : "";
  useEffect(() => setFailed(false), [src]);
  if (brand.canavo) return <Logo size={size} />;
  if (src && !failed) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={src}
        alt=""
        width={size}
        height={size}
        onError={() => setFailed(true)}
        className="block shrink-0 rounded-[10px] bg-surface object-contain"
        style={{ width: size, height: size }}
      />
    );
  }
  const initials =
    brand.name
      .split(/\s+/)
      .filter((w) => /[\p{L}\p{N}]/u.test(w))
      .slice(0, 2)
      .map((w) => [...w.replace(/[^\p{L}\p{N}]/gu, "")][0]?.toUpperCase() ?? "")
      .join("") || "?";
  return (
    <span
      aria-hidden
      className="flex shrink-0 items-center justify-center rounded-[10px] bg-primary/15 text-sm font-extrabold text-primary"
      style={{ width: size, height: size }}
    >
      {initials}
    </span>
  );
}

/**
 * Sidebar: one entry per category (links to its first screen the session may
 * use). The category's screens are tabs at the top of the page (CategoryTabs).
 * A single category (the delivery partner's "My work") lists its screens directly.
 */
function SidebarNav({ groups, pathname, compact }: { groups: NavGroup[]; pathname: string; compact: boolean }) {
  const activeGroup = activeNavGroup(groups, pathname)?.id;
  const entry = (key: string, href: string, label: string, Icon: NavGroup["icon"], active: boolean, index: number) => (
    <Link
      key={key}
      href={href}
      title={compact ? label : undefined}
      aria-label={label}
      aria-current={active ? "page" : undefined}
      className={clsx(
        "group/item flex min-h-[44px] items-center gap-3 rounded-xl px-[19px] text-[15px] font-semibold transition-colors md:px-[19px]",
        active ? "bg-primary text-white shadow-sm" : "text-muted hover:bg-surface-2 hover:text-fg",
      )}
    >
      <Icon size={22} weight={active ? "fill" : "regular"} className="shrink-0 transition-transform duration-200 group-hover/item:scale-110" />
      <span
        aria-hidden
        className={clsx(
          "truncate whitespace-nowrap transition-[opacity,transform] duration-300",
          compact ? "pointer-events-none -translate-x-3 opacity-0" : "translate-x-0 opacity-100",
        )}
        style={{ transitionDelay: compact ? "0ms" : `${80 + index * 25}ms` }}
      >
        {label}
      </span>
    </Link>
  );
  return (
    <nav className="scrollbar-thin flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto overflow-x-hidden px-2 py-2" aria-label="Main">
      {groups.length === 1
        ? groups[0]!.items.map((i, n) => entry(i.href, i.href, i.label, i.icon, isNavActive(pathname, i), n))
        : groups.map((g, n) => entry(g.id, g.items[0]!.href, g.label, g.icon, g.id === activeGroup, n))}
    </nav>
  );
}

/**
 * Round handle on the sidebar's edge: the chevron flips as the sidebar
 * slides open / shut. Grows on hover; Ctrl/⌘ + \\ does the same.
 */
function SidebarToggle({ collapsed, onToggle }: { collapsed: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
      aria-expanded={!collapsed}
      title={`${collapsed ? "Expand" : "Collapse"} sidebar (Ctrl + \\)`}
      className={clsx(
        "absolute -right-3.5 top-[18px] z-20 flex h-7 w-7 items-center justify-center rounded-full border border-line bg-surface text-muted shadow-md",
        "transition-all duration-300 hover:scale-110 hover:border-primary hover:bg-primary hover:text-white focus-visible:scale-110",
        "opacity-70 group-hover/side:opacity-100",
      )}
    >
      <CaretLeft size={14} weight="bold" className={clsx("transition-transform duration-500 ease-[cubic-bezier(0.34,1.56,0.64,1)]", collapsed && "rotate-180")} />
    </button>
  );
}

/** Avatar in the top bar: who's signed in, and log out. */
function UserMenu({ name, role, email, photoUrl, onLogout }: { name: string; role: string; email: string | null; photoUrl: string | null; onLogout: () => void }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !(e.target as HTMLElement).closest("[data-user-menu]")) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);
  const initials = name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("");
  const avatar = (size: string) =>
    photoUrl ? (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={mediaUrl(photoUrl)} alt="" className={clsx(size, "rounded-full object-cover")} />
    ) : (
      <span className={clsx(size, "flex items-center justify-center rounded-full bg-primary/15 text-sm font-bold text-primary")}>{initials}</span>
    );
  return (
    <div className="relative" data-user-menu>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Account"
        className="flex min-h-tap items-center gap-2 rounded-xl px-1.5 hover:bg-surface-2 md:pr-2"
      >
        {avatar("h-9 w-9")}
        <span className="hidden min-w-0 text-left leading-tight lg:block">
          <span className="block max-w-[140px] truncate text-sm font-bold">{name}</span>
          <span className="block max-w-[140px] truncate text-xs text-muted">{role}</span>
        </span>
        <CaretDown size={14} className={clsx("hidden text-muted transition-transform duration-200 lg:block", open && "rotate-180")} />
      </button>
      {open && (
        <div role="menu" className="absolute right-0 top-[calc(100%+8px)] z-50 w-64 animate-fade-in rounded-2xl border border-line bg-surface p-2 shadow-xl">
          <div className="flex items-center gap-3 px-2 pb-3 pt-1">
            {avatar("h-11 w-11")}
            <div className="min-w-0">
              <p className="truncate font-bold">{name}</p>
              <p className="truncate text-xs text-muted">{role}</p>
              {email && <p className="truncate text-xs text-muted">{email}</p>}
            </div>
          </div>
          <div className="border-t border-line pt-2">
            <Link
              href="/account/security"
              role="menuitem"
              onClick={() => setOpen(false)}
              className="flex min-h-tap w-full items-center gap-3 rounded-xl px-3 font-semibold hover:bg-surface-2"
            >
              <ShieldCheck size={20} />
              Security
            </Link>
            <button
              type="button"
              role="menuitem"
              onClick={onLogout}
              className="flex min-h-tap w-full items-center gap-3 rounded-xl px-3 font-semibold text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/40"
            >
              <SignOut size={20} />
              Log out
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** The current category's screens as tabs above the page (categories with their own tabs render them in-page). */
function CategoryTabs({ groups, pathname }: { groups: NavGroup[]; pathname: string }) {
  const group = activeNavGroup(groups, pathname);
  if (!group || groups.length === 1 || group.ownTabs || group.items.length < 2) return null;
  return (
    <div className="mx-auto w-full max-w-[1440px] shrink-0 px-4 pt-3 md:px-6 print:hidden">
      <TabNav tabs={group.items} label={`${group.label} sections`} className="" />
    </div>
  );
}

/**
 * Header context: outlet picker (the business name and logo are in the sidebar). Platform admins have no
 * outlets (hotel data is private), so they just see "Platform console".
 */
function OutletSwitcher({ value, disabled, onChange }: { value: string | null; disabled: boolean; onChange: (v: string) => void }) {
  const { me } = useSession();
  if (!me) return null;
  const selectCls =
    "min-h-[40px] max-w-[240px] truncate rounded-lg border border-line bg-surface px-2 text-sm font-semibold focus:outline-none focus:ring-2 focus:ring-primary/30 disabled:opacity-60";

  if (me.platformAdmin) {
    return (
      <div className="flex min-w-0 items-center gap-2">
        <ShieldStar size={22} className="shrink-0 text-primary" />
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-[11px] font-bold uppercase leading-tight tracking-wider text-muted">CANAVO platform</span>
          <span className="truncate text-sm font-semibold">Platform console</span>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-w-0 items-center gap-2">
      <Storefront size={22} className="shrink-0 text-muted" />
      <div className="flex min-w-0 flex-col">
        {me.outlets.length > 1 ? (
          <select aria-label="Outlet" value={value ?? ""} disabled={disabled} onChange={(e) => onChange(e.target.value)} className={clsx(selectCls, "border-0 px-0 focus:ring-0")}>
            {me.outlets.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
        ) : (
          <span className="truncate text-sm font-semibold">{me.outlets[0]?.name ?? "No outlet yet"}</span>
        )}
      </div>
    </div>
  );
}
