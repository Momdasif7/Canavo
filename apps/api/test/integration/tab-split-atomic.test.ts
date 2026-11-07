/**
 * Phase 1.6 — splitting a running tab into several bills must be all-or-nothing.
 * Known gap: each split bill used its own transaction, so a failure on the 2nd bill
 * left the 1st created and its items billed.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { billingTestHooks } from "../../src/services/billing";
import { createHotel, db, login, startServer, type Hotel } from "./helpers";

let srv: Awaited<ReturnType<typeof startServer>>;
let h: Hotel;
beforeAll(async () => {
  srv = await startServer();
  h = await createHotel("Split");
});
afterEach(() => {
  billingTestHooks.beforeCommit = undefined;
});
afterAll(() => srv.close());

async function openTabWithItems() {
  const table = await db.diningTable.create({ data: { outletId: h.outletId, label: `T${Date.now() % 10000}` } });
  const cashier = await login(srv.base, h.users.cashier.email, h.outletId);
  const opened = await cashier.call("POST", `/tables/${table.id}/open`, { guests: 2 });
  expect(opened.status, JSON.stringify(opened.body)).toBe(201);
  const sessionId = opened.body.id ?? opened.body.session?.id;
  const added = await cashier.call("POST", `/tables/sessions/${sessionId}/items`, {
    items: [
      { menuItemId: h.items.chai, quantity: 2, addonIds: [] },
      { menuItemId: h.items.samosa, quantity: 1, addonIds: [] },
    ],
  });
  expect(added.status, JSON.stringify(added.body)).toBeLessThan(300);
  const items = await db.tableSessionItem.findMany({ where: { sessionId }, orderBy: { createdAt: "asc" } });
  return { cashier, sessionId, items };
}

describe("atomic tab split", () => {
  it("a failure on the 2nd split bill rolls back the 1st (no partial bills, items stay unbilled)", async () => {
    const { cashier, sessionId, items } = await openTabWithItems();
    let calls = 0;
    billingTestHooks.beforeCommit = () => {
      if (++calls === 2) throw new Error("injected failure on the second bill");
    };
    const res = await cashier.call("POST", `/tables/sessions/${sessionId}/bill`, { mode: "BY_ITEMS", groups: [[items[0].id], [items[1].id]] });
    expect(res.status).toBe(500);
    expect(await db.order.count({ where: { tableSessionId: sessionId } })).toBe(0);
    expect(await db.tableSessionItem.count({ where: { sessionId, billedOrderId: { not: null } } })).toBe(0);
  });

  it("the same split succeeds as one unit when nothing fails", async () => {
    const { cashier, sessionId, items } = await openTabWithItems();
    const res = await cashier.call("POST", `/tables/sessions/${sessionId}/bill`, { mode: "BY_ITEMS", groups: [[items[0].id], [items[1].id]] });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.orders).toHaveLength(2);
    expect(await db.order.count({ where: { tableSessionId: sessionId } })).toBe(2);
    expect(await db.tableSessionItem.count({ where: { sessionId, billedOrderId: null } })).toBe(0);
    const nums = res.body.orders.map((o: { order: { invoiceNumber: string } }) => o.order.invoiceNumber);
    expect(new Set(nums).size).toBe(2);
  });
});
