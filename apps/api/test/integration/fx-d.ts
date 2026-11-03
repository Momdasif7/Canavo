/**
 * Phase 5 module group D fixtures: delivery-ready tenants, extra delivery
 * partners, on-duty records, delivery orders and a cached login per user
 * (POST /auth/login is rate-limited to 50/15 min per IP).
 */
import bcrypt from "bcryptjs";
import { distanceMeters } from "@canavo/shared";
import request from "supertest";
import { app, createTenant, db, loginAs } from "./helpers";
import { runForOutlet } from "../../src/lib/tenant";
import { signAccess } from "../../src/lib/tokens";

export type Agent = Awaited<ReturnType<typeof loginAs>>;
export type Tenant = Awaited<ReturnType<typeof createTenant>>;

/** Outlet location used by every group-D tenant (Chennai Central). */
export const OUTLET_LAT = 13.0827;
export const OUTLET_LNG = 80.2707;

/**
 * Agent bound to a freshly signed access token (same claims as POST /auth/login).
 * Avoids the 50-per-15-min login limiter; signing uses the current (possibly
 * faked) clock, so call it again after vi.setSystemTime.
 */
export async function mint(email: string, outletId?: string): Promise<Agent> {
  const u = await db.user.findUniqueOrThrow({ where: { email }, select: { id: true, role: true, tokenVersion: true } });
  const token = signAccess(u);
  const h = (r: request.Test) => {
    r.set("authorization", `Bearer ${token}`);
    if (outletId) r.set("x-outlet-id", outletId);
    return r;
  };
  return {
    token,
    get: (p: string) => h(request(app).get(p)),
    post: (p: string, body?: object) => h(request(app).post(p)).send(body),
    patch: (p: string, body?: object) => h(request(app).patch(p)).send(body),
    put: (p: string, body?: object) => h(request(app).put(p)).send(body),
    delete: (p: string) => h(request(app).delete(p)),
  };
}

const cache = new Map<string, Agent>();
/** One agent per (email, outlet), reused. */
export async function as(email: string, outletId?: string): Promise<Agent> {
  const key = `${email}|${outletId ?? ""}`;
  let a = cache.get(key);
  if (!a) {
    a = await mint(email, outletId);
    cache.set(key, a);
  }
  return a;
}
export { loginAs };

let seq = 0;
const tag = () => `${Date.now().toString(36)}${(seq++).toString(36)}`;
export const phone = () => `9${String(Math.floor(Math.random() * 1e9)).padStart(9, "0")}`;

/** Point `meters` due north of the outlet; asserts the rounded haversine distance is exact. */
export function pointAt(meters: number, lat = OUTLET_LAT, lng = OUTLET_LNG) {
  const p = { latitude: lat + meters / ((6371000 * Math.PI) / 180), longitude: lng };
  const d = Math.round(distanceMeters(p, { latitude: lat, longitude: lng }));
  if (d !== meters) throw new Error(`pointAt(${meters}) gave ${d}`);
  return p;
}

/** IST calendar date of an instant (YYYY-MM-DD). */
export const istDate = (d = new Date()) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(d);

export interface DeliveryTenant extends Tenant {
  itemId: string;
  manager: Agent;
  cashier: Agent;
  owner: Agent;
  /** Create a menu item at the given price (paise, no GST). */
  item: (price: number) => Promise<string>;
}

/**
 * Tenant whose outlet has coordinates, a geofence, delivery enabled, the given
 * dispatch limit, no GST and no round-off (so grandTotal = item price + fee).
 */
export async function deliveryTenant(opts: { max?: number; modules?: string[]; withCoords?: boolean } = {}): Promise<DeliveryTenant> {
  const t = await createTenant({ name: `D Tenant ${tag()}`, modules: opts.modules });
  await db.outlet.update({
    where: { id: t.outlet.id },
    data: {
      ...(opts.withCoords !== false && { latitude: OUTLET_LAT, longitude: OUTLET_LNG }),
      geofenceMeters: 150,
      deliveryEnabled: true,
      maxDeliveriesPerPartner: opts.max ?? 2,
      upiVpa: "dtest@upi",
      gstEnabled: false,
      roundOff: false,
      packagingCharge: 0,
    },
  });
  const cat = await db.menuCategory.create({ data: { businessId: t.business.id, name: "Mains" } });
  const item = async (price: number) =>
    (await db.menuItem.create({ data: { businessId: t.business.id, categoryId: cat.id, name: `Item ${price} ${tag()}`, price, gstRate: 0 } })).id;
  const itemId = await item(10000);
  const [manager, cashier, owner] = await Promise.all([
    as(t.users.OUTLET_MANAGER.email, t.outlet.id),
    as(t.users.CASHIER.email, t.outlet.id),
    as(t.users.BUSINESS_OWNER.email, t.outlet.id),
  ]);
  return { ...t, itemId, item, manager, cashier, owner };
}

/** Extra DELIVERY user linked to the outlet. `name` controls ordering in partner lists. */
export async function addPartner(t: Tenant, name: string, opts: { pin?: string } = {}) {
  const email = `dp.${tag()}@it.canavo.test`;
  const u = await db.user.create({
    data: {
      businessId: t.business.id,
      name,
      email,
      phone: phone(),
      role: "DELIVERY",
      passwordHash: await bcrypt.hash("Canavo@123", 4),
      ...(opts.pin && { pinHash: await bcrypt.hash(opts.pin, 4) }),
      outlets: { create: { outletId: t.outlet.id } },
    },
  });
  return { id: u.id, email, name };
}

/** Put a partner on duty (open PRESENT attendance record) at the outlet. */
export async function onDuty(userId: string, outletId: string) {
  return db.staffAttendance.create({
    data: { userId, outletId, workDate: istDate(), clockInAt: new Date(), clockInDistance: 5, status: "PRESENT" },
  });
}

export interface OrderOpts {
  price?: number;
  itemId?: string;
  cod?: boolean;
  agentId?: string;
  forceAssign?: boolean;
  latitude?: number;
  longitude?: number;
  zoneId?: string;
}

/** POS delivery order (no payment taken). Returns the raw response. */
export async function postDeliveryOrder(t: DeliveryTenant, by: Agent, o: OrderOpts = {}) {
  const itemId = o.itemId ?? (o.price !== undefined ? await t.item(o.price) : t.itemId);
  return by.post("/orders", {
    orderType: "DELIVERY",
    customerName: "Ravi Kumar",
    customerPhone: phone(),
    items: [{ menuItemId: itemId, quantity: 1 }],
    delivery: {
      address: "12 Anna Salai, Chennai",
      ...(o.latitude !== undefined && { latitude: o.latitude, longitude: o.longitude }),
      ...(o.zoneId && { zoneId: o.zoneId }),
      ...(o.agentId && { agentId: o.agentId }),
      ...(o.forceAssign && { forceAssign: true }),
      ...(o.cod !== undefined && { cod: o.cod }),
    },
  });
}

/** Create a delivery order and return its order + delivery rows. */
export async function deliveryOrder(t: DeliveryTenant, o: OrderOpts = {}, by?: Agent) {
  const res = await postDeliveryOrder(t, by ?? t.cashier, o);
  if (res.status !== 201) throw new Error(`order → ${res.status} ${JSON.stringify(res.body)}`);
  const delivery = await db.delivery.findUniqueOrThrow({ where: { orderId: res.body.id } });
  return { order: res.body as { id: string; grandTotal: number; invoiceNumber: string }, delivery };
}

/** Run a service function inside the outlet's tenant context. */
export const inOutlet = <T>(outletId: string, fn: () => Promise<T>) => runForOutlet(outletId, fn);

/** Poll until `fn` returns truthy (background jobs fired after a response). */
export async function waitFor<T>(fn: () => Promise<T>, ms = 3000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v || Date.now() > end) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
