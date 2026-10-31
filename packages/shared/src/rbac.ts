export const ROLES = [
  "SUPER_ADMIN",
  "BUSINESS_OWNER",
  "OUTLET_MANAGER",
  "CASHIER",
  "KITCHEN",
  "DELIVERY",
  "INVENTORY_MANAGER",
] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  SUPER_ADMIN: "Super Admin",
  BUSINESS_OWNER: "Business Owner",
  OUTLET_MANAGER: "Outlet Manager",
  CASHIER: "Cashier",
  KITCHEN: "Kitchen Staff",
  DELIVERY: "Delivery Staff",
  INVENTORY_MANAGER: "Inventory Manager",
};

export const PERMISSIONS = [
  "outlet:manage",
  "settings:billing",
  "settings:outlet",
  "staff:manage",
  "staff:view",
  "attendance:self",
  "attendance:manage",
  "menu:manage",
  "menu:view",
  "order:create",
  "order:view",
  "order:cancel",
  "payment:collect",
  "kot:view",
  "kot:update",
  "report:view",
  "inventory:manage",
  "delivery:own",
  // Phase 2–3
  "table:manage",
  "table:serve",
  "reservation:manage",
  "delivery:manage",
  "customer:view",
  "customer:manage",
  "offer:manage",
  "inventory:view",
  "audit:view",
  "admin:backup",
  // Multi-business platform
  "platform:manage",
  /** Bills history page and bill list (owner, manager, cashier) */
  "bills:view",
  /** Settings pages (owner, manager, cashier — cashiers see read-only outlet info + printer) */
  "settings:view",
  /** Download all of the business's own data (owner only) */
  "data:export",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const ALL = [...PERMISSIONS];

export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  /**
   * SaaS operator: onboards hotels, sets their modules, creates / resets owner
   * accounts, runs platform backups. No access to any hotel's data (privacy):
   * no POS, bills, staff, customers or reports. Audit log limited to platform actions.
   */
  SUPER_ADMIN: ["platform:manage", "admin:backup", "audit:view"],
  /** Runs one business: all its outlets, staff, settings and data */
  BUSINESS_OWNER: ALL.filter((p) => p !== "platform:manage" && p !== "admin:backup" && p !== "delivery:own"),
  /** Runs assigned outlet(s), including GST / tax settings */
  OUTLET_MANAGER: ALL.filter((p) => p !== "platform:manage" && p !== "admin:backup" && p !== "outlet:manage" && p !== "delivery:own" && p !== "data:export"),
  CASHIER: [
    "attendance:self", "menu:view", "order:create", "order:view", "payment:collect", "kot:view",
    "table:serve", "reservation:manage", "delivery:manage", "customer:view", "bills:view", "settings:view",
  ],
  KITCHEN: ["attendance:self", "menu:view", "kot:view", "kot:update", "inventory:view"],
  /** Delivery partners only see their own deliveries (no bills list, no settings) */
  DELIVERY: ["attendance:self", "delivery:own"],
  /** Stock work and stock reports only — no sales, profit or GST reports (owner & manager only) */
  INVENTORY_MANAGER: ["attendance:self", "menu:view", "inventory:manage", "inventory:view"],
};

export function can(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}
