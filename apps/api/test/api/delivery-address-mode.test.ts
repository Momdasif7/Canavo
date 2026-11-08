/**
 * Product request (rqb) — delivery with or without a map. Outlet setting GET/PUT /delivery/settings
 * (owner / manager change it; the cashier reads it for the POS), and both modes end to end:
 * MAP (pin, zones, distance fees — unchanged) and ADDRESS (typed address + PIN code, flat fee,
 * minimum order, allowed PIN codes / area names) on the online ordering page and on POS orders.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHotel, login, startServer } from "../integration/helpers";
import { db, makeWorld, roleMatrix, type Client, type World } from "./service-fixtures";

const MODULES = ["BILLING", "KOT", "TABLES", "DELIVERY", "CUSTOMERS", "REPORTS", "CHANNELS"];

let srv: Awaited<ReturnType<typeof startServer>>;
let w: World;
let owner: Client, manager: Client, cashier: Client;
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
  return { status: r.status, body: (text ? JSON.parse(text) : null) as T };
}

let seq = 0;
const phone = () => `9${String(Date.now() % 1e5).padStart(5, "0")}${String(seq++ % 1e4).padStart(4, "0")}`;

const onlineDelivery = (delivery: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  orderType: "DELIVERY",
  customerName: "Meena",
  customerPhone: phone(),
  payment: "COD",
  items: [{ menuItemId: w.h.items.biryani, quantity: 2 }],
  delivery,
  ...extra,
});

const posDelivery = (delivery: Record<string, unknown>, items = [{ menuItemId: w.h.items.biryani, quantity: 2 }]) =>
  cashier.call("POST", "/orders", { orderType: "DELIVERY", customerName: "Counter Customer", customerPhone: phone(), delivery, items });

const ADDRESS_SETTINGS = { addressMode: "ADDRESS", flatFee: 4000, minOrder: 20000, areas: ["600017", "T Nagar"], etaMinutes: 40 };

beforeAll(async () => {
  srv = await startServer();
  w = await makeWorld(srv.base, "Delivery Mode", { modules: MODULES });
  ({ owner, manager, cashier } = w.as);
  slug = `qa-dm-${Date.now().toString(36)}`;
  const s = await owner.call("PUT", "/storefront/settings", { slug, onlineOrdering: true, delivery: true, takeaway: true, verifyPhoneOtp: false, cashOnDelivery: true });
  expect(s.status, JSON.stringify(s.body)).toBe(200);
  expect((await manager.call("POST", "/delivery/zones", { name: "Near", radiusKm: 5, fee: 3000, etaMinutes: 25 })).status).toBe(201);
});
afterAll(() => srv.close());

describe("delivery settings: roles, validation, isolation", () => {
  it("defaults to MAP (existing outlets keep the map); owner / manager change it, cashier reads it, everyone else 403", async () => {
    const g = await cashier.call("GET", "/delivery/settings");
    expect(g.status).toBe(200);
    expect(g.body).toEqual({ addressMode: "MAP", flatFee: 0, minOrder: 0, areas: [], etaMinutes: 30, outletLocation: true });
    expect(await roleMatrix(w, ["owner", "manager", "cashier"], (c) => c.call("GET", "/delivery/settings"), 200)).toEqual([]);
    expect(await roleMatrix(w, ["owner", "manager"], (c) => c.call("PUT", "/delivery/settings", { etaMinutes: 30 }), 200)).toEqual([]);
    // Module off → refused for the owner too.
    const off = await createHotel("Delivery Mode Off", { modules: ["BILLING", "KOT"] });
    const offOwner = await login(srv.base, off.users.owner.email, off.outletId);
    expect((await offOwner.call("GET", "/delivery/settings")).status).toBe(403);
    expect((await offOwner.call("PUT", "/delivery/settings", { addressMode: "ADDRESS" })).status).toBe(403);
    // A manager pointed at an outlet they don't work at / the super admin: refused.
    expect((await w.managerOutlet2.call("PUT", "/delivery/settings", { addressMode: "ADDRESS" })).status).toBe(403);
    expect((await w.admin.call("PUT", "/delivery/settings", { addressMode: "ADDRESS" })).status).toBe(403);
  });

  it("validation: mode, money in integer paise within bounds, ETA range, PIN codes are 6 digits; duplicates collapse", async () => {
    for (const body of [
      { addressMode: "PIN" },
      { flatFee: -1 },
      { flatFee: 12.5 },
      { flatFee: 1_000_001 },
      { minOrder: -5 },
      { etaMinutes: 4 },
      { etaMinutes: 301 },
      { areas: ["12345"] },
      { areas: ["x"] },
      { areas: "600017" },
      { areas: Array.from({ length: 201 }, (_, i) => `Area ${i}`) },
    ]) {
      expect((await manager.call("PUT", "/delivery/settings", body)).status, JSON.stringify(body).slice(0, 60)).toBe(400);
    }
    const r = await manager.call("PUT", "/delivery/settings", { areas: [" Adyar ", "adyar", "600020"] });
    expect(r.status).toBe(200);
    expect(r.body.areas).toEqual(["adyar", "600020"]);
    expect((await manager.call("PUT", "/delivery/settings", { areas: [] })).body.areas).toEqual([]);
  });

  it("is per outlet: changing outlet 1 leaves outlet 2 and another hotel on the map; the change is audited", async () => {
    expect((await owner.call("PUT", "/delivery/settings", { addressMode: "ADDRESS", flatFee: 1000 })).body.addressMode).toBe("ADDRESS");
    expect((await owner.call("GET", "/delivery/settings", undefined, { "x-outlet-id": w.h.outlet2Id })).body.addressMode).toBe("MAP");
    expect((await w.otherOwner.call("GET", "/delivery/settings")).body.addressMode).toBe("MAP");
    const log = await db.auditLog.findFirst({ where: { action: "delivery.settings", entityId: w.h.outletId }, orderBy: { createdAt: "desc" } });
    expect(log).toBeTruthy();
    expect((await owner.call("PUT", "/delivery/settings", { addressMode: "MAP", flatFee: 0 })).body.addressMode).toBe("MAP");
  });
});

describe("MAP mode (unchanged)", () => {
  it("public page has the map (location + zones); quote needs a pin; order fee comes from the zone", async () => {
    const page = await pub("GET", `/public/o/${slug}`);
    expect(page.status).toBe(200);
    expect(page.body).toMatchObject({ delivery: true, deliveryMode: "MAP", deliveryFlat: null, location: { lat: 13, lng: 80.2 } });
    expect(page.body.zones).toHaveLength(1);
    expect((await pub("GET", `/public/o/${slug}/delivery-quote`)).status).toBe(400);
    const q = await pub("GET", `/public/o/${slug}/delivery-quote?lat=13.01&lng=80.2`);
    expect(q.body).toMatchObject({ mode: "MAP", deliverable: true, fee: 3000, zone: { name: "Near" } });
    const far = await pub("GET", `/public/o/${slug}/delivery-quote?lat=13.5&lng=80.2`);
    expect(far.body.deliverable).toBe(false);

    const placed = await pub("POST", `/public/o/${slug}/orders`, onlineDelivery({ address: "4 Beach Road, Chennai", latitude: 13.01, longitude: 80.2 }));
    expect(placed.status, JSON.stringify(placed.body)).toBe(201);
    const view = await pub("GET", `/public/o/${slug}/orders/${placed.body.token}`);
    expect(view.body.charges).toContainEqual({ label: "Delivery fee", amount: 3000 });
    const d = await db.delivery.findFirstOrThrow({ where: { order: { channelOrderId: placed.body.token } } });
    expect(d.latitude).toBe(13.01);
    expect(d.zoneId).toBeTruthy();
  });

  it("POS: map coordinates pick the zone fee; staff quote says MAP", async () => {
    const q = await cashier.call("GET", "/delivery/quote?lat=13.01&lng=80.2");
    expect(q.body).toMatchObject({ addressMode: "MAP", deliverable: true, fee: 3000 });
    const r = await posDelivery({ address: "9 Mount Road, Chennai", latitude: 13.01, longitude: 80.2 });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.chargesBreakup).toContainEqual({ label: "Delivery fee", amount: 3000 });
  });
});

describe("ADDRESS mode (no map)", () => {
  beforeAll(async () => {
    const r = await manager.call("PUT", "/delivery/settings", ADDRESS_SETTINGS);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject(ADDRESS_SETTINGS);
  });

  it("public page: no map / zones / location, flat fee, minimum, ETA and allowed areas", async () => {
    const page = await pub("GET", `/public/o/${slug}`);
    expect(page.body).toMatchObject({ delivery: true, deliveryMode: "ADDRESS", location: null, zones: [], deliveryFlat: { fee: 4000, minOrder: 20000, etaMinutes: 40, areas: ["600017", "T Nagar"] } });
  });

  it("quote: flat fee; allowed PIN code / area name pass, others refused with a clear message", async () => {
    const ok = await pub("GET", `/public/o/${slug}/delivery-quote?pincode=600017`);
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ mode: "ADDRESS", deliverable: true, fee: 4000, minOrder: 20000, etaMinutes: 40, message: null });
    expect((await pub("GET", `/public/o/${slug}/delivery-quote?area=${encodeURIComponent("t nagar")}`)).body.deliverable).toBe(true);
    expect((await pub("GET", `/public/o/${slug}/delivery-quote?pincode=600099&address=${encodeURIComponent("12 Usman Road, T. Nagar")}`)).body.deliverable).toBe(true);
    const no = await pub("GET", `/public/o/${slug}/delivery-quote?pincode=600099`);
    expect(no.body.deliverable).toBe(false);
    expect(no.body.message).toMatch(/don't deliver to PIN code 600099.*600017, T Nagar/);
    expect((await pub("GET", `/public/o/${slug}/delivery-quote?pincode=12`)).body).toMatchObject({ deliverable: false, message: "Enter a 6-digit PIN code" });
    // No pin needed (and a stray pin is ignored).
    expect((await pub("GET", `/public/o/${slug}/delivery-quote?lat=13.5&lng=80.2&pincode=600017`)).body.deliverable).toBe(true);
    // Staff quote (POS) follows the same setting.
    const staff = await cashier.call("GET", "/delivery/quote?pincode=600099");
    expect(staff.body).toMatchObject({ addressMode: "ADDRESS", deliverable: false, fee: 4000, needsCoordinates: false, zones: [] });
    expect((await cashier.call("GET", "/delivery/quote?pincode=600017")).body.deliverable).toBe(true);
  });

  it("online order: allowed PIN → placed, flat fee on the bill, typed address + PIN kept, no pin stored", async () => {
    const placed = await pub(
      "POST",
      `/public/o/${slug}/orders`,
      onlineDelivery({ address: "Flat 3B, 21 Ranganathan Street", landmark: "Opp. Pothys", pincode: "600017", area: "T Nagar", latitude: 13.5, longitude: 80.2, zoneId: "cl0000000000000000000000" }),
    );
    expect(placed.status, JSON.stringify(placed.body)).toBe(201);
    const view = await pub("GET", `/public/o/${slug}/orders/${placed.body.token}`);
    expect(view.body.charges).toContainEqual({ label: "Delivery fee", amount: 4000 });
    expect(view.body.grandTotal).toBe(32000 + 4000);
    const d = await db.delivery.findFirstOrThrow({ where: { order: { channelOrderId: placed.body.token } } });
    expect(d).toMatchObject({ address: "Flat 3B, 21 Ranganathan Street, T Nagar", landmark: "Opp. Pothys", pincode: "600017", latitude: null, longitude: null, zoneId: null, distanceKm: null });
    expect(d.etaAt!.getTime() - d.createdAt.getTime()).toBeGreaterThan(39 * 60_000);
  });

  it("online order refused: outside the areas, no PIN code, below the delivery minimum — nothing is created", async () => {
    const before = await db.order.count({ where: { outletId: w.h.outletId } });
    const outside = await pub("POST", `/public/o/${slug}/orders`, onlineDelivery({ address: "5 Anna Nagar 2nd Ave", pincode: "600040" }));
    expect(outside.status).toBe(400);
    expect(outside.body.error).toMatch(/don't deliver to PIN code 600040/);
    const noPin = await pub("POST", `/public/o/${slug}/orders`, onlineDelivery({ address: "21 Ranganathan Street" }));
    expect(noPin.status).toBe(400);
    expect(noPin.body.error).toMatch(/PIN code/);
    const badPin = await pub("POST", `/public/o/${slug}/orders`, onlineDelivery({ address: "21 Ranganathan Street", pincode: "06001" }));
    expect(badPin.status).toBe(400);
    const small = await pub("POST", `/public/o/${slug}/orders`, onlineDelivery({ address: "21 Ranganathan Street", pincode: "600017" }, { items: [{ menuItemId: w.h.items.biryani, quantity: 1 }] }));
    expect(small.status).toBe(400);
    expect(small.body.error).toMatch(/Minimum order for delivery is ₹200/);
    expect(await db.order.count({ where: { outletId: w.h.outletId } })).toBe(before);
    // Takeaway is not affected by the delivery minimum.
    const takeaway = await pub("POST", `/public/o/${slug}/orders`, { orderType: "TAKEAWAY", customerName: "Ravi", customerPhone: phone(), payment: "COUNTER", items: [{ menuItemId: w.h.items.chai, quantity: 1 }] });
    expect(takeaway.status).toBe(201);
  });

  it("POS delivery order follows the setting: PIN code required, area checked, flat fee, coordinates dropped", async () => {
    const ok = await posDelivery({ address: "12 Usman Road", pincode: "600017", latitude: 13.5, longitude: 80.2 });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(ok.body.chargesBreakup).toContainEqual({ label: "Delivery fee", amount: 4000 });
    const d = await db.delivery.findUniqueOrThrow({ where: { orderId: ok.body.id } });
    expect(d).toMatchObject({ pincode: "600017", latitude: null, longitude: null, zoneId: null });
    // Area name typed in the address is enough.
    expect((await posDelivery({ address: "45 North Usman Road, T Nagar", pincode: "600099" })).status).toBe(201);
    const noPin = await posDelivery({ address: "12 Usman Road" });
    expect(noPin.status).toBe(400);
    expect(noPin.body.error).toMatch(/PIN code/);
    const outside = await posDelivery({ address: "8 Anna Nagar", pincode: "600040" });
    expect(outside.status).toBe(400);
    expect(outside.body.error).toMatch(/don't deliver/);
    const small = await posDelivery({ address: "12 Usman Road", pincode: "600017" }, [{ menuItemId: w.h.items.chai, quantity: 1 }]);
    expect(small.status).toBe(400);
    // Delivery board / partner get the typed address and PIN code.
    const board = await manager.call("GET", "/delivery?active=1");
    expect((board.body as { id: string; pincode: string | null }[]).find((x) => x.id === d.id)?.pincode).toBe("600017");
  });

  it("no allowed areas and no fee: any PIN code, no delivery fee line", async () => {
    expect((await manager.call("PUT", "/delivery/settings", { areas: [], flatFee: 0, minOrder: 0 })).status).toBe(200);
    const r = await posDelivery({ address: "1 Anywhere Street", pincode: "110001" });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect((r.body.chargesBreakup as { label: string }[]).some((c) => c.label === "Delivery fee")).toBe(false);
    expect((await pub("GET", `/public/o/${slug}/delivery-quote?pincode=110001`)).body).toMatchObject({ deliverable: true, fee: 0 });
  });

  it("switching back to MAP restores the zones and pin exactly as before", async () => {
    expect((await manager.call("PUT", "/delivery/settings", { addressMode: "MAP" })).status).toBe(200);
    const page = await pub("GET", `/public/o/${slug}`);
    expect(page.body).toMatchObject({ deliveryMode: "MAP", deliveryFlat: null, location: { lat: 13, lng: 80.2 } });
    expect(page.body.zones).toHaveLength(1);
    const r = await posDelivery({ address: "9 Mount Road, Chennai", latitude: 13.01, longitude: 80.2 });
    expect(r.body.chargesBreakup).toContainEqual({ label: "Delivery fee", amount: 3000 });
  });
});
