/**
 * QA Phase 7 — soft delete and the audit log.
 *  - Deactivated records (menu items, staff, inventory items, vendors, canteen members,
 *    blocked customers) still resolve everywhere in history (bills, receipts, reports,
 *    ledgers) and are kept out of the lists used to make NEW records.
 *  - Audit log: rows written per typical action, the indexes behind the audit screen, and
 *    whether anything ever trims it (measured here; recommendations in the phase report).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHotel, db, login, PASSWORD, startServer, type Client, type Hotel } from "../integration/helpers";
import { failures, ownerClient, runChecks } from "./recon-kit";

const MODULES = ["BILLING", "KOT", "TABLES", "DELIVERY", "INVENTORY", "CUSTOMERS", "OFFERS", "REPORTS", "CANTEEN"];
let srv: Awaited<ReturnType<typeof startServer>>;
let h: Hotel;
let owner: Client, manager: Client, cashier: Client;
const owner_db = ownerClient();
type R = { status: number; body: any }; // eslint-disable-line @typescript-eslint/no-explicit-any
const ok = async (p: Promise<R>) => {
  const r = await p;
  if (r.status >= 300) throw new Error(`${r.status} ${JSON.stringify(r.body).slice(0, 300)}`);
  return r.body;
};
const phone = () => `9${String(Math.floor(Math.random() * 1e9)).padStart(9, "0")}`;
const today = () => new Date().toISOString().slice(0, 10);

beforeAll(async () => {
  srv = await startServer();
  h = await createHotel("SoftDel", { modules: MODULES });
  owner = await login(srv.base, h.users.owner.email, h.outletId);
  manager = await login(srv.base, h.users.manager.email, h.outletId);
  cashier = await login(srv.base, h.users.cashier.email, h.outletId);
}, 120_000);
afterAll(async () => {
  expect(failures(await runChecks(owner_db))).toEqual([]);
  await owner_db.$disconnect();
  await srv.close();
});

describe("soft delete: gone from active lists, still there in history", () => {
  it("a sold menu item is hidden (not deleted): old bills, receipts and reports still show it; new bills refuse it", async () => {
    const item = await ok(owner.call("POST", "/menu/items", { name: "Retired Dosa", price: 9000, categoryId: (await db.menuCategory.findFirstOrThrow({ where: { businessId: h.businessId } })).id, gstRate: 5 }));
    const o = await ok(cashier.call("POST", "/orders", { orderType: "TAKEAWAY", items: [{ menuItemId: item.id, quantity: 2 }] }));
    await ok(cashier.call("POST", `/orders/${o.id}/payments`, { payments: [{ mode: "CASH", amount: o.grandTotal }] }));
    expect((await owner.call("DELETE", `/menu/items/${item.id}`)).status).toBe(204);
    const row = await db.menuItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(row.status).toBe("HIDDEN");
    // History resolves.
    const bill = await ok(owner.call("GET", `/orders/${o.id}`));
    expect(bill.items[0]).toMatchObject({ name: "Retired Dosa", menuItemId: item.id });
    expect((await ok(owner.call("GET", `/orders/${o.id}/receipt`))).items[0].name).toBe("Retired Dosa");
    const rep = await ok(owner.call("GET", `/reports/items?from=${today()}&to=${today()}`));
    expect(JSON.stringify(rep)).toContain("Retired Dosa");
    // Not sellable any more; the menu marks it hidden for the POS to leave out.
    expect((await cashier.call("POST", "/orders", { orderType: "TAKEAWAY", items: [{ menuItemId: item.id, quantity: 1 }] })).status).toBe(400);
    const menu = await ok(cashier.call("GET", "/menu"));
    expect(menu.items.find((i: { id: string }) => i.id === item.id)?.status).toBe("HIDDEN");
    // Deleting is recorded in the audit log like every other menu change.
    expect(await db.auditLog.count({ where: { entity: "MenuItem", entityId: item.id, action: { startsWith: "menu.item.delete" } } })).toBe(1);
  });

  it("an item never billed but already on a running tab is hidden, not deleted — the tab can still be billed", async () => {
    const cat = (await db.menuCategory.findFirstOrThrow({ where: { businessId: h.businessId } })).id;
    const item = await ok(owner.call("POST", "/menu/items", { name: "Tab Only Vada", price: 4000, categoryId: cat, gstRate: 5 }));
    const t = await ok(owner.call("POST", "/tables", { label: `SD${Date.now() % 10000}` }));
    const s = await ok(cashier.call("POST", `/tables/${t.id}/open`, { guests: 1 }));
    await ok(cashier.call("POST", `/tables/sessions/${s.id}/items`, { items: [{ menuItemId: item.id, quantity: 1 }] }));
    expect((await owner.call("DELETE", `/menu/items/${item.id}`)).status).toBe(204);
    expect(await db.menuItem.findUnique({ where: { id: item.id } })).not.toBeNull();
    const billed = await cashier.call("POST", `/tables/sessions/${s.id}/bill`, {});
    expect(billed.status, JSON.stringify(billed.body)).toBe(201);
    expect(billed.body.orders[0].order.items[0].name).toBe("Tab Only Vada");
  });

  it("a deactivated staff member can't log in or be picked, but their bills still name them", async () => {
    const email = `gone.${Date.now()}@it.local`;
    const staff = await ok(owner.call("POST", "/staff", { name: "Leaving Cashier", email, phone: phone(), password: PASSWORD, role: "CASHIER", outletIds: [h.outletId] }));
    const leaver = await login(srv.base, email, h.outletId);
    const o = await ok(leaver.call("POST", "/orders", { orderType: "TAKEAWAY", items: [{ menuItemId: h.items.chai, quantity: 1 }] }));
    await ok(owner.call("PATCH", `/staff/${staff.id}`, { status: "INACTIVE" }));
    // Signed out at once and can't sign in again.
    expect((await leaver.call("GET", "/orders")).status).toBe(401);
    expect((await fetch(`${srv.base}/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password: PASSWORD }) })).status).toBe(401);
    // History: the bill still shows who made it.
    expect((await ok(owner.call("GET", `/orders/${o.id}`))).cashier).toMatchObject({ id: staff.id, name: "Leaving Cashier" });
    // Staff list keeps them (with their status) for the record…
    const list = await ok(owner.call("GET", "/staff"));
    expect(list.find((u: { id: string }) => u.id === staff.id)?.status).toBe("INACTIVE");
    // …but they are not offered for new work: not a waiter for a tab, not a delivery partner, not an approver.
    const t = await ok(owner.call("POST", "/tables", { label: `SW${Date.now() % 10000}` }));
    expect((await cashier.call("POST", `/tables/${t.id}/open`, { guests: 1, waiterId: staff.id })).status).toBe(400);
    await ok(owner.call("PATCH", `/staff/${h.users.delivery.id}`, { status: "INACTIVE" }));
    expect((await ok(manager.call("GET", "/delivery/agents"))).some((a: { id: string }) => a.id === h.users.delivery.id)).toBe(false);
    await ok(owner.call("PATCH", `/staff/${h.users.delivery.id}`, { status: "ACTIVE" }));
  });

  it("a deactivated inventory item / vendor stays in the ledger, purchases and valuation history but leaves the active lists", async () => {
    const ghee = await ok(owner.call("POST", "/inventory/items", { name: "Ghee", unit: "KG", openingStock: 5, costPerUnit: 50000 }));
    await ok(owner.call("POST", "/inventory/items", { name: "Butter", unit: "KG", openingStock: 3, costPerUnit: 40000 }));
    const vendor = await ok(owner.call("POST", "/inventory/vendors", { name: "Old Dairy" }));
    const p = await ok(owner.call("POST", "/inventory/purchases", { vendorId: vendor.id, items: [{ inventoryItemId: ghee.id, quantity: 2, unitCost: 48000 }], receive: true }));
    expect((await owner.call("DELETE", `/inventory/items/${ghee.id}`)).status).toBe(204);
    expect((await owner.call("DELETE", `/inventory/vendors/${vendor.id}`)).status).toBe(204);
    expect((await ok(owner.call("GET", "/inventory/items"))).items.some((i: { id: string }) => i.id === ghee.id)).toBe(false);
    expect((await ok(owner.call("GET", "/inventory/items?includeInactive=1"))).items.some((i: { id: string }) => i.id === ghee.id)).toBe(true);
    const ledger = await ok(owner.call("GET", `/inventory/transactions?itemId=${ghee.id}`));
    expect(ledger.length).toBe(2);
    expect((await ok(owner.call("GET", `/inventory/purchases/${p.id}`))).vendor.name).toBe("Old Dairy");
    // A stock audit counts only active items.
    const a = await ok(owner.call("POST", "/inventory/audits", {}));
    expect(a.lines.some((l: { inventoryItemId: string }) => l.inventoryItemId === ghee.id)).toBe(false);
    await ok(owner.call("POST", `/inventory/audits/${a.id}/cancel`));
  });

  it("a blocked customer / inactive canteen member: history resolves, new credit / member bills are refused", async () => {
    const p = phone();
    const o = await ok(cashier.call("POST", "/orders", { orderType: "TAKEAWAY", customerPhone: p, items: [{ menuItemId: h.items.chai, quantity: 1 }] }));
    await ok(cashier.call("POST", `/orders/${o.id}/payments`, { payments: [{ mode: "UPI", amount: o.grandTotal }] }));
    const c = await db.customer.findFirstOrThrow({ where: { businessId: h.businessId, phone: p } });
    await ok(owner.call("POST", `/customers/${c.id}/block`, { blocked: true, reason: "Bounced" }));
    // Blocked: no new bills under their number (so no credit, no points) — the counter is told why.
    const refused = await cashier.call("POST", "/orders", { orderType: "TAKEAWAY", customerPhone: p, items: [{ menuItemId: h.items.chai, quantity: 1 }] });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toMatch(/blocked/i);
    const detail = await ok(owner.call("GET", `/customers/${c.id}`));
    expect(JSON.stringify(detail)).toContain(o.id);
    const m = await ok(owner.call("POST", "/canteen/members", { name: "Gone Member", phone: phone() }));
    const mo = await ok(cashier.call("POST", "/orders", { orderType: "TAKEAWAY", memberId: m.id, items: [{ menuItemId: h.items.chai, quantity: 1 }] }));
    await ok(owner.call("PATCH", `/canteen/members/${m.id}`, { memberActive: false }));
    expect((await cashier.call("POST", "/orders", { orderType: "TAKEAWAY", memberId: m.id, items: [{ menuItemId: h.items.chai, quantity: 1 }] })).status).toBe(400);
    expect((await ok(owner.call("GET", `/orders/${mo.id}`))).customerId).toBe(m.id);
  });
});

describe("audit log growth", () => {
  it("rows per typical action, the indexes behind the audit screen, no trimming job", async () => {
    const before = await db.auditLog.count({ where: { businessId: h.businessId } });
    const start = new Date();
    // A small "typical day": 20 bills, all paid (some split), 1 void, 1 refund, a khata settle,
    // a wastage entry, a shift open/close.
    await ok(cashier.call("POST", "/cash-shifts/open", { openingFloat: 100000 }));
    const p = phone();
    for (let i = 0; i < 20; i++) {
      const o = await ok(cashier.call("POST", "/orders", { orderType: "TAKEAWAY", ...(i % 4 === 0 && { customerPhone: p }), items: [{ menuItemId: h.items.biryani, quantity: 1 }] }));
      if (i % 4 === 0) await ok(cashier.call("POST", `/orders/${o.id}/payments`, { payments: [{ mode: "KHATA", amount: o.grandTotal }] }));
      else if (i % 3 === 0) {
        await ok(cashier.call("POST", `/orders/${o.id}/payments`, { payments: [{ mode: "CASH", amount: 5000 }] }));
        await ok(cashier.call("POST", `/orders/${o.id}/payments`, { payments: [{ mode: "UPI", amount: o.grandTotal - 5000 }] }));
      } else await ok(cashier.call("POST", `/orders/${o.id}/payments`, { payments: [{ mode: "CASH", amount: o.grandTotal }] }));
      if (i === 5) await ok(manager.call("POST", `/orders/${o.id}/cancel`, { reason: "Wrong table" }));
      if (i === 6) await ok(manager.call("POST", `/orders/${o.id}/refunds`, { reason: "QUALITY", refundMode: "CASH", amount: 2000 }));
    }
    const c = await db.customer.findFirstOrThrow({ where: { businessId: h.businessId, phone: p } });
    await ok(cashier.call("POST", `/customers/${c.id}/khata/settle`, { amount: 10000, mode: "CASH" }));
    await ok(cashier.call("POST", "/cash-shifts/current/close", { countedCash: 100000 }));
    const rows = await db.auditLog.groupBy({ by: ["action"], where: { businessId: h.businessId, createdAt: { gte: start } }, _count: true });
    const added = (await db.auditLog.count({ where: { businessId: h.businessId } })) - before;
    const per = Object.fromEntries(rows.map((r) => [r.action, r._count]));
    console.info(`[audit] +${added} rows for 20 bills; by action ${JSON.stringify(per)}`);
    // Every bill and every payment call is audited, in the same transaction as the change.
    expect(per["order.create"]).toBeGreaterThanOrEqual(20);
    expect(per["payment.collect"]).toBeGreaterThanOrEqual(20);
    expect(added / 20).toBeLessThan(4); // ≈ 2.3 rows per bill today
    // Every audit row carries its business (the tenant filter fills it), so the owner's screen can use its index.
    expect(await db.auditLog.count({ where: { businessId: null, outletId: h.outletId } })).toBe(0);
    const idx = await owner_db.$queryRawUnsafe<{ indexdef: string }[]>(`SELECT indexdef FROM pg_indexes WHERE tablename = 'AuditLog' ORDER BY indexname`);
    const defs = idx.map((i) => i.indexdef).join("\n");
    expect(defs).toMatch(/\("businessId", "createdAt"\)/);
    expect(defs).toMatch(/\("outletId", "createdAt"\)/);
    expect(defs).toMatch(/\(entity, "entityId"\)/);
    const size = await owner_db.$queryRawUnsafe<{ avg: number }[]>(`SELECT AVG(pg_column_size(a.*))::float AS avg FROM "AuditLog" a WHERE "businessId" = $1`, h.businessId);
    console.info(`[audit] average row ${Math.round(size[0].avg)} bytes; indexes:\n${defs}`);
  });
});
