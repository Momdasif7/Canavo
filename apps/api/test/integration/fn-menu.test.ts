/**
 * QA Phase 5 — group B — Menu: categories, items (sizes / add-ons / food type /
 * HSN / time slots), outlet overrides, roles & modules, photo upload.
 */
import { beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { app, createTenant } from "./helpers";
import { createDefaultTaxRates } from "../../src/services/tax-defaults";
import { as, bill, db, hhmm, istMinutes, line, mkCategory, mkItem, tenant, uid, upload } from "./fx-b";

let T: Awaited<ReturnType<typeof tenant>>;
let outlet2Id: string;
let catId: string;
let other: Awaited<ReturnType<typeof createTenant>>;
let foreignCatId: string;
let foreignItemId: string;

beforeAll(async () => {
  T = await tenant();
  outlet2Id = (await db.outlet.create({ data: { businessId: T.business.id, name: `Second ${uid()}`, stateCode: "33" } })).id;
  catId = (await mkCategory(T.business.id, "Snacks")).id;
  other = await createTenant({ name: "Other menu biz" });
  foreignCatId = (await mkCategory(other.business.id, "FOREIGN-CAT")).id;
  foreignItemId = (await mkItem(other.business.id, foreignCatId, 9900, { name: "FOREIGN-ITEM" })).id;
});

const itemBody = (extra: Record<string, unknown> = {}) => ({ name: `Dosa ${uid()}`, categoryId: catId, price: 5000, ...extra });

describe("Menu categories @regression", () => {
  it("IT-MENU-001 owner creates a category and GET /menu lists it @regression", async () => {
    const owner = await T.owner();
    const res = await owner.post("/menu/categories", { name: "Beverages" });
    expect(res.status).toBe(201);
    const menu = await owner.get("/menu");
    expect(menu.status).toBe(200);
    expect(menu.body.categories.map((c: { id: string }) => c.id)).toContain(res.body.id);
  });

  it("IT-MENU-002 sub-category create + rename; parent link kept @regression", async () => {
    const owner = await T.owner();
    const parent = await owner.post("/menu/categories", { name: `Parent ${uid()}` });
    const sub = await owner.post("/menu/categories", { name: "Hot", parentId: parent.body.id });
    expect(sub.status).toBe(201);
    expect(sub.body.parentId).toBe(parent.body.id);
    const ren = await owner.patch(`/menu/categories/${sub.body.id}`, { name: "Hot Beverages" });
    expect(ren.status).toBe(200);
    expect(ren.body).toMatchObject({ name: "Hot Beverages", parentId: parent.body.id });
  });

  it("IT-MENU-003 category name BVA: empty → 400, 60 chars → 201, 61 chars → 400 @regression", async () => {
    const owner = await T.owner();
    expect((await owner.post("/menu/categories", { name: "" })).status).toBe(400);
    expect((await owner.post("/menu/categories", { name: "c".repeat(60) })).status).toBe(201);
    expect((await owner.post("/menu/categories", { name: "c".repeat(61) })).status).toBe(400);
  });

  it("IT-MENU-004 a category cannot be its own parent → 400 @regression", async () => {
    const owner = await T.owner();
    const c = await owner.post("/menu/categories", { name: `Self ${uid()}` });
    const res = await owner.patch(`/menu/categories/${c.body.id}`, { parentId: c.body.id });
    expect(res.status).toBe(400);
  });

  // Expected: a parent loop (A under B, B under A) is rejected like the self-parent case.
  // Actual: only the direct self-reference is checked, so PATCH B {parentId: A} returns 200 and
  // both categories become each other's parent (neither is a root any more; tree UIs lose them).
  it.fails("IT-MENU-005 (BUG-CANDIDATE-B1) indirect parent cycle A→B→A is rejected @regression", async () => {
    const owner = await T.owner();
    const a = await owner.post("/menu/categories", { name: `A ${uid()}` });
    const b = await owner.post("/menu/categories", { name: `B ${uid()}`, parentId: a.body.id });
    const res = await owner.patch(`/menu/categories/${a.body.id}`, { parentId: b.body.id });
    expect(res.status).toBe(400);
  });

  it("IT-MENU-006 deleting a category that has items → 400 and the item survives @regression", async () => {
    const owner = await T.owner();
    const c = await mkCategory(T.business.id);
    const item = await mkItem(T.business.id, c.id, 1000);
    const res = await owner.delete(`/menu/categories/${c.id}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/1 item/);
    expect(await db.menuItem.findUnique({ where: { id: item.id } })).not.toBeNull();
  });

  it("IT-MENU-007 deleting an empty parent → 204 and its sub-categories are re-parented to top level @regression", async () => {
    const owner = await T.owner();
    const p = await mkCategory(T.business.id);
    const s1 = await mkCategory(T.business.id, `S1 ${uid()}`, p.id);
    const s2 = await mkCategory(T.business.id, `S2 ${uid()}`, p.id);
    expect((await owner.delete(`/menu/categories/${p.id}`)).status).toBe(204);
    const kids = await db.menuCategory.findMany({ where: { id: { in: [s1.id, s2.id] } } });
    expect(kids).toHaveLength(2);
    expect(kids.every((k) => k.parentId === null)).toBe(true);
  });

  it("IT-MENU-008 delete / patch of an unknown or another business's category → 404, foreign row untouched @regression", async () => {
    const owner = await T.owner();
    expect((await owner.delete("/menu/categories/does-not-exist")).status).toBe(404);
    expect((await owner.delete(`/menu/categories/${foreignCatId}`)).status).toBe(404);
    expect((await owner.patch(`/menu/categories/${foreignCatId}`, { name: "pwned" })).status).toBe(404);
    expect((await db.menuCategory.findUniqueOrThrow({ where: { id: foreignCatId } })).name).toBe("FOREIGN-CAT");
  });
});

describe("Menu items @regression", () => {
  it("IT-MENU-010 item with sizes, add-ons, EGG, HSN and time slot is stored and returned @regression", async () => {
    const owner = await T.owner();
    const res = await owner.post(
      "/menu/items",
      itemBody({
        foodType: "EGG", hsnCode: "21069099", availableFrom: "07:00", availableTo: "11:30", kitchenStation: "BEVERAGE",
        variants: [{ name: "Regular", price: 1500 }, { name: "Large", price: 2500 }],
        addons: [{ name: "Extra cheese", price: 1000 }],
      }),
    );
    expect(res.status).toBe(201);
    const got = await owner.get(`/menu/items/${res.body.id}`);
    expect(got.status).toBe(200);
    expect(got.body).toMatchObject({ foodType: "EGG", hsnCode: "21069099", availableFrom: "07:00", availableTo: "11:30", kitchenStation: "BEVERAGE" });
    expect(got.body.variants.map((v: { name: string; price: number }) => [v.name, v.price]).sort()).toEqual([["Large", 2500], ["Regular", 1500]]);
    expect(got.body.addons[0]).toMatchObject({ name: "Extra cheese", price: 1000 });
  });

  it("IT-MENU-011 NON_VEG and VEG (default) food types; HSN defaults to 996331 @regression", async () => {
    const owner = await T.owner();
    const nv = await owner.post("/menu/items", itemBody({ foodType: "NON_VEG" }));
    const v = await owner.post("/menu/items", itemBody());
    expect(nv.body.foodType).toBe("NON_VEG");
    expect(v.body.foodType).toBe("VEG");
    expect(v.body.hsnCode).toBe("996331");
  });

  it("IT-MENU-012 Tamil / Hindi / emoji names round-trip unchanged @regression", async () => {
    const owner = await T.owner();
    for (const name of ["மசாலா தோசை", "पनीर टिक्का", "Chai ☕🔥", "Café crème — ½ plate"]) {
      const res = await owner.post("/menu/items", itemBody({ name }));
      expect(res.status).toBe(201);
      expect((await owner.get(`/menu/items/${res.body.id}`)).body.name).toBe(name);
    }
  });

  it("IT-MENU-013 name BVA: 100 chars → 201, 101 chars → 400, empty → 400 @regression", async () => {
    const owner = await T.owner();
    expect((await owner.post("/menu/items", itemBody({ name: "n".repeat(100) }))).status).toBe(201);
    expect((await owner.post("/menu/items", itemBody({ name: "n".repeat(101) }))).status).toBe(400);
    expect((await owner.post("/menu/items", itemBody({ name: "" }))).status).toBe(400);
  });

  it("IT-MENU-014 invalid item fields are rejected with 400 (never 500) @regression", async () => {
    const owner = await T.owner();
    const bad: Record<string, unknown>[] = [
      { price: -1 }, { price: 10.5 }, { price: "100" }, { foodType: "VEGAN" }, { availableFrom: "25:00" },
      { hsnCode: "123456789" }, { categoryId: undefined }, { variants: [{ name: "", price: 100 }] },
      { variants: [{ name: "L", price: -5 }] }, { addons: [{ name: "x", price: 1.5 }] }, { gstRate: 101 }, { status: "SOLD_OUT" },
      { categoryId: "nope" },
    ];
    for (const b of bad) {
      const res = await owner.post("/menu/items", itemBody(b));
      expect(res.status, JSON.stringify(b)).toBe(400);
    }
  });

  it("IT-MENU-015 price BVA: 0 paise accepted (free item), 1 paise accepted @regression", async () => {
    const owner = await T.owner();
    expect((await owner.post("/menu/items", itemBody({ price: 0 }))).status).toBe(201);
    expect((await owner.post("/menu/items", itemBody({ price: 1 }))).status).toBe(201);
  });

  it("IT-MENU-016 new items default to GST 0% (business with the standard slabs) @critical @regression", async () => {
    const t = await tenant();
    await createDefaultTaxRates(db as never, t.business.id);
    const c = await mkCategory(t.business.id);
    const owner = await t.owner();
    const res = await owner.post("/menu/items", { name: "Plain", categoryId: c.id, price: 10000 });
    expect(res.status).toBe(201);
    expect(res.body.gstRate).toBe(0);
    const menu = await owner.get("/menu");
    const it0 = menu.body.items.find((i: { id: string }) => i.id === res.body.id);
    expect(it0.effectiveTaxRate.cgst + it0.effectiveTaxRate.sgst).toBe(0);
    const o = await bill(owner, [line(res.body.id)]);
    expect(o.status).toBe(201);
    expect(o.body.grandTotal).toBe(10000);
    expect(o.body.cgst + o.body.sgst).toBe(0);
  });

  it("IT-MENU-017 explicit taxRateId (18%) sets gstRate 18; another business's taxRateId → 400 @critical @regression", async () => {
    const t = await tenant();
    await createDefaultTaxRates(db as never, t.business.id);
    await createDefaultTaxRates(db as never, other.business.id);
    const c = await mkCategory(t.business.id);
    const owner = await t.owner();
    const r18 = await db.taxRate.findFirstOrThrow({ where: { businessId: t.business.id, name: "GST 18%" } });
    const res = await owner.post("/menu/items", { name: "Cola", categoryId: c.id, price: 11800, taxRateId: r18.id });
    expect(res.status).toBe(201);
    expect(res.body.gstRate).toBe(18);
    const foreign = await db.taxRate.findFirstOrThrow({ where: { businessId: other.business.id, name: "GST 5%" } });
    expect((await owner.post("/menu/items", { name: "Cola2", categoryId: c.id, price: 100, taxRateId: foreign.id })).status).toBe(400);
  });

  it("IT-MENU-018 PATCH variants replaces the whole set @regression", async () => {
    const owner = await T.owner();
    const created = await owner.post("/menu/items", itemBody({ variants: [{ name: "S", price: 100 }, { name: "M", price: 200 }] }));
    const res = await owner.patch(`/menu/items/${created.body.id}`, { variants: [{ name: "XL", price: 900 }] });
    expect(res.status).toBe(200);
    expect(res.body.variants.map((v: { name: string }) => v.name)).toEqual(["XL"]);
  });

  it("IT-MENU-019 billing a size + add-on charges size price + add-on price @critical @regression", async () => {
    const owner = await T.owner();
    const it0 = await owner.post("/menu/items", itemBody({ price: 9999, variants: [{ name: "Large", price: 2500 }], addons: [{ name: "Ghee", price: 500 }] }));
    const o = await bill(owner, [line(it0.body.id, 2, { variantId: it0.body.variants[0].id, addonIds: [it0.body.addons[0].id] })]);
    expect(o.status).toBe(201);
    expect(o.body.items[0].unitPrice).toBe(3000);
    expect(o.body.grandTotal).toBe(6000);
  });

  it("IT-MENU-020 bill with an unknown size or another item's add-on → 400 @regression", async () => {
    const owner = await T.owner();
    const a = await owner.post("/menu/items", itemBody({ addons: [{ name: "A", price: 100 }] }));
    const b = await owner.post("/menu/items", itemBody({ variants: [{ name: "V", price: 100 }] }));
    expect((await bill(owner, [line(a.body.id, 1, { variantId: b.body.variants[0].id })])).status).toBe(400);
    expect((await bill(owner, [line(b.body.id, 1, { addonIds: [a.body.addons[0].id] })])).status).toBe(400);
  });

  it("IT-MENU-021 HIDDEN and OUT_OF_STOCK items cannot be billed @regression", async () => {
    const owner = await T.owner();
    const h = await mkItem(T.business.id, catId, 1000, { status: "HIDDEN" });
    const s = await mkItem(T.business.id, catId, 1000, { status: "OUT_OF_STOCK" });
    expect((await bill(owner, [line(h.id)])).status).toBe(400);
    const r = await bill(owner, [line(s.id)]);
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/not available/);
  });

  it("IT-MENU-022 time slot: billing outside the window → 400, inside → 201 @regression", async () => {
    const owner = await T.owner();
    const now = istMinutes();
    const outside = await mkItem(T.business.id, catId, 1000, { availableFrom: hhmm(now + 120), availableTo: hhmm(now + 180) });
    const inside = await mkItem(T.business.id, catId, 1000, { availableFrom: hhmm(now - 60), availableTo: hhmm(now + 60) });
    const r = await bill(owner, [line(outside.id)]);
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/only served/);
    expect((await bill(owner, [line(inside.id)])).status).toBe(201);
  });

  it("IT-MENU-023 delete: never-sold item is removed; sold item is only hidden @regression", async () => {
    const owner = await T.owner();
    const fresh = await mkItem(T.business.id, catId, 1000);
    expect((await owner.delete(`/menu/items/${fresh.id}`)).status).toBe(204);
    expect(await db.menuItem.findUnique({ where: { id: fresh.id } })).toBeNull();
    const sold = await mkItem(T.business.id, catId, 1000);
    expect((await bill(owner, [line(sold.id)])).status).toBe(201);
    expect((await owner.delete(`/menu/items/${sold.id}`)).status).toBe(204);
    expect((await db.menuItem.findUniqueOrThrow({ where: { id: sold.id } })).status).toBe("HIDDEN");
  });

  it("IT-MENU-024 BUG-008 regression: foreign categoryId on create/patch → 400 @critical @regression", async () => {
    const owner = await T.owner();
    expect((await owner.post("/menu/items", itemBody({ categoryId: foreignCatId }))).status).toBe(400);
    const own = await mkItem(T.business.id, catId, 1000);
    expect((await owner.patch(`/menu/items/${own.id}`, { categoryId: foreignCatId })).status).toBe(400);
    expect((await owner.post("/menu/categories", { name: "x", parentId: foreignCatId })).status).toBe(400);
  });

  it("IT-MENU-025 another business's item: GET / PATCH / override / DELETE → 404 and nothing changes @critical @regression", async () => {
    const owner = await T.owner();
    expect((await owner.get(`/menu/items/${foreignItemId}`)).status).toBe(404);
    expect((await owner.patch(`/menu/items/${foreignItemId}`, { price: 1 })).status).toBe(404);
    expect((await owner.put(`/menu/items/${foreignItemId}/override`, { price: 1 })).status).toBe(404);
    await owner.delete(`/menu/items/${foreignItemId}`);
    const after = await db.menuItem.findUniqueOrThrow({ where: { id: foreignItemId } });
    expect(after.price).toBe(9900);
    const menu = await owner.get("/menu");
    expect(JSON.stringify(menu.body)).not.toContain("FOREIGN-ITEM");
  });

  // Expected: imageUrl only accepts http(s) links (the bulk import enforces exactly this).
  // Actual: z.string().url() accepts any scheme — "javascript:alert(1)" / "data:" URLs are stored (201).
  it.fails("IT-MENU-026 (BUG-CANDIDATE-B2) imageUrl with a javascript: scheme is rejected @regression", async () => {
    const owner = await T.owner();
    const res = await owner.post("/menu/items", itemBody({ imageUrl: "javascript:alert(document.cookie)" }));
    expect(res.status).toBe(400);
  });
});

describe("Outlet overrides @critical @regression", () => {
  it("IT-MENU-030 price override shows on GET /menu for that outlet only @critical @regression", async () => {
    const owner1 = await T.owner();
    const owner2 = await as(T.users.BUSINESS_OWNER.email, outlet2Id);
    const it0 = await mkItem(T.business.id, catId, 10000);
    const put = await owner1.put(`/menu/items/${it0.id}/override`, { price: 12000 });
    expect(put.status).toBe(200);
    const m1 = (await owner1.get("/menu")).body.items.find((i: { id: string }) => i.id === it0.id);
    const m2 = (await owner2.get("/menu")).body.items.find((i: { id: string }) => i.id === it0.id);
    expect(m1).toMatchObject({ price: 12000, basePrice: 10000, hasOverride: true });
    expect(m2).toMatchObject({ price: 10000, hasOverride: false });
  });

  it("IT-MENU-031 billed price follows the outlet override (outlet 1 override, outlet 2 base) @critical @regression", async () => {
    const owner1 = await T.owner();
    const owner2 = await as(T.users.BUSINESS_OWNER.email, outlet2Id);
    const it0 = await mkItem(T.business.id, catId, 10000);
    await owner1.put(`/menu/items/${it0.id}/override`, { price: 8000 });
    const o1 = await bill(owner1, [line(it0.id, 2)]);
    const o2 = await bill(owner2, [line(it0.id, 2)]);
    expect(o1.body.items[0].unitPrice).toBe(8000);
    expect(o1.body.grandTotal).toBe(16000);
    expect(o2.body.items[0].unitPrice).toBe(10000);
    expect(o2.body.grandTotal).toBe(20000);
  });

  it("IT-MENU-032 OUT_OF_STOCK override blocks billing at that outlet only @regression", async () => {
    const owner1 = await T.owner();
    const owner2 = await as(T.users.BUSINESS_OWNER.email, outlet2Id);
    const it0 = await mkItem(T.business.id, catId, 5000);
    await owner1.put(`/menu/items/${it0.id}/override`, { status: "OUT_OF_STOCK" });
    expect((await bill(owner1, [line(it0.id)])).status).toBe(400);
    expect((await bill(owner2, [line(it0.id)])).status).toBe(201);
    const m1 = (await owner1.get("/menu")).body.items.find((i: { id: string }) => i.id === it0.id);
    expect(m1.status).toBe("OUT_OF_STOCK");
  });

  it("IT-MENU-033 override equal to the global value stores no override (204); null clears; omitted keeps @regression", async () => {
    const owner = await T.owner();
    const it0 = await mkItem(T.business.id, catId, 5000);
    expect((await owner.put(`/menu/items/${it0.id}/override`, { price: 5000 })).status).toBe(204);
    expect(await db.outletItemOverride.count({ where: { menuItemId: it0.id } })).toBe(0);
    await owner.put(`/menu/items/${it0.id}/override`, { price: 6000, status: "HIDDEN" });
    const keep = await owner.put(`/menu/items/${it0.id}/override`, { price: 7000 });
    expect(keep.body).toMatchObject({ price: 7000, status: "HIDDEN" });
    const clr = await owner.put(`/menu/items/${it0.id}/override`, { price: null, status: null });
    expect(clr.status).toBe(204);
    expect(await db.outletItemOverride.count({ where: { menuItemId: it0.id } })).toBe(0);
  });

  it("IT-MENU-034 override validation: negative / fractional price and unknown status → 400 @regression", async () => {
    const owner = await T.owner();
    const it0 = await mkItem(T.business.id, catId, 5000);
    for (const b of [{ price: -1 }, { price: 10.5 }, { status: "GONE" }]) {
      expect((await owner.put(`/menu/items/${it0.id}/override`, b)).status).toBe(400);
    }
  });

  it("IT-MENU-035 global price change is picked up when there is no override @regression", async () => {
    const owner = await T.owner();
    const it0 = await mkItem(T.business.id, catId, 5000);
    expect((await owner.patch(`/menu/items/${it0.id}`, { price: 5500 })).status).toBe(200);
    const o = await bill(owner, [line(it0.id)]);
    expect(o.body.grandTotal).toBe(5500);
  });
});

describe("Menu roles & modules @regression", () => {
  it("IT-MENU-040 cashier / kitchen / inventory can view but not manage the menu @regression", async () => {
    const it0 = await mkItem(T.business.id, catId, 5000);
    for (const a of [await T.cashier(), await T.kitchen(), await T.inventory()]) {
      expect((await a.get("/menu")).status).toBe(200);
      expect((await a.get(`/menu/items/${it0.id}`)).status).toBe(200);
      expect((await a.post("/menu/items", itemBody())).status).toBe(403);
      expect((await a.patch(`/menu/items/${it0.id}`, { price: 1 })).status).toBe(403);
      expect((await a.put(`/menu/items/${it0.id}/override`, { price: 1 })).status).toBe(403);
      expect((await a.post("/menu/categories", { name: "x" })).status).toBe(403);
      expect((await a.delete(`/menu/items/${it0.id}`)).status).toBe(403);
      expect((await a.get("/menu/import/template")).status).toBe(403);
    }
    expect((await db.menuItem.findUniqueOrThrow({ where: { id: it0.id } })).price).toBe(5000);
  });

  it("IT-MENU-041 delivery partner cannot view the menu (403) @regression", async () => {
    expect((await (await T.delivery()).get("/menu")).status).toBe(403);
  });

  it("IT-MENU-042 outlet manager can manage the menu @regression", async () => {
    const mgr = await T.manager();
    expect((await mgr.post("/menu/items", itemBody())).status).toBe(201);
  });

  it("IT-MENU-043 menu works with INVENTORY only; 403 when neither BILLING nor INVENTORY is enabled @regression", async () => {
    const inv = await tenant({ modules: ["INVENTORY"] });
    expect((await (await inv.owner()).get("/menu")).status).toBe(200);
    const none = await tenant({ modules: ["ATTENDANCE"] });
    expect((await (await none.owner()).get("/menu")).status).toBe(403);
  });

  it("IT-MENU-044 no token → 401 @regression", async () => {
    expect((await request(app).get("/menu")).status).toBe(401);
  });
});

// ---------- Photos ----------
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 2)]);
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.from([0x24, 0, 0, 0]), Buffer.from("WEBPVP8 "), Buffer.alloc(64, 3)]);
const fileName = (url: string) => url.split("/uploads/files/")[1];

describe("Menu photo upload @regression", () => {
  it("IT-MENU-050 PNG / JPEG / WebP accepted by magic bytes, stored locally with the sniffed extension @regression", async () => {
    const owner = await T.owner();
    for (const [buf, ext] of [[PNG, "png"], [JPG, "jpg"], [WEBP, "webp"]] as const) {
      const res = await upload("/uploads/image", owner.token, T.outlet.id, buf, `photo.${ext}`);
      expect(res.status).toBe(201);
      expect(res.body.storage).toBe("local");
      expect(fileName(res.body.url)).toMatch(new RegExp(`\\.${ext}$`));
    }
  });

  it("IT-MENU-051 uploaded file is served publicly with the right type and X-Content-Type-Options: nosniff @regression", async () => {
    const owner = await T.owner();
    const up = await upload("/uploads/image", owner.token, T.outlet.id, PNG, "p.png");
    const got = await request(app).get(`/uploads/files/${fileName(up.body.url)}`);
    expect(got.status).toBe(200);
    expect(got.headers["content-type"]).toMatch(/^image\/png/);
    expect(got.headers["x-content-type-options"]).toBe("nosniff");
    expect(Buffer.compare(got.body as Buffer, PNG)).toBe(0);
  });

  it("IT-MENU-052 raw image/jpeg body is accepted @regression", async () => {
    const owner = await T.owner();
    const res = await request(app).post("/uploads/image").set("authorization", `Bearer ${owner.token}`).set("content-type", "image/jpeg").send(JPG);
    expect(res.status).toBe(201);
  });

  it("IT-MENU-053 SVG, plain text, HTML-named-.png and GIF are rejected with 400 @regression", async () => {
    const owner = await T.owner();
    const cases: [Buffer, string][] = [
      [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), "x.svg"],
      [Buffer.from("hello world"), "notes.txt"],
      [Buffer.from("<html><script>alert(1)</script></html>"), "fake.png"],
      [Buffer.from("GIF89a\x01\x00\x01\x00"), "anim.gif"],
      [Buffer.from("<?php system($_GET['c']); ?>"), "shell.php.png"],
    ];
    for (const [buf, name] of cases) {
      const res = await upload("/uploads/image", owner.token, T.outlet.id, buf, name);
      expect(res.status, name).toBe(400);
    }
  });

  it("IT-MENU-054 double extension with real JPEG bytes is stored under a random .jpg name (no .php) @regression", async () => {
    const owner = await T.owner();
    const res = await upload("/uploads/image", owner.token, T.outlet.id, JPG, "shell.php.jpg");
    expect(res.status).toBe(201);
    expect(fileName(res.body.url)).toMatch(/^[a-zA-Z0-9_-]+\.jpg$/);
    expect(res.body.url).not.toContain("php");
  });

  it("IT-MENU-055 PNG/HTML polyglot is served only as image/png with nosniff @regression", async () => {
    const owner = await T.owner();
    const poly = Buffer.concat([PNG.subarray(0, 8), Buffer.from("<html><script>alert(1)</script></html>")]);
    const up = await upload("/uploads/image", owner.token, T.outlet.id, poly, "poly.html");
    expect(up.status).toBe(201);
    const got = await request(app).get(`/uploads/files/${fileName(up.body.url)}`);
    expect(got.headers["content-type"]).toMatch(/^image\/png/);
    expect(got.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("IT-MENU-056 size BVA: exactly 5 MB → 201, 5 MB + 1 byte → 413 (multipart and raw) @regression", async () => {
    const owner = await T.owner();
    const max = 5 * 1024 * 1024;
    const ok = Buffer.concat([PNG.subarray(0, 8), Buffer.alloc(max - 8)]);
    const big = Buffer.concat([PNG.subarray(0, 8), Buffer.alloc(max - 7)]);
    expect((await upload("/uploads/image", owner.token, T.outlet.id, ok, "ok.png")).status).toBe(201);
    expect((await upload("/uploads/image", owner.token, T.outlet.id, big, "big.png")).status).toBe(413);
    const raw = await request(app).post("/uploads/image").set("authorization", `Bearer ${owner.token}`).set("content-type", "image/png").send(big);
    expect(raw.status).toBe(413);
  });

  it("IT-MENU-057 empty file → 400; no auth → 401 @regression", async () => {
    const owner = await T.owner();
    const empty = await request(app).post("/uploads/image").set("authorization", `Bearer ${owner.token}`).set("content-type", "image/png").send(Buffer.alloc(0));
    expect(empty.status).toBe(400);
    expect((await request(app).post("/uploads/image").attach("file", PNG, "a.png")).status).toBe(401);
  });

  it("IT-MENU-058 file serving rejects traversal / unknown names with 404 @regression", async () => {
    for (const p of ["/uploads/files/..%2F..%2Fpackage.json", "/uploads/files/abcdefgh12345.png", "/uploads/files/abcdefgh.php", "/uploads/files/x.png"]) {
      expect((await request(app).get(p)).status, p).toBe(404);
    }
  });

  it("IT-MENU-059 uploaded URL can be saved as the item photo and shows on GET /menu @regression", async () => {
    const owner = await T.owner();
    const up = await upload("/uploads/image", owner.token, T.outlet.id, PNG, "dish.png");
    const it0 = await owner.post("/menu/items", itemBody({ imageUrl: up.body.url }));
    expect(it0.status).toBe(201);
    const m = (await owner.get("/menu")).body.items.find((i: { id: string }) => i.id === it0.body.id);
    expect(m.imageUrl).toBe(up.body.url);
    const clr = await owner.patch(`/menu/items/${it0.body.id}`, { imageUrl: "" });
    expect(clr.body.imageUrl).toBeNull();
  });
});
