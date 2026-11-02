/**
 * Route-guard policy (Phase 3 audit, kept as a regression gate). Walks the real
 * Express app — see route-inventory.ts.
 *
 *  - Every route is authenticated unless it is in PUBLIC (reviewed).
 *  - Every authenticated route has a permission guard (role ∩ module) or the
 *    platform-admin guard, unless it is in HANDLER_AUTHZ (reviewed: the handler
 *    itself scopes to the caller — own records, own deliveries, etc.).
 *  - A NEW route that fits neither fails until someone reviews it and either
 *    adds a guard or adds it here with the reason.
 *
 * WRITE_ROUTE_INVENTORY=1 also writes docs/qa/ROUTE_GUARDS.md.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { routeInventory, type RouteEntry } from "./route-inventory";

const PUBLIC: Record<string, string> = {
  "POST /auth/login": "login (IP rate limited, account lockout)",
  "POST /auth/logout": "takes the refresh token itself",
  "POST /auth/otp/request": "login (IP rate limited, enumeration-safe)",
  "POST /auth/otp/verify": "login (IP rate limited, OTP attempts)",
  "POST /auth/refresh": "takes the refresh token itself",
  "GET /health": "liveness probe",
  "GET /openapi.json": "API description (see SA-CFG-02: disable in production)",
  "GET /public/receipts/:token": "signed JWT link (RECEIPT_LINK_SECRET, 90 d)",
  "GET /uploads/files/:name": "random file names, strict name regex",
  "POST /webhooks/razorpay": "HMAC signature, fails closed without a secret",
};

const HANDLER_AUTHZ: Record<string, string> = {
  "GET /auth/me": "own profile",
  "GET /outlets": "own outlets; fields trimmed without settings:view",
  "GET /outlets/current": "requireOutlet; fields trimmed without settings:view",
  "GET /outlets/current/shifts": "requireOutlet; shift names/times only",
  "GET /attendance/calendar": "own, or attendance:manage + same business/outlet (BUG-005)",
  "GET /attendance/leaves": "own, or scoped listing for attendance:manage",
  "GET /attendance/me/status": "own",
  "GET /notifications": "userId = caller",
  "POST /notifications/:id/read": "userId = caller",
  "POST /notifications/:id/unread": "userId = caller",
  "POST /notifications/devices": "own device token (see SA-NTF-01)",
  "DELETE /notifications/devices/:token": "userId = caller",
  "DELETE /notifications/read": "userId = caller",
  "POST /notifications/read-all": "userId = caller",
  "GET /delivery/:id": "delivery:manage or assigned agent (canSee)",
  "POST /delivery/:id/collect": "delivery:manage or assigned agent",
  "POST /delivery/:id/complete": "delivery:manage or assigned agent",
  "POST /delivery/:id/issue": "delivery:manage or assigned agent",
  "PATCH /delivery/:id/status": "delivery:manage or assigned agent; agents can't cancel",
  "POST /delivery/:id/upi-qr": "delivery:manage or assigned agent",
  "POST /delivery/:id/upi-qr/:paymentId/confirm": "delivery:manage or assigned agent",
  "GET /tax-rates": "requireBusiness + requireAnyPermission (local guard)",
  "GET /tax-rates/:id": "requireBusiness + requireAnyPermission (local guard)",
  "GET /admin/settings": "requireSettingsAccess (+ super-admin IP whitelist)",
  "GET /admin/settings/:scope/:key": "requireSettingsAccess",
  "PUT /admin/settings/:scope/:key": "requireSettingsAccess",
  "POST /uploads/image": "any signed-in user; magic-byte check, 5 MB",
  "GET /uploads/signature": "any signed-in user; 404 unless Cloudinary configured",
};

const key = (r: RouteEntry) => `${r.method} ${r.path}`;

describe("@critical @regression route guard policy (Phase 3)", async () => {
  const routes = await routeInventory();

  it("SA-RT-000 the inventory sees the whole API", () => {
    expect(routes.length).toBeGreaterThanOrEqual(250);
  });

  it("SA-RT-001 every non-public route is authenticated", () => {
    const missing = routes.filter((r) => !r.authenticate && !PUBLIC[key(r)]).map(key);
    expect(missing).toEqual([]);
  });

  it("SA-RT-002 every authenticated route has a permission/platform guard or a reviewed handler-level check", () => {
    const unguarded = routes
      .filter((r) => r.authenticate && r.authz !== "permission" && r.authz !== "platform-admin" && !HANDLER_AUTHZ[key(r)])
      .map(key);
    expect(unguarded).toEqual([]);
  });

  it("SA-RT-003 the reviewed lists have no stale entries", () => {
    const all = new Set(routes.map(key));
    expect(Object.keys({ ...PUBLIC, ...HANDLER_AUTHZ }).filter((k) => !all.has(k))).toEqual([]);
  });

  it("SA-RT-004 the platform console is platform-admin only", () => {
    expect(routes.filter((r) => r.path.startsWith("/platform") && !r.platformAdmin).map(key)).toEqual([]);
  });

  if (process.env.WRITE_ROUTE_INVENTORY) {
    it("writes docs/qa/ROUTE_GUARDS.md", () => {
      const row = (r: RouteEntry) =>
        `| ${r.method} | \`${r.path}\` | ${r.authenticate ? "✓" : "—"} | ${r.outlet === "none" ? "" : r.outlet} | ${r.modules.join(", ")} | ${r.platformAdmin ? "platform-admin" : r.permissions.join(", ")} | ${[...r.custom, ...(r.anonymous ? [`${r.anonymous} inline`] : [])].join(", ")} | ${PUBLIC[key(r)] ?? HANDLER_AUTHZ[key(r)] ?? ""} |`;
      const md = [
        "# Route guard inventory",
        "",
        `Generated by \`apps/api/test/static/route-guards.test.ts\` from the live Express app (${routes.length} endpoints). Regenerate: \`WRITE_ROUTE_INVENTORY=1 npx vitest run test/static/route-guards.test.ts\` in apps/api.`,
        "",
        "| Method | Path | Auth | Outlet | Module(s) | Permission | Other guards | Reviewed note |",
        "|---|---|---|---|---|---|---|---|",
        ...routes.map(row),
        "",
      ].join("\n");
      fs.writeFileSync(path.join(__dirname, "../../../../docs/qa/ROUTE_GUARDS.md"), md);
    });
  }
});
