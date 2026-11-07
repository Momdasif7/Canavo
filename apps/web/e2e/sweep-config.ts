/**
 * Configuration for the duplicate-button sweep (duplicate-buttons.spec.ts).
 *
 * The sweep flags any accessible name that appears on two or more VISIBLE
 * interactive elements on the same page (buttons, [role=button|tab|menuitem|switch],
 * links). Before something is reported as a duplicate it goes through the
 * allowlist below — every rule says WHY that kind of repeat is legitimate.
 */

export interface SweepRole {
  key: string;
  email: string;
  label: string;
}

/** Seed logins (apps/api/prisma/seed.ts), password Canavo@123. */
export const ROLES: SweepRole[] = [
  { key: "super-admin", email: "admin@canavo.local", label: "Super admin" },
  { key: "owner", email: "owner@canavo.local", label: "Business owner" },
  { key: "manager", email: "manager@canavo.local", label: "Outlet manager" },
  { key: "cashier", email: "cashier@canavo.local", label: "Cashier" },
  { key: "waiter", email: "waiter@canavo.local", label: "Waiter" },
  { key: "kitchen", email: "kitchen@canavo.local", label: "Kitchen" },
  { key: "inventory", email: "inventory@canavo.local", label: "Inventory manager" },
  { key: "delivery", email: "delivery@canavo.local", label: "Delivery partner" },
  { key: "accountant", email: "accountant@canavo.local", label: "Accountant" },
  { key: "auditor", email: "auditor@canavo.local", label: "Auditor" },
  { key: "support", email: "support@canavo.local", label: "Platform support" },
];

export const VIEWPORTS = [
  { key: "desktop", width: 1440, height: 900 },
  { key: "phone", width: 390, height: 844 },
] as const;

/**
 * Dynamic routes: open the parent page and follow the first link whose href
 * matches. If there's no such link (no data), the route is reported as "no instance".
 */
export const DYNAMIC_ROUTES: Record<string, { from: string; link: RegExp }> = {
  "/customers/[id]": { from: "/customers", link: /^\/customers\/(?!khata|loyalty)[^/?#]+$/ },
  "/inventory/audits/[id]": { from: "/inventory/audits", link: /^\/inventory\/audits\/[^/?#]+$/ },
  "/platform/businesses/[id]": { from: "/platform/businesses", link: /^\/platform\/businesses\/(?!new)[^/?#]+$/ },
};

/** Pages outside the signed-in app, checked once without a login. */
export const PUBLIC_ROUTES = ["/login", "/forgot-password", "/reset-password"];

// ---------------------------------------------------------------------------
// Allowlist — legitimate repeats. A duplicate group is ignored when EVERY pair
// of elements in it is covered by one of these rules.
// ---------------------------------------------------------------------------

/**
 * Rule "per-item": the elements sit in different items of a repeated structure —
 * table rows (tr / [role=row]), list items (li / [role=listitem]) or a grid/list of
 * 3+ identical cards (e.g. "Edit" on every staff row, "New code" on every table
 * QR card, "Add" on every POS menu tile). Each one acts on its own item.
 * (Implemented in the page script: items are siblings with the same tag + class.)
 */
export const PER_ITEM_MIN_SIBLINGS = 3;

/** Rule "pagination / stepping": the same control repeated above and below a list. */
export const PAGINATION_NAMES = [/^(previous|next|prev|first|last)( page| day| week| month)?$/i, /^page \d+$/i, /^\d+$/, /^[«»‹›<>]$/];

/**
 * Rule "named" — specific repeats that were reviewed and are NOT duplicate actions.
 * `route` is a regex on the pathname, `name` an exact (case-insensitive) accessible name.
 */
export const NAMED_ALLOWLIST: { route: RegExp; name: string | RegExp; reason: string }[] = [
  {
    route: /^\/settings$/,
    name: /^(58|80) mm/,
    reason: "options of two different settings (Receipt paper vs Kitchen ticket paper) in the Receipt printer card",
  },
  {
    route: /^\/settings$/,
    name: "Save",
    reason: "each settings card (Outlet profile, Money controls) saves its own form",
  },
  {
    route: /^\/admin\/settings$/,
    name: /^(Save|Defaults)$/,
    reason: "each system-settings section (notification channels, printer defaults, pre-order lead time, WhatsApp templates) saves / resets its own values",
  },
];

/**
 * Duplicates that are real (or debatable) but deliberately LEFT, because the screen
 * belongs to another workstream or needs a product decision. They are reported in the
 * results file under "Left (known)" and don't fail the sweep.
 */
export const KNOWN_LEFT: { route: RegExp; name: string | RegExp; reason: string }[] = [];
