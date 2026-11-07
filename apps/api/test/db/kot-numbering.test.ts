/**
 * QA Phase 7 (database) — dba-2: KOT numbers are "count of today's KOTs + 1", read without a lock.
 * Bills (and table rounds) fired at the same moment at one outlet read the same count and print the
 * same KOT number for different orders; a deleted KOT (rejected QR / cancelled pre-order) also lowers
 * the count so the next KOT re-uses a number. The kitchen calls orders by that number.
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import { createHotel, db, login, startServer, type Client, type Hotel } from "../integration/helpers";

let srv: Awaited<ReturnType<typeof startServer>>;
let h: Hotel, cashier: Client, manager: Client;

beforeAll(async () => {
  srv = await startServer();
  h = await createHotel("DB KOT numbers");
  cashier = await login(srv.base, h.users.cashier.email, h.outletId);
  manager = await login(srv.base, h.users.manager.email, h.outletId);
});
afterAll(() => srv.close());

const dupes = async (where: object = {}) => {
  const kots = await db.kotTicket.findMany({ where: { outletId: h.outletId, ...where }, select: { kotNumber: true } });
  const seen = new Map<number, number>();
  for (const k of kots) seen.set(k.kotNumber, (seen.get(k.kotNumber) ?? 0) + 1);
  return { total: kots.length, dupes: [...seen].filter(([, n]) => n > 1).map(([no]) => no) };
};

it("12 bills fired at the same moment get 12 different KOT numbers", async () => {
  const rs = await Promise.all(
    Array.from({ length: 12 }, (_, i) => (i % 2 ? cashier : manager).call("POST", "/orders", { orderType: "TAKEAWAY", items: [{ menuItemId: h.items.chai, quantity: 1 }] })),
  );
  expect(rs.map((r) => r.status)).toEqual(Array(12).fill(201));
  const d = await dupes();
  expect(d.total).toBe(12);
  expect(d.dupes).toEqual([]);
});

it("a deleted KOT doesn't make the next one re-use a number", async () => {
  const before = await db.kotTicket.findMany({ where: { outletId: h.outletId }, orderBy: { kotNumber: "asc" } });
  await db.kotTicket.delete({ where: { id: before[0]!.id } }); // what a rejected QR request / cancelled pre-order does
  const r = await cashier.call("POST", "/orders", { orderType: "TAKEAWAY", items: [{ menuItemId: h.items.samosa, quantity: 1 }] });
  expect(r.status).toBe(201);
  expect((await dupes()).dupes).toEqual([]);
});

it("rounds fired at the same moment on 6 different tables get different KOT numbers", async () => {
  const sessions: string[] = [];
  for (let i = 0; i < 6; i++) {
    const t = await manager.call("POST", "/tables", { label: `K${i}-${Date.now().toString(36)}`, capacity: 2 });
    const s = await manager.call("POST", `/tables/${t.body.id}/open`, { guests: 1 });
    expect(s.status, JSON.stringify(s.body)).toBe(201);
    sessions.push(s.body.id);
  }
  const rs = await Promise.all(sessions.map((id, i) => (i % 2 ? cashier : manager).call("POST", `/tables/sessions/${id}/items`, { items: [{ menuItemId: h.items.chai, quantity: 1 }] })));
  expect(rs.map((r) => r.status)).toEqual(Array(6).fill(201));
  expect((await dupes({ sessionId: { in: sessions } })).dupes).toEqual([]);
});
