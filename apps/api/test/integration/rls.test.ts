/**
 * Phase 1.1 — PostgreSQL Row-Level Security backstop. These tests connect as the
 * non-superuser app role (see vitest.integration.config.ts), like production.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { platformPrisma, prisma, rawPrisma } from "../../src/db";
import { runWithTenant } from "../../src/lib/tenant";
import { createHotel, login, startServer, type Hotel } from "./helpers";

let srv: Awaited<ReturnType<typeof startServer>>;
let a: Hotel, b: Hotel;
let orderA: { id: string }, orderB: { id: string };

beforeAll(async () => {
  srv = await startServer();
  [a, b] = [await createHotel("RlsA"), await createHotel("RlsB")];
  const ca = await login(srv.base, a.users.cashier.email, a.outletId);
  const cb = await login(srv.base, b.users.cashier.email, b.outletId);
  orderA = (await ca.call("POST", "/orders", { orderType: "TAKEAWAY", items: [{ menuItemId: a.items.chai, quantity: 1 }] })).body;
  orderB = (await cb.call("POST", "/orders", { orderType: "TAKEAWAY", items: [{ menuItemId: b.items.chai, quantity: 1 }] })).body;
  await cb.call("POST", `/orders/${orderB.id}/payments`, { payments: [{ mode: "CASH", amount: 1500 }] });
});
afterAll(() => srv.close());

const asBusiness = <T>(businessId: string, fn: () => Promise<T>) => runWithTenant({ businessId }, fn);

describe("row-level security", () => {
  it("a raw connection with no tenant setting reads nothing (fail closed)", async () => {
    expect(await platformPrisma.order.count()).toBeGreaterThanOrEqual(2);
    const rows = await rawPrisma.$queryRaw<{ n: bigint }[]>`SELECT count(*)::bigint AS n FROM "Order"`;
    expect(Number(rows[0]!.n)).toBe(0);
  });

  it("raw SQL with app.business_id = A sees only A — even selecting B's order by id", async () => {
    const seen = await rawPrisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.business_id', ${a.businessId}, true)`;
      const mine = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "Order" WHERE id = ${orderA.id}`;
      const theirs = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "Order" WHERE id = ${orderB.id}`;
      const pay = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "Payment" WHERE "orderId" = ${orderB.id}`;
      return { mine: mine.length, theirs: theirs.length, pay: pay.length };
    });
    expect(seen).toEqual({ mine: 1, theirs: 0, pay: 0 });
  });

  it("writes into another hotel are rejected by the database (WITH CHECK)", async () => {
    await expect(
      rawPrisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.business_id', ${a.businessId}, true)`;
        // Another hotel's rows are invisible to UPDATE (0 rows), and new rows for it are refused.
        const updated = await tx.$executeRaw`UPDATE "Order" SET notes = 'hijack' WHERE id = ${orderB.id}`;
        expect(updated).toBe(0);
        await tx.$executeRaw`INSERT INTO "DiningArea" ("id", "outletId", "name") VALUES (${`rls-${Date.now()}`}, ${b.outletId}, 'Hijack')`;
      }),
    ).rejects.toThrow(/row-level security|violates/i);
    expect((await platformPrisma.order.findUnique({ where: { id: orderB.id } }))?.notes).not.toBe("hijack");
  });

  it("the tenant client cannot read another hotel's order even without an outletId filter (IDOR backstop)", async () => {
    // Order is not covered by the app's businessId filter: before RLS this returned hotel B's bill.
    const leaked = await asBusiness(a.businessId, () => prisma.order.findUnique({ where: { id: orderB.id } }));
    expect(leaked).toBeNull();
    const own = await asBusiness(a.businessId, () => prisma.order.findUnique({ where: { id: orderA.id } }));
    expect(own?.id).toBe(orderA.id);
    const payments = await asBusiness(a.businessId, () => prisma.payment.findMany({ where: { orderId: orderB.id } }));
    expect(payments).toHaveLength(0);
    const items = await asBusiness(a.businessId, () => prisma.orderItem.count({ where: { orderId: orderB.id } }));
    expect(items).toBe(0);
  });

  it("raw queries through the tenant client carry the tenant too", async () => {
    const n = await asBusiness(a.businessId, () => prisma.$queryRaw<{ n: bigint }[]>`SELECT count(*)::bigint AS n FROM "Order" WHERE id IN (${orderA.id}, ${orderB.id})`);
    expect(Number(n[0]!.n)).toBe(1);
  });

  it("interactive transactions on the tenant client are confined too", async () => {
    const seen = await asBusiness(a.businessId, () =>
      prisma.$transaction(async (tx) => ({ a: await tx.order.count({ where: { id: orderA.id } }), b: await tx.order.count({ where: { id: orderB.id } }) })),
    );
    expect(seen).toEqual({ a: 1, b: 0 });
  });

  it("a platform-admin request context sees no hotel data (fail closed), only platform rows", async () => {
    const r = await runWithTenant({ platform: true }, async () => ({
      orders: await prisma.order.count(),
      outlets: await prisma.outlet.count(),
      hotelUsers: await prisma.user.count({ where: { businessId: { not: null } } }),
    }));
    expect(r).toEqual({ orders: 0, outlets: 0, hotelUsers: 0 });
  });

  it("the platform client (explicit cross-hotel work) still sees everything", async () => {
    expect(await platformPrisma.order.count({ where: { id: { in: [orderA.id, orderB.id] } } })).toBe(2);
  });

  it("every table has forced RLS except the reviewed platform/infrastructure tables (a new table without a policy fails here)", async () => {
    const rows = await rawPrisma.$queryRaw<{ relname: string }[]>`
      SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname <> '_prisma_migrations'
        AND NOT (c.relrowsecurity AND c.relforcerowsecurity)
      ORDER BY 1`;
    // Business: the tenant root (looked up by id). OutboxEvent: read only by the publisher (platform client).
    // IdempotencyKey: per user. OtpCode, Setting: no hotel data.
    expect(rows.map((r) => r.relname)).toEqual(["Business", "IdempotencyKey", "OtpCode", "OutboxEvent", "Setting"]);
  });
});
