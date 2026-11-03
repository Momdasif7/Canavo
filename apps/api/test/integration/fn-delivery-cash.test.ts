/**
 * QA Phase 5 — group D: Cash on Delivery, partner cash ledger, manual cash
 * handovers, settle, partner timeline / activity (README "Cash on Delivery",
 * "Delivery partners page": cash in hand = cash collected − cash received).
 */
import { beforeAll, describe, expect, it } from "vitest";
import { db } from "./helpers";
import { addPartner, as, deliveryOrder, deliveryTenant, onDuty, sleep, type DeliveryTenant } from "./fx-d";

type Partner = Awaited<ReturnType<typeof addPartner>>;

/** Assigned COD delivery for `agent` at `price` paise. */
async function codFor(t: DeliveryTenant, agent: Partner, price: number, cod = true) {
  return deliveryOrder(t, { price, cod, agentId: agent.id, forceAssign: true }, t.manager);
}

// =====================================================================
// COD switch
// =====================================================================
describe("@regression @critical COD order and the cart / payment-step switch", () => {
  let t: DeliveryTenant;
  let a: Partner;

  beforeAll(async () => {
    t = await deliveryTenant({ max: 20 });
    a = await addPartner(t, "A partner");
  });

  it("IT-COD-001 delivery order placed with cod:true → delivery.cod, order OPEN, nothing paid", async () => {
    const { order, delivery } = await codFor(t, a, 15000);
    expect(delivery.cod).toBe(true);
    const o = await db.order.findUniqueOrThrow({ where: { id: order.id }, include: { payments: true } });
    expect(o.status).toBe("OPEN");
    expect(o.payments).toHaveLength(0);
  });

  it("IT-COD-002 POST /orders/:id/cod switches COD on (pending QR voided, partner notified) and off", async () => {
    const { order, delivery } = await codFor(t, a, 12000, false);
    const qr = await t.cashier.post(`/orders/${order.id}/upi-qr`, {});
    expect(qr.status).toBeLessThan(300);
    const on = await t.cashier.post(`/orders/${order.id}/cod`, {});
    expect(on.status).toBe(200);
    expect(on.body.delivery.cod).toBe(true);
    expect(on.body.balance).toBe(12000);
    expect(await db.payment.count({ where: { orderId: order.id, status: "PENDING" } })).toBe(0);
    const n = await db.notification.findFirst({ where: { userId: a.id, title: "Cash on Delivery", body: { contains: "₹120.00" } } });
    expect(n).not.toBeNull();
    const off = await t.cashier.post(`/orders/${order.id}/cod`, { cod: false });
    expect(off.status).toBe(200);
    expect((await db.delivery.findUniqueOrThrow({ where: { id: delivery.id } })).cod).toBe(false);
  });

  it("IT-COD-003 COD on a paid order → 409; on a takeaway order → 400; on a delivered one → 409", async () => {
    const paid = await codFor(t, a, 5000, false);
    await t.cashier.post(`/orders/${paid.order.id}/payments`, { payments: [{ mode: "CASH", amount: 5000 }] });
    expect((await t.cashier.post(`/orders/${paid.order.id}/cod`, {})).status).toBe(409);
    const tk = await t.cashier.post("/orders", { orderType: "TAKEAWAY", items: [{ menuItemId: t.itemId, quantity: 1 }] });
    expect((await t.cashier.post(`/orders/${tk.body.id}/cod`, {})).status).toBe(400);
    const done = await codFor(t, a, 5000, false);
    await t.manager.patch(`/delivery/${done.delivery.id}/status`, { status: "DELIVERED" });
    expect((await t.cashier.post(`/orders/${done.order.id}/cod`, {})).status).toBe(409);
  });

  it("IT-COD-004 a delivery partner cannot switch COD (payment:collect) → 403", async () => {
    const { order } = await codFor(t, a, 5000, false);
    const me = await as(a.email, t.outlet.id);
    expect((await me.post(`/orders/${order.id}/cod`, {})).status).toBe(403);
  });
});

// =====================================================================
// Completing COD deliveries
// =====================================================================
describe("@regression @critical COD completion records cash against the partner", () => {
  let t: DeliveryTenant;
  let a: Partner;
  let me: Awaited<ReturnType<typeof as>>;

  beforeAll(async () => {
    t = await deliveryTenant({ max: 20 });
    a = await addPartner(t, "A partner");
    await onDuty(a.id, t.outlet.id);
    me = await as(a.email, t.outlet.id);
  });

  it("IT-COD-010 partner 'Cash collected & delivered' → CASH payment SUCCESS by the partner (ref COD), order PAID", async () => {
    const { order, delivery } = await codFor(t, a, 23050);
    await me.patch(`/delivery/${delivery.id}/status`, { status: "ACCEPTED" });
    const res = await me.post(`/delivery/${delivery.id}/complete`, { cashCollected: 23050 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: "DELIVERED", cashCollected: 23050, amountDue: 0 });
    const pays = await db.payment.findMany({ where: { orderId: order.id } });
    expect(pays).toHaveLength(1);
    expect(pays[0]).toMatchObject({ mode: "CASH", amount: 23050, status: "SUCCESS", collectedById: a.id, reference: "COD" });
    expect((await db.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("PAID");
    const log = await db.auditLog.findFirst({ where: { action: "delivery.complete", entityId: delivery.id } });
    expect(log).not.toBeNull();
  });

  it("IT-COD-011 'expected' amount mismatch (₹99.99 vs ₹100 due) → 409 and nothing recorded", async () => {
    const { order, delivery } = await codFor(t, a, 10000);
    await me.patch(`/delivery/${delivery.id}/status`, { status: "ACCEPTED" });
    const res = await me.post(`/delivery/${delivery.id}/complete`, { cashCollected: 9999 });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/₹100\.00/);
    expect(await db.payment.count({ where: { orderId: order.id } })).toBe(0);
    expect((await db.delivery.findUniqueOrThrow({ where: { id: delivery.id } })).status).toBe("ACCEPTED");
  });

  it("IT-COD-012 negative / fractional cashCollected → 400", async () => {
    const { delivery } = await codFor(t, a, 10000);
    await me.patch(`/delivery/${delivery.id}/status`, { status: "ACCEPTED" });
    expect((await me.post(`/delivery/${delivery.id}/complete`, { cashCollected: -1 })).status).toBe(400);
    expect((await me.post(`/delivery/${delivery.id}/complete`, { cashCollected: 100.5 })).status).toBe(400);
  });

  it("IT-COD-013 completing twice → 409, still exactly one cash payment", async () => {
    const { order, delivery } = await codFor(t, a, 8000);
    await me.patch(`/delivery/${delivery.id}/status`, { status: "ACCEPTED" });
    expect((await me.post(`/delivery/${delivery.id}/complete`, {})).status).toBe(200);
    expect((await me.post(`/delivery/${delivery.id}/complete`, {})).status).toBe(409);
    expect(await db.payment.count({ where: { orderId: order.id, status: "SUCCESS" } })).toBe(1);
  });

  it("IT-COD-014 part-paid at the counter (₹50 of ₹200) → partner collects only the ₹150 balance", async () => {
    const { order, delivery } = await codFor(t, a, 20000);
    await t.cashier.post(`/orders/${order.id}/payments`, { payments: [{ mode: "CASH", amount: 5000 }] });
    await me.patch(`/delivery/${delivery.id}/status`, { status: "ACCEPTED" });
    const res = await me.post(`/delivery/${delivery.id}/complete`, { cashCollected: 15000 });
    expect(res.status).toBe(200);
    const byPartner = await db.payment.aggregate({ where: { orderId: order.id, collectedById: a.id }, _sum: { amount: true } });
    expect(byPartner._sum.amount).toBe(15000);
  });

  it("IT-COD-015 manager marking DELIVERED records the cash against the assigned partner (not the manager)", async () => {
    const { order, delivery } = await codFor(t, a, 7000);
    const res = await t.manager.patch(`/delivery/${delivery.id}/status`, { status: "DELIVERED" });
    expect(res.status).toBe(200);
    const p = await db.payment.findFirstOrThrow({ where: { orderId: order.id, status: "SUCCESS" } });
    expect(p.collectedById).toBe(a.id);
  });

  it("IT-COD-016 another partner cannot complete or collect on A's delivery → 403", async () => {
    const b = await addPartner(t, "B partner");
    const meB = await as(b.email, t.outlet.id);
    const { delivery } = await codFor(t, a, 6000);
    expect((await meB.post(`/delivery/${delivery.id}/complete`, {})).status).toBe(403);
    expect((await meB.post(`/delivery/${delivery.id}/collect`, { payments: [{ mode: "CASH", amount: 6000 }] })).status).toBe(403);
  });

  it("IT-COD-017 /collect more than the amount due → 400", async () => {
    const { delivery } = await codFor(t, a, 6000);
    const res = await me.post(`/delivery/${delivery.id}/collect`, { payments: [{ mode: "CASH", amount: 6001 }] });
    expect(res.status).toBe(400);
  });

  // BUG-CANDIDATE-D1: README "Delivery partner portal" — partners have "no payment options";
  // Known limitations — "Delivery agents can't record payments". Expected: a DELIVERY user
  // cannot record a payment (403). Actual: POST /delivery/:id/collect by the partner records a
  // UPI/CARD payment with any reference, marks the order PAID, and the amount never enters the
  // partner's cash in hand — so cash taken for a COD order can be hidden behind a fake UTR.
  it.fails("IT-COD-018 @critical (BUG-CANDIDATE-D1) partner cannot self-record a UPI payment on a COD order", async () => {
    const { order, delivery } = await codFor(t, a, 9000);
    const res = await me.post(`/delivery/${delivery.id}/collect`, { payments: [{ mode: "UPI", amount: 9000, reference: "FAKE-UTR" }] });
    expect(res.status).toBe(403);
    expect((await db.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("OPEN");
  });
});

// =====================================================================
// Cash ledger & handovers — explicit numbers
// =====================================================================
describe("@regression @critical COD cash ledger: 3 orders ₹150 + ₹230.50 + ₹99, handover ₹200 → ₹279.50", () => {
  let t: DeliveryTenant;
  let a: Partner;
  let me: Awaited<ReturnType<typeof as>>;
  const ds: { id: string; orderId: string }[] = [];
  let handoverId: string;

  beforeAll(async () => {
    t = await deliveryTenant({ max: 10 });
    a = await addPartner(t, "A partner");
    await onDuty(a.id, t.outlet.id);
    me = await as(a.email, t.outlet.id);
    for (const price of [15000, 23050, 9900]) {
      const { delivery, order } = await codFor(t, a, price);
      ds.push({ id: delivery.id, orderId: order.id });
    }
    for (const [i, d] of ds.entries()) {
      await me.patch(`/delivery/${d.id}/status`, { status: "OUT_FOR_DELIVERY" });
      const r = await me.post(`/delivery/${d.id}/complete`, { cashCollected: [15000, 23050, 9900][i] });
      if (r.status !== 200) throw new Error(JSON.stringify(r.body));
      await sleep(5); // distinct confirmedAt → deterministic FIFO
    }
  });

  it("IT-COD-020 cash in hand after 3 COD orders = ₹479.50 (partner view and manager view)", async () => {
    const mine = (await me.get("/delivery/mine/cash")).body;
    expect(mine).toMatchObject({ balance: 47950, collectedToday: 47950, handedOverToday: 0 });
    expect(mine.pending.map((p: { amount: number }) => p.amount)).toEqual([15000, 23050, 9900]);
    const rows = (await t.manager.get("/delivery/cash")).body;
    const row = rows.find((r: { agent: { id: string } }) => r.agent.id === a.id);
    expect(row).toMatchObject({ balance: 47950, collectedToday: 47950, receivedToday: 0 });
    expect((await me.get("/delivery/mine/summary")).body).toMatchObject({ cashInHand: 47950, cashInHandOrders: 3, delivered: 3 });
  });

  it("IT-COD-021 partial handover ₹200 → cash to receive ₹279.50; FIFO: first order fully covered", async () => {
    const res = await t.manager.post("/delivery/cash/handovers", { agentId: a.id, amount: 20000, note: "Evening" });
    expect(res.status).toBe(201);
    expect(res.body.balance).toBe(27950);
    expect(res.body.warnings).toBeUndefined();
    handoverId = res.body.handover.id;
    const mine = (await me.get("/delivery/mine/cash")).body;
    expect(mine).toMatchObject({ balance: 27950, handedOverToday: 20000 });
    expect(mine.pending.map((p: { amount: number }) => p.amount)).toEqual([18050, 9900]);
    expect(mine.handovers[0]).toMatchObject({ amount: 20000, note: "Evening" });
    expect(mine.handovers[0].receivedBy.id).toBe(t.users.OUTLET_MANAGER.id);
    const settled = await db.delivery.findMany({ where: { id: { in: ds.map((d) => d.id) } }, select: { id: true, cashSettledAt: true } });
    expect(settled.find((d) => d.id === ds[0].id)!.cashSettledAt).not.toBeNull();
    expect(settled.filter((d) => d.cashSettledAt).length).toBe(1);
    expect(await db.notification.findFirst({ where: { userId: a.id, title: "Cash handover recorded" } })).not.toBeNull();
  });

  it("IT-COD-022 edit the handover to ₹400 → ₹79.50 left; two orders settled", async () => {
    const res = await t.manager.patch(`/delivery/cash/handovers/${handoverId}`, { amount: 40000 });
    expect(res.status).toBe(200);
    expect(res.body.balance).toBe(7950);
    const pending = (await me.get("/delivery/mine/cash")).body.pending;
    expect(pending.map((p: { amount: number }) => p.amount)).toEqual([7950]);
    expect(await db.delivery.count({ where: { id: { in: ds.map((d) => d.id) }, cashSettledAt: { not: null } } })).toBe(2);
  });

  it("IT-COD-023 delete the handover → back to ₹479.50 and no order settled", async () => {
    const res = await t.manager.delete(`/delivery/cash/handovers/${handoverId}`);
    expect(res.status).toBe(200);
    expect(res.body.balance).toBe(47950);
    expect(await db.delivery.count({ where: { id: { in: ds.map((d) => d.id) }, cashSettledAt: { not: null } } })).toBe(0);
    expect((await t.manager.delete(`/delivery/cash/handovers/${handoverId}`)).status).toBe(404);
  });

  it("IT-COD-024 several partial handovers add up (₹100 + ₹0.50) → ₹379.00", async () => {
    await t.manager.post("/delivery/cash/handovers", { agentId: a.id, amount: 10000 });
    const r = await t.manager.post("/delivery/cash/handovers", { agentId: a.id, amount: 50 });
    expect(r.body.balance).toBe(37900);
    const list = (await t.manager.get(`/delivery/cash/handovers?agentId=${a.id}`)).body;
    expect(list.map((h: { amount: number }) => h.amount).sort((x: number, y: number) => x - y)).toEqual([50, 10000]);
    expect(list[0].agent.id).toBe(a.id);
  });

  it("IT-COD-025 settle → one 'Full handover' for the whole balance, then balance 0; settle again → 400", async () => {
    const res = await t.manager.post("/delivery/cash/settle", { agentId: a.id });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ amount: 37900, settled: 1 });
    expect(res.body.handover.note).toBe("Full handover");
    expect((await me.get("/delivery/mine/cash")).body.balance).toBe(0);
    expect(await db.delivery.count({ where: { id: { in: ds.map((d) => d.id) }, cashSettledAt: { not: null } } })).toBe(3);
    expect((await t.manager.post("/delivery/cash/settle", { agentId: a.id })).status).toBe(400);
  });

  it("IT-COD-026 handover larger than cash held → 201 with a credit warning and negative balance", async () => {
    const res = await t.manager.post("/delivery/cash/handovers", { agentId: a.id, amount: 1000 });
    expect(res.status).toBe(201);
    expect(res.body.balance).toBe(-1000);
    expect(res.body.warnings[0]).toMatch(/₹10\.00 in credit/);
    await t.manager.delete(`/delivery/cash/handovers/${res.body.handover.id}`);
  });

  it("IT-COD-027 timeline shows the day's events in order with amounts and balances", async () => {
    await me.post(`/delivery/${ds[0].id}/issue`, { reason: "OTHER", note: "late" }).catch(() => undefined);
    const res = await t.manager.get(`/delivery/partners/${a.id}/timeline`);
    expect(res.status).toBe(200);
    const types = res.body.events.map((e: { type: string }) => e.type);
    expect(types).toEqual(expect.arrayContaining(["CLOCK_IN", "ASSIGNED", "PICKED", "DELIVERED", "COLLECTED", "HANDOVER"]));
    expect(types.filter((x: string) => x === "COLLECTED")).toHaveLength(3);
    const collected = res.body.events.filter((e: { type: string }) => e.type === "COLLECTED").map((e: { amount: number }) => e.amount);
    expect(collected.sort((x: number, y: number) => x - y)).toEqual([9900, 15000, 23050]);
    const at = res.body.events.map((e: { at: string }) => new Date(e.at).getTime());
    expect([...at].sort((x, y) => x - y)).toEqual(at);
    expect(res.body.openingBalance).toBe(0);
    expect(res.body.closingBalance).toBe(0);
  });

  it("IT-COD-028 timeline for a non-partner → 400; for a bad date string → handled (no 500)", async () => {
    expect((await t.manager.get(`/delivery/partners/${t.users.CASHIER.id}/timeline`)).status).toBe(400);
    expect((await t.manager.get(`/delivery/partners/${a.id}/timeline?date=2026-02-30`)).status).toBeLessThan(500);
  });

  it("IT-COD-029 activity today: collected ₹479.50, received ₹479.50 (+settle), closing 0, delivered 3", async () => {
    const res = await t.manager.get(`/delivery/partners/activity?agentId=${a.id}`);
    expect(res.status).toBe(200);
    const p = res.body.partners[0];
    expect(p.totals).toMatchObject({ delivered: 3, cashCollected: 47950, closingBalance: 0 });
    expect(p.totals.cashReceived).toBe(10000 + 50 + 37900);
    expect(p.days[0]).toMatchObject({ codDelivered: 3, cashCollected: 47950 });
    expect(p.currentBalance).toBe(0);
  });
});

describe("@regression COD handover validation and permissions", () => {
  let t: DeliveryTenant;
  let a: Partner;

  beforeAll(async () => {
    t = await deliveryTenant({ max: 10 });
    a = await addPartner(t, "A partner");
  });

  it.each([
    ["zero", { amount: 0 }],
    ["negative", { amount: -100 }],
    ["fractional paise", { amount: 100.5 }],
    ["missing amount", {}],
    ["bad receivedAt", { amount: 100, receivedAt: "yesterday" }],
  ])("IT-COD-030 handover with %s → 400", async (_l, body) => {
    expect((await t.manager.post("/delivery/cash/handovers", { agentId: a.id, ...body })).status).toBe(400);
  });

  it("IT-COD-031 handover for a non-partner or a partner of another business → 400", async () => {
    expect((await t.manager.post("/delivery/cash/handovers", { agentId: t.users.CASHIER.id, amount: 100 })).status).toBe(400);
    const other = await deliveryTenant();
    const foreign = await addPartner(other, "Foreign");
    expect((await t.manager.post("/delivery/cash/handovers", { agentId: foreign.id, amount: 100 })).status).toBe(400);
    expect((await t.manager.post("/delivery/cash/settle", { agentId: foreign.id })).status).toBe(400);
  });

  it("IT-COD-032 a partner cannot record, edit or settle handovers (403)", async () => {
    const me = await as(a.email, t.outlet.id);
    expect((await me.post("/delivery/cash/handovers", { agentId: a.id, amount: 100 })).status).toBe(403);
    expect((await me.post("/delivery/cash/settle", { agentId: a.id })).status).toBe(403);
    expect((await me.get("/delivery/cash/handovers")).status).toBe(403);
  });

  it("IT-COD-033 editing / deleting another business's handover → 404, untouched", async () => {
    const h = (await t.manager.post("/delivery/cash/handovers", { agentId: a.id, amount: 500 })).body.handover;
    const other = await deliveryTenant();
    expect((await other.manager.patch(`/delivery/cash/handovers/${h.id}`, { amount: 1 })).status).toBe(404);
    expect((await other.manager.delete(`/delivery/cash/handovers/${h.id}`)).status).toBe(404);
    expect((await db.deliveryCashHandover.findUniqueOrThrow({ where: { id: h.id } })).amount).toBe(500);
  });

  it("IT-COD-034 a partner's /mine/cash shows only their own handovers and balance", async () => {
    const b = await addPartner(t, "B partner");
    await t.manager.post("/delivery/cash/handovers", { agentId: b.id, amount: 777 });
    const mine = (await (await as(a.email, t.outlet.id)).get("/delivery/mine/cash")).body;
    expect(mine.handovers.every((h: { agentId: string }) => h.agentId === a.id)).toBe(true);
    expect(mine.handovers.map((h: { amount: number }) => h.amount)).not.toContain(777);
  });

  // BUG-CANDIDATE-D2: deliveryCashSettleSchema documents `deliveryIds` ("Specific deliveries;
  // omit to settle everything the partner holds") but POST /delivery/cash/settle ignores it and
  // records a handover for the partner's ENTIRE balance. Expected: settling one ₹100 delivery
  // records ₹100 and leaves ₹100 to receive. Actual: ₹200 recorded, balance 0.
  it.fails("IT-COD-035 @critical (BUG-CANDIDATE-D2) settle with deliveryIds settles only those deliveries", async () => {
    const c = await addPartner(t, "C partner");
    const meC = await as(c.email, t.outlet.id);
    const d1 = await codFor(t, c, 10000);
    const d2 = await codFor(t, c, 10000);
    for (const d of [d1, d2]) {
      await meC.patch(`/delivery/${d.delivery.id}/status`, { status: "ACCEPTED" });
      await meC.post(`/delivery/${d.delivery.id}/complete`, {});
    }
    const res = await t.manager.post("/delivery/cash/settle", { agentId: c.id, deliveryIds: [d1.delivery.id] });
    expect(res.status).toBe(200);
    expect(res.body.amount).toBe(10000);
    expect((await meC.get("/delivery/mine/cash")).body.balance).toBe(10000);
  });
});

// =====================================================================
// Per-day boundaries in IST (activity), back-dated handover
// =====================================================================
describe("@regression COD per-day partner activity uses IST day boundaries", () => {
  it("IT-COD-040 23:50 IST and 00:10 IST collections fall on different days; running balance carries over", async () => {
    const t = await deliveryTenant({ max: 10 });
    const b = await addPartner(t, "B partner");
    const o1 = await codFor(t, b, 10000);
    const o2 = await codFor(t, b, 5000);
    // 2026-10-20 23:50 IST and 2026-10-21 00:10 IST
    await db.payment.create({ data: { orderId: o1.order.id, mode: "CASH", amount: 10000, status: "SUCCESS", confirmedAt: new Date("2026-10-20T18:20:00Z"), collectedById: b.id } });
    await db.payment.create({ data: { orderId: o2.order.id, mode: "CASH", amount: 5000, status: "SUCCESS", confirmedAt: new Date("2026-10-20T18:40:00Z"), collectedById: b.id } });
    const h = await t.manager.post("/delivery/cash/handovers", { agentId: b.id, amount: 8000, receivedAt: "2026-10-21T10:00:00+05:30" });
    expect(h.status).toBe(201);
    const res = await t.manager.get(`/delivery/partners/activity?from=2026-10-20&to=2026-10-21&agentId=${b.id}`);
    expect(res.status).toBe(200);
    const [d20, d21] = res.body.partners[0].days;
    expect(d20).toMatchObject({ date: "2026-10-20", openingBalance: 0, cashCollected: 10000, cashReceived: 0, closingBalance: 10000 });
    expect(d21).toMatchObject({ date: "2026-10-21", openingBalance: 10000, cashCollected: 5000, cashReceived: 8000, closingBalance: 7000 });
    const tl = (await t.manager.get(`/delivery/partners/${b.id}/timeline?date=2026-10-21`)).body;
    expect(tl).toMatchObject({ date: "2026-10-21", openingBalance: 10000, closingBalance: 7000 });
    const hist = (await t.manager.get(`/delivery/cash/handovers?from=2026-10-21&agentId=${b.id}`)).body;
    expect(hist.map((x: { amount: number }) => x.amount)).toEqual([8000]);
    expect((await t.manager.get(`/delivery/cash/handovers?from=2026-10-20&to=2026-10-20&agentId=${b.id}`)).body).toEqual([]);
  });

  it("IT-COD-041 activity range with to < from → 400", async () => {
    const t = await deliveryTenant();
    expect((await t.manager.get("/delivery/partners/activity?from=2026-10-21&to=2026-10-20")).status).toBe(400);
  });

  it("IT-COD-042 cash collected at another outlet does not count in this outlet's ledger", async () => {
    const t = await deliveryTenant({ max: 10 });
    const b = await addPartner(t, "B partner");
    const o2 = await db.outlet.create({ data: { businessId: t.business.id, name: "Second", stateCode: "33", deliveryEnabled: true, gstEnabled: false } });
    const ord = await db.order.create({
      data: { outletId: o2.id, invoiceNumber: `X-${Date.now()}`, orderType: "DELIVERY", subtotal: 3000, taxableValue: 3000, grandTotal: 3000, status: "PAID" } as never,
    }).catch(() => null);
    if (ord) await db.payment.create({ data: { orderId: ord.id, mode: "CASH", amount: 3000, status: "SUCCESS", confirmedAt: new Date(), collectedById: b.id } });
    const row = (await t.manager.get("/delivery/cash")).body.find((r: { agent: { id: string } }) => r.agent.id === b.id);
    expect(row.balance).toBe(0);
  });
});
