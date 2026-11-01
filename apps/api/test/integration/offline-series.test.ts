/** Phase 3.4 — offline device invoice series: offline bills keep their printed number. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHotel, db, login, startServer, type Client, type Hotel } from "./helpers";

let srv: Awaited<ReturnType<typeof startServer>>;
let h: Hotel;
let cashier: Client;

beforeAll(async () => {
  srv = await startServer();
  h = await createHotel("Offline");
  cashier = await login(srv.base, h.users.cashier.email, h.outletId);
});
afterAll(() => srv.close());

const fy = () => {
  const d = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata", year: "numeric", month: "numeric" }).formatToParts(new Date());
  const y = Number(d.find((p) => p.type === "year")!.value);
  return Number(d.find((p) => p.type === "month")!.value) >= 4 ? y : y - 1;
};
const offlineBill = (number?: string) =>
  cashier.call("POST", "/orders", {
    orderType: "TAKEAWAY",
    items: [{ menuItemId: h.items.chai, quantity: 1 }],
    clientOrderId: crypto.randomUUID(),
    createdAt: new Date(Date.now() - 60_000).toISOString(),
    ...(number && { offlineInvoiceNumber: number }),
  });

describe("offline invoice series", () => {
  it("is off by default: offline bills get the next normal number", async () => {
    expect((await cashier.call("POST", "/orders/offline-series", { deviceId: "device-one-1234" })).body).toEqual({ enabled: false });
    const r = await offlineBill("INVA1-2026-00001");
    expect(r.body.invoiceNumber).toMatch(/^INV-\d{4}-\d{5}$/);
  });

  it("gives each device its own series and keeps the device's number at sync", async () => {
    await db.business.update({ where: { id: h.businessId }, data: { features: { OFFLINE_INVOICE_SERIES: true } } });
    const a = (await cashier.call("POST", "/orders/offline-series", { deviceId: "device-one-1234" })).body;
    const b = (await cashier.call("POST", "/orders/offline-series", { deviceId: "device-two-5678" })).body;
    expect(a).toMatchObject({ enabled: true, code: "A1", prefix: "INVA1" });
    expect(b.code).toBe("A2");
    expect((await cashier.call("POST", "/orders/offline-series", { deviceId: "device-one-1234" })).body.code).toBe("A1");
    const n = `INVA1-${fy()}-00001`;
    const r = await offlineBill(n);
    expect(r.body.invoiceNumber).toBe(n);
    expect((await cashier.call("POST", "/orders/offline-series", { deviceId: "device-one-1234" })).body.lastSeqByFy[String(fy())]).toBe(1);
  });

  it("falls back to the normal counter for a taken number, another FY, an unknown series or online bills", async () => {
    expect((await offlineBill(`INVA1-${fy()}-00001`)).body.invoiceNumber).toMatch(/^INV-/);
    expect((await offlineBill(`INVA1-${fy() - 1}-00002`)).body.invoiceNumber).toMatch(/^INV-/);
    expect((await offlineBill(`INVZ9-${fy()}-00003`)).body.invoiceNumber).toMatch(/^INV-/);
    const online = await cashier.call("POST", "/orders", { orderType: "TAKEAWAY", items: [{ menuItemId: h.items.chai, quantity: 1 }], offlineInvoiceNumber: `INVA1-${fy()}-00004` });
    expect(online.body.invoiceNumber).toMatch(/^INV-/);
  });
});
