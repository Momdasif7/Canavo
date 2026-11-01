export const ROLES = [
  "SUPER_ADMIN",
  "BUSINESS_OWNER",
  "OUTLET_MANAGER",
  "CASHIER",
  "KITCHEN",
  "DELIVERY",
  "INVENTORY_MANAGER",
  /** Table service: opens tabs, takes orders, fires KOTs — never takes money (Phase 4.1) */
  "WAITER",
  /** Books and GST returns: reports, bills and stock, read-only (Phase 4.2) */
  "ACCOUNTANT",
  /** Read-only look at everything a CA / auditor needs, plus the audit log (Phase 4.2) */
  "AUDITOR",
  /** CANAVO support staff: read-only platform console + owner-granted support views (Phase 4.2) */
  "PLATFORM_SUPPORT",
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
  WAITER: "Waiter / Captain",
  ACCOUNTANT: "Accountant",
  AUDITOR: "Auditor",
  PLATFORM_SUPPORT: "Platform Support",
};

/** Platform (CANAVO operator) roles: no business of their own. */
export const PLATFORM_ROLES: readonly Role[] = ["SUPER_ADMIN", "PLATFORM_SUPPORT"];
export const isPlatformRole = (role: Role) => PLATFORM_ROLES.includes(role);

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
  /** Read-only platform console: businesses, owners, support grants (super admin + platform support) */
  "platform:view",
  /** Bills history page and bill list (owner, manager, cashier) */
  "bills:view",
  /** Settings pages (owner, manager, cashier — cashiers see read-only outlet info + printer) */
  "settings:view",
  /** Download all of the business's own data (owner only) */
  "data:export",
  /** Approve voids, refunds and large discounts with a PIN at the counter (owner, manager) — Phase 3.3 */
  "approval:grant",
  /** Phase 5: corporate accounts, members, wallets, meal slots, subscriptions (owner, manager) */
  "canteen:manage",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const ALL = [...PERMISSIONS];
const PLATFORM_ONLY: Permission[] = ["platform:manage", "platform:view", "admin:backup"];

export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  /**
   * SaaS operator: onboards hotels, sets their modules, creates / resets owner
   * accounts, runs platform backups. No access to any hotel's data (privacy):
   * no POS, bills, staff, customers or reports. Audit log limited to platform actions.
   */
  SUPER_ADMIN: ["platform:manage", "platform:view", "admin:backup", "audit:view"],
  /** Runs one business: all its outlets, staff, settings and data */
  BUSINESS_OWNER: ALL.filter((p) => !PLATFORM_ONLY.includes(p) && p !== "delivery:own"),
  /** Runs assigned outlet(s), including GST / tax settings */
  OUTLET_MANAGER: ALL.filter((p) => !PLATFORM_ONLY.includes(p) && p !== "outlet:manage" && p !== "delivery:own" && p !== "data:export"),
  CASHIER: [
    "attendance:self", "menu:view", "order:create", "order:view", "payment:collect", "kot:view",
    "table:serve", "reservation:manage", "delivery:manage", "customer:view", "bills:view", "settings:view",
  ],
  KITCHEN: ["attendance:self", "menu:view", "kot:view", "kot:update", "inventory:view"],
  /** Delivery partners only see their own deliveries (no bills list, no settings) */
  DELIVERY: ["attendance:self", "delivery:own"],
  /** Stock work and stock reports only — no sales, profit or GST reports (owner & manager only) */
  INVENTORY_MANAGER: ["attendance:self", "menu:view", "inventory:manage", "inventory:view"],
  /** Serves tables: no payments, bills list, settings or reports (cashiers / managers bill and collect) */
  WAITER: ["attendance:self", "menu:view", "order:create", "kot:view", "table:serve", "reservation:manage", "customer:view"],
  /** Reports (incl. GSTR-1 / exports), bills and stock — no POS, staff, settings changes, cancels or refunds */
  ACCOUNTANT: ["attendance:self", "report:view", "bills:view", "order:view", "inventory:view", "menu:view"],
  /** Read-only; the API also refuses every write from an auditor (middleware/auth.ts) */
  AUDITOR: ["report:view", "bills:view", "order:view", "audit:view", "inventory:view", "staff:view", "menu:view"],
  /** Reads the platform console and opens owner-granted support views; changes nothing */
  PLATFORM_SUPPORT: ["platform:view"],
};

export function can(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

/**
 * Role permission, narrowed by the user's custom role (Phase 4.2). A custom role is a
 * subset of its base role: it can only take permissions away, never add them.
 * `custom` null/undefined = no custom role (the full base role).
 */
export function canWith(role: Role, permission: Permission, custom?: readonly string[] | null): boolean {
  return can(role, permission) && (!custom || custom.includes(permission));
}

/** Custom roles can be based on business staff roles only (not owner / platform roles). */
export const CUSTOM_ROLE_BASES = ["OUTLET_MANAGER", "CASHIER", "KITCHEN", "DELIVERY", "INVENTORY_MANAGER", "WAITER", "ACCOUNTANT", "AUDITOR"] as const satisfies readonly Role[];

/** Plain-English names for permissions (custom role editor). */
export const PERMISSION_LABELS: Record<Permission, string> = {
  "outlet:manage": "Business-wide settings and outlets",
  "settings:billing": "Change GST / billing settings",
  "settings:outlet": "Change outlet settings",
  "staff:manage": "Add and edit staff",
  "staff:view": "See staff list",
  "attendance:self": "Clock in / out",
  "attendance:manage": "Manage attendance, shifts and leave",
  "menu:manage": "Edit the menu",
  "menu:view": "See the menu",
  "order:create": "Take orders",
  "order:view": "See orders",
  "order:cancel": "Void bills, refunds and item cancels",
  "payment:collect": "Collect payments",
  "kot:view": "See kitchen tickets",
  "kot:update": "Update kitchen tickets",
  "report:view": "See reports",
  "inventory:manage": "Manage stock",
  "delivery:own": "Own deliveries (delivery partner)",
  "table:manage": "Set up tables and floor plan",
  "table:serve": "Serve tables (open tabs, add items)",
  "reservation:manage": "Reservations and pre-orders",
  "delivery:manage": "Manage deliveries",
  "customer:view": "See customers",
  "customer:manage": "Edit customers, loyalty and credit",
  "offer:manage": "Manage offers and coupons",
  "inventory:view": "See stock",
  "audit:view": "See the audit log",
  "admin:backup": "Platform backups",
  "platform:manage": "Manage the platform",
  "platform:view": "View the platform console",
  "bills:view": "See bills history",
  "settings:view": "See settings",
  "data:export": "Download all business data",
  "approval:grant": "Approve voids, refunds and discounts with a PIN",
  "canteen:manage": "Canteen: corporate accounts, members, wallets, meal slots and subscriptions",
};
