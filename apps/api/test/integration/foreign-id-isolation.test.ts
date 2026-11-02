/**
 * Cross-tenant reads and foreign-ID links found in the Phase 3 code review.
 *   BUG-007  GET /inventory/recipes returns every business's recipes + costs
 *   BUG-008  menu item categoryId / category parentId accept another business's category
 *   BUG-009  staff shiftId accepts another outlet's (or business's) shift
 */
import { beforeAll, describe, expect, it } from "vitest";
import { createTenant, db, demoTenant, loginAs } from "./helpers";

let victim: Awaited<ReturnType<typeof createTenant>>;
let victimCategoryId: string;
let victimShiftId: string;
let victimMenuItemId: string;
let demo: Awaited<ReturnType<typeof demoTenant>>;

beforeAll(async () => {
  demo = await demoTenant();
  victim = await createTenant({ name: "Victim Foods" });
  const cat = await db.menuCategory.create({ data: { businessId: victim.business.id, name: "VICTIM-CATEGORY" } });
  victimCategoryId = cat.id;
  const item = await db.menuItem.create({ data: { businessId: victim.business.id, categoryId: cat.id, name: "VICTIM-DOSA", price: 8000 } });
  victimMenuItemId = item.id;
  const ing = await db.inventoryItem.create({ data: { businessId: victim.business.id, name: "VICTIM-SECRET-BATTER", unit: "KG", costPerUnit: 12345 } });
  await db.recipe.create({ data: { menuItemId: item.id, inventoryItemId: ing.id, quantity: 0.2 } });
  const shift = await db.shift.create({ data: { outletId: victim.outlet.id, name: "VICTIM-SHIFT", startTime: "06:00", endTime: "14:00" } });
  victimShiftId = shift.id;
});

describe("@critical @regression BUG-007 recipes are tenant-scoped", () => {
  it("ISO-INV-001 GET /inventory/recipes never returns another business's recipes", async () => {
    const inv = await loginAs("inventory@canavo.local", demo.outlet.id);
    const res = await inv.get("/inventory/recipes");
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain("VICTIM-SECRET-BATTER");
    expect(res.body.length).toBeGreaterThan(0); // own recipes still listed
  });

  it("ISO-INV-002 GET /inventory/recipes?menuItemId=<foreign> returns nothing", async () => {
    const inv = await loginAs("inventory@canavo.local", demo.outlet.id);
    const res = await inv.get(`/inventory/recipes?menuItemId=${victimMenuItemId}`);
    expect(JSON.stringify(res.body)).not.toContain("VICTIM-SECRET-BATTER");
  });
});

describe("@critical @regression BUG-008 menu cannot link another business's category", () => {
  it("ISO-MENU-001 POST /menu/items with a foreign categoryId is rejected", async () => {
    const owner = await loginAs("owner@canavo.local", demo.outlet.id);
    const res = await owner.post("/menu/items", { name: "Attacker item", categoryId: victimCategoryId, price: 1000 });
    expect([400, 404]).toContain(res.status);
  });

  it("ISO-MENU-002 PATCH /menu/items/:id with a foreign categoryId is rejected", async () => {
    const owner = await loginAs("owner@canavo.local", demo.outlet.id);
    const own = await db.menuItem.findFirstOrThrow({ where: { businessId: demo.businessId } });
    const res = await owner.patch(`/menu/items/${own.id}`, { categoryId: victimCategoryId });
    expect([400, 404]).toContain(res.status);
    const after = await db.menuItem.findUniqueOrThrow({ where: { id: own.id } });
    expect(after.categoryId).toBe(own.categoryId);
  });

  it("ISO-MENU-003 POST/PATCH /menu/categories with a foreign parentId is rejected", async () => {
    const owner = await loginAs("owner@canavo.local", demo.outlet.id);
    const created = await owner.post("/menu/categories", { name: "Attacker sub", parentId: victimCategoryId });
    expect([400, 404]).toContain(created.status);
    const own = await db.menuCategory.findFirstOrThrow({ where: { businessId: demo.businessId } });
    const patched = await owner.patch(`/menu/categories/${own.id}`, { parentId: victimCategoryId });
    expect([400, 404]).toContain(patched.status);
  });

  it("ISO-MENU-004 own categories still work", async () => {
    const owner = await loginAs("owner@canavo.local", demo.outlet.id);
    const parent = await db.menuCategory.findFirstOrThrow({ where: { businessId: demo.businessId, parentId: null } });
    const res = await owner.post("/menu/categories", { name: `Own sub ${Date.now()}`, parentId: parent.id });
    expect(res.status).toBe(201);
  });
});

describe("@critical @regression BUG-009 staff cannot be given another outlet's shift", () => {
  it("ISO-STF-001 PATCH /staff/:id with a foreign shiftId is rejected", async () => {
    const mgr = await loginAs("manager@canavo.local", demo.outlet.id);
    const cashier = await db.user.findUniqueOrThrow({ where: { email: "cashier@canavo.local" } });
    const res = await mgr.patch(`/staff/${cashier.id}`, { shiftId: victimShiftId });
    expect([400, 404]).toContain(res.status);
    const after = await db.user.findUniqueOrThrow({ where: { id: cashier.id } });
    expect(after.shiftId).not.toBe(victimShiftId);
  });

  it("ISO-STF-002 POST /staff with a foreign shiftId is rejected", async () => {
    const mgr = await loginAs("manager@canavo.local", demo.outlet.id);
    const res = await mgr.post("/staff", {
      name: "Attacker staff", phone: `6${String(Math.floor(Math.random() * 1e9)).padStart(9, "0")}`, role: "CASHIER",
      outletIds: [demo.outlet.id], shiftId: victimShiftId, pin: "4321",
    });
    expect([400, 404]).toContain(res.status);
  });

  it("ISO-STF-003 an own-outlet shift is still accepted", async () => {
    const mgr = await loginAs("manager@canavo.local", demo.outlet.id);
    const shift = await db.shift.create({ data: { outletId: demo.outlet.id, name: `Own ${Date.now()}`, startTime: "09:00", endTime: "17:00" } });
    const cashier = await db.user.findUniqueOrThrow({ where: { email: "cashier@canavo.local" } });
    const res = await mgr.patch(`/staff/${cashier.id}`, { shiftId: shift.id });
    expect(res.status).toBe(200);
    await db.user.update({ where: { id: cashier.id }, data: { shiftId: cashier.shiftId } });
  });
});
