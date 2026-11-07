import { PERMISSIONS, ROLE_PERMISSIONS, type Permission, type Role } from "./rbac";

/** Feature modules a business can be subscribed to. Staff, settings and logins are always available. */
export const MODULES = [
  "BILLING",
  "KOT",
  "TABLES",
  "DELIVERY",
  "RESERVATIONS",
  "INVENTORY",
  "CUSTOMERS",
  "OFFERS",
  "ATTENDANCE",
  "REPORTS",
  "CANTEEN",
  "CHANNELS",
] as const;
export type ModuleKey = (typeof MODULES)[number];

export const MODULE_INFO: Record<ModuleKey, { label: string; description: string; requires: ModuleKey[] }> = {
  BILLING: { label: "Billing / POS", description: "Menu, billing, payments, receipts, bills history", requires: [] },
  KOT: { label: "Kitchen (KOT)", description: "Kitchen order tickets and kitchen display", requires: ["BILLING"] },
  TABLES: { label: "Tables", description: "Floor plan, running tabs, split bills", requires: ["BILLING"] },
  DELIVERY: { label: "Delivery", description: "Delivery zones, agents and tracking", requires: ["BILLING"] },
  RESERVATIONS: { label: "Reservations & pre-orders", description: "Table bookings and scheduled orders", requires: ["BILLING"] },
  INVENTORY: { label: "Inventory", description: "Stock, recipes, purchases, vendors, audits", requires: [] },
  CUSTOMERS: { label: "Customers & loyalty", description: "Customer profiles, points, khata (credit)", requires: ["BILLING"] },
  OFFERS: { label: "Offers & coupons", description: "Combos, happy hours, coupons", requires: ["BILLING"] },
  ATTENDANCE: { label: "Attendance & leave", description: "Clock-in/out, shifts, leave, salary sheet", requires: [] },
  REPORTS: { label: "Reports", description: "Sales, GST, profit, staff and other reports", requires: [] },
  CANTEEN: {
    label: "Canteen & institutional",
    description: "Corporate accounts, subsidies, wallets and cards, meal slots, pre-orders, subscriptions",
    requires: ["BILLING", "CUSTOMERS"],
  },
  CHANNELS: {
    label: "Online orders & channels",
    description: "QR table ordering, online ordering page, digital menu, Zomato / Swiggy via a partner hub",
    requires: ["BILLING"],
  },
};

/** Which module a permission belongs to; permissions not listed are always available. */
export const PERMISSION_MODULE: Partial<Record<Permission, ModuleKey>> = {
  "order:create": "BILLING",
  "order:view": "BILLING",
  "bills:view": "BILLING",
  "order:cancel": "BILLING",
  "approval:grant": "BILLING",
  "canteen:manage": "CANTEEN",
  "channel:manage": "CHANNELS",
  "payment:collect": "BILLING",
  "kot:view": "KOT",
  "kot:update": "KOT",
  "table:manage": "TABLES",
  "table:serve": "TABLES",
  "delivery:manage": "DELIVERY",
  "delivery:own": "DELIVERY",
  "reservation:manage": "RESERVATIONS",
  "inventory:view": "INVENTORY",
  "inventory:manage": "INVENTORY",
  "customer:view": "CUSTOMERS",
  "customer:manage": "CUSTOMERS",
  "offer:manage": "OFFERS",
  "attendance:self": "ATTENDANCE",
  "attendance:manage": "ATTENDANCE",
  "report:view": "REPORTS",
};

/** The menu is needed for billing and for inventory recipes. */
const MENU_PERMISSIONS: Permission[] = ["menu:view", "menu:manage"];

/** Add missing dependencies (e.g. TABLES needs BILLING) and drop unknown keys. */
export function normalizeModules(modules: readonly string[]): ModuleKey[] {
  const set = new Set(modules.filter((m): m is ModuleKey => (MODULES as readonly string[]).includes(m)));
  for (const m of [...set]) for (const r of MODULE_INFO[m].requires) set.add(r);
  return MODULES.filter((m) => set.has(m));
}

/** Is a permission usable given the business's modules? `null` modules = platform context (all). */
export function permissionEnabled(permission: Permission, modules: readonly string[] | null): boolean {
  if (modules === null) return true;
  if (MENU_PERMISSIONS.includes(permission)) return modules.includes("BILLING") || modules.includes("INVENTORY");
  const m = PERMISSION_MODULE[permission];
  return !m || modules.includes(m);
}

/** Effective permissions = role permissions ∩ custom role (if any) ∩ enabled modules. */
export function effectivePermissions(role: Role, modules: readonly string[] | null, custom?: readonly string[] | null): Permission[] {
  return PERMISSIONS.filter((p) => ROLE_PERMISSIONS[role].includes(p) && (!custom || custom.includes(p)) && permissionEnabled(p, modules));
}
