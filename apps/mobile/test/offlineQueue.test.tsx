/**
 * Offline bill queue: enqueue while offline, persisted across an app kill, resumed and retried,
 * idempotent on clientOrderId (no duplicate bills), backoff while the server keeps failing.
 * Real SQL (node:sqlite behind the expo-sqlite mock) + the real API client against a fake server.
 */
import { tokens } from "./helpers";

type Db = typeof import("../src/lib/db");
type Sync = typeof import("../src/offline/sync");
type Api = typeof import("../src/lib/api");

/** Fresh JS modules over the same SQLite file and keychain = an app restart. */
function boot() {
  jest.resetModules();
  const db = require("../src/lib/db") as Db;
  const sync = require("../src/offline/sync") as Sync;
  const api = require("../src/lib/api") as Api;
  return { db, sync, api };
}

import { bill, fakeServer } from "./fakeServer";

describe("offline queue (db + sync pass)", () => {
  it("enqueues once per clientOrderId and survives an app kill / restart", async () => {
    let { db } = boot();
    await db.enqueueOrder(bill("c-1"));
    await db.enqueueOrder(bill("c-1")); // double tap / re-save: INSERT OR IGNORE
    await db.enqueueOrder(bill("c-2"));
    expect(await db.countUnsynced()).toBe(2);

    ({ db } = boot()); // killed and relaunched
    const q = await db.listQueue(["pending"]);
    expect(q.map((o) => o.clientOrderId).sort()).toEqual(["c-1", "c-2"]);
    expect(q[0].payload).toMatchObject({ orderType: "TAKEAWAY" });
    expect(q[0].grandTotal).toBe(10500);
  });

  it("offline → pass aborts without spending attempts; online → bills created and paid", async () => {
    const { db, sync, api } = boot();
    await api.api.setTokens(tokens);
    const server = fakeServer();
    server.set("down");
    await expect(sync.runSyncPass()).rejects.toMatchObject({ status: 0 });
    let q = await db.listQueue(["pending"]);
    expect(q).toHaveLength(2);
    expect(q.every((o) => o.attempts === 0)).toBe(true);

    server.set("up");
    await sync.runSyncPass();
    expect(await db.countUnsynced()).toBe(0);
    q = await db.listQueue(["done"]);
    expect(q).toHaveLength(2);
    expect(q.every((o) => o.orderId && o.invoiceNumber)).toBe(true);
    expect([...server.orders.values()].every((o) => o.paid)).toBe(true);
    // outlet of the queued bill is sent explicitly
    expect(server.calls.find((c) => c.path === "/orders/sync")!.headers["X-Outlet-Id"]).toBe("o1");
  });

  it("response lost after the server committed → retry returns the same order (no duplicate bill)", async () => {
    const { db, sync, api } = boot();
    await api.api.setTokens(tokens);
    const server = fakeServer();
    await db.enqueueOrder(bill("c-dup"));
    server.set("dropResponse");
    await expect(sync.runSyncPass()).rejects.toMatchObject({ status: 0 });
    expect(server.orders.size).toBe(1);
    await sync.runSyncPass();
    expect(server.orders.size).toBe(1);
    const [done] = await db.listQueue(["done"]).then((r) => r.filter((o) => o.clientOrderId === "c-dup"));
    expect(done.orderId).toBe(server.orders.get("c-dup")!.id);
    // payment that went through but whose answer was lost → 409 on retry → done, not failed
    await db.enqueueOrder(bill("c-paid"));
    await sync.runSyncPass();
    const o = server.orders.get("c-paid")!;
    expect(o.paid).toBe(true);
  });

  it("payment answered 409 'already paid' counts as done", async () => {
    const { db, sync, api } = boot();
    await api.api.setTokens(tokens);
    const server = fakeServer();
    await db.enqueueOrder(bill("c-409"));
    await sync.runSyncPass();
    // simulate: row back to unpaid (answer lost), server already paid
    await db.markCreated("c-409", server.orders.get("c-409")!.id, "INV", 10500);
    await sync.runSyncPass();
    expect((await db.listQueue(["done"])).some((o) => o.clientOrderId === "c-409")).toBe(true);
    expect((await db.listQueue(["failed"])).some((o) => o.clientOrderId === "c-409")).toBe(false);
  });

  it("a rejected bill is retried, set aside after MAX_ATTEMPTS, and can be re-queued", async () => {
    const { db, sync, api } = boot();
    await api.api.setTokens(tokens);
    const server = fakeServer();
    await db.enqueueOrder(bill("c-bad"));
    server.rejectId("c-bad");
    for (let i = 1; i < sync.MAX_ATTEMPTS; i++) {
      await sync.runSyncPass();
      const [p] = (await db.listQueue(["pending"])).filter((o) => o.clientOrderId === "c-bad");
      expect(p.attempts).toBe(i);
      expect(p.lastError).toBe("Item not found");
    }
    await sync.runSyncPass();
    expect((await db.listQueue(["failed"])).map((o) => o.clientOrderId)).toContain("c-bad");
    expect(await db.countUnsynced()).toBe(0);

    server.rejectId(null);
    await db.requeueFailed();
    const [again] = (await db.listQueue(["pending"])).filter((o) => o.clientOrderId === "c-bad");
    expect(again.attempts).toBe(0);
    await sync.runSyncPass();
    expect((await db.listQueue(["done"])).map((o) => o.clientOrderId)).toContain("c-bad");
  });

  it("backoff: 30 s doubling to a 5 min cap", () => {
    const { sync } = boot();
    expect([0, 1, 2, 3, 4, 5, 50].map(sync.nextSyncDelay)).toEqual([30_000, 60_000, 120_000, 240_000, 300_000, 300_000, 300_000]);
  });
});
