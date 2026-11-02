/**
 * CANAVO SMOKE suite (@smoke) — black-box HTTP checks against a RUNNING API.
 *
 * Budget: < 15 minutes (normally < 30 s). Proves the build is alive enough to
 * be worth deeper testing: every role can log in, a bill can be created and
 * paid, its KOT reaches the kitchen, reports load, privacy walls hold, and
 * logout revokes the session.
 *
 *   SMOKE_BASE_URL   API base URL            (default http://localhost:4000)
 *   SMOKE_PASSWORD   password for all roles  (default Canavo@123 — dev seed only)
 *   SMOKE_DOMAIN     login email domain      (default canavo.local)
 *   SMOKE_READONLY=1 skip steps that write data (bill, payment, KOT update)
 *
 * Run:  npm run test:smoke -w @canavo/api
 * NEVER point this at production with demo credentials — see docs/qa/SANITY_CHECKLIST.md.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const BASE = (process.env.SMOKE_BASE_URL ?? "http://localhost:4000").replace(/\/$/, "");
const PASSWORD = process.env.SMOKE_PASSWORD ?? "Canavo@123";
const DOMAIN = process.env.SMOKE_DOMAIN ?? "canavo.local";
const READONLY = process.env.SMOKE_READONLY === "1";

const ROLES = {
  admin: "SUPER_ADMIN",
  owner: "BUSINESS_OWNER",
  manager: "OUTLET_MANAGER",
  cashier: "CASHIER",
  kitchen: "KITCHEN",
  inventory: "INVENTORY_MANAGER",
  delivery: "DELIVERY",
} as const;
type Login = keyof typeof ROLES;

interface Session {
  accessToken: string;
  refreshToken: string;
  outletId?: string;
  permissions: string[];
}
const sessions = {} as Record<Login, Session>;

async function call(method: string, path: string, opts: { as?: Login; body?: unknown; outlet?: string | null } = {}) {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  if (opts.as) {
    const s = sessions[opts.as];
    headers.authorization = `Bearer ${s.accessToken}`;
    const outlet = opts.outlet === undefined ? s.outletId : opts.outlet;
    if (outlet) headers["x-outlet-id"] = outlet;
  }
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  let json: any = undefined;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = text;
  }
  return { status: res.status, json };
}

const started = Date.now();
afterAll(() => {
  const secs = (Date.now() - started) / 1000;
  console.info(`[smoke] finished in ${secs.toFixed(1)} s against ${BASE}`);
  expect(secs).toBeLessThan(15 * 60);
});

describe("@smoke CANAVO", () => {
  beforeAll(async () => {
    const res = await fetch(`${BASE}/health`).catch(() => null);
    if (!res?.ok) throw new Error(`API not reachable at ${BASE}/health — start it first`);
  });

  it("SMK-001 @smoke /health returns ok", async () => {
    const r = await call("GET", "/health");
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ ok: true });
  });

  it("SMK-002 @smoke unauthenticated request is refused (401)", async () => {
    const r = await call("GET", "/orders");
    expect(r.status).toBe(401);
  });

  it("SMK-003 @smoke wrong password is refused (401) without leaking which part was wrong", async () => {
    const r = await call("POST", "/auth/login", { body: { email: `cashier@${DOMAIN}`, password: "definitely-wrong-1" } });
    expect(r.status).toBe(401);
    expect(String(r.json?.error ?? r.json?.message ?? "")).toMatch(/invalid email or password/i);
  });

  describe.each(Object.entries(ROLES) as [Login, string][])("SMK-01x @smoke login as %s", (login, role) => {
    it(`logs in and /auth/me reports role ${role}`, async () => {
      const r = await call("POST", "/auth/login", { body: { email: `${login}@${DOMAIN}`, password: PASSWORD } });
      expect(r.status, JSON.stringify(r.json)).toBe(200);
      expect(typeof r.json.accessToken).toBe("string");
      expect(typeof r.json.refreshToken).toBe("string");
      sessions[login] = { accessToken: r.json.accessToken, refreshToken: r.json.refreshToken, permissions: [] };

      const me = await call("GET", "/auth/me", { as: login, outlet: null });
      expect(me.status).toBe(200);
      expect(me.json.role).toBe(role);
      expect(me.json).not.toHaveProperty("passwordHash");
      expect(me.json).not.toHaveProperty("pinHash");
      sessions[login].permissions = me.json.permissions;
      sessions[login].outletId = me.json.outlets?.[0]?.id;
      if (role === "SUPER_ADMIN") {
        expect(me.json.outlets).toEqual([]);
        expect(me.json.permissions).not.toContain("order:view");
      } else {
        expect(me.json.outlets.length).toBeGreaterThan(0);
      }
    });
  });

  it("SMK-020 @smoke super admin sees the platform console but is refused hotel data (403)", async () => {
    expect((await call("GET", "/platform/summary", { as: "admin" })).status).toBe(200);
    const r = await call("GET", "/orders", { as: "admin", outlet: sessions.owner.outletId });
    expect(r.status).toBe(403);
  });

  it("SMK-021 @smoke cashier loads the menu", async () => {
    const r = await call("GET", "/menu", { as: "cashier" });
    expect(r.status).toBe(200);
    expect(Array.isArray(r.json.items)).toBe(true);
    expect(r.json.items.length).toBeGreaterThan(0);
  });

  const bill: { id?: string; invoiceNumber?: string; grandTotal?: number; clientOrderId: string; body?: unknown } = {
    clientOrderId: randomUUID(),
  };

  it.skipIf(READONLY)("SMK-030 @smoke cashier creates a takeaway bill (server-computed integer paise)", async () => {
    const menu = await call("GET", "/menu", { as: "cashier" });
    const item = menu.json.items.find((i: any) => i.status === "AVAILABLE" && !(i.variants ?? []).length);
    expect(item, "need one AVAILABLE item without sizes").toBeTruthy();
    bill.body = {
      clientOrderId: bill.clientOrderId,
      orderType: "TAKEAWAY",
      notes: "SMOKE TEST — safe to ignore",
      items: [{ menuItemId: item.id, quantity: 2 }],
    };
    const r = await call("POST", "/orders", { as: "cashier", body: bill.body });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    expect(r.json.status).toBe("OPEN");
    expect(r.json.invoiceNumber).toMatch(/^[A-Z0-9-]{1,16}$/);
    for (const k of ["subtotal", "taxableValue", "cgst", "sgst", "igst", "grandTotal"]) {
      expect(Number.isInteger(r.json[k]), `${k} must be integer paise`).toBe(true);
      expect(r.json[k]).toBeGreaterThanOrEqual(0);
    }
    expect(r.json.grandTotal % 100, "grand total rounds to the rupee").toBe(0);
    Object.assign(bill, { id: r.json.id, invoiceNumber: r.json.invoiceNumber, grandTotal: r.json.grandTotal });
  });

  it.skipIf(READONLY)("SMK-031 @smoke re-sending the same clientOrderId is idempotent (200, same bill)", async () => {
    const r = await call("POST", "/orders", { as: "cashier", body: bill.body });
    expect(r.status).toBe(200);
    expect(r.json.id).toBe(bill.id);
    expect(r.json.invoiceNumber).toBe(bill.invoiceNumber);
  });

  let kotId: string | undefined;
  it.skipIf(READONLY)("SMK-040 @smoke the bill's KOT appears on the kitchen display", async () => {
    const r = await call("GET", "/kot", { as: "kitchen" });
    expect(r.status).toBe(200);
    const kot = r.json.find((k: any) => k.orderId === bill.id);
    expect(kot, "KOT for the smoke bill").toBeTruthy();
    expect(kot.status).toBe("RECEIVED");
    kotId = kot.id;
  });

  it.skipIf(READONLY)("SMK-041 @smoke kitchen moves the KOT RECEIVED → PREPARING → READY", async () => {
    for (const status of ["PREPARING", "READY"]) {
      const r = await call("PATCH", `/kot/${kotId}`, { as: "kitchen", body: { status } });
      expect(r.status).toBe(200);
      expect(r.json.status).toBe(status);
    }
  });

  it.skipIf(READONLY)("SMK-050 @smoke cashier collects full cash payment and the bill becomes PAID", async () => {
    const r = await call("POST", `/orders/${bill.id}/payments`, {
      as: "cashier",
      body: { payments: [{ mode: "CASH", amount: bill.grandTotal }], tendered: bill.grandTotal! + 5000 },
    });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(r.json.paid).toBe(true);
    expect(r.json.balance).toBe(0);
    expect(r.json.change).toBe(5000);
    expect(r.json.order.status).toBe("PAID");
  });

  it.skipIf(READONLY)("SMK-051 @smoke receipt renders for the paid bill", async () => {
    const r = await call("GET", `/orders/${bill.id}/receipt`, { as: "cashier" });
    expect(r.status).toBe(200);
  });

  it("SMK-060 @smoke manager loads the sales report and daily summary", async () => {
    expect((await call("GET", "/reports/sales", { as: "manager" })).status).toBe(200);
    expect((await call("GET", "/reports/daily", { as: "manager" })).status).toBe(200);
  });

  it("SMK-061 @smoke owner sees the bill history", async () => {
    const r = await call("GET", "/orders?limit=5", { as: "owner" });
    expect(r.status).toBe(200);
    if (!READONLY) expect(JSON.stringify(r.json)).toContain(bill.invoiceNumber!);
  });

  it("SMK-070 @smoke inventory manager sees stock but NOT sales reports (403)", async () => {
    expect((await call("GET", "/inventory/items", { as: "inventory" })).status).toBe(200);
    expect((await call("GET", "/reports/sales", { as: "inventory" })).status).toBe(403);
  });

  it("SMK-071 @smoke kitchen cannot create bills (403)", async () => {
    const r = await call("POST", "/orders", { as: "kitchen", body: { orderType: "TAKEAWAY", items: [{ menuItemId: "x", quantity: 1 }] } });
    expect(r.status).toBe(403);
  });

  it("SMK-072 @smoke delivery partner sees own deliveries only endpoint", async () => {
    expect((await call("GET", "/delivery/mine", { as: "delivery" })).status).toBe(200);
    expect((await call("GET", "/delivery", { as: "delivery" })).status).toBe(403);
  });

  it("SMK-080 @smoke logout revokes the refresh token", async () => {
    const { refreshToken } = sessions.cashier;
    expect((await call("POST", "/auth/logout", { body: { refreshToken } })).status).toBe(204);
    const r = await call("POST", "/auth/refresh", { body: { refreshToken } });
    expect(r.status).toBe(401);
  });
});
