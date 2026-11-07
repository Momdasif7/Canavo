/**
 * Delivery with or without a map (Setting `delivery.location`, per outlet):
 * - MAP (default): pin + zones by distance, unchanged.
 * - ADDRESS: typed address + landmark (+ PIN code), one flat fee, optional min order / ETA and an
 *   allowed list of areas / PIN codes; no coordinates kept; staff get a Google Maps search link.
 * Covers the setting (CRUD, validation, roles, outlet scope), POS and online orders in both modes,
 * both quote endpoints, board / partner data and the COD partner flow in ADDRESS mode.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHotel, db, login, startServer, type Client, type Hotel } from "../integration/helpers";
import { mobile, roleClients, type RoleKey } from "./commerce-kit";

const MODULES = ["BILLING", "KOT", "TABLES", "DELIVERY", "CUSTOMERS", "REPORTS", "CHANNELS", "ATTENDANCE"];
const ADDRESS_MODE = { mode: "ADDRESS", flatFee: 4000, minOrder: 10000, etaMinutes: 45, pincodes: ["600040", "600017"], areas: ["Anna Nagar"] };

let srv: Awaited<ReturnType<typeof startServer>>;
let h: Hotel;
let c: Record<RoleKey, Client>;
let slug: string;

let ipSeq = 0;
const nextIp = () => `10.88.${Math.floor(++ipSeq / 250) % 250}.${(ipSeq % 250) + 1}`;
async function pub<T = any>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const r = await fetch(`${srv.base}${path}`, {
    method,
    headers: { "x-forwarded-for": nextIp(), ...(body !== undefined && { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  return { status: r.status, body: text ? JSON.parse(text) : null };
}

const setMode = async (body: object) => {
  const r = await c.owner.call("PUT", "/delivery/settings", body);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return r.body;
};
const posDelivery = (delivery: Record<string, unknown>, extra: Record<string, unknown> = {}, cl: Client = c.cashier) =>
  cl.call("POST", "/orders", {
    orderType: "DELIVERY",
    customerName: "Door Customer",
    customerPhone: mobile(),
    delivery: { address: "12 Second Avenue, Chennai", ...delivery },
    items: [{ menuItemId: h.items.biryani, quantity: 1 }],
    ...extra,
  });
/** The partner back at the outlet with nothing in hand (earlier orders were auto-assigned to them). */
const freePartner = async () => {
  await db.delivery.updateMany({ where: { agentId: h.users.delivery.id, status: { not: "DELIVERED" } }, data: { status: "CANCELLED" } });
  await db.user.update({ where: { id: h.users.delivery.id }, data: { deliveryAtOutlet: true, deliveryRunStartedAt: null } });
};
const deliveryOf = (orderId: string) => db.delivery.findFirstOrThrow({ where: { orderId } });
const chargesOf = async (orderId: string) => (await db.order.findUniqueOrThrow({ where: { id: orderId }, select: { chargesBreakup: true } })).chargesBreakup as { label: string; amount: number }[];
const online = (delivery: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  orderType: "DELIVERY",
  customerName: "Online Ravi",
  customerPhone: mobile(),
  payment: "COD",
  items: [{ menuItemId: h.items.biryani, quantity: 1 }],
  delivery: { address: "4 Lake View Road, Chennai", ...delivery },
  ...extra,
});

beforeAll(async () => {
  srv = await startServer();
  h = await createHotel("QA Delivery Mode", { modules: MODULES });
  c = await roleClients(srv.base, h);
  slug = `qa-dm-${Date.now().toString(36)}`;
  expect((await c.owner.call("PUT", "/storefront/settings", { slug, onlineOrdering: true, verifyPhoneOtp: false, delivery: true, cashOnDelivery: true, onlineNeedsConfirmation: false })).status).toBe(200);
  // One map zone: 5 km, ₹30 fee (the MAP-mode regression baseline).
  expect((await c.owner.call("POST", "/delivery/zones", { name: "Near", radiusKm: 5, fee: 3000, etaMinutes: 25 })).status).toBe(201);
  await db.staffAttendance.create({ data: { userId: h.users.delivery.id, outletId: h.outletId, workDate: new Date().toISOString().slice(0, 10), clockInAt: new Date(), clockInDistance: 0, status: "PRESENT" } });
});
afterAll(() => srv.close());

describe("setting: delivery location mode", () => {
  it("defaults to MAP; everyone who handles deliveries can read it; others can't", async () => {
    for (const k of ["owner", "manager", "cashier", "delivery"] as const) {
      const r = await c[k].call("GET", "/delivery/settings");
      expect(r.status, k).toBe(200);
      expect(r.body).toEqual({ mode: "MAP", flatFee: 0, minOrder: 0, etaMinutes: 30, pincodes: [], areas: [] });
    }
    for (const k of ["kitchen", "inventory", "accountant", "auditor"] as const) expect((await c[k].call("GET", "/delivery/settings")).status, k).toBe(403);
  });

  it("only owner / manager change it; invalid values → 400 and nothing saved", async () => {
    for (const k of ["cashier", "delivery", "waiter", "kitchen"] as const) expect((await c[k].call("PUT", "/delivery/settings", { mode: "ADDRESS" })).status, k).toBe(403);
    for (const bad of [{ mode: "GPS" }, { pincodes: ["60004"] }, { pincodes: ["060040"] }, { flatFee: -1 }, { flatFee: 12.5 }, { etaMinutes: 2 }, { areas: ["x"] }, { junk: 1 }]) {
      expect((await c.manager.call("PUT", "/delivery/settings", bad)).status, JSON.stringify(bad)).toBe(400);
    }
    expect((await c.owner.call("GET", "/delivery/settings")).body.mode).toBe("MAP");
    const saved = await c.manager.call("PUT", "/delivery/settings", { ...ADDRESS_MODE, pincodes: ["600040", "600040", "600017"] });
    expect(saved.status).toBe(200);
    expect(saved.body).toEqual(ADDRESS_MODE);
    // Partial update keeps the rest.
    expect((await c.owner.call("PUT", "/delivery/settings", { etaMinutes: 40 })).body).toEqual({ ...ADDRESS_MODE, etaMinutes: 40 });
    await setMode(ADDRESS_MODE);
    expect(await db.auditLog.count({ where: { action: "delivery.settings", entityId: h.outletId } })).toBeGreaterThanOrEqual(3);
  });

  it("is per outlet: outlet 2 stays on MAP", async () => {
    const o2 = await login(srv.base, h.users.owner.email, h.outlet2Id);
    expect((await o2.call("GET", "/delivery/settings")).body.mode).toBe("MAP");
    await setMode({ mode: "MAP" });
  });
});

describe("MAP mode (unchanged)", () => {
  it("POS: pin → zone fee and distance; no pin and no zone → refused; far pin → refused", async () => {
    await setMode({ mode: "MAP" });
    const ok = await posDelivery({ latitude: 13.01, longitude: 80.2 });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(await chargesOf(ok.body.id)).toContainEqual({ label: "Delivery fee", amount: 3000 });
    const d = await deliveryOf(ok.body.id);
    expect(d.latitude).toBe(13.01);
    expect(d.zoneId).not.toBeNull();
    const none = await posDelivery({});
    expect(none.status).toBe(400);
    expect(none.body.error).toMatch(/map coordinates or choose a delivery zone/);
    expect((await posDelivery({ latitude: 13.5, longitude: 80.2 })).status).toBe(400);
  });

  it("quote and public page: zones and map centre", async () => {
    const q = await c.cashier.call("GET", "/delivery/quote?lat=13.01&lng=80.2");
    expect(q.body).toMatchObject({ mode: "MAP", deliverable: true, fee: 3000 });
    const page = await pub("GET", `/public/o/${slug}`);
    expect(page.body.deliveryMode).toEqual({ mode: "MAP" });
    expect(page.body.zones).toHaveLength(1);
    expect(page.body.location).toEqual({ lat: 13.0, lng: 80.2 });
    expect(page.body.accent).toMatch(/^#[0-9A-F]{6}$/);
    const pq = await pub("GET", `/public/o/${slug}/delivery-quote?lat=13.01&lng=80.2`);
    expect(pq.body).toMatchObject({ mode: "MAP", deliverable: true, zone: { fee: 3000 } });
    expect((await pub("GET", `/public/o/${slug}/delivery-quote?pincode=600040`)).status).toBe(400);
  });

  it("online order with a pin gets the zone fee", async () => {
    const r = await pub("POST", `/public/o/${slug}/orders`, online({ latitude: 13.01, longitude: 80.2 }));
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const req = await db.channelRequest.findUniqueOrThrow({ where: { publicToken: r.body.token } });
    expect(await chargesOf(req.orderId!)).toContainEqual({ label: "Delivery fee", amount: 3000 });
    expect((await deliveryOf(req.orderId!)).latitude).toBe(13.01);
  });
});

describe("ADDRESS mode", () => {
  beforeAll(async () => {
    await setMode(ADDRESS_MODE);
  });

  it("POS: allowed PIN → flat fee, ETA, address with PIN, no coordinates kept (even if sent)", async () => {
    const before = Date.now();
    const r = await posDelivery({ pincode: "600040", landmark: "Opp. temple", latitude: 13.01, longitude: 80.2 });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(await chargesOf(r.body.id)).toContainEqual({ label: "Delivery fee", amount: 4000 });
    expect(await chargesOf(r.body.id)).not.toContainEqual({ label: "Delivery fee", amount: 3000 });
    const d = await deliveryOf(r.body.id);
    expect(d).toMatchObject({ address: "12 Second Avenue, Chennai - 600040", landmark: "Opp. temple", latitude: null, longitude: null, zoneId: null, distanceKm: null });
    const eta = (d.etaAt!.getTime() - before) / 60_000;
    expect(eta).toBeGreaterThan(44);
    expect(eta).toBeLessThan(46.5);
  });

  it("POS: no zone or pin needed; area chosen or written in the address is allowed", async () => {
    expect((await posDelivery({ area: "Anna Nagar" })).status).toBe(201);
    expect((await posDelivery({ address: "7 3rd Main Road, Anna Nagar West, Chennai" })).status).toBe(201);
    expect((await posDelivery({ address: "7 3rd Main Road, Chennai 600017" })).status).toBe(201);
  });

  it("POS: outside the list → 400 with a clear message; min order enforced; bad PIN format → 400", async () => {
    const far = await posDelivery({ pincode: "560001" });
    expect(far.status).toBe(400);
    expect(far.body.error).toBe("Sorry, we don't deliver to 560001. We deliver to Anna Nagar, 600040 and 600017");
    const nowhere = await posDelivery({ address: "4 Beach Road, Adyar" });
    expect(nowhere.status).toBe(400);
    expect(nowhere.body.error).toMatch(/^Sorry, we don't deliver there/);
    const small = await posDelivery({ pincode: "600040" }, { items: [{ menuItemId: h.items.chai, quantity: 1 }] });
    expect(small.status).toBe(400);
    expect(small.body.error).toMatch(/Minimum order for delivery is/);
    expect((await posDelivery({ pincode: "60004" })).status).toBe(400);
    expect(await db.order.count({ where: { outletId: h.outletId, customerName: "Door Customer", status: "CANCELLED" } })).toBe(0);
  });

  it("POS: aggregator orders aren't refused and get no fee from us", async () => {
    const r = await posDelivery({ pincode: "560001", source: "AGGREGATOR" });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect((await chargesOf(r.body.id)).find((x) => x.label === "Delivery fee")).toBeUndefined();
  });

  it("staff quote: flat fee / ETA / lists, PIN and area checked, no zones", async () => {
    const q = await c.cashier.call("GET", "/delivery/quote");
    expect(q.status).toBe(200);
    expect(q.body).toMatchObject({ mode: "ADDRESS", fee: 4000, minOrder: 10000, etaMinutes: 45, deliverable: true, zones: [], areas: ["Anna Nagar"], pincodes: ["600040", "600017"] });
    expect((await c.cashier.call("GET", "/delivery/quote?pincode=600017")).body.deliverable).toBe(true);
    const no = await c.cashier.call("GET", "/delivery/quote?pincode=560001");
    expect(no.body).toMatchObject({ deliverable: false, message: expect.stringMatching(/don't deliver to 560001/) });
    expect((await c.cashier.call("GET", "/delivery/quote?pincode=12")).status).toBe(400);
  });

  it("public page: no map (no zones, no map centre), flat fee info", async () => {
    const page = await pub("GET", `/public/o/${slug}`);
    expect(page.body.deliveryMode).toEqual({ mode: "ADDRESS", fee: 4000, minOrder: 10000, etaMinutes: 45, areas: ["Anna Nagar"], pincodes: ["600040", "600017"] });
    expect(page.body.zones).toEqual([]);
    expect(page.body.location).toBeNull();
    const q = await pub("GET", `/public/o/${slug}/delivery-quote?pincode=600040`);
    expect(q.body).toMatchObject({ mode: "ADDRESS", deliverable: true, fee: 4000 });
    expect((await pub("GET", `/public/o/${slug}/delivery-quote?pincode=560001`)).body.deliverable).toBe(false);
    expect((await pub("GET", `/public/o/${slug}/delivery-quote?pincode=abc`)).status).toBe(400);
  });

  it("online order: allowed PIN → flat fee, coordinates / zone ignored; outside → 400", async () => {
    const zone = await db.deliveryZone.findFirstOrThrow({ where: { outletId: h.outletId } });
    const r = await pub("POST", `/public/o/${slug}/orders`, online({ pincode: "600017", landmark: "Near park", latitude: 13.01, longitude: 80.2, zoneId: zone.id }));
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const req = await db.channelRequest.findUniqueOrThrow({ where: { publicToken: r.body.token } });
    expect(await chargesOf(req.orderId!)).toContainEqual({ label: "Delivery fee", amount: 4000 });
    expect(await deliveryOf(req.orderId!)).toMatchObject({ address: "4 Lake View Road, Chennai - 600017", latitude: null, zoneId: null, cod: true });
    const view = await pub("GET", `/public/o/${slug}/orders/${r.body.token}`);
    expect(view.body.charges).toContainEqual({ label: "Delivery fee", amount: 4000 });

    const far = await pub("POST", `/public/o/${slug}/orders`, online({ pincode: "560001" }));
    expect(far.status).toBe(400);
    expect(far.body.error).toMatch(/don't deliver to 560001/);
    expect((await pub("POST", `/public/o/${slug}/orders`, online({ area: "Anna Nagar" }))).status).toBe(201);
  });

  it("auto-assignment still gives ADDRESS-mode orders to an available partner", async () => {
    await freePartner();
    const r = await posDelivery({ pincode: "600040" });
    expect(r.status).toBe(201);
    expect((await deliveryOf(r.body.id)).agentId).toBe(h.users.delivery.id);
  });

  it("board and partner data carry the typed address and a Google Maps search link; COD flow works", async () => {
    await freePartner();
    const r = await posDelivery({ pincode: "600040", agentId: h.users.delivery.id, cod: true });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const d = await deliveryOf(r.body.id);
    const link = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent("12 Second Avenue, Chennai - 600040")}`;

    const board = await c.manager.call("GET", "/delivery?active=1");
    const row = (board.body as { id: string; address: string; mapsUrl: string; latitude: null }[]).find((x) => x.id === d.id)!;
    expect(row).toMatchObject({ address: "12 Second Avenue, Chennai - 600040", mapsUrl: link, latitude: null });

    const mine = await c.delivery.call("GET", "/delivery/mine");
    expect((mine.body as { id: string; mapsUrl: string }[]).find((x) => x.id === d.id)?.mapsUrl).toBe(link);
    expect((await c.delivery.call("GET", `/delivery/${d.id}`)).body.mapsUrl).toBe(link);

    expect((await c.delivery.call("PATCH", `/delivery/${d.id}/status`, { status: "ACCEPTED" })).status).toBe(200);
    expect((await c.delivery.call("PATCH", `/delivery/${d.id}/status`, { status: "OUT_FOR_DELIVERY" })).status).toBe(200);
    const done = await c.delivery.call("POST", `/delivery/${d.id}/complete`, { cashCollected: r.body.grandTotal });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body).toMatchObject({ status: "DELIVERED", cashCollected: r.body.grandTotal, mapsUrl: link });
  });

  it("switching back to MAP restores zones and pins", async () => {
    await setMode({ mode: "MAP" });
    const r = await posDelivery({ latitude: 13.01, longitude: 80.2 });
    expect(await chargesOf(r.body.id)).toContainEqual({ label: "Delivery fee", amount: 3000 });
    expect((await posDelivery({ pincode: "600040" })).status).toBe(400);
  });
});
