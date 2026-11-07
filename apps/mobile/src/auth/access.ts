/**
 * What the signed-in user can see, derived ONLY from `/auth/me` — the
 * server's effective permissions (role ∩ the business's enabled modules) and
 * the module list. Pure functions, no React Native imports, so the same rules
 * can be checked from a node script against the real API.
 */
import type { ModuleKey, Permission } from "@canavo/shared";

export interface AccessProfile {
  permissions: readonly string[];
  /** null/undefined = platform context (all modules) */
  modules?: readonly string[] | null;
}

export const hasPermission = (me: AccessProfile, p: Permission) => me.permissions.includes(p);
export const hasModule = (me: AccessProfile, m: ModuleKey) => me.modules == null || me.modules.includes(m);

export type TabName = "index" | "bill" | "tables" | "deliveries" | "cash" | "history" | "kot" | "online" | "stock" | "reports" | "more";

/** Delivery partner: own deliveries only (no delivery board, bills or settings). */
export const isDeliveryPartner = (me: AccessProfile) => hasPermission(me, "delivery:own") && !hasPermission(me, "delivery:manage");

/** Bills / receipts (the server requires `bills:view` for the bill list). */
export const canViewBills = (me: AccessProfile) => hasPermission(me, "bills:view");

/** Settings screens (outlet info, printer…). */
export const canViewSettings = (me: AccessProfile) => hasPermission(me, "settings:view");

/** Online / aggregator order board (`GET /channels/board`): CHANNELS module + billing, kitchen or channel managers. */
export const canViewChannelBoard = (me: AccessProfile) =>
  hasModule(me, "CHANNELS") && (hasPermission(me, "order:create") || hasPermission(me, "kot:view") || hasPermission(me, "channel:manage"));

/** QR / online orders waiting for staff to accept (the API's `canHandle`: table:serve or order:create). */
export const canHandleChannelRequests = (me: AccessProfile) =>
  hasModule(me, "CHANNELS") && (hasPermission(me, "table:serve") || hasPermission(me, "order:create"));

/** "Online" tab: the board and/or the confirmation queue. */
export const canViewOnlineOrders = (me: AccessProfile) => canViewChannelBoard(me) || canHandleChannelRequests(me);

/** Bottom tabs, in display order. Home and More are always present. */
export function visibleTabs(me: AccessProfile): TabName[] {
  const can = (p: Permission) => hasPermission(me, p);
  // Delivery partners get a focused app: duty, deliveries, cash to hand over, history.
  if (isDeliveryPartner(me) && !can("order:create") && !can("kot:view")) return ["index", "deliveries", "cash", "history", "more"];
  const tabs: TabName[] = ["index"];
  if (can("order:create")) tabs.push("bill");
  if (can("table:serve")) tabs.push("tables");
  // Delivery agents get their own tabs; managers reach the delivery board from More.
  if (isDeliveryPartner(me)) tabs.push("deliveries", "cash", "history");
  if (can("kot:view")) tabs.push("kot");
  if (canViewOnlineOrders(me)) tabs.push("online");
  // Kitchen / inventory staff (or an inventory-only business) get a Stock tab; billing roles use More.
  if (can("inventory:view") && !can("order:create")) tabs.push("stock");
  if (can("report:view")) tabs.push("reports");
  tabs.push("more");
  return tabs;
}

export type MoreItem = "notifications" | "delivery-board" | "delivery-partners" | "inventory" | "customers" | "attendance" | "staff-attendance" | "outlet-info" | "printer";

/** More-tab items that are settings screens (need `settings:view`). */
export const SETTINGS_ITEMS: readonly MoreItem[] = ["outlet-info", "printer"];

export function moreItems(me: AccessProfile): MoreItem[] {
  const can = (p: Permission) => hasPermission(me, p);
  // Personal items (notifications, attendance; profile and sign-out are always on the screen) are for everyone.
  const items: MoreItem[] = ["notifications"];
  if (can("delivery:manage")) items.push("delivery-board", "delivery-partners");
  if (can("inventory:view")) items.push("inventory");
  if (can("customer:view")) items.push("customers");
  if (can("attendance:self") || can("attendance:manage")) items.push("attendance");
  // Daily register: managers / owners mark attendance for their staff.
  if (can("attendance:manage")) items.push("staff-attendance");
  if (canViewSettings(me)) {
    items.push("outlet-info");
    // Printing is for bills and KOTs.
    if (can("order:create") || can("kot:view")) items.push("printer");
  }
  return items;
}

/** POS features inside the Bill tab. */
export function posFeatures(me: AccessProfile) {
  const can = (p: Permission) => hasPermission(me, p);
  return {
    customers: can("customer:view"),
    /** Loyalty points need the customers module */
    points: can("customer:view"),
    coupons: hasModule(me, "OFFERS"),
    offers: hasModule(me, "OFFERS"),
    delivery: can("delivery:manage"),
    preOrder: can("reservation:manage"),
    /** Table label on dine-in bills */
    tables: can("table:serve"),
    kot: can("kot:view"),
  };
}

/** The API's 403 when a module is switched off for the business. */
export const MODULE_DISABLED_RE = /not enabled for your business/i;
export const SUSPENDED_RE = /business account is suspended/i;
