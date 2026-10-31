/**
 * @smoke — 15-minute health check of a running CANAVO stack (actual run ≈ 10 s).
 * Covers: login per role, role-correct permissions, create a bill, KOT appears
 * (REST + live socket), payment, report loads, report blocked for a non-reporting
 * role, Super Admin refused hotel data, logout revokes the session.
 *
 * Env: SMOKE_API_URL (default http://localhost:4000), SMOKE_PASSWORD (default demo
 * password), SMOKE_OUTLET (default "CANAVO Canteen"). Never point it at production
 * with demo credentials; production has no demo users.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { io, type Socket } from "socket.io-client";

const API = (process.env.SMOKE_API_URL ?? "http://localhost:4000").replace(/\/$/, "");
const PASSWORD = process.env.SMOKE_PASSWORD ?? "Canavo@123";
const OUTLET = process.env.SMOKE_OUTLET ?? "CANAVO Canteen";

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
interface Session {
  email: string;
  token: string;
  refreshToken: string;
  me: Json;
  outletId?: string;
  call: (method: string, path: string, body?: unknown) => Promise<{ status: number; body: Json }>;
}

async function login(email: string): Promise<Session> {
  const res = await fetch(`${API}/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  expect(res.status, `login ${email}`).toBe(200);
  const tokens = (await res.json()) as Json;
  const meRes = await fetch(`${API}/auth/me`, { headers: { authorization: `Bearer ${tokens.accessToken}` } });
  expect(meRes.status).toBe(200);
  const me = (await meRes.json()) as Json;
  const outletId = (me.outlets as Json[]).find((o) => o.name === OUTLET)?.id as string | undefined;
  const call = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(`${API}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${tokens.accessToken}`,
        ...(outletId && { "x-outlet-id": outletId }),
        ...(body !== undefined && { "content-type": "application/json" }),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    let parsed: Json = {};
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = { raw: text };
    }
    return { status: r.status, body: parsed };
  };
  return { email, token: tokens.accessToken, refreshToken: tokens.refreshToken, me, outletId, call };
}

const ROLES = [
  { email: "admin@canavo.local", role: "SUPER_ADMIN" },
  { email: "owner@canavo.local", role: "BUSINESS_OWNER" },
  { email: "manager@canavo.local", role: "OUTLET_MANAGER" },
  { email: "cashier@canavo.local", role: "CASHIER" },
  { email: "kitchen@canavo.local", role: "KITCHEN" },
  { email: "inventory@canavo.local", role: "INVENTORY_MANAGER" },
  { email: "delivery@canavo.local", role: "DELIVERY" },
] as const;

const S: Record<string, Session> = {};
let orderId: string | undefined;
let socket: Socket | undefined;

beforeAll(async () => {
  const health = await fetch(`${API}/health`).catch(() => null);
  if (!health?.ok) throw new Error(`API not reachable at ${API}/health. Start the stack first.`);
});

afterAll(async () => {
  socket?.disconnect();
  if (orderId && S.manager) await S.manager.call("POST", `/orders/${orderId}/cancel`, { reason: "smoke test cleanup" });
});

describe("@smoke CANAVO", () => {
  it("TC-SMK-001 API health", async () => {
    const r = await fetch(`${API}/health`);
    expect(r.status).toBe(200);
    expect(((await r.json()) as Json).ok).toBe(true);
  });

  it.each(ROLES)("TC-SMK-002 login as $role ($email)", async ({ email, role }) => {
    const s = await login(email);
    expect(s.me.role).toBe(role);
    S[role === "BUSINESS_OWNER" ? "owner" : role === "OUTLET_MANAGER" ? "manager" : role.toLowerCase()] = s;
  });

  it("TC-SMK-003 role permissions are correct", () => {
    const perms = (k: string) => S[k]!.me.permissions as string[];
    expect(S.super_admin!.me.platformAdmin).toBe(true);
    expect(S.super_admin!.me.outlets).toHaveLength(0);
    expect(perms("super_admin").sort()).toEqual(["admin:backup", "audit:view", "platform:manage"]);
    expect(perms("cashier")).toContain("order:create");
    expect(perms("cashier")).not.toContain("report:view");
    expect(perms("kitchen")).toContain("kot:view");
    expect(perms("inventory_manager")).not.toContain("report:view");
    expect(perms("delivery")).toContain("delivery:own");
    expect(perms("owner")).toContain("report:view");
    for (const k of ["owner", "manager", "cashier", "kitchen", "inventory_manager", "delivery"]) {
      expect(S[k]!.outletId, `${k} has the smoke outlet`).toBeTruthy();
    }
  });

  it("TC-SMK-004 kitchen display is connected live", async () => {
    socket = io(API, { auth: { token: S.kitchen!.token, outletId: S.kitchen!.outletId }, transports: ["websocket"] });
    await new Promise<void>((resolve, reject) => {
      socket!.once("connect", () => resolve());
      socket!.once("connect_error", (e) => reject(e));
      setTimeout(() => reject(new Error("socket connect timeout")), 10_000);
    });
    expect(socket.connected).toBe(true);
  });

  it("TC-SMK-005 cashier creates a bill, KOT is created and pushed live to the kitchen", async () => {
    const menu = await S.cashier!.call("GET", "/menu");
    expect(menu.status).toBe(200);
    const item = (menu.body.items as Json[]).find((i) => i.status === "AVAILABLE" && !(i.variants as Json[]).length && !i.availableFrom);
    expect(item, "an always-available item without sizes").toBeTruthy();
    const live = new Promise<Json[]>((resolve, reject) => {
      socket!.once("kot:new", (kots: Json[]) => resolve(kots));
      setTimeout(() => reject(new Error("no kot:new within 10 s")), 10_000);
    });
    const order = await S.cashier!.call("POST", "/orders", {
      orderType: "TAKEAWAY",
      items: [{ menuItemId: item!.id, quantity: 1 }],
      notes: "SMOKE TEST — ignore",
    });
    expect(order.status).toBe(201);
    orderId = order.body.id;
    expect(order.body.grandTotal).toBeGreaterThan(0);
    expect(Number.isInteger(order.body.grandTotal)).toBe(true);
    expect(order.body.kots?.length ?? 0).toBeGreaterThan(0);
    const pushed = await live;
    expect(pushed.some((k) => k.orderId === orderId)).toBe(true);
  });

  it("TC-SMK-006 KOT appears on the kitchen list", async () => {
    const r = await S.kitchen!.call("GET", "/kot");
    expect(r.status).toBe(200);
    const list = (Array.isArray(r.body) ? r.body : (r.body.items ?? [])) as Json[];
    expect(list.some((k) => k.orderId === orderId || k.order?.id === orderId)).toBe(true);
  });

  it("TC-SMK-007 cashier takes cash payment, bill becomes PAID", async () => {
    const o = await S.cashier!.call("GET", `/orders/${orderId}`);
    expect(o.status).toBe(200);
    const pay = await S.cashier!.call("POST", `/orders/${orderId}/payments`, { payments: [{ mode: "CASH", amount: o.body.grandTotal }] });
    expect(pay.status, JSON.stringify(pay.body)).toBe(200);
    const after = await S.cashier!.call("GET", `/orders/${orderId}`);
    expect(after.body.status).toBe("PAID");
  });

  it("TC-SMK-008 owner opens the sales report", async () => {
    const r = await S.owner!.call("GET", "/reports/sales");
    expect(r.status).toBe(200);
    expect(r.body).toBeTypeOf("object");
  });

  it("TC-SMK-009 report is refused for a non-reporting role (inventory)", async () => {
    expect((await S.inventory_manager!.call("GET", "/reports/sales")).status).toBe(403);
  });

  it("TC-SMK-010 Super Admin is refused hotel data", async () => {
    const r = await fetch(`${API}/orders?limit=1`, { headers: { authorization: `Bearer ${S.super_admin!.token}`, "x-outlet-id": S.cashier!.outletId! } });
    expect(r.status).toBe(403);
  });

  it("TC-SMK-011 logout revokes the refresh token", async () => {
    const s = await login("cashier@canavo.local");
    const out = await fetch(`${API}/auth/logout`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ refreshToken: s.refreshToken }) });
    expect(out.status).toBe(204);
    const refresh = await fetch(`${API}/auth/refresh`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ refreshToken: s.refreshToken }) });
    expect(refresh.status).toBe(401);
  });
});
