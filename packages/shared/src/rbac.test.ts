/**
 * RBAC × modules truth table (Phase 4).
 *  - Spec rules from the README are asserted explicitly.
 *  - role ∩ module is checked exhaustively: 7 roles × all 1,024 module subsets.
 *  - The full role × permission matrix is snapshotted (rbac.test.ts.snap) so any
 *    change to who-can-do-what fails CI until it is reviewed.
 *  - WRITE_RBAC_TABLE=1 writes docs/qa/RBAC_TRUTH_TABLE.md for product review.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MODULE_INFO, MODULES, effectivePermissions, normalizeModules, permissionEnabled, PERMISSION_MODULE, type ModuleKey } from "./modules";
import { can, PERMISSIONS, ROLE_LABELS, ROLE_PERMISSIONS, ROLES, type Permission, type Role } from "./rbac";

const HOTEL_DATA: Permission[] = PERMISSIONS.filter((p) => !["platform:manage", "admin:backup", "audit:view"].includes(p));
const has = (r: Role, p: Permission) => can(r, p);
const who = (p: Permission) => ROLES.filter((r) => has(r, p));
const subsets = (): ModuleKey[][] => Array.from({ length: 1 << MODULES.length }, (_, mask) => MODULES.filter((_, i) => mask & (1 << i)));

describe("RBAC — spec rules (README 'Multi-business model' / 'Who sees what')", () => {
  it("UT-RBAC-001 Super Admin has only platform:manage, admin:backup, audit:view — no hotel data", () => {
    expect([...ROLE_PERMISSIONS.SUPER_ADMIN].sort()).toEqual(["admin:backup", "audit:view", "platform:manage"]);
    for (const p of HOTEL_DATA) expect(has("SUPER_ADMIN", p), p).toBe(false);
  });

  it("UT-RBAC-002 only the Super Admin manages the platform and backups", () => {
    expect(who("platform:manage")).toEqual(["SUPER_ADMIN"]);
    expect(who("admin:backup")).toEqual(["SUPER_ADMIN"]);
  });

  it("UT-RBAC-003 only the Owner exports business data and manages outlets", () => {
    expect(who("data:export")).toEqual(["BUSINESS_OWNER"]);
    expect(who("outlet:manage")).toEqual(["BUSINESS_OWNER"]);
  });

  it("UT-RBAC-004 Bills and Settings pages: Owner, Manager, Cashier only", () => {
    expect(who("bills:view")).toEqual(["BUSINESS_OWNER", "OUTLET_MANAGER", "CASHIER"]);
    expect(who("settings:view")).toEqual(["BUSINESS_OWNER", "OUTLET_MANAGER", "CASHIER"]);
  });

  it("UT-RBAC-005 GST & tax settings: Owner and Manager (README: Manager or Owner)", () => {
    expect(who("settings:billing")).toEqual(["BUSINESS_OWNER", "OUTLET_MANAGER"]);
  });

  it("UT-RBAC-006 sales/profit/GST reports: Owner and Manager only (not Inventory)", () => {
    expect(who("report:view")).toEqual(["BUSINESS_OWNER", "OUTLET_MANAGER"]);
  });

  it("UT-RBAC-007 Inventory staff: stock work only", () => {
    expect([...ROLE_PERMISSIONS.INVENTORY_MANAGER].sort()).toEqual(["attendance:self", "inventory:manage", "inventory:view", "menu:view"]);
  });

  it("UT-RBAC-008 Delivery partners: own deliveries + own attendance only (no bills, no settings)", () => {
    expect([...ROLE_PERMISSIONS.DELIVERY].sort()).toEqual(["attendance:self", "delivery:own"]);
    expect(who("delivery:own")).toEqual(["DELIVERY"]);
  });

  it("UT-RBAC-009 Kitchen: view/update KOTs, cannot bill, pay or see bills", () => {
    expect(has("KITCHEN", "kot:view") && has("KITCHEN", "kot:update")).toBe(true);
    for (const p of ["order:create", "payment:collect", "bills:view", "settings:view", "order:cancel"] as Permission[]) expect(has("KITCHEN", p)).toBe(false);
  });

  it("UT-RBAC-010 Cashier: bills, payments, tables, reservations, delivery dispatch; no cancel, no staff, no reports", () => {
    for (const p of ["order:create", "payment:collect", "table:serve", "reservation:manage", "delivery:manage", "bills:view"] as Permission[]) expect(has("CASHIER", p), p).toBe(true);
    for (const p of ["order:cancel", "staff:manage", "report:view", "settings:billing", "offer:manage", "customer:manage"] as Permission[]) expect(has("CASHIER", p), p).toBe(false);
  });

  it("UT-RBAC-011 Manager = Owner minus outlet:manage and data:export", () => {
    const owner = new Set(ROLE_PERMISSIONS.BUSINESS_OWNER);
    const mgr = new Set(ROLE_PERMISSIONS.OUTLET_MANAGER);
    expect([...owner].filter((p) => !mgr.has(p)).sort()).toEqual(["data:export", "outlet:manage"]);
    expect([...mgr].every((p) => owner.has(p))).toBe(true);
  });

  it("UT-RBAC-012 every role's permissions are known permissions; labels exist for every role", () => {
    for (const r of ROLES) {
      for (const p of ROLE_PERMISSIONS[r]) expect(PERMISSIONS).toContain(p);
      expect(ROLE_LABELS[r]).toBeTruthy();
    }
  });
});

/**
 * Independent oracle (Phase 4 mutation testing showed the earlier checks were
 * tautological — they derived expectations from PERMISSION_MODULE / MODULE_INFO
 * themselves, so emptying those tables survived). These tables restate the spec.
 */
const SPEC_REQUIRES: Record<ModuleKey, ModuleKey[]> = {
  BILLING: [], KOT: ["BILLING"], TABLES: ["BILLING"], DELIVERY: ["BILLING"], RESERVATIONS: ["BILLING"],
  INVENTORY: [], CUSTOMERS: ["BILLING"], OFFERS: ["BILLING"], ATTENDANCE: [], REPORTS: [],
};
const SPEC_PERMISSION_MODULE: Partial<Record<Permission, ModuleKey>> = {
  "order:create": "BILLING", "order:view": "BILLING", "order:cancel": "BILLING", "payment:collect": "BILLING", "bills:view": "BILLING",
  "kot:view": "KOT", "kot:update": "KOT",
  "table:manage": "TABLES", "table:serve": "TABLES",
  "delivery:manage": "DELIVERY", "delivery:own": "DELIVERY",
  "reservation:manage": "RESERVATIONS",
  "inventory:view": "INVENTORY", "inventory:manage": "INVENTORY",
  "customer:view": "CUSTOMERS", "customer:manage": "CUSTOMERS",
  "offer:manage": "OFFERS",
  "attendance:self": "ATTENDANCE", "attendance:manage": "ATTENDANCE",
  "report:view": "REPORTS",
};

describe("modules — spec oracle (UT-MOD-SPEC)", () => {
  it("UT-MOD-SPEC-001 module dependencies match the spec table", () => {
    for (const m of MODULES) expect([...MODULE_INFO[m].requires].sort(), m).toEqual(SPEC_REQUIRES[m]);
    for (const m of MODULES) expect(normalizeModules([m]), m).toEqual(MODULES.filter((x) => x === m || SPEC_REQUIRES[m].includes(x)));
  });
  it("UT-MOD-SPEC-002 module-gated permissions match the spec table", () => {
    expect(PERMISSION_MODULE).toEqual(SPEC_PERMISSION_MODULE);
  });
  it("UT-MOD-SPEC-003 concrete examples: switching a module off removes exactly its features", () => {
    const all = normalizeModules([...MODULES]);
    const without = (m: ModuleKey) => normalizeModules(all.filter((x) => x !== m && !SPEC_REQUIRES[x].includes(m)));
    expect(effectivePermissions("KITCHEN", without("KOT"))).not.toContain("kot:view");
    expect(effectivePermissions("DELIVERY", without("DELIVERY"))).toEqual(["attendance:self"]);
    expect(effectivePermissions("DELIVERY", without("ATTENDANCE"))).toEqual(["delivery:own"]);
    expect(effectivePermissions("INVENTORY_MANAGER", without("INVENTORY"))).toEqual(["attendance:self", "menu:view"]);
    expect(effectivePermissions("INVENTORY_MANAGER", ["ATTENDANCE"])).toEqual(["attendance:self"]); // no menu without BILLING/INVENTORY
    expect(effectivePermissions("CASHIER", ["BILLING"])).toEqual(["menu:view", "order:create", "order:view", "payment:collect", "bills:view", "settings:view"]);
    expect(effectivePermissions("BUSINESS_OWNER", without("REPORTS"))).not.toContain("report:view");
    expect(effectivePermissions("OUTLET_MANAGER", [])).toEqual(["settings:billing", "settings:outlet", "staff:manage", "staff:view", "audit:view", "settings:view"]);
  });
  it("UT-MOD-SPEC-004 every module has a non-empty label and description (shown in the platform console)", () => {
    for (const m of MODULES) {
      expect(MODULE_INFO[m].label.length, m).toBeGreaterThan(2);
      expect(MODULE_INFO[m].description.length, m).toBeGreaterThan(5);
    }
  });
});

describe("modules — dependencies and permission gating", () => {
  it("UT-MOD-001 every module that needs Billing gets it automatically (e.g. Tables → Billing)", () => {
    for (const m of MODULES) expect(normalizeModules([m])).toEqual(MODULES.filter((x) => x === m || MODULE_INFO[m].requires.includes(x)));
    expect(normalizeModules(["TABLES"])).toEqual(["BILLING", "TABLES"]);
  });

  it("UT-MOD-002 normalizeModules drops unknown keys, dedupes, keeps canonical order, is idempotent (all 1,024 subsets)", () => {
    expect(normalizeModules(["REPORTS", "NOPE", "BILLING", "BILLING"])).toEqual(["BILLING", "REPORTS"]);
    for (const s of subsets()) {
      const n = normalizeModules([...s].reverse());
      expect(normalizeModules(n)).toEqual(n);
      for (const m of n) for (const r of MODULE_INFO[m].requires) expect(n).toContain(r);
    }
  });

  it("UT-MOD-003 every module-gated permission maps to a real module", () => {
    for (const [p, m] of Object.entries(PERMISSION_MODULE)) {
      expect(PERMISSIONS).toContain(p);
      expect(MODULES).toContain(m);
    }
  });

  it("UT-MOD-004 exhaustive: effective = role ∩ enabled modules, for 7 roles × 1,024 module sets", () => {
    let checked = 0;
    for (const raw of subsets()) {
      const mods = normalizeModules(raw);
      for (const role of ROLES) {
        const eff = new Set(effectivePermissions(role, mods));
        for (const p of PERMISSIONS) {
          const m = PERMISSION_MODULE[p];
          const menu = p === "menu:view" || p === "menu:manage";
          const enabled = menu ? mods.includes("BILLING") || mods.includes("INVENTORY") : !m || mods.includes(m);
          expect(eff.has(p), `${role} ${p} [${mods.join(",")}]`).toBe(has(role, p) && enabled);
          checked++;
        }
      }
    }
    expect(checked).toBe(1024 * ROLES.length * PERMISSIONS.length);
  });

  it("UT-MOD-005 logins, staff and settings are always on (never module-gated)", () => {
    for (const p of ["staff:manage", "staff:view", "settings:view", "settings:outlet", "settings:billing", "outlet:manage", "audit:view", "data:export"] as Permission[]) {
      expect(PERMISSION_MODULE[p]).toBeUndefined();
      expect(permissionEnabled(p, [])).toBe(true);
    }
  });

  it("UT-MOD-006 platform context (modules = null) enables every permission the role has", () => {
    for (const r of ROLES) expect(effectivePermissions(r, null)).toEqual(PERMISSIONS.filter((p) => has(r, p)));
  });
});

describe("truth table snapshot", () => {
  const matrix = Object.fromEntries(ROLES.map((r) => [r, PERMISSIONS.filter((p) => has(r, p)).join(" ")]));

  it("UT-RBAC-100 role × permission matrix (review any diff with the product owner)", () => {
    expect(matrix).toMatchSnapshot();
  });

  if (process.env.WRITE_RBAC_TABLE) {
    it("writes docs/qa/RBAC_TRUTH_TABLE.md", () => {
      const short: Record<Role, string> = { SUPER_ADMIN: "SA", BUSINESS_OWNER: "Owner", OUTLET_MANAGER: "Mgr", CASHIER: "Cash", KITCHEN: "Kit", DELIVERY: "Del", INVENTORY_MANAGER: "Inv" };
      const rows = PERMISSIONS.map((p) => `| \`${p}\` | ${PERMISSION_MODULE[p] ?? (p.startsWith("menu:") ? "BILLING or INVENTORY" : "always on")} | ${ROLES.map((r) => (has(r, p) ? "✅" : "·")).join(" | ")} |`);
      const md = [
        "# RBAC truth table",
        "",
        "Generated from `packages/shared/src/rbac.ts` + `modules.ts` by `rbac.test.ts` (`WRITE_RBAC_TABLE=1`). A permission is **effective** only when the role has it **and** its module is enabled for the business. Snapshot-tested: any change fails CI until reviewed.",
        "",
        `| Permission | Module | ${ROLES.map((r) => short[r]).join(" | ")} |`,
        `|---|---|${ROLES.map(() => ":-:").join("|")}|`,
        ...rows,
        "",
      ].join("\n");
      fs.writeFileSync(path.join(__dirname, "../../../docs/qa/RBAC_TRUTH_TABLE.md"), md);
    });
  }
});
