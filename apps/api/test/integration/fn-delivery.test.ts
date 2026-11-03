/**
 * QA Phase 5 — group D: Delivery zones, dispatch limit, on-a-run lock, return
 * detection, waiting queue, manual assignment rules, status flow and the
 * partner portal (README "Delivery dispatch limit", "Delivery partner portal").
 */
import { beforeAll, describe, expect, it } from "vitest";
import { assignWaitingDeliveries, partnerAvailability } from "../../src/services/delivery-assign";
import { db } from "./helpers";
import {
  addPartner,
  as,
  deliveryOrder,
  deliveryTenant,
  inOutlet,
  onDuty,
  pointAt,
  postDeliveryOrder,
  sleep,
  waitFor,
  type DeliveryTenant,
} from "./fx-d";

const agentOf = async (deliveryId: string) => (await db.delivery.findUniqueOrThrow({ where: { id: deliveryId } })).agentId;

// =====================================================================
// Zones & quote
// =====================================================================
describe("@regression Delivery zones & quote", () => {
  let t: DeliveryTenant;
  let near: { id: string };
  let far: { id: string };

  beforeAll(async () => {
    t = await deliveryTenant();
    near = (await t.manager.post("/delivery/zones", { name: "Near", radiusKm: 2, fee: 2000, minOrder: 0, etaMinutes: 20 })).body;
    far = (await t.manager.post("/delivery/zones", { name: "Far", radiusKm: 5, fee: 4000, minOrder: 20000, etaMinutes: 40 })).body;
  });

  it("IT-DEL-001 manager creates a zone; defaults fee 0, min order 0, ETA 30, active", async () => {
    const res = await t.manager.post("/delivery/zones", { name: "Defaults", radiusKm: 9 });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ fee: 0, minOrder: 0, etaMinutes: 30, active: true, outletId: t.outlet.id });
    await t.manager.delete(`/delivery/zones/${res.body.id}`);
  });

  it.each([
    ["radiusKm 0", { name: "x", radiusKm: 0 }],
    ["radiusKm 100.01", { name: "x", radiusKm: 100.01 }],
    ["etaMinutes 4", { name: "x", radiusKm: 1, etaMinutes: 4 }],
    ["etaMinutes 301", { name: "x", radiusKm: 1, etaMinutes: 301 }],
    ["negative fee", { name: "x", radiusKm: 1, fee: -1 }],
    ["fractional paise fee", { name: "x", radiusKm: 1, fee: 10.5 }],
    ["empty name", { name: " ", radiusKm: 1 }],
  ])("IT-DEL-002 zone validation rejects %s with 400", async (_l, body) => {
    expect((await t.manager.post("/delivery/zones", body)).status).toBe(400);
  });

  it("IT-DEL-003 BVA radiusKm 100 and etaMinutes 5/300 are accepted", async () => {
    const a = await t.manager.post("/delivery/zones", { name: "Max", radiusKm: 100, etaMinutes: 300, active: false });
    const b = await t.manager.post("/delivery/zones", { name: "Min", radiusKm: 0.1, etaMinutes: 5, active: false });
    expect([a.status, b.status]).toEqual([201, 201]);
    await t.manager.delete(`/delivery/zones/${a.body.id}`);
    await t.manager.delete(`/delivery/zones/${b.body.id}`);
  });

  it("IT-DEL-004 cashier can list zones but cannot create one (needs settings:outlet)", async () => {
    expect((await t.cashier.get("/delivery/zones")).status).toBe(200);
    expect((await t.cashier.post("/delivery/zones", { name: "C", radiusKm: 1 })).status).toBe(403);
  });

  it("IT-DEL-005 zone update / delete; deleted or foreign zone → 404", async () => {
    const z = (await t.manager.post("/delivery/zones", { name: "Temp", radiusKm: 3, active: false })).body;
    const up = await t.manager.patch(`/delivery/zones/${z.id}`, { fee: 1500, name: "Temp2" });
    expect(up.status).toBe(200);
    expect(up.body).toMatchObject({ fee: 1500, name: "Temp2", radiusKm: 3 });
    expect((await t.manager.delete(`/delivery/zones/${z.id}`)).status).toBe(204);
    expect((await t.manager.patch(`/delivery/zones/${z.id}`, { fee: 1 })).status).toBe(404);
    const other = await deliveryTenant();
    expect((await other.manager.patch(`/delivery/zones/${near.id}`, { fee: 1 })).status).toBe(404);
    expect((await other.manager.delete(`/delivery/zones/${near.id}`)).status).toBe(404);
  });

  it("IT-DEL-006 quote picks the smallest covering zone (1.5 km → Near; 3 km → Far)", async () => {
    const p1 = pointAt(1500);
    const q1 = await t.cashier.get(`/delivery/quote?lat=${p1.latitude}&lng=${p1.longitude}`);
    expect(q1.status).toBe(200);
    expect(q1.body).toMatchObject({ distanceKm: 1.5, deliverable: true, fee: 2000, minOrder: 0, etaMinutes: 20 });
    expect(q1.body.zone.id).toBe(near.id);
    const p3 = pointAt(3000);
    const q3 = await t.cashier.get(`/delivery/quote?lat=${p3.latitude}&lng=${p3.longitude}`);
    expect(q3.body).toMatchObject({ distanceKm: 3, fee: 4000, minOrder: 20000, etaMinutes: 40 });
    expect(q3.body.zone.id).toBe(far.id);
  });

  it("IT-DEL-007 BVA: exactly on the 2 km radius is inside Near", async () => {
    const p = pointAt(2000);
    const q = await t.cashier.get(`/delivery/quote?lat=${p.latitude}&lng=${p.longitude}`);
    expect(q.body.distanceKm).toBe(2);
    expect(q.body.zone.id).toBe(near.id);
  });

  it("IT-DEL-008 outside every zone → not deliverable (quote) and the order is refused 400", async () => {
    const p = pointAt(8000);
    const q = await t.cashier.get(`/delivery/quote?lat=${p.latitude}&lng=${p.longitude}`);
    expect(q.body).toMatchObject({ deliverable: false, zone: null, fee: null });
    const res = await postDeliveryOrder(t, t.cashier, { price: 50000, latitude: p.latitude, longitude: p.longitude });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/within 5 km/);
  });

  it("IT-DEL-009 quote without coordinates lists zones and asks for coordinates", async () => {
    const q = await t.cashier.get("/delivery/quote");
    expect(q.body.needsCoordinates).toBe(true);
    expect(q.body.zones.map((z: { id: string }) => z.id)).toEqual(expect.arrayContaining([near.id, far.id]));
  });

  it("IT-DEL-010 inactive zones are ignored by quote", async () => {
    const z = (await t.manager.post("/delivery/zones", { name: "Tiny inactive", radiusKm: 1, fee: 1, active: false })).body;
    const p = pointAt(500);
    const q = await t.cashier.get(`/delivery/quote?lat=${p.latitude}&lng=${p.longitude}`);
    expect(q.body.zone.id).toBe(near.id);
    await t.manager.delete(`/delivery/zones/${z.id}`);
  });

  it("IT-DEL-011 @critical order inside Near adds the ₹20 delivery fee, stores distance and ETA", async () => {
    const p = pointAt(1500);
    const before = Date.now();
    const { order, delivery } = await deliveryOrder(t, { price: 10000, latitude: p.latitude, longitude: p.longitude });
    expect(order.grandTotal).toBe(12000);
    expect(delivery.zoneId).toBe(near.id);
    expect(delivery.distanceKm).toBe(1.5);
    const eta = delivery.etaAt!.getTime() - before;
    expect(eta).toBeGreaterThan(19 * 60_000);
    expect(eta).toBeLessThan(21 * 60_000);
  });

  it("IT-DEL-012 order below the zone minimum (₹199.99 < ₹200 in Far) → 400; exactly ₹200 → 201", async () => {
    const p = pointAt(3000);
    const low = await postDeliveryOrder(t, t.cashier, { price: 19999, latitude: p.latitude, longitude: p.longitude });
    expect(low.status).toBe(400);
    expect(low.body.error).toMatch(/Minimum order/);
    const ok = await postDeliveryOrder(t, t.cashier, { price: 20000, latitude: p.latitude, longitude: p.longitude });
    expect(ok.status).toBe(201);
    expect(ok.body.grandTotal).toBe(24000);
  });

  it("IT-DEL-013 chosen zone smaller than the address distance → 400", async () => {
    const p = pointAt(3000);
    const res = await postDeliveryOrder(t, t.cashier, { price: 50000, latitude: p.latitude, longitude: p.longitude, zoneId: near.id });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/outside zone Near/);
  });

  it("IT-DEL-014 with zones configured, neither coordinates nor zone → 400; unknown zone → 400", async () => {
    expect((await postDeliveryOrder(t, t.cashier, {})).status).toBe(400);
    expect((await postDeliveryOrder(t, t.cashier, { zoneId: "nope" })).status).toBe(400);
  });

  it("IT-DEL-015 delivery disabled at the outlet → 400; missing customer phone → 400", async () => {
    const o = await deliveryTenant();
    await db.outlet.update({ where: { id: o.outlet.id }, data: { deliveryEnabled: false } });
    expect((await postDeliveryOrder(o, o.cashier, {})).status).toBe(400);
    await db.outlet.update({ where: { id: o.outlet.id }, data: { deliveryEnabled: true } });
    const res = await o.cashier.post("/orders", { orderType: "DELIVERY", customerName: "X", items: [{ menuItemId: o.itemId, quantity: 1 }], delivery: { address: "12 Anna Salai" } });
    expect(res.status).toBe(400);
  });

  it("IT-DEL-016 quote with coordinates when the outlet has no location → 400", async () => {
    const o = await deliveryTenant({ withCoords: false });
    const res = await o.cashier.get("/delivery/quote?lat=13.09&lng=80.27");
    expect(res.status).toBe(400);
  });
});

// =====================================================================
// Auto-assignment and the dispatch limit
// =====================================================================
describe("@regression @critical Delivery dispatch limit & auto-assign", () => {
  it("IT-DEL-020 no partner on duty → order waits unassigned and managers are told why", async () => {
    const t = await deliveryTenant();
    await addPartner(t, "A partner");
    const { delivery, order } = await deliveryOrder(t);
    expect(delivery.agentId).toBeNull();
    const n = await waitFor(() =>
      db.notification.findFirst({ where: { userId: t.users.OUTLET_MANAGER.id, title: "Delivery waiting for a partner" } }),
    );
    expect(n?.body).toContain(order.invoiceNumber);
    expect(n?.body).toMatch(/no delivery partner is on duty/);
  });

  it("IT-DEL-021 partner on duty at the outlet gets the POS order automatically", async () => {
    const t = await deliveryTenant();
    const a = await addPartner(t, "A partner");
    await onDuty(a.id, t.outlet.id);
    const { delivery } = await deliveryOrder(t);
    expect(delivery.agentId).toBe(a.id);
    expect(delivery.assignedAt).not.toBeNull();
  });

  it("IT-DEL-022 default limit 2: fill a partner who already has one first, then the next; 5th order waits", async () => {
    const t = await deliveryTenant();
    const a = await addPartner(t, "A partner");
    const b = await addPartner(t, "B partner");
    await onDuty(a.id, t.outlet.id);
    await onDuty(b.id, t.outlet.id);
    const got: (string | null)[] = [];
    for (let i = 0; i < 5; i++) got.push((await deliveryOrder(t)).delivery.agentId);
    // First goes to one partner; the second fills that same partner; then the other partner; then nobody.
    expect(got[1]).toBe(got[0]);
    expect(got[2]).not.toBe(got[0]);
    expect(got[3]).toBe(got[2]);
    expect(new Set([got[0], got[2]])).toEqual(new Set([a.id, b.id]));
    expect(got[4]).toBeNull();
    const avail = await inOutlet(t.outlet.id, () => partnerAvailability(t.outlet.id));
    const pa = avail.find((p) => p.id === a.id)!;
    expect(pa).toMatchObject({ active: 2, max: 2, available: false, reason: "Has 2 of 2 orders" });
  });

  it("IT-DEL-023 outlet setting maxDeliveriesPerPartner=1 (BVA 1 ok, 0 / 11 rejected) gives each partner one order", async () => {
    const t = await deliveryTenant();
    expect((await t.manager.patch("/outlets/current", { maxDeliveriesPerPartner: 0 })).status).toBe(400);
    expect((await t.manager.patch("/outlets/current", { maxDeliveriesPerPartner: 11 })).status).toBe(400);
    expect((await t.manager.patch("/outlets/current", { maxDeliveriesPerPartner: 1 })).status).toBe(200);
    const a = await addPartner(t, "A partner");
    const b = await addPartner(t, "B partner");
    await onDuty(a.id, t.outlet.id);
    await onDuty(b.id, t.outlet.id);
    const d1 = (await deliveryOrder(t)).delivery.agentId;
    const d2 = (await deliveryOrder(t)).delivery.agentId;
    const d3 = (await deliveryOrder(t)).delivery.agentId;
    expect(new Set([d1, d2])).toEqual(new Set([a.id, b.id]));
    expect(d3).toBeNull();
  });

  it("IT-DEL-024 partner without an open clock-in is 'Not clocked in' and gets nothing", async () => {
    const t = await deliveryTenant();
    const a = await addPartner(t, "A partner");
    const me = await as(a.email, t.outlet.id);
    const st = await me.get("/delivery/me/status");
    expect(st.body).toMatchObject({ onDuty: false, available: false, reason: "Not clocked in" });
  });

  it("IT-DEL-025 auto-assign switched off (setting delivery.autoAssign=false) → orders wait", async () => {
    const t = await deliveryTenant();
    const a = await addPartner(t, "A partner");
    await onDuty(a.id, t.outlet.id);
    await db.setting.create({ data: { scope: t.outlet.id, key: "delivery.autoAssign", value: false } });
    const { delivery } = await deliveryOrder(t);
    expect(delivery.agentId).toBeNull();
    expect(await inOutlet(t.outlet.id, () => assignWaitingDeliveries(t.outlet.id))).toBe(0);
  });
});

describe("@regression @critical Delivery on-a-run lock and back-at-outlet detection", () => {
  let t: DeliveryTenant;
  let a: Awaited<ReturnType<typeof addPartner>>;
  let me: Awaited<ReturnType<typeof as>>;
  let first: Awaited<ReturnType<typeof deliveryOrder>>;
  let waiting: Awaited<ReturnType<typeof deliveryOrder>>;

  beforeAll(async () => {
    t = await deliveryTenant();
    a = await addPartner(t, "A partner");
    await onDuty(a.id, t.outlet.id);
    me = await as(a.email, t.outlet.id);
    first = await deliveryOrder(t);
  });

  it("IT-DEL-030 partner picks up (ACCEPTED → OUT_FOR_DELIVERY): pickedAt set, partner is on a run", async () => {
    expect(first.delivery.agentId).toBe(a.id);
    expect((await me.patch(`/delivery/${first.delivery.id}/status`, { status: "ACCEPTED" })).status).toBe(200);
    const res = await me.patch(`/delivery/${first.delivery.id}/status`, { status: "OUT_FOR_DELIVERY" });
    expect(res.status).toBe(200);
    expect(res.body.pickedAt).toBeTruthy();
    const st = (await me.get("/delivery/me/status")).body;
    expect(st).toMatchObject({ onDuty: true, atOutlet: false, outForDelivery: 1, available: false, reason: "Out for delivery" });
    expect(st.onRunSince).toBeTruthy();
  });

  it("IT-DEL-031 on a run with 1 of 2 orders, a new order is NOT given to the partner (waits)", async () => {
    waiting = await deliveryOrder(t);
    expect(waiting.delivery.agentId).toBeNull();
  });

  it("IT-DEL-032 manager 'Mark back at outlet' while an order is still out → 409", async () => {
    const res = await t.manager.post(`/delivery/agents/${a.id}/back`);
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/still has 1 order/);
  });

  it("IT-DEL-033 GPS inside the geofence while an order is still out does not count as back", async () => {
    const p = pointAt(10);
    const res = await me.post("/delivery/me/location", { lat: p.latitude, lng: p.longitude });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ distanceToOutlet: 10, atOutlet: false, backNow: false });
    expect(await agentOf(waiting.delivery.id)).toBeNull();
  });

  it("IT-DEL-034 after delivering everything but before returning: 'Returning to the outlet', still no orders", async () => {
    const done = await me.post(`/delivery/${first.delivery.id}/complete`, {});
    expect(done.status).toBe(200);
    await sleep(500); // background assignWaitingDeliveries after completion
    expect(await agentOf(waiting.delivery.id)).toBeNull();
    const st = (await me.get("/delivery/me/status")).body;
    expect(st).toMatchObject({ outForDelivery: 0, atOutlet: false, available: false, reason: "Returning to the outlet" });
  });

  it("IT-DEL-035 GPS 2 km away → still away; 260 m with accuracy 500 (cap 100 → radius 250) → still away", async () => {
    const far = pointAt(2000);
    expect((await me.post("/delivery/me/location", { lat: far.latitude, lng: far.longitude })).body.backNow).toBe(false);
    const edge = pointAt(260);
    const r = await me.post("/delivery/me/location", { lat: edge.latitude, lng: edge.longitude, accuracy: 500 });
    expect(r.body).toMatchObject({ distanceToOutlet: 260, backNow: false, atOutlet: false });
    expect(await agentOf(waiting.delivery.id)).toBeNull();
  });

  it("IT-DEL-036 GPS 250 m with accuracy 100 (boundary) → back; waiting order assigned at once", async () => {
    const p = pointAt(250);
    const r = await me.post("/delivery/me/location", { lat: p.latitude, lng: p.longitude, accuracy: 100 });
    expect(r.body).toMatchObject({ backNow: true, atOutlet: true });
    expect(await agentOf(waiting.delivery.id)).toBe(a.id);
    const n = await db.notification.findFirst({ where: { userId: a.id, title: "You're back at the outlet" } });
    expect(n).not.toBeNull();
  });

  it("IT-DEL-037 validation: lat 91 → 400; negative accuracy → 400", async () => {
    expect((await me.post("/delivery/me/location", { lat: 91, lng: 80 })).status).toBe(400);
    expect((await me.post("/delivery/me/location", { lat: 13, lng: 80, accuracy: -1 })).status).toBe(400);
  });

  it("IT-DEL-038 manager / cashier cannot post partner GPS (delivery:own only) → 403", async () => {
    expect((await t.manager.post("/delivery/me/location", { lat: 13, lng: 80 })).status).toBe(403);
  });
});

describe("@regression @critical Delivery back-at-outlet by manager button and by clock-in", () => {
  it("IT-DEL-040 manager 'Mark back at outlet' after delivery → available, waiting order assigned", async () => {
    const t = await deliveryTenant();
    const a = await addPartner(t, "A partner");
    await onDuty(a.id, t.outlet.id);
    const me = await as(a.email, t.outlet.id);
    const o1 = await deliveryOrder(t);
    await me.patch(`/delivery/${o1.delivery.id}/status`, { status: "OUT_FOR_DELIVERY" });
    const w = await deliveryOrder(t);
    expect(w.delivery.agentId).toBeNull();
    await me.post(`/delivery/${o1.delivery.id}/complete`, {});
    const res = await t.manager.post(`/delivery/agents/${a.id}/back`);
    expect(res.status).toBe(200);
    expect(await agentOf(w.delivery.id)).toBe(a.id);
    expect(res.body).toMatchObject({ atOutlet: true });
    const log = await db.auditLog.findFirst({ where: { action: "delivery.partner_back", entityId: a.id } });
    expect(log).not.toBeNull();
  });

  it("IT-DEL-041 'Mark back' for an unknown partner → 404; partner role-check: cashier id → 404", async () => {
    const t = await deliveryTenant();
    expect((await t.manager.post(`/delivery/agents/nope/back`)).status).toBe(404);
    expect((await t.manager.post(`/delivery/agents/${t.users.CASHIER.id}/back`)).status).toBe(404);
  });

  it("IT-DEL-042 clocking in at the outlet counts as back and picks up the waiting order", async () => {
    const t = await deliveryTenant();
    const b = await addPartner(t, "B partner");
    await db.user.update({ where: { id: b.id }, data: { deliveryAtOutlet: false, deliveryRunStartedAt: new Date() } });
    const w = await deliveryOrder(t);
    expect(w.delivery.agentId).toBeNull();
    const me = await as(b.email, t.outlet.id);
    const p = pointAt(20);
    const res = await me.post("/attendance/clock-in", { latitude: p.latitude, longitude: p.longitude });
    expect(res.status).toBe(201);
    expect(await waitFor(async () => (await agentOf(w.delivery.id)) === b.id)).toBe(true);
    expect((await db.user.findUniqueOrThrow({ where: { id: b.id } })).deliveryAtOutlet).toBe(true);
  });

  it("IT-DEL-043 assignWaitingDeliveries assigns oldest first, up to the limit, and returns the count", async () => {
    const t = await deliveryTenant();
    const a = await addPartner(t, "A partner");
    const w1 = await deliveryOrder(t);
    const w2 = await deliveryOrder(t);
    const w3 = await deliveryOrder(t);
    await onDuty(a.id, t.outlet.id);
    const n = await inOutlet(t.outlet.id, () => assignWaitingDeliveries(t.outlet.id));
    expect(n).toBe(2);
    expect(await agentOf(w1.delivery.id)).toBe(a.id);
    expect(await agentOf(w2.delivery.id)).toBe(a.id);
    expect(await agentOf(w3.delivery.id)).toBeNull();
  });

  it("IT-DEL-044 waiting delivery of a cancelled order is never assigned", async () => {
    const t = await deliveryTenant();
    const a = await addPartner(t, "A partner");
    const w = await deliveryOrder(t);
    const c = await t.manager.post(`/orders/${w.order.id}/cancel`, { reason: "Customer cancelled" });
    expect(c.status).toBeLessThan(300);
    await onDuty(a.id, t.outlet.id);
    expect(await inOutlet(t.outlet.id, () => assignWaitingDeliveries(t.outlet.id))).toBe(0);
    const d = await db.delivery.findUniqueOrThrow({ where: { id: w.delivery.id } });
    expect(d).toMatchObject({ agentId: null, status: "CANCELLED" });
  });
});

// =====================================================================
// Manual assignment rules
// =====================================================================
describe("@regression Delivery manual assignment of a busy / away partner", () => {
  let t: DeliveryTenant;
  let a: Awaited<ReturnType<typeof addPartner>>;
  let free: Awaited<ReturnType<typeof addPartner>>;
  let extra: Awaited<ReturnType<typeof deliveryOrder>>;

  beforeAll(async () => {
    t = await deliveryTenant();
    a = await addPartner(t, "A partner");
    await onDuty(a.id, t.outlet.id);
    await deliveryOrder(t);
    await deliveryOrder(t); // A is full (2 of 2)
    extra = await deliveryOrder(t);
    free = await addPartner(t, "Z free partner");
  });

  it("IT-DEL-050 cashier assigning a full partner → 409 PARTNER_UNAVAILABLE, canForce false", async () => {
    const res = await t.cashier.patch(`/delivery/${extra.delivery.id}/assign`, { agentId: a.id });
    expect(res.status).toBe(409);
    expect(res.body.details).toMatchObject({ code: "PARTNER_UNAVAILABLE", canForce: false, reason: "Has 2 of 2 orders" });
  });

  it("IT-DEL-051 cashier cannot override with force:true → still 409", async () => {
    const res = await t.cashier.patch(`/delivery/${extra.delivery.id}/assign`, { agentId: a.id, force: true });
    expect(res.status).toBe(409);
    expect(await agentOf(extra.delivery.id)).toBeNull();
  });

  it("IT-DEL-052 manager gets the warning (canForce true) and can Assign anyway with force", async () => {
    const warn = await t.manager.patch(`/delivery/${extra.delivery.id}/assign`, { agentId: a.id });
    expect(warn.status).toBe(409);
    expect(warn.body.details).toMatchObject({ code: "PARTNER_UNAVAILABLE", canForce: true });
    const ok = await t.manager.patch(`/delivery/${extra.delivery.id}/assign`, { agentId: a.id, force: true });
    expect(ok.status).toBe(200);
    expect(ok.body.agentId).toBe(a.id);
    const [pa] = await inOutlet(t.outlet.id, () => partnerAvailability(t.outlet.id, undefined, [a.id]));
    expect(pa.active).toBe(3);
  });

  it("IT-DEL-053 owner gets canForce true as well", async () => {
    const o = await deliveryOrder(t);
    const res = await t.owner.patch(`/delivery/${o.delivery.id}/assign`, { agentId: a.id });
    expect(res.status).toBe(409);
    expect(res.body.details.canForce).toBe(true);
  });

  it("IT-DEL-054 assigning a partner who is not clocked in is refused for the cashier too", async () => {
    const o = await deliveryOrder(t);
    const res = await t.cashier.patch(`/delivery/${o.delivery.id}/assign`, { agentId: free.id });
    expect(res.status).toBe(409);
    expect(res.body.details.reason).toBe("Not clocked in");
  });

  it("IT-DEL-055 cashier assigns an available partner → 200, partner notified", async () => {
    await onDuty(free.id, t.outlet.id);
    const o = await deliveryOrder(t); // auto-assigned to free (A is full)
    expect(o.delivery.agentId).toBe(free.id);
    await t.cashier.patch(`/delivery/${o.delivery.id}/assign`, { agentId: null });
    const res = await t.cashier.patch(`/delivery/${o.delivery.id}/assign`, { agentId: free.id });
    expect(res.status).toBe(200);
    const n = await db.notification.findFirst({ where: { userId: free.id, title: "New delivery assigned" } });
    expect(n).not.toBeNull();
  });

  it("IT-DEL-056 unassign (agentId null) → 200, assignedAt cleared; reassignment notifies the old partner", async () => {
    const o = await deliveryOrder(t);
    const un = await t.manager.patch(`/delivery/${o.delivery.id}/assign`, { agentId: null });
    expect(un.status).toBe(200);
    expect(un.body).toMatchObject({ agentId: null, assignedAt: null });
    await t.manager.patch(`/delivery/${o.delivery.id}/assign`, { agentId: free.id, force: true });
    await t.manager.patch(`/delivery/${o.delivery.id}/assign`, { agentId: a.id, force: true });
    const n = await db.notification.findFirst({ where: { userId: free.id, title: "Delivery reassigned" } });
    expect(n).not.toBeNull();
  });

  it("IT-DEL-057 assigning a non-partner (cashier) or a partner of another business → 400", async () => {
    const o = await deliveryOrder(t);
    expect((await t.manager.patch(`/delivery/${o.delivery.id}/assign`, { agentId: t.users.CASHIER.id })).status).toBe(400);
    const other = await deliveryTenant();
    const foreign = await addPartner(other, "Foreign");
    expect((await t.manager.patch(`/delivery/${o.delivery.id}/assign`, { agentId: foreign.id, force: true })).status).toBe(400);
    expect((await t.manager.patch(`/delivery/${o.delivery.id}/assign`, {})).status).toBe(400);
  });

  it("IT-DEL-058 assigning a delivered / cancelled delivery → 409", async () => {
    const o = await deliveryOrder(t);
    await t.manager.patch(`/delivery/${o.delivery.id}/status`, { status: "CANCELLED" });
    const res = await t.manager.patch(`/delivery/${o.delivery.id}/assign`, { agentId: free.id, force: true });
    expect(res.status).toBe(409);
  });

  it("IT-DEL-059 POS order naming a full partner: cashier 409 (canForce false); manager forceAssign → 201", async () => {
    const c = await postDeliveryOrder(t, t.cashier, { agentId: a.id });
    expect(c.status).toBe(409);
    expect(c.body.details).toMatchObject({ code: "PARTNER_UNAVAILABLE", canForce: false });
    const m = await postDeliveryOrder(t, t.manager, { agentId: a.id });
    expect(m.status).toBe(409);
    expect(m.body.details.canForce).toBe(true);
    const f = await postDeliveryOrder(t, t.manager, { agentId: a.id, forceAssign: true });
    expect(f.status).toBe(201);
    expect((await db.delivery.findUniqueOrThrow({ where: { orderId: f.body.id } })).agentId).toBe(a.id);
  });

  it("IT-DEL-060 cashier assigning a partner who is on a run (under the limit) → 409 'Out for delivery'", async () => {
    const t2 = await deliveryTenant();
    const p = await addPartner(t2, "Runner");
    await onDuty(p.id, t2.outlet.id);
    const me = await as(p.email, t2.outlet.id);
    const o1 = await deliveryOrder(t2);
    await me.patch(`/delivery/${o1.delivery.id}/status`, { status: "OUT_FOR_DELIVERY" });
    const o2 = await deliveryOrder(t2);
    const res = await t2.cashier.patch(`/delivery/${o2.delivery.id}/assign`, { agentId: p.id });
    expect(res.status).toBe(409);
    expect(res.body.details.reason).toBe("Out for delivery");
  });
});

// =====================================================================
// Status transitions
// =====================================================================
describe("@regression Delivery status flow", () => {
  let t: DeliveryTenant;
  let a: Awaited<ReturnType<typeof addPartner>>;
  let b: Awaited<ReturnType<typeof addPartner>>;
  let meA: Awaited<ReturnType<typeof as>>;
  let meB: Awaited<ReturnType<typeof as>>;

  beforeAll(async () => {
    t = await deliveryTenant({ max: 10 });
    a = await addPartner(t, "A partner");
    b = await addPartner(t, "B partner");
    await onDuty(a.id, t.outlet.id);
    meA = await as(a.email, t.outlet.id);
    meB = await as(b.email, t.outlet.id);
  });

  it("IT-DEL-070 PENDING → ACCEPTED sets acceptedAt; returns a WhatsApp customer message link", async () => {
    const o = await deliveryOrder(t);
    const res = await meA.patch(`/delivery/${o.delivery.id}/status`, { status: "ACCEPTED" });
    expect(res.status).toBe(200);
    expect(res.body.acceptedAt).toBeTruthy();
    expect(res.body.customerMessage.waLink).toMatch(/^https:\/\/wa\.me\/91\d{10}\?text=/);
  });

  it.each([
    ["OUT_FOR_DELIVERY", "ACCEPTED"],
    ["OUT_FOR_DELIVERY", "PENDING"],
    ["ACCEPTED", "ACCEPTED"],
  ])("IT-DEL-071 backwards / same-state %s → %s is 400", async (from, to) => {
    const o = await deliveryOrder(t);
    // unassigned, so partner A is not put "on a run" by this synthetic state
    await db.delivery.update({ where: { id: o.delivery.id }, data: { status: from as "ACCEPTED", agentId: null } });
    const res = await t.manager.patch(`/delivery/${o.delivery.id}/status`, { status: to });
    expect(res.status).toBe(400);
  });

  it("IT-DEL-072 skipping steps forward (PENDING → OUT_FOR_DELIVERY) is allowed", async () => {
    const o = await deliveryOrder(t);
    const res = await meA.patch(`/delivery/${o.delivery.id}/status`, { status: "OUT_FOR_DELIVERY" });
    expect(res.status).toBe(200);
    // reset partner for later tests
    await meA.post(`/delivery/${o.delivery.id}/complete`, {});
    await t.manager.post(`/delivery/agents/${a.id}/back`);
  });

  it("IT-DEL-073 dispatch without an agent → 400 'Assign an agent'", async () => {
    const o = await deliveryOrder(t);
    await t.manager.patch(`/delivery/${o.delivery.id}/assign`, { agentId: null });
    const res = await t.manager.patch(`/delivery/${o.delivery.id}/status`, { status: "OUT_FOR_DELIVERY" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Assign an agent/);
  });

  it("IT-DEL-074 partner cannot cancel (403); manager can (200, managers notified); terminal states are final", async () => {
    const o = await deliveryOrder(t);
    expect((await meA.patch(`/delivery/${o.delivery.id}/status`, { status: "CANCELLED" })).status).toBe(403);
    const c = await t.manager.patch(`/delivery/${o.delivery.id}/status`, { status: "CANCELLED", note: "Customer asked" });
    expect(c.status).toBe(200);
    expect(c.body.notes).toContain("CANCELLED: Customer asked");
    expect((await t.manager.patch(`/delivery/${o.delivery.id}/status`, { status: "ACCEPTED" })).status).toBe(400);
    expect((await t.manager.patch(`/delivery/${o.delivery.id}/status`, { status: "CANCELLED" })).status).toBe(400);
  });

  it("IT-DEL-075 a partner cannot move someone else's delivery → 403", async () => {
    const o = await deliveryOrder(t);
    expect(o.delivery.agentId).toBe(a.id);
    expect((await meB.patch(`/delivery/${o.delivery.id}/status`, { status: "ACCEPTED" })).status).toBe(403);
  });

  it("IT-DEL-076 @critical partner marking an unpaid order DELIVERED via status → 409 COLLECT_PAYMENT with amount due", async () => {
    const o = await deliveryOrder(t, { cod: true });
    const res = await meA.patch(`/delivery/${o.delivery.id}/status`, { status: "DELIVERED" });
    expect(res.status).toBe(409);
    expect(res.body.details).toMatchObject({ code: "COLLECT_PAYMENT", amountDue: 10000 });
    expect((await db.delivery.findUniqueOrThrow({ where: { id: o.delivery.id } })).status).toBe("PENDING");
  });

  it("IT-DEL-077 partner cannot complete a PENDING delivery (accept first) → 409", async () => {
    const o = await deliveryOrder(t);
    const res = await meA.post(`/delivery/${o.delivery.id}/complete`, {});
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/Accept the delivery first/);
  });

  it("IT-DEL-078 cancelling the order cancels the delivery; completing it then → 409, no payment", async () => {
    const o = await deliveryOrder(t);
    await meA.patch(`/delivery/${o.delivery.id}/status`, { status: "ACCEPTED" });
    expect((await t.manager.post(`/orders/${o.order.id}/cancel`, { reason: "Duplicate" })).status).toBeLessThan(300);
    expect((await db.delivery.findUniqueOrThrow({ where: { id: o.delivery.id } })).status).toBe("CANCELLED");
    expect((await meA.post(`/delivery/${o.delivery.id}/complete`, {})).status).toBe(409);
    expect(await db.payment.count({ where: { orderId: o.order.id, status: "SUCCESS" } })).toBe(0);
  });

  it("IT-DEL-079 unknown status value → 400; unknown delivery id → 404", async () => {
    const o = await deliveryOrder(t);
    expect((await t.manager.patch(`/delivery/${o.delivery.id}/status`, { status: "LOST" })).status).toBe(400);
    expect((await t.manager.patch(`/delivery/nope/status`, { status: "ACCEPTED" })).status).toBe(404);
  });

  it("IT-DEL-080 a delivery of another business is 404 for this manager", async () => {
    const o = await deliveryOrder(t);
    const other = await deliveryTenant();
    expect((await other.manager.get(`/delivery/${o.delivery.id}`)).status).toBe(404);
    expect((await other.manager.patch(`/delivery/${o.delivery.id}/status`, { status: "CANCELLED" })).status).toBe(404);
  });
});

// =====================================================================
// Partner portal
// =====================================================================
describe("@regression Delivery partner portal", () => {
  let t: DeliveryTenant;
  let a: Awaited<ReturnType<typeof addPartner>>;
  let b: Awaited<ReturnType<typeof addPartner>>;
  let meA: Awaited<ReturnType<typeof as>>;
  let meB: Awaited<ReturnType<typeof as>>;
  let codA: Awaited<ReturnType<typeof deliveryOrder>>;
  let prepaidA: Awaited<ReturnType<typeof deliveryOrder>>;
  let ofB: Awaited<ReturnType<typeof deliveryOrder>>;

  beforeAll(async () => {
    t = await deliveryTenant({ max: 5 });
    a = await addPartner(t, "A partner");
    b = await addPartner(t, "B partner");
    meA = await as(a.email, t.outlet.id);
    meB = await as(b.email, t.outlet.id);
    codA = await deliveryOrder(t, { cod: true, agentId: a.id, forceAssign: true }, t.manager);
    prepaidA = await deliveryOrder(t, { agentId: a.id, forceAssign: true, price: 25000 }, t.manager);
    await t.cashier.post(`/orders/${prepaidA.order.id}/payments`, { payments: [{ mode: "UPI", amount: 25000, reference: "UTR1" }] });
    ofB = await deliveryOrder(t, { agentId: b.id, forceAssign: true }, t.manager);
  });

  it("IT-DEL-090 @critical /delivery/mine lists only the partner's own deliveries", async () => {
    const res = await meA.get("/delivery/mine");
    expect(res.status).toBe(200);
    const ids = res.body.map((d: { id: string }) => d.id).sort();
    expect(ids).toEqual([codA.delivery.id, prepaidA.delivery.id].sort());
    expect(res.body.every((d: { agentId: string }) => d.agentId === a.id)).toBe(true);
  });

  it("IT-DEL-091 @critical GET /delivery/:id of another partner's delivery → 403; own → 200", async () => {
    expect((await meA.get(`/delivery/${ofB.delivery.id}`)).status).toBe(403);
    expect((await meB.get(`/delivery/${ofB.delivery.id}`)).status).toBe(200);
  });

  it("IT-DEL-092 COD shows the amount to collect; prepaid shows nothing to collect", async () => {
    const cod = (await meA.get(`/delivery/${codA.delivery.id}`)).body;
    expect(cod).toMatchObject({ cod: true, amountDue: 10000, amountPaid: 0 });
    const pre = (await meA.get(`/delivery/${prepaidA.delivery.id}`)).body;
    expect(pre).toMatchObject({ cod: false, amountDue: 0, amountPaid: 25000 });
    const sum = (await meA.get("/delivery/mine/summary")).body;
    expect(sum).toMatchObject({ activeDeliveries: 2, codOrders: 1, codToCollect: 10000 });
  });

  it("IT-DEL-093 partner cannot read the manager board, cash board, zones or agents (403)", async () => {
    for (const p of ["/delivery", "/delivery/cash", "/delivery/zones", "/delivery/agents", "/delivery/partners/activity"]) {
      expect((await meA.get(p)).status, p).toBe(403);
    }
  });

  it("IT-DEL-094 kitchen staff cannot see a delivery (403)", async () => {
    const k = await as(t.users.KITCHEN.email, t.outlet.id);
    expect((await k.get(`/delivery/${codA.delivery.id}`)).status).toBe(403);
    expect((await k.get(`/delivery`)).status).toBe(403);
  });

  it("IT-DEL-095 issue report appends ISSUE note and notifies managers; other partner → 403", async () => {
    const res = await meA.post(`/delivery/${codA.delivery.id}/issue`, { reason: "CUSTOMER_UNREACHABLE", note: "Phone off" });
    expect(res.status).toBe(200);
    expect(res.body.notes).toContain("ISSUE: Customer not reachable — Phone off");
    const n = await db.notification.findFirst({ where: { userId: t.users.OUTLET_MANAGER.id, title: `Delivery problem: ${codA.order.invoiceNumber}` } });
    expect(n?.body).toContain("Phone off");
    expect((await meB.post(`/delivery/${codA.delivery.id}/issue`, { reason: "OTHER" })).status).toBe(403);
    expect((await meA.post(`/delivery/${codA.delivery.id}/issue`, { reason: "FLAT_TYRE" })).status).toBe(400);
  });

  it("IT-DEL-096 live location on own active delivery → ok; on someone else's → 403", async () => {
    const r = await meA.post(`/delivery/${codA.delivery.id}/location`, { lat: 13.09, lng: 80.27 });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect((await meA.post(`/delivery/${ofB.delivery.id}/location`, { lat: 13.09, lng: 80.27 })).status).toBe(403);
  });

  it("IT-DEL-097 completing a prepaid order records no cash; it moves to history", async () => {
    await meA.patch(`/delivery/${prepaidA.delivery.id}/status`, { status: "ACCEPTED" });
    const done = await meA.post(`/delivery/${prepaidA.delivery.id}/complete`, {});
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ status: "DELIVERED", cashCollected: 0 });
    expect(await db.payment.count({ where: { orderId: prepaidA.order.id, mode: "CASH" } })).toBe(0);
    const hist = (await meA.get("/delivery/mine?view=history")).body;
    expect(hist.map((d: { id: string }) => d.id)).toContain(prepaidA.delivery.id);
    expect((await meA.post(`/delivery/${prepaidA.delivery.id}/issue`, { reason: "OTHER" })).status).toBe(409);
  });

  it("IT-DEL-098 module DELIVERY switched off → 403 for the board and the portal", async () => {
    const off = await deliveryTenant({ modules: ["BILLING", "ATTENDANCE"] });
    expect((await off.manager.get("/delivery")).status).toBe(403);
    const dp = await as(off.users.DELIVERY.email, off.outlet.id);
    expect((await dp.get("/delivery/mine")).status).toBe(403);
  });

  it("IT-DEL-099 manager board filters: agentId=none lists only unassigned; active=1 hides delivered", async () => {
    const un = await deliveryOrder(t);
    const none = (await t.manager.get("/delivery?agentId=none")).body;
    expect(none.map((d: { id: string }) => d.id)).toContain(un.delivery.id);
    expect(none.every((d: { agentId: string | null }) => d.agentId === null)).toBe(true);
    const active = (await t.manager.get("/delivery?active=1")).body;
    expect(active.map((d: { id: string }) => d.id)).not.toContain(prepaidA.delivery.id);
  });
});
