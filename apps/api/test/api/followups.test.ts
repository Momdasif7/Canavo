/**
 * QA Phase 6 follow-ups (decisions taken with the product owner, 2026-11-06):
 *  - BUG-049 khata limit holds when two bills for one customer go on credit at the same moment;
 *  - BUG-050 voiding a cash-paid bill takes its cash out of the shift's expected cash;
 *  - BUG-051 uploading a settlement file (marks payments settled) needs settlement:manage, not report:view.
 * BUG-048 (hub URL SSRF) is covered in channels.test.ts and lib/safe-url.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, makeWorld, type World } from "./service-fixtures";
import { startServer } from "../integration/helpers";

let srv: Awaited<ReturnType<typeof startServer>>;
let w: World;

beforeAll(async () => {
  srv = await startServer();
  w = await makeWorld(srv.base, "Followups");
});
afterAll(() => srv.close());

const phone = () => `9${String(Math.floor(Math.random() * 1e9)).padStart(9, "0")}`;
const bill = async (extra: Record<string, unknown> = {}) => {
  const r = await w.as.cashier.call("POST", "/orders", { orderType: "TAKEAWAY", items: [{ menuItemId: w.h.items.biryani, quantity: 1 }], ...extra });
  expect(r.status).toBe(201);
  return r.body as { id: string; grandTotal: number };
};

describe("BUG-049 khata limit under concurrency", () => {
  it("two bills for the same customer put on credit at once never go past the limit", async () => {
    const p = phone();
    const a = await bill({ customerPhone: p, customerName: "Credit Kumar" });
    const b = await bill({ customerPhone: p, customerName: "Credit Kumar" });
    // Create the customer with a limit that fits one bill but not both.
    await w.as.cashier.call("POST", "/orders/" + a.id + "/payments", { payments: [{ mode: "KHATA", amount: 1 }] });
    const customer = await db.customer.findFirstOrThrow({ where: { phone: p } });
    await db.customer.update({ where: { id: customer.id }, data: { khataLimit: 1 + a.grandTotal } });
    const rs = await Promise.all([
      w.as.cashier.call("POST", `/orders/${a.id}/payments`, { payments: [{ mode: "KHATA", amount: a.grandTotal - 1 }] }),
      w.as.manager.call("POST", `/orders/${b.id}/payments`, { payments: [{ mode: "KHATA", amount: b.grandTotal }] }),
    ]);
    expect(rs.map((r) => r.status).sort()).toEqual([200, 400]);
    const after = await db.customer.findUniqueOrThrow({ where: { id: customer.id } });
    expect(after.khataBalance).toBeLessThanOrEqual(after.khataLimit);
  });
});

describe("BUG-050 voided cash bill and the cash drawer", () => {
  it("expected cash drops by the cash handed back when a cash-paid bill is voided", async () => {
    const { cashier, manager } = w.as;
    if ((await cashier.call("GET", "/cash-shifts/current")).body === null) expect((await cashier.call("POST", "/cash-shifts/open", { openingFloat: 50000 })).status).toBe(201);
    const o = await bill();
    expect((await cashier.call("POST", `/orders/${o.id}/payments`, { payments: [{ mode: "CASH", amount: o.grandTotal }] })).status).toBe(200);
    const paid = (await cashier.call("GET", "/cash-shifts/current")).body.summary;
    expect((await manager.call("POST", `/orders/${o.id}/cancel`, { reason: "Customer walked out" })).status).toBe(200);
    const voided = (await cashier.call("GET", "/cash-shifts/current")).body.summary;
    expect(voided.voidCashReturned).toBe(paid.voidCashReturned + o.grandTotal);
    expect(voided.expectedCash).toBe(paid.expectedCash - o.grandTotal);
  });

  it("voiding a UPI-paid bill doesn't touch the drawer", async () => {
    const { cashier, manager } = w.as;
    const o = await bill();
    expect((await cashier.call("POST", `/orders/${o.id}/payments`, { payments: [{ mode: "CARD", amount: o.grandTotal }] })).status).toBe(200);
    const before = (await cashier.call("GET", "/cash-shifts/current")).body.summary.expectedCash;
    expect((await manager.call("POST", `/orders/${o.id}/cancel`, { reason: "Wrong order" })).status).toBe(200);
    expect((await cashier.call("GET", "/cash-shifts/current")).body.summary.expectedCash).toBe(before);
  });
});

describe("BUG-051 settlement upload needs its own permission", () => {
  const upload = { mode: "CARD", rows: [{ date: new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date()), amount: 12345, reference: "QA-REF" }] };

  it("owner, manager and accountant may upload; everyone may still read only with report:view", async () => {
    for (const k of ["owner", "manager", "accountant"] as const) expect((await w.as[k].call("POST", "/settlements", upload)).status, k).toBe(200);
    for (const k of ["owner", "manager", "accountant"] as const) expect((await w.as[k].call("GET", "/settlements")).status, k).toBe(200);
  });

  it("an accountant-based custom role without settlement:manage can read but not upload", async () => {
    const role = await w.as.owner.call("POST", "/staff/roles", { name: `Books read-only ${Date.now()}`, baseRole: "ACCOUNTANT", permissions: ["report:view", "bills:view", "order:view"] });
    expect(role.status).toBe(201);
    const acc = await db.user.findFirstOrThrow({ where: { businessId: w.h.businessId, role: "ACCOUNTANT" } });
    await db.user.update({ where: { id: acc.id }, data: { customRoleId: role.body.id, tokenVersion: { increment: 1 } } });
    const { login } = await import("../integration/helpers");
    const c = await login(srv.base, acc.email!, w.h.outletId);
    expect((await c.call("GET", "/settlements")).status).toBe(200);
    expect((await c.call("POST", "/settlements", upload)).status).toBe(403);
  });
});
