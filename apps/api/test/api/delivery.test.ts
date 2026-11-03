/**
 * QA Phase 6 — /delivery: zones, quote, delivery orders (COD), assignment limit and the on-a-run
 * lock, status flow, completing / collecting at the door, the partner cash ledger (handovers,
 * settle) and the partner portal. Contract, roles, module gating, tenant isolation, validation, and
 * money races (door collection racing the counter, settling twice at once).
 */
import bcrypt from "bcryptjs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHotel, login, PASSWORD, startServer } from "../integration/helpers";
import { assertIntegerMoney, assertNoSecrets, db, LONG, makeWorld, roleMatrix, UNICODE_NAME, type Client, type World } from "./service-fixtures";

let srv: Awaited<ReturnType<typeof startServer>>;
let w: World;
let manager: Client, cashier: Client, partner: Client, partner2: Client, waiter: Client;
let p1: string, p2: string;

const phone = () => `9${String(Math.floor(Math.random() * 1e9)).padStart(9, "0")}`;
const deliveryOrder = async (c: Client = cashier, d: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => {
  const r = await c.call("POST", "/orders", {
    orderType: "DELIVERY",
    customerName: "Door Customer",
    customerPhone: phone(),
    delivery: { address: "12 Anna Salai, Chennai", latitude: 13.01, longitude: 80.2, ...d },
    items: [{ menuItemId: w.h.items.biryani, quantity: 1 }],
    ...extra,
  });
  return r;
};
const newDelivery = async (d: Record<string, unknown> = {}) => {
  const r = await deliveryOrder(cashier, d);
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  const del = await db.delivery.findFirstOrThrow({ where: { orderId: r.body.id } });
  return { orderId: r.body.id as string, grandTotal: r.body.grandTotal as number, id: del.id };
};
const onDuty = async (userId: string) => {
  await db.staffAttendance.create({ data: { userId, outletId: w.h.outletId, workDate: new Date().toISOString().slice(0, 10), clockInAt: new Date(), clockInDistance: 0, status: "PRESENT" } });
};
const resetPartner = async (userId: string) => {
  await db.delivery.updateMany({ where: { agentId: userId, status: { in: ["PENDING", "ACCEPTED", "PREPARING", "OUT_FOR_DELIVERY"] } }, data: { status: "CANCELLED" } });
  await db.user.update({ where: { id: userId }, data: { deliveryAtOutlet: true, deliveryRunStartedAt: null } });
};

beforeAll(async () => {
  srv = await startServer();
  w = await makeWorld(srv.base, "Delivery API");
  ({ manager, cashier, waiter } = w.as);
  partner = w.as.delivery;
  p1 = w.h.users.delivery.id;
  const email2 = `partner2.${Date.now()}@it.local`;
  p2 = (await db.user.create({ data: { businessId: w.h.businessId, role: "DELIVERY", name: "Partner Two", email: email2, phone: phone(), passwordHash: await bcrypt.hash(PASSWORD, 4), outlets: { create: { outletId: w.h.outletId } } } })).id;
  partner2 = await login(srv.base, email2, w.h.outletId);
  await onDuty(p1);
  await onDuty(p2);
});
afterAll(() => srv.close());

// =====================================================================
describe("zones and quote", () => {
  it("zone CRUD (owner / manager: delivery:manage + settings:outlet); integer money; validation", async () => {
    const z = await manager.call("POST", "/delivery/zones", { name: "Near 🛵", radiusKm: 5, fee: 3000, minOrder: 10000, outletId: w.h.outlet2Id });
    expect(z.status).toBe(201);
    expect(z.body).toMatchObject({ name: "Near 🛵", fee: 3000, outletId: w.h.outletId });
    for (const body of [{}, { name: "", radiusKm: 1 }, { name: "x", radiusKm: 0 }, { name: "x", radiusKm: 101 }, { name: "x", radiusKm: 1, fee: -1 }, { name: "x", radiusKm: 1, fee: 1.5 }, { name: "x", radiusKm: 1, etaMinutes: 4 }, { name: LONG, radiusKm: 1 }]) {
      expect((await manager.call("POST", "/delivery/zones", body)).status, JSON.stringify(body).slice(0, 50)).toBe(400);
    }
    expect((await manager.call("PATCH", `/delivery/zones/${z.body.id}`, { fee: 2500 })).body.fee).toBe(2500);
    expect((await manager.call("PATCH", "/delivery/zones/cl0000000000000000000000", { fee: 1 })).status).toBe(404);
    expect((await w.otherOwner.call("PATCH", `/delivery/zones/${z.body.id}`, { fee: 0 })).status).toBe(404);
    expect((await w.otherOwner.call("DELETE", `/delivery/zones/${z.body.id}`)).status).toBe(404);
    expect(await roleMatrix(w, ["owner", "manager"], (c, r) => c.call("POST", "/delivery/zones", { name: `Z ${r}`, radiusKm: 50 }), 201)).toEqual([]);
    expect(await roleMatrix(w, ["owner", "manager", "cashier"], (c) => c.call("GET", "/delivery/zones"), 200)).toEqual([]);
  });

  it("quote: coordinates validated; without them → zone list; with them → fee / deliverable", async () => {
    expect((await cashier.call("GET", "/delivery/quote?lat=91&lng=80")).status).toBe(400);
    expect((await cashier.call("GET", "/delivery/quote?lat=abc&lng=80")).status).toBe(400);
    expect((await cashier.call("GET", "/delivery/quote")).body.needsCoordinates).toBe(true);
    const q = await cashier.call("GET", "/delivery/quote?lat=13.01&lng=80.2");
    expect(q.status).toBe(200);
    expect(q.body.deliverable).toBe(true);
    assertIntegerMoney(q.body);
  });
});

// =====================================================================
describe("delivery orders and COD", () => {
  it("a delivery order needs a name, phone and an address in range", async () => {
    expect((await cashier.call("POST", "/orders", { orderType: "DELIVERY", items: [{ menuItemId: w.h.items.biryani, quantity: 1 }] })).status).toBe(400);
    expect((await deliveryOrder(cashier, {}, { customerName: undefined })).status).toBe(400);
    expect((await deliveryOrder(cashier, { address: "x" })).status).toBe(400);
    expect((await deliveryOrder(cashier, { latitude: 28.6, longitude: 77.2 })).status).toBe(400);
    expect((await deliveryOrder(cashier, { latitude: 91 })).status).toBe(400);
    const ok = await deliveryOrder(cashier, { address: UNICODE_NAME + " street" });
    expect(ok.status).toBe(201);
    expect((await db.delivery.findFirstOrThrow({ where: { orderId: ok.body.id } })).address).toBe(UNICODE_NAME + " street");
  });

  it("choosing COD is a payment decision: a waiter can't (403), a cashier can", async () => {
    expect((await deliveryOrder(waiter, { cod: true })).status).toBe(403);
    const r = await deliveryOrder(cashier, { cod: true });
    expect(r.status).toBe(201);
    expect((await db.delivery.findFirstOrThrow({ where: { orderId: r.body.id } })).cod).toBe(true);
  });

  it("POST /orders/:id/cod: toggles; a paid or cancelled order → 409; waiter → 403", async () => {
    const d = await newDelivery();
    expect((await waiter.call("POST", `/orders/${d.orderId}/cod`, {})).status).toBe(403);
    const on = await cashier.call("POST", `/orders/${d.orderId}/cod`, {});
    expect(on.status).toBe(200);
    expect(on.body.delivery.cod).toBe(true);
    expect((await cashier.call("POST", `/orders/${d.orderId}/cod`, { cod: false })).body.delivery.cod).toBe(false);
    await cashier.call("POST", `/orders/${d.orderId}/payments`, { payments: [{ mode: "UPI", amount: d.grandTotal }] });
    expect((await cashier.call("POST", `/orders/${d.orderId}/cod`, {})).status).toBe(409);
    const c = await newDelivery();
    await manager.call("POST", `/orders/${c.orderId}/cancel`, { reason: "customer cancelled" });
    expect((await cashier.call("POST", `/orders/${c.orderId}/cod`, {})).status).toBe(409);
  });
});

// =====================================================================
describe("assignment limit and the on-a-run lock", () => {
  it("a partner takes up to the outlet's limit; the next → 409 (cashier can't force, manager can)", async () => {
    await resetPartner(p1);
    const ds = [await newDelivery(), await newDelivery(), await newDelivery()];
    for (const d of ds) await db.delivery.update({ where: { id: d.id }, data: { agentId: null } });
    expect((await cashier.call("PATCH", `/delivery/${ds[0].id}/assign`, { agentId: p1 })).status).toBe(200);
    expect((await cashier.call("PATCH", `/delivery/${ds[1].id}/assign`, { agentId: p1 })).status).toBe(200);
    const third = await cashier.call("PATCH", `/delivery/${ds[2].id}/assign`, { agentId: p1 });
    expect(third.status).toBe(409);
    expect(third.body.details).toMatchObject({ code: "PARTNER_UNAVAILABLE", canForce: false });
    expect((await cashier.call("PATCH", `/delivery/${ds[2].id}/assign`, { agentId: p1, force: true })).status).toBe(409);
    expect((await manager.call("PATCH", `/delivery/${ds[2].id}/assign`, { agentId: p1, force: true })).status).toBe(200);
  });

  it("out on a run: no new orders until back; 'back' refused while orders are out", async () => {
    await resetPartner(p1);
    const a = await newDelivery();
    const b = await newDelivery();
    await db.delivery.updateMany({ where: { id: { in: [a.id, b.id] } }, data: { agentId: null } });
    await manager.call("PATCH", `/delivery/${a.id}/assign`, { agentId: p1 });
    expect((await partner.call("PATCH", `/delivery/${a.id}/status`, { status: "OUT_FOR_DELIVERY" })).status).toBe(200);
    const blocked = await cashier.call("PATCH", `/delivery/${b.id}/assign`, { agentId: p1 });
    expect(blocked.status).toBe(409);
    expect(blocked.body.details.reason).toMatch(/Out for delivery/);
    expect((await manager.call("POST", `/delivery/agents/${p1}/back`)).status).toBe(409);
    expect((await manager.call("POST", "/delivery/agents/cl0000000000000000000000/back")).status).toBe(404);
  });

  it("not clocked in / unknown / not a partner → refused", async () => {
    const d = await newDelivery();
    const off = (await db.user.create({ data: { businessId: w.h.businessId, role: "DELIVERY", name: "Off duty", email: `off.${Date.now()}@it.local`, phone: phone(), passwordHash: "x", outlets: { create: { outletId: w.h.outletId } } } })).id;
    expect((await cashier.call("PATCH", `/delivery/${d.id}/assign`, { agentId: off })).body.details?.reason).toMatch(/clocked in/);
    expect((await cashier.call("PATCH", `/delivery/${d.id}/assign`, { agentId: w.h.users.cashier.id })).status).toBe(400);
    expect((await cashier.call("PATCH", `/delivery/${d.id}/assign`, { agentId: w.other.users.delivery.id })).status).toBe(400);
    expect((await cashier.call("PATCH", `/delivery/${d.id}/assign`, {})).status).toBe(400);
    expect((await cashier.call("PATCH", `/delivery/${d.id}/assign`, { agentId: null })).body.agentId).toBeNull();
  });

  it("agents list: availability fields, no secrets", async () => {
    const r = await manager.call("GET", "/delivery/agents");
    expect(r.status).toBe(200);
    expect(r.body.find((a: { id: string }) => a.id === p1)).toMatchObject({ onDuty: true, max: expect.any(Number), available: expect.any(Boolean) });
    assertNoSecrets(r.body);
  });
});

// =====================================================================
describe("status flow, completing and collecting at the door", () => {
  it("partner: can't cancel, can't go backwards, can't mark an unpaid order delivered without collecting", async () => {
    await resetPartner(p1);
    const d = await newDelivery();
    await manager.call("PATCH", `/delivery/${d.id}/assign`, { agentId: p1, force: true });
    expect((await partner.call("PATCH", `/delivery/${d.id}/status`, { status: "CANCELLED" })).status).toBe(403);
    expect((await partner.call("PATCH", `/delivery/${d.id}/status`, { status: "PREPARING" })).status).toBe(200);
    expect((await partner.call("PATCH", `/delivery/${d.id}/status`, { status: "ACCEPTED" })).status).toBe(400);
    expect((await partner.call("PATCH", `/delivery/${d.id}/status`, { status: "LOST" })).status).toBe(400);
    expect((await partner.call("PATCH", `/delivery/${d.id}/status`, { status: "OUT_FOR_DELIVERY", note: LONG })).status).toBe(400);
    const done = await partner.call("PATCH", `/delivery/${d.id}/status`, { status: "DELIVERED" });
    expect(done.status).toBe(409);
    expect(done.body.details).toMatchObject({ code: "COLLECT_PAYMENT", amountDue: d.grandTotal });
    expect((await partner2.call("PATCH", `/delivery/${d.id}/status`, { status: "OUT_FOR_DELIVERY" })).status).toBe(403);
    expect((await partner2.call("GET", `/delivery/${d.id}`)).status).toBe(403);
  });

  it("dispatch without an agent → 400", async () => {
    const d = await newDelivery();
    await db.delivery.update({ where: { id: d.id }, data: { agentId: null } });
    expect((await manager.call("PATCH", `/delivery/${d.id}/status`, { status: "OUT_FOR_DELIVERY" })).status).toBe(400);
  });

  it("complete (COD): cash recorded against the partner; a stale amount → 409; twice → 409; a cancelled order → 409", async () => {
    await resetPartner(p2);
    const d = await newDelivery({ cod: true });
    await manager.call("PATCH", `/delivery/${d.id}/assign`, { agentId: p2, force: true });
    await partner2.call("PATCH", `/delivery/${d.id}/status`, { status: "ACCEPTED" });
    expect((await partner2.call("POST", `/delivery/${d.id}/complete`, { cashCollected: d.grandTotal - 1 })).status).toBe(409);
    expect((await partner2.call("POST", `/delivery/${d.id}/complete`, { cashCollected: -1 })).status).toBe(400);
    expect((await partner.call("POST", `/delivery/${d.id}/complete`, {})).status).toBe(403);
    const ok = await partner2.call("POST", `/delivery/${d.id}/complete`, { cashCollected: d.grandTotal });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ status: "DELIVERED", cashCollected: d.grandTotal, amountDue: 0 });
    assertIntegerMoney(ok.body);
    expect((await db.payment.findFirstOrThrow({ where: { orderId: d.orderId } })).collectedById).toBe(p2);
    expect((await partner2.call("POST", `/delivery/${d.id}/complete`, {})).status).toBe(409);
    const c = await newDelivery();
    await manager.call("PATCH", `/delivery/${c.id}/assign`, { agentId: p2, force: true });
    await manager.call("POST", `/orders/${c.orderId}/cancel`, { reason: "cancelled order" });
    expect((await partner2.call("POST", `/delivery/${c.id}/complete`, {})).status).toBe(409);
  });

  it("collect: more than due / zero / bad mode → 400; already paid → 409", async () => {
    const d = await newDelivery();
    await manager.call("PATCH", `/delivery/${d.id}/assign`, { agentId: p1, force: true });
    for (const payments of [[{ mode: "CASH", amount: d.grandTotal + 1 }], [{ mode: "CASH", amount: 0 }], [{ mode: "KHATA", amount: 100 }], [{ mode: "CASH", amount: 1.5 }], []]) {
      expect((await partner.call("POST", `/delivery/${d.id}/collect`, { payments })).status, JSON.stringify(payments)).toBe(400);
    }
    expect((await partner.call("POST", `/delivery/${d.id}/collect`, { payments: [{ mode: "UPI", amount: d.grandTotal, reference: "UTR1" }] })).body.paid).toBe(true);
    expect((await partner.call("POST", `/delivery/${d.id}/collect`, { payments: [{ mode: "CASH", amount: 1 }] })).status).toBe(409);
    expect((await partner.call("POST", `/delivery/${d.id}/upi-qr`)).status).toBe(409);
  });

  it("door collection racing the counter → paid once (no overpayment)", async () => {
    const d = await newDelivery();
    await manager.call("PATCH", `/delivery/${d.id}/assign`, { agentId: p1, force: true });
    const rs = await Promise.all([
      partner.call("POST", `/delivery/${d.id}/collect`, { payments: [{ mode: "CASH", amount: d.grandTotal }] }),
      cashier.call("POST", `/orders/${d.orderId}/payments`, { payments: [{ mode: "UPI", amount: d.grandTotal }] }),
    ]);
    expect(rs.filter((r) => r.status === 200)).toHaveLength(1);
    const sum = await db.payment.aggregate({ where: { orderId: d.orderId, status: "SUCCESS" }, _sum: { amount: true } });
    expect(sum._sum.amount).toBe(d.grandTotal);
  });

  it("door UPI QR: partner's own delivery only; confirm once", async () => {
    const d = await newDelivery();
    await manager.call("PATCH", `/delivery/${d.id}/assign`, { agentId: p1, force: true });
    expect((await partner2.call("POST", `/delivery/${d.id}/upi-qr`)).status).toBe(403);
    const q = await partner.call("POST", `/delivery/${d.id}/upi-qr`);
    expect(q.status).toBe(201);
    expect(q.body.amount).toBe(d.grandTotal);
    expect((await partner.call("POST", `/delivery/${d.id}/upi-qr/${q.body.paymentId}/confirm`, { reference: "UTR9" })).body.paid).toBe(true);
    expect((await partner.call("POST", `/delivery/${d.id}/upi-qr/${q.body.paymentId}/confirm`, {})).status).toBe(404);
  });

  it("issue and live location: validated, own delivery only", async () => {
    const d = await newDelivery();
    await manager.call("PATCH", `/delivery/${d.id}/assign`, { agentId: p1, force: true });
    expect((await partner.call("POST", `/delivery/${d.id}/issue`, { reason: "ALIENS" })).status).toBe(400);
    expect((await partner.call("POST", `/delivery/${d.id}/issue`, { reason: "OTHER", note: LONG })).status).toBe(400);
    expect((await partner.call("POST", `/delivery/${d.id}/issue`, { reason: "WRONG_ADDRESS", note: "no such door" })).status).toBe(200);
    expect((await partner2.call("POST", `/delivery/${d.id}/issue`, { reason: "OTHER" })).status).toBe(403);
    expect((await partner.call("POST", `/delivery/${d.id}/location`, { lat: 91, lng: 80 })).status).toBe(400);
    expect((await partner.call("POST", `/delivery/${d.id}/location`, { lat: "13", lng: 80 })).status).toBe(400);
    expect((await partner2.call("POST", `/delivery/${d.id}/location`, { lat: 13, lng: 80 })).status).toBe(403);
    expect((await partner.call("POST", `/delivery/${d.id}/location`, { lat: 13.005, lng: 80.2 })).body.ok).toBe(true);
    expect((await manager.call("POST", `/delivery/${d.id}/location`, { lat: 13, lng: 80 })).status).toBe(403);
    expect((await partner.call("POST", "/delivery/me/location", { lat: 200, lng: 0 })).status).toBe(400);
  });
});

// =====================================================================
describe("partner cash ledger: handovers and settle", () => {
  let agent: string;
  let agentClient: Client;
  beforeAll(async () => {
    const email = `ledger.${Date.now()}@it.local`;
    agent = (await db.user.create({ data: { businessId: w.h.businessId, role: "DELIVERY", name: "Ledger Partner", email, phone: phone(), passwordHash: await bcrypt.hash(PASSWORD, 4), outlets: { create: { outletId: w.h.outletId } } } })).id;
    agentClient = await login(srv.base, email, w.h.outletId);
    await onDuty(agent);
    for (let i = 0; i < 2; i++) {
      const d = await newDelivery({ cod: true });
      await manager.call("PATCH", `/delivery/${d.id}/assign`, { agentId: agent, force: true });
      expect((await agentClient.call("POST", `/delivery/${d.id}/complete`, {})).status).toBe(409); // accept first
      await agentClient.call("PATCH", `/delivery/${d.id}/status`, { status: "ACCEPTED" });
      expect((await agentClient.call("POST", `/delivery/${d.id}/complete`, {})).status).toBe(200);
    }
  });

  it("/mine/cash and /cash agree on the balance", async () => {
    const mine = await agentClient.call("GET", "/delivery/mine/cash");
    expect(mine.status).toBe(200);
    expect(mine.body.balance).toBeGreaterThan(0);
    const all = await manager.call("GET", "/delivery/cash");
    expect(all.body.find((r: { agent: { id: string } }) => r.agent.id === agent).balance).toBe(mine.body.balance);
    assertIntegerMoney(mine.body);
    assertNoSecrets(all.body);
  });

  it("handover validation; partial handover; edit; delete; unknown → 404; other hotel → 404", async () => {
    for (const body of [{ agentId: agent }, { agentId: agent, amount: 0 }, { agentId: agent, amount: -5 }, { agentId: agent, amount: 1.5 }, { agentId: agent, amount: 100, receivedAt: "now" }, { amount: 100 }, { agentId: agent, amount: 100, note: LONG }]) {
      expect((await manager.call("POST", "/delivery/cash/handovers", body)).status, JSON.stringify(body).slice(0, 60)).toBe(400);
    }
    expect((await manager.call("POST", "/delivery/cash/handovers", { agentId: w.h.users.cashier.id, amount: 100 })).status).toBe(400);
    const before = (await agentClient.call("GET", "/delivery/mine/cash")).body.balance;
    const h = await manager.call("POST", "/delivery/cash/handovers", { agentId: agent, amount: 1000, receivedById: w.h.users.owner.id });
    expect(h.status).toBe(201);
    expect(h.body.balance).toBe(before - 1000);
    expect(h.body.handover.receivedById).toBe(w.h.users.manager.id);
    expect((await manager.call("PATCH", `/delivery/cash/handovers/${h.body.handover.id}`, { amount: 0 })).status).toBe(400);
    expect((await manager.call("PATCH", `/delivery/cash/handovers/${h.body.handover.id}`, { amount: 500 })).body.balance).toBe(before - 500);
    expect((await w.otherOwner.call("PATCH", `/delivery/cash/handovers/${h.body.handover.id}`, { amount: 999999 })).status).toBe(404);
    expect((await w.otherOwner.call("DELETE", `/delivery/cash/handovers/${h.body.handover.id}`)).status).toBe(404);
    expect((await manager.call("PATCH", "/delivery/cash/handovers/cl0000000000000000000000", { amount: 5 })).status).toBe(404);
    expect((await manager.call("DELETE", `/delivery/cash/handovers/${h.body.handover.id}`)).body.balance).toBe(before);
    const list = await manager.call("GET", `/delivery/cash/handovers?agentId=${agent}`);
    expect(list.status).toBe(200);
    expect((await manager.call("GET", "/delivery/cash/handovers?from=2026-02-30")).status).toBe(400);
  });

  it("settling twice at the same moment hands over the balance once (never negative)", async () => {
    const before = (await agentClient.call("GET", "/delivery/mine/cash")).body.balance as number;
    expect(before).toBeGreaterThan(0);
    const rs = await Promise.all([manager.call("POST", "/delivery/cash/settle", { agentId: agent }), cashier.call("POST", "/delivery/cash/settle", { agentId: agent })]);
    expect(rs.filter((r) => r.status === 200)).toHaveLength(1);
    expect((await agentClient.call("GET", "/delivery/mine/cash")).body.balance).toBe(0);
    expect((await manager.call("POST", "/delivery/cash/settle", { agentId: agent })).status).toBe(400);
    expect((await manager.call("POST", "/delivery/cash/settle", {})).status).toBe(400);
  });
});

// =====================================================================
describe("lists, partner portal, roles and isolation", () => {
  it("GET /delivery filters; invalid date / status → 400", async () => {
    const r = await manager.call("GET", "/delivery?active=1");
    expect(r.status).toBe(200);
    assertIntegerMoney(r.body);
    assertNoSecrets(r.body);
    expect((await manager.call("GET", "/delivery?agentId=none")).body.every((d: { agentId: string | null }) => d.agentId === null)).toBe(true);
    for (const q of ["date=2026-13-01", "date=2026-02-30", "status=LOST", "active=2"]) expect((await manager.call("GET", `/delivery?${q}`)).status, q).toBe(400);
  });

  it("partner portal: /mine shows only my deliveries; history / summary validate dates", async () => {
    const mine = await partner.call("GET", "/delivery/mine");
    expect(mine.status).toBe(200);
    expect(mine.body.every((d: { agentId: string }) => d.agentId === p1)).toBe(true);
    expect((await partner.call("GET", "/delivery/mine?view=history")).status).toBe(200);
    expect((await partner.call("GET", "/delivery/mine?view=all")).status).toBe(400);
    expect((await partner.call("GET", "/delivery/mine?view=history&from=2026-02-30")).status).toBe(400);
    expect((await partner.call("GET", "/delivery/mine/summary?from=2026-01-10&to=2026-01-01")).status).toBe(400);
    const s = await partner.call("GET", "/delivery/mine/summary");
    expect(s.status).toBe(200);
    assertIntegerMoney(s.body);
    expect((await partner.call("GET", "/delivery/me/status")).body.id).toBe(p1);
  });

  it("roles: delivery:manage (owner, manager, cashier) vs delivery:own (delivery partners)", async () => {
    expect(await roleMatrix(w, ["owner", "manager", "cashier"], (c) => c.call("GET", "/delivery"), 200)).toEqual([]);
    expect(await roleMatrix(w, ["owner", "manager", "cashier"], (c) => c.call("GET", "/delivery/cash"), 200)).toEqual([]);
    expect(await roleMatrix(w, ["delivery"], (c) => c.call("GET", "/delivery/mine"), 200)).toEqual([]);
    expect(await roleMatrix(w, ["delivery"], (c) => c.call("GET", "/delivery/mine/cash"), 200)).toEqual([]);
    expect(await roleMatrix(w, ["owner", "manager", "cashier"], (c) => c.call("GET", "/delivery/partners/activity"), 200)).toEqual([]);
  });

  it("another hotel / unassigned outlet / super admin / DELIVERY module off", async () => {
    const d = await newDelivery();
    for (const [m, p, b] of [["GET", `/delivery/${d.id}`, undefined], ["PATCH", `/delivery/${d.id}/assign`, { agentId: null }], ["PATCH", `/delivery/${d.id}/status`, { status: "CANCELLED" }], ["POST", `/delivery/${d.id}/complete`, {}], ["POST", `/delivery/${d.id}/collect`, { payments: [{ mode: "CASH", amount: 1 }] }]] as const) {
      expect((await w.otherOwner.call(m, p, b)).status, `${m} ${p}`).toBe(404);
    }
    expect((await w.otherOwner.call("GET", "/delivery")).body.map((x: { id: string }) => x.id)).not.toContain(d.id);
    expect((await w.managerOutlet2.call("GET", "/delivery")).status).toBe(403);
    expect((await w.admin.call("GET", "/delivery")).status).toBe(403);
    expect((await db.delivery.findUniqueOrThrow({ where: { id: d.id } })).status).toBe("PENDING");
    const off = await createHotel("No delivery", { modules: ["BILLING"] });
    const o = await login(srv.base, off.users.owner.email, off.outletId);
    expect((await o.call("GET", "/delivery")).status).toBe(403);
  });
});
