/**
 * Phase 1.3 — transactional outbox.
 *  - nothing is emitted for a rolled-back transaction;
 *  - a crash right after commit does not lose the KOT event: it is delivered when
 *    the publisher (re)starts;
 *  - failed deliveries are retried with backoff and kept, not lost.
 */
import { io as connect, type Socket } from "socket.io-client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drainOutbox, outboxEmitOutlet, outboxTask, startOutboxPublisher, stopOutboxPublisher } from "../../src/lib/outbox";
import { billingTestHooks } from "../../src/services/billing";
import { socketEmitter } from "../../src/realtime";
import { createHotel, db, login, startServer, type Hotel } from "./helpers";

let srv: Awaited<ReturnType<typeof startServer>>;
let h: Hotel;
let kitchen: Socket;
const received: { event: string; payload: unknown }[] = [];

beforeAll(async () => {
  srv = await startServer();
  h = await createHotel("Outbox");
  const k = await login(srv.base, h.users.kitchen.email, h.outletId);
  kitchen = connect(srv.base, { auth: { token: k.token, outletId: h.outletId }, transports: ["websocket"] });
  await new Promise<void>((resolve, reject) => {
    kitchen.once("connect", () => resolve());
    kitchen.once("connect_error", reject);
  });
  kitchen.onAny((event, payload) => received.push({ event, payload }));
});
afterAll(async () => {
  kitchen?.disconnect();
  await srv.close();
});

const waitFor = async (cond: () => boolean, ms = 5000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
};

describe("transactional outbox", () => {
  it("a rolled-back transaction writes no event and emits nothing", async () => {
    const before = await db.outboxEvent.count();
    await expect(
      db.$transaction(async (tx) => {
        await outboxEmitOutlet(tx, h.outletId, "test:rolled-back", { x: 1 });
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await db.outboxEvent.count()).toBe(before);
    await drainOutbox();
    expect(received.some((r) => r.event === "test:rolled-back")).toBe(false);
  });

  it("a failed bill (rolled back) produces no kot:new event", async () => {
    const cashier = await login(srv.base, h.users.cashier.email, h.outletId);
    billingTestHooks.beforeCommit = () => {
      throw new Error("injected");
    };
    const before = await db.outboxEvent.count({ where: { name: "kot:new" } });
    const res = await cashier.call("POST", "/orders", { orderType: "TAKEAWAY", items: [{ menuItemId: h.items.chai, quantity: 1 }] });
    billingTestHooks.beforeCommit = undefined;
    expect(res.status).toBe(500);
    expect(await db.outboxEvent.count({ where: { name: "kot:new" } })).toBe(before);
  });

  it("crash after commit: the KOT event survives and is delivered when the publisher restarts", async () => {
    stopOutboxPublisher(); // simulate the process dying right after the bill committed
    const cashier = await login(srv.base, h.users.cashier.email, h.outletId);
    const res = await cashier.call("POST", "/orders", { orderType: "TAKEAWAY", items: [{ menuItemId: h.items.samosa, quantity: 1 }] });
    expect(res.status).toBe(201);
    await new Promise((r) => setTimeout(r, 300));
    const pending = await db.outboxEvent.findFirst({ where: { name: "kot:new", deliveredAt: null }, orderBy: { seq: "desc" } });
    expect(pending, "kot:new waiting in the outbox").toBeTruthy();
    expect(received.some((r) => r.event === "kot:new" && JSON.stringify(r.payload).includes(res.body.id))).toBe(false);

    startOutboxPublisher(socketEmitter()); // "restart"
    await waitFor(() => received.some((r) => r.event === "kot:new" && JSON.stringify(r.payload).includes(res.body.id)));
    expect((await db.outboxEvent.findUnique({ where: { seq: pending!.seq } }))?.deliveredAt).toBeTruthy();
  });

  it("normal flow: the kitchen gets kot:new right after the bill (via the outbox)", async () => {
    const cashier = await login(srv.base, h.users.cashier.email, h.outletId);
    const t0 = Date.now();
    const res = await cashier.call("POST", "/orders", { orderType: "TAKEAWAY", items: [{ menuItemId: h.items.biryani, quantity: 1 }] });
    await waitFor(() => received.some((r) => r.event === "kot:new" && JSON.stringify(r.payload).includes(res.body.id)));
    expect(Date.now() - t0).toBeLessThan(1500);
  });

  it("a failing task is retried later and its error kept (not lost, not hot-looping)", async () => {
    await outboxTask(db, "no.such.task", { a: 1 });
    // The running publisher and an explicit drain may race for the row: wait for the first attempt.
    let row = null as Awaited<ReturnType<typeof db.outboxEvent.findFirst>>;
    for (let i = 0; i < 50; i++) {
      await drainOutbox();
      row = await db.outboxEvent.findFirst({ where: { name: "no.such.task" }, orderBy: { seq: "desc" } });
      if (row && row.attempts >= 1 && row.lastError) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(row?.deliveredAt).toBeNull();
    expect(row?.attempts).toBe(1);
    expect(row?.lastError).toMatch(/no outbox task/);
    expect(row!.availableAt.getTime()).toBeGreaterThan(Date.now());
    await db.outboxEvent.delete({ where: { seq: row!.seq } });
  });
});
