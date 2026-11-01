/** Phase 4.3 — owner summary endpoint and the anomaly alerts job (flag ANOMALY_ALERTS). */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { alertAnomalies } from "../../src/jobs-notifications";
import { createHotel, db, login, startServer, type Client, type Hotel } from "./helpers";

let srv: Awaited<ReturnType<typeof startServer>>;
let h: Hotel;
let manager: Client, owner: Client, cashier: Client;
let owner2Id: string;

beforeAll(async () => {
  srv = await startServer();
  h = await createHotel("Anomaly");
  const o2 = await db.user.create({
    data: { businessId: h.businessId, role: "BUSINESS_OWNER", name: "Second owner", email: `owner2.${Date.now()}@it.local`, phone: `8${String(Math.floor(Math.random() * 1e9)).padStart(9, "0")}`, passwordHash: "x" },
  });
  owner2Id = o2.id;
  manager = await login(srv.base, h.users.manager.email, h.outletId);
  cashier = await login(srv.base, h.users.cashier.email, h.outletId);
  owner = await login(srv.base, h.users.owner.email);
});
afterAll(() => srv.close());

const anomalyCount = (userId: string) => db.notification.count({ where: { userId, kind: "report.anomaly" } });

async function voidBill() {
  const o = await manager.call("POST", "/orders", { orderType: "TAKEAWAY", items: [{ menuItemId: h.items.chai, quantity: 1 }] });
  expect((await manager.call("POST", `/orders/${o.body.id}/cancel`, { reason: "Customer left" })).status).toBe(200);
}

describe("owner summary + anomaly alerts", () => {
  it("summarises today per outlet across the owner's outlets", async () => {
    const o = await manager.call("POST", "/orders", { orderType: "TAKEAWAY", items: [{ menuItemId: h.items.samosa, quantity: 2 }] });
    await manager.call("POST", `/orders/${o.body.id}/payments`, { payments: [{ mode: "UPI", amount: o.body.grandTotal }] });
    await voidBill();
    const r = await owner.call("GET", "/reports/owner-summary");
    expect(r.status).toBe(200);
    expect(r.body.outlets).toHaveLength(2);
    const main = r.body.outlets.find((x: { outletId: string }) => x.outletId === h.outletId);
    expect(main.bills).toBe(1);
    expect(main.grossSales).toBe(o.body.grandTotal);
    expect(main.voids).toEqual({ count: 1, amount: 1500 });
    expect(main.cash.status).toBe("NONE");
    expect(main.topItems[0].name).toBe("Samosa");
    expect(r.body.totals.voids.count).toBe(1);
    // Cashiers can't see reports.
    expect((await cashier.call("GET", "/reports/owner-summary")).status).toBe(403);
  });

  it("sends nothing while the flag is off", async () => {
    await voidBill();
    await voidBill(); // 3 voids today
    await alertAnomalies();
    expect(await anomalyCount(h.users.owner.id)).toBe(0);
  });

  it("with the flag on, pushes one alert per owner per anomaly, and never repeats it the same day", async () => {
    await db.business.update({ where: { id: h.businessId }, data: { features: { ANOMALY_ALERTS: true } } });
    await alertAnomalies();
    expect(await anomalyCount(h.users.owner.id)).toBe(1);
    expect(await anomalyCount(owner2Id)).toBe(1);
    expect(await anomalyCount(h.users.manager.id)).toBe(0); // owners only
    const n = await db.notification.findFirst({ where: { userId: h.users.owner.id, kind: "report.anomaly" } });
    expect(n?.title).toContain("Unusual voids");
    // Second run (and another void): already reported today.
    await voidBill();
    await alertAnomalies();
    expect(await anomalyCount(h.users.owner.id)).toBe(1);
    expect(await anomalyCount(owner2Id)).toBe(1);
    await db.business.update({ where: { id: h.businessId }, data: { features: {} } });
  });
});
