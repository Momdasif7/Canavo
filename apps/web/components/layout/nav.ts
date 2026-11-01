import { can, type Permission } from "@canavo/shared";
import type { Me } from "@/lib/types";
import {
  BookOpenText,
  CalendarCheck,
  CalendarPlus,
  CashRegister,
  ChartBar,
  ChefHat,
  ClipboardText,
  CookingPot,
  GearSix,
  Moped,
  Notebook,
  Package,
  Receipt,
  ShoppingCart,
  SquaresFour,
  Tag,
  UserList,
  WhatsappLogo,
  UsersThree,
  ArrowsLeftRight,
  Storefront,
  type Icon,
} from "@phosphor-icons/react";
import { Briefcase, IdentificationBadge } from "@phosphor-icons/react";
import { Gift, Vault, Buildings, ChartLineUp, ClockCounterClockwise, Gauge, HandCoins, IdentificationCard, Lifebuoy, Percent, ShieldStar, SlidersHorizontal, Truck } from "@phosphor-icons/react";
import { ForkKnife, Clock, Repeat, QrCode } from "@phosphor-icons/react";
import { ADMIN_SECTIONS } from "@/components/admin/nav";

export interface NavItem {
  href: string;
  label: string;
  icon: Icon;
  /** Shown when the session has any of these (effective) permissions; empty = everyone */
  anyOf: Permission[];
  /** Additionally requires every one of these */
  allOf?: Permission[];
  /** Hidden when the session has any of these (e.g. partner screens for managers) */
  noneOf?: Permission[];
  /**
   * Where the screen works: "business" (default) needs an outlet / business
   * context, "platform" is for platform admins only, "any" works in both.
   */
  scope?: "business" | "platform" | "any";
}

export interface NavGroup {
  /** Stable id — other modules add groups by id (e.g. "reports", "admin") */
  id: string;
  label: string;
  /** Category icon in the sidebar */
  icon: Icon;
  /** The category's pages render their own in-page tabs (inventory, reports, settings, admin) */
  ownTabs?: boolean;
  items: NavItem[];
}

/**
 * Sidebar categories. The sidebar shows one entry per category (linking to its
 * first permitted screen); inside the category, its screens appear as tabs at
 * the top of the page. Empty categories (no permitted items, e.g. a module
 * that's off) are hidden.
 */
export const NAV_GROUPS: NavGroup[] = [
  {
    id: "platform",
    label: "Platform",
    icon: ShieldStar,
    items: [
      { href: "/platform", label: "Overview", icon: Gauge, anyOf: ["platform:view"], scope: "platform" },
      { href: "/platform/businesses", label: "Businesses", icon: Buildings, anyOf: ["platform:view"], scope: "platform" },
      { href: "/platform/admins", label: "Platform admins", icon: ShieldStar, anyOf: ["platform:view"], scope: "platform" },
    ],
  },
  {
    // Delivery partner portal: focused nav for the DELIVERY role (managers use the board instead).
    id: "partner",
    label: "My work",
    icon: Moped,
    items: [
      { href: "/delivery", label: "My deliveries", icon: Moped, anyOf: ["delivery:own"], noneOf: ["delivery:manage"] },
      { href: "/delivery/cash", label: "Cash handover", icon: HandCoins, anyOf: ["delivery:own"], noneOf: ["delivery:manage"] },
      { href: "/delivery/dashboard", label: "Dashboard", icon: ChartBar, anyOf: ["delivery:own"], noneOf: ["delivery:manage"] },
      { href: "/delivery/history", label: "History", icon: ClockCounterClockwise, anyOf: ["delivery:own"], noneOf: ["delivery:manage"] },
    ],
  },
  {
    id: "dashboard",
    label: "Dashboard",
    icon: ChartBar,
    items: [{ href: "/dashboard", label: "Dashboard", icon: ChartBar, anyOf: ["report:view"] }],
  },
  {
    id: "operations",
    label: "Billing & orders",
    icon: CashRegister,
    items: [
      // Waiters take orders on the Tables screen; the POS is for whoever collects payment.
      { href: "/pos", label: "POS", icon: CashRegister, anyOf: ["order:create"], allOf: ["payment:collect"] },
      { href: "/tables", label: "Tables", icon: SquaresFour, anyOf: ["table:serve", "table:manage"] },
      { href: "/bills", label: "Bills", icon: Receipt, anyOf: ["bills:view"] },
      { href: "/cash-drawer", label: "Cash drawer", icon: Vault, anyOf: ["payment:collect"] },
      { href: "/gift-cards", label: "Gift cards", icon: Gift, anyOf: ["payment:collect"] },
      { href: "/reservations", label: "Reservations", icon: CalendarPlus, anyOf: ["reservation:manage"] },
    ],
  },
  {
    id: "kitchen",
    label: "Kitchen",
    icon: CookingPot,
    items: [
      { href: "/kitchen", label: "Kitchen display", icon: CookingPot, anyOf: ["kot:view"] },
      { href: "/menu", label: "Menu", icon: BookOpenText, anyOf: ["menu:manage"] },
    ],
  },
  {
    // Phase 5 (CANTEEN module): institutional canteens and corporate catering.
    id: "canteen",
    label: "Canteen",
    icon: ForkKnife,
    items: [
      { href: "/canteen/accounts", label: "Corporate accounts", icon: Briefcase, anyOf: ["canteen:manage"] },
      { href: "/canteen/members", label: "Members & cards", icon: IdentificationBadge, anyOf: ["canteen:manage"] },
      { href: "/canteen/slots", label: "Meal slots", icon: Clock, anyOf: ["canteen:manage"] },
      { href: "/canteen/preorders", label: "Pre-orders", icon: CalendarPlus, anyOf: ["canteen:manage"] },
      { href: "/canteen/production", label: "Production plan", icon: ClipboardText, anyOf: ["canteen:manage"] },
      { href: "/canteen/subscriptions", label: "Meal plans", icon: Repeat, anyOf: ["canteen:manage"] },
    ],
  },
  {
    id: "delivery",
    label: "Delivery",
    icon: Moped,
    items: [
      { href: "/delivery", label: "Delivery board", icon: Moped, anyOf: ["delivery:manage"] },
      { href: "/delivery/partners", label: "Delivery partners", icon: IdentificationCard, anyOf: ["delivery:manage"] },
    ],
  },
  {
    id: "inventory",
    label: "Inventory",
    icon: Package,
    ownTabs: true,
    items: [
      { href: "/inventory", label: "Stock", icon: Package, anyOf: ["inventory:view", "inventory:manage"] },
      { href: "/inventory/purchases", label: "Purchases", icon: ShoppingCart, anyOf: ["inventory:view", "inventory:manage"] },
      { href: "/inventory/vendors", label: "Vendors", icon: Truck, anyOf: ["inventory:view", "inventory:manage"] },
      { href: "/inventory/recipes", label: "Recipes", icon: ChefHat, anyOf: ["inventory:view", "inventory:manage"] },
      { href: "/inventory/audits", label: "Audits", icon: ClipboardText, anyOf: ["inventory:view", "inventory:manage"] },
      { href: "/inventory/transfers", label: "Transfers", icon: ArrowsLeftRight, anyOf: ["inventory:view", "inventory:manage"] },
    ],
  },
  {
    id: "customers",
    label: "Customers",
    icon: UserList,
    items: [
      { href: "/customers", label: "Customers", icon: UserList, anyOf: ["customer:view"] },
      { href: "/customers/khata", label: "Khata", icon: Notebook, anyOf: ["customer:view"] },
      { href: "/offers", label: "Offers & Coupons", icon: Tag, anyOf: ["offer:manage"] },
    ],
  },
  {
    id: "reports",
    label: "Reports",
    icon: ChartLineUp,
    ownTabs: true,
    items: [
      { href: "/reports", label: "Reports", icon: ChartLineUp, anyOf: ["report:view"] },
      { href: "/reports/outlets", label: "All outlets", icon: Buildings, anyOf: ["report:view"] },
    ],
  },
  {
    id: "people",
    label: "Staff & attendance",
    icon: UsersThree,
    items: [
      { href: "/staff", label: "Staff", icon: UsersThree, anyOf: ["staff:view"] },
      { href: "/attendance", label: "Attendance", icon: CalendarCheck, anyOf: ["attendance:manage"] },
    ],
  },
  {
    id: "management",
    label: "Settings",
    icon: GearSix,
    ownTabs: true,
    items: [
      { href: "/settings", label: "Outlet settings", icon: GearSix, anyOf: ["settings:view"] },
      { href: "/settings/taxes", label: "GST & Taxes", icon: Percent, anyOf: ["settings:billing"], allOf: ["settings:view"] },
      { href: "/settings/whatsapp", label: "WhatsApp", icon: WhatsappLogo, anyOf: ["settings:outlet"], allOf: ["settings:view"] },
      // Phase 6.3/6.4 (CHANNELS): QR table ordering + the outlet's own online ordering page.
      { href: "/settings/online-ordering", label: "Online ordering", icon: QrCode, anyOf: ["channel:manage"] },
      { href: "/settings/support", label: "Support access", icon: Lifebuoy, anyOf: ["outlet:manage"] },
      { href: "/outlets", label: "Outlets", icon: Storefront, anyOf: ["outlet:manage"] },
    ],
  },
  { id: "admin", label: "Admin", icon: SlidersHorizontal, ownTabs: true, items: ADMIN_SECTIONS },
];

/** Flat list of every nav entry (route guards, first-route logic). */
export const NAV_ITEMS: NavItem[] = NAV_GROUPS.flatMap((g) => g.items);

/** Session facts the nav needs. */
export interface NavContext {
  me: Pick<Me, "role" | "permissions" | "platformAdmin">;
  /** null = platform admin (always in the platform console; they can't open a hotel) */
  outletId: string | null;
}

const has = (ctx: NavContext, p: Permission) => Boolean(ctx.me.permissions?.includes(p));

/** Platform admin: only platform-wide screens (hotel data is private to each hotel). */
export const inPlatformConsole = (ctx: NavContext) => ctx.me.platformAdmin && !ctx.outletId;

const scopeOk = (item: NavItem, ctx: NavContext) => {
  const scope = item.scope ?? "business";
  if (scope === "platform") return ctx.me.platformAdmin;
  if (scope === "business") return !inPlatformConsole(ctx);
  return true;
};

const permsOk = (item: NavItem, ctx: NavContext) =>
  (!item.anyOf.length || item.anyOf.some((p) => has(ctx, p))) &&
  (item.allOf ?? []).every((p) => has(ctx, p)) &&
  !(item.noneOf ?? []).some((p) => has(ctx, p));

export const navAllowed = (item: NavItem, ctx: NavContext) => scopeOk(item, ctx) && permsOk(item, ctx);

/** Delivery partner (own runs only, no board): gets the focused partner portal. */
export const isDeliveryPartner = (ctx: NavContext) => has(ctx, "delivery:own") && !has(ctx, "delivery:manage");

/** Groups with only the entries this session may see; empty groups (e.g. a module that's off) dropped. */
export function navGroupsFor(ctx: NavContext): NavGroup[] {
  return NAV_GROUPS.map((g) => ({ ...g, items: g.items.filter((i) => navAllowed(i, ctx)) })).filter((g) => g.items.length > 0);
}

export function firstAllowedRoute(ctx: NavContext): string {
  // Platform admins land on the console; owners and managers on the dashboard,
  // cashiers on the POS, waiters on Tables, kitchen on the KDS, delivery partners on their runs,
  // accountants / auditors on the dashboard, inventory staff on Stock.
  // `settings:outlet` marks management roles (always on).
  if (ctx.me.platformAdmin) return "/platform";
  const order: [boolean, string][] = [
    [has(ctx, "report:view") && has(ctx, "settings:outlet"), "/dashboard"],
    [has(ctx, "order:create") && has(ctx, "payment:collect"), "/pos"],
    [has(ctx, "table:serve"), "/tables"],
    [has(ctx, "kot:view"), "/kitchen"],
    [isDeliveryPartner(ctx), "/delivery"],
    [has(ctx, "report:view") && has(ctx, "bills:view"), "/dashboard"],
    [has(ctx, "inventory:view") || has(ctx, "inventory:manage"), "/inventory"],
    [has(ctx, "report:view"), "/dashboard"],
  ];
  const preferred = order.find(([ok]) => ok)?.[1];
  return preferred ?? NAV_ITEMS.find((i) => i.anyOf.length > 0 && navAllowed(i, ctx))?.href ?? "/settings";
}

/**
 * Most specific nav entries for a path (so /inventory/purchases doesn't resolve
 * to /inventory). Several entries may share an href (e.g. /delivery is the board
 * for managers and "My deliveries" for partners).
 */
function navItemsFor(pathname: string): NavItem[] {
  const matches = NAV_ITEMS.filter((i) => pathname === i.href || pathname.startsWith(`${i.href}/`));
  const best = Math.max(0, ...matches.map((i) => i.href.length));
  return matches.filter((i) => i.href.length === best);
}

/** Most specific nav entry for a path; with a session, prefers the entry it may use. */
export function navItemFor(pathname: string, ctx?: NavContext): NavItem | undefined {
  const items = navItemsFor(pathname);
  return (ctx && items.find((i) => navAllowed(i, ctx))) || items[0];
}

export type RouteAccess = "ok" | "role" | "module" | "needs-business";

/**
 * Why a route is (not) available: `module` when the role could use it but the
 * business doesn't subscribe to the module; `needs-business` when a platform
 * admin asks for a hotel screen (they never work inside a hotel).
 */
export function routeAccess(pathname: string, ctx: NavContext): RouteAccess {
  const items = navItemsFor(pathname);
  // /admin itself just redirects to the first admin section the session may use.
  // /account/* (own password, devices, 2FA) is for every signed-in user, platform admins included.
  if (!items.length) return inPlatformConsole(ctx) && !pathname.startsWith("/platform") && !pathname.startsWith("/account") && pathname !== "/admin" ? "needs-business" : "ok";
  if (items.some((i) => navAllowed(i, ctx))) return "ok";
  if (!items.some((i) => scopeOk(i, ctx))) return inPlatformConsole(ctx) ? "needs-business" : "role";
  // The role could use it if only the business's modules are missing.
  const roleCould = items.some(
    (i) =>
      (!i.anyOf.length || i.anyOf.some((p) => can(ctx.me.role, p))) &&
      (i.allOf ?? []).every((p) => can(ctx.me.role, p)) &&
      !(i.noneOf ?? []).some((p) => has(ctx, p)),
  );
  return roleCould ? "module" : "role";
}

export const isNavActive = (pathname: string, item: NavItem) => navItemFor(pathname)?.href === item.href;

/** The (permitted) category the current page belongs to. */
export const activeNavGroup = (groups: NavGroup[], pathname: string) => groups.find((g) => g.items.some((i) => isNavActive(pathname, i)));
