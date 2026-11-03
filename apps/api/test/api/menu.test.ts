/**
 * QA Phase 6 — /menu (categories, items, sizes, add-ons, outlet overrides, Excel/CSV bulk import)
 * and /tax-rates: status codes + shapes, the RBAC table for every role, tenant / outlet / platform
 * isolation, module gating, input validation (400 never 500, nothing written), import abuse
 * (bad rows, duplicates, formula cells, huge files, internal image URLs).
 */
import ExcelJS from "exceljs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHotel, startServer } from "../integration/helpers";
import { db, GHOST, intMoney, isolation, LONG, login, NAMES, noSecrets, rbacMatrix, rejects, world, type Ep, type World } from "./kit";

let srv: Awaited<ReturnType<typeof startServer>>;
let w: World;
let catId: string;

beforeAll(async () => {
  srv = await startServer();
  w = await world(srv.base, "Menu API");
  catId = (await db.menuCategory.findFirstOrThrow({ where: { businessId: w.h.businessId } })).id;
});
afterAll(() => srv.close());

const owner = () => w.as.BUSINESS_OWNER;
const item = (extra: Record<string, unknown> = {}) => ({ name: `Item ${Math.random().toString(36).slice(2, 7)}`, categoryId: catId, price: 2500, ...extra });

async function upload(path: string, file: Buffer | string, filename: string, field = "file", c = owner()) {
  const form = new FormData();
  form.append(field, new Blob([file]), filename);
  const r = await fetch(`${srv.base}${path}`, { method: "POST", headers: { authorization: `Bearer ${c.token}`, "x-outlet-id": w.h.outletId }, body: form });
  const text = await r.text();
  let body: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: r.status, body };
}

async function xlsx(rows: (string | number | { formula: string; result?: string })[][]) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Menu");
  ws.addRow(["Category *", "Sub-category", "Item name *", "Price (₹) *", "Sizes", "GST %", "Food type", "Kitchen station", "Description", "Image URL", "Available"]);
  for (const r of rows) ws.addRow(r);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

describe("menu: RBAC table for every role", () => {
  it("menu:view / menu:manage / settings:billing gate each endpoint", async () => {
    const id = w.h.items.chai;
    const eps: Ep[] = [
      { method: "GET", path: "/menu", perms: ["menu:view"] },
      { method: "GET", path: "/menu/tax-check", perms: ["menu:view"] },
      { method: "GET", path: `/menu/items/${id}`, perms: ["menu:view"] },
      { method: "POST", path: "/menu/categories", perms: ["menu:manage"] },
      { method: "PATCH", path: `/menu/categories/${GHOST}`, perms: ["menu:manage"] },
      { method: "DELETE", path: `/menu/categories/${GHOST}`, perms: ["menu:manage"] },
      { method: "POST", path: "/menu/items", perms: ["menu:manage"] },
      { method: "PATCH", path: `/menu/items/${GHOST}`, perms: ["menu:manage"] },
      { method: "DELETE", path: `/menu/items/${GHOST}`, perms: ["menu:manage"] },
      { method: "PUT", path: `/menu/items/${GHOST}/override`, perms: ["menu:manage"] },
      { method: "GET", path: "/menu/import/template", perms: ["menu:manage"] },
      { method: "POST", path: "/menu/import", perms: ["menu:manage"] },
      { method: "GET", path: "/tax-rates", perms: ["menu:view", "settings:billing"], any: true },
      { method: "GET", path: `/tax-rates/${GHOST}`, perms: ["menu:view", "settings:billing"], any: true },
      { method: "POST", path: "/tax-rates", perms: ["settings:billing"] },
      { method: "PATCH", path: `/tax-rates/${GHOST}`, perms: ["settings:billing"] },
      { method: "DELETE", path: `/tax-rates/${GHOST}`, perms: ["settings:billing"] },
    ];
    await rbacMatrix(w, eps);
  });

  it("another hotel, an unassigned outlet and the super admin get nothing", async () => {
    const rate = (await db.taxRate.findFirstOrThrow({ where: { businessId: w.h.businessId } })).id;
    const id = w.h.items.chai;
    await isolation(w, [
      { method: "GET", path: `/menu/items/${id}` },
      { method: "PATCH", path: `/menu/items/${id}`, body: { price: 1 } },
      { method: "DELETE", path: `/menu/items/${id}` },
      { method: "PUT", path: `/menu/items/${id}/override`, body: { price: 1 } },
      { method: "PATCH", path: `/menu/categories/${catId}`, body: { name: "Hacked" } },
      { method: "DELETE", path: `/menu/categories/${catId}` },
      { method: "GET", path: `/tax-rates/${rate}` },
      { method: "PATCH", path: `/tax-rates/${rate}`, body: { name: "Hacked" } },
      { method: "DELETE", path: `/tax-rates/${rate}` },
    ]);
    // Hotel A's data unchanged
    expect((await db.menuItem.findUniqueOrThrow({ where: { id } })).price).toBe(1500);
    expect((await db.menuCategory.findUniqueOrThrow({ where: { id: catId } })).name).toBe("Snacks");
    // The other hotel's menu never lists hotel A's items
    const theirs = await w.other.owner.call("GET", "/menu");
    expect(theirs.body.items.map((i: { id: string }) => i.id)).not.toContain(id);
  });

  it("menu is refused when neither BILLING nor INVENTORY is on; tax rates stay a settings page", async () => {
    const off = await createHotel("Menu off", { modules: ["ATTENDANCE"] });
    const c = await login(srv.base, off.users.owner.email, off.outletId);
    expect((await c.call("GET", "/menu")).status).toBe(403);
    expect((await c.call("POST", "/menu/items", item())).status).toBe(403);
    expect((await c.call("GET", "/tax-rates")).status).toBe(200);
  });
});

describe("categories", () => {
  it("create / rename / delete with unicode, and mass-assigned businessId is ignored", async () => {
    for (const name of NAMES) {
      const r = await owner().call("POST", "/menu/categories", { name: name.slice(0, 60), businessId: w.other.h.businessId, id: "chosen-id" });
      expect(r.status, JSON.stringify(r.body)).toBe(201);
      expect(r.body.name).toBe(name.slice(0, 60));
      expect(r.body.businessId).toBe(w.h.businessId);
      expect(r.body.id).not.toBe("chosen-id");
    }
    const c = (await owner().call("POST", "/menu/categories", { name: "Temp" })).body;
    expect((await owner().call("PATCH", `/menu/categories/${c.id}`, { name: "Temp 2" })).body.name).toBe("Temp 2");
    expect((await owner().call("DELETE", `/menu/categories/${c.id}`)).status).toBe(204);
    expect((await owner().call("DELETE", `/menu/categories/${c.id}`)).status).toBe(404);
    expect((await owner().call("PATCH", `/menu/categories/${GHOST}`, { name: "x" })).status).toBe(404);
  });

  it("a category with items can't be deleted", async () => {
    const r = await owner().call("DELETE", `/menu/categories/${catId}`);
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/item/);
  });

  it("validation: 400 and nothing written", async () => {
    const before = await db.menuCategory.count({ where: { businessId: w.h.businessId } });
    await rejects(owner(), "POST", "/menu/categories", [{}, { name: "" }, { name: null }, { name: 5 }, { name: LONG }, { name: "A", sortOrder: 1.5 }, { name: "A", sortOrder: "1" }, [], "x"]);
    expect(await db.menuCategory.count({ where: { businessId: w.h.businessId } })).toBe(before);
  });

  it("qac-1: parentId of ANOTHER hotel's category is refused (no cross-tenant links)", async () => {
    const theirs = (await db.menuCategory.findFirstOrThrow({ where: { businessId: w.other.h.businessId } })).id;
    const r = await owner().call("POST", "/menu/categories", { name: "Leech", parentId: theirs });
    expect(r.status).toBe(400);
    const p = await owner().call("PATCH", `/menu/categories/${catId}`, { parentId: theirs });
    expect(p.status).toBe(400);
    expect(await db.menuCategory.count({ where: { parentId: theirs, businessId: w.h.businessId } })).toBe(0);
  });
});

describe("items", () => {
  it("create → 201 with integer money, sizes and add-ons; GET by id; no secrets", async () => {
    const r = await owner().call("POST", "/menu/items", item({ variants: [{ name: "Small", price: 2000 }, { name: "Large", price: 3500 }], addons: [{ name: "Cheese", price: 1000 }] }));
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    intMoney(r.body, ["price"]);
    expect(r.body.variants).toHaveLength(2);
    expect(r.body.addons[0]).toMatchObject({ name: "Cheese", price: 1000 });
    for (const v of r.body.variants) intMoney(v, ["price"]);
    const g = await owner().call("GET", `/menu/items/${r.body.id}`);
    expect(g.status).toBe(200);
    expect(g.body.id).toBe(r.body.id);
    noSecrets(g.body);
    const menu = await w.as.CASHIER.call("GET", "/menu");
    expect(menu.status).toBe(200);
    noSecrets(menu.body);
    const row = menu.body.items.find((i: { id: string }) => i.id === r.body.id);
    intMoney(row, ["price", "basePrice"]);
  });

  it("unicode / emoji / SQL / XSS names are stored and returned verbatim", async () => {
    for (const name of NAMES) {
      const r = await owner().call("POST", "/menu/items", item({ name }));
      expect(r.status).toBe(201);
      expect((await owner().call("GET", `/menu/items/${r.body.id}`)).body.name).toBe(name);
    }
    expect(await db.menuItem.count()).toBeGreaterThan(0); // table still there
  });

  it("mass assignment: businessId / id / gstRate-with-taxRate smuggled in the body are ignored", async () => {
    const r = await owner().call("POST", "/menu/items", { ...item(), businessId: w.other.h.businessId, id: "mine", createdAt: "2000-01-01T00:00:00Z" });
    expect(r.status).toBe(201);
    expect(r.body.businessId).toBe(w.h.businessId);
    expect(r.body.id).not.toBe("mine");
    expect(r.body.createdAt.startsWith("2000")).toBe(false);
  });

  it("validation: wrong types, negatives, floats, oversize, nulls → 400, nothing written", async () => {
    const before = await db.menuItem.count({ where: { businessId: w.h.businessId } });
    await rejects(owner(), "POST", "/menu/items", [
      {},
      { ...item(), name: "" },
      { ...item(), name: LONG },
      { ...item(), description: LONG },
      { ...item(), price: -1 },
      { ...item(), price: 12.5 },
      { ...item(), price: "100" },
      { ...item(), price: null },
      { ...item(), categoryId: null },
      { ...item(), foodType: "MEAT" },
      { ...item(), status: "SOLD" },
      { ...item(), gstRate: 101 },
      { ...item(), availableFrom: "25:00" },
      { ...item(), hsnCode: "123456789" },
      { ...item(), variants: [{ name: "S", price: -5 }] },
      { ...item(), variants: [{ name: "S", price: 1.5 }] },
      { ...item(), addons: [{ name: "", price: 5 }] },
      { ...item(), imageUrl: "not a url" },
    ]);
    expect(await db.menuItem.count({ where: { businessId: w.h.businessId } })).toBe(before);
  });

  it("qac-2: amounts beyond the 32-bit money column → 400, not 500", async () => {
    const before = await db.menuItem.count({ where: { businessId: w.h.businessId } });
    await rejects(owner(), "POST", "/menu/items", [
      { ...item(), price: 1e13 },
      { ...item(), price: 2 ** 31 },
      { ...item(), variants: [{ name: "L", price: 3e9 }] },
      { ...item(), addons: [{ name: "A", price: 3e9 }] },
    ]);
    await rejects(owner(), "PUT", `/menu/items/${w.h.items.chai}/override`, [{ price: 3e9 }]);
    await rejects(owner(), "PATCH", `/menu/items/${w.h.items.chai}`, [{ price: 3e9 }]);
    expect(await db.menuItem.count({ where: { businessId: w.h.businessId } })).toBe(before);
  });

  it("qac-1: categoryId of another hotel / of nothing → 400, never linked across tenants", async () => {
    const theirs = (await db.menuCategory.findFirstOrThrow({ where: { businessId: w.other.h.businessId } })).id;
    const before = await db.menuItem.count({ where: { categoryId: theirs } });
    await rejects(owner(), "POST", "/menu/items", [{ ...item(), categoryId: theirs }, { ...item(), categoryId: GHOST }]);
    await rejects(owner(), "PATCH", `/menu/items/${w.h.items.samosa}`, [{ categoryId: theirs }, { categoryId: GHOST }]);
    expect(await db.menuItem.count({ where: { categoryId: theirs } })).toBe(before);
  });

  it("qac-3: image URLs must be http(s) to a public host (no internal / metadata / javascript: links)", async () => {
    const bad = [
      "http://169.254.169.254/latest/meta-data/iam",
      "http://127.0.0.1:4000/admin",
      "http://localhost/x.png",
      "http://10.0.0.5/x.png",
      "http://192.168.1.10/x.png",
      "http://172.16.0.1/x.png",
      "http://[::1]/x.png",
      "http://0.0.0.0/x.png",
      "http://metadata.google.internal/computeMetadata/v1/",
      "javascript:alert(1)",
      "file:///etc/passwd",
      "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=",
    ];
    await rejects(owner(), "POST", "/menu/items", bad.map((imageUrl) => ({ ...item(), imageUrl })));
    await rejects(owner(), "PATCH", `/menu/items/${w.h.items.chai}`, bad.map((imageUrl) => ({ imageUrl })));
    const ok = await owner().call("POST", "/menu/items", item({ imageUrl: "https://res.cloudinary.com/demo/image/upload/sample.jpg" }));
    expect(ok.status).toBe(201);
    const clear = await owner().call("PATCH", `/menu/items/${ok.body.id}`, { imageUrl: "" });
    expect(clear.body.imageUrl).toBeNull();
  });

  it("PATCH replaces sizes; unknown ids → 404", async () => {
    const r = (await owner().call("POST", "/menu/items", item({ variants: [{ name: "S", price: 100 }] }))).body;
    const p = await owner().call("PATCH", `/menu/items/${r.id}`, { variants: [{ name: "M", price: 200 }, { name: "L", price: 300 }] });
    expect(p.status).toBe(200);
    expect(p.body.variants.map((v: { name: string }) => v.name).sort()).toEqual(["L", "M"]);
    expect((await owner().call("PATCH", `/menu/items/${GHOST}`, { price: 5 })).status).toBe(404);
    expect((await owner().call("GET", `/menu/items/${GHOST}`)).status).toBe(404);
    expect((await owner().call("DELETE", `/menu/items/${GHOST}`)).status).toBe(404);
  });

  it("outlet override: price/status per outlet, other outlet unaffected, equal-to-base clears", async () => {
    const id = (await owner().call("POST", "/menu/items", item({ price: 5000 }))).body.id;
    const o = await owner().call("PUT", `/menu/items/${id}/override`, { price: 4500, status: "OUT_OF_STOCK" });
    expect(o.status).toBe(200);
    const m1 = (await owner().call("GET", "/menu")).body.items.find((i: { id: string }) => i.id === id);
    expect(m1).toMatchObject({ price: 4500, basePrice: 5000, status: "OUT_OF_STOCK", hasOverride: true });
    const m2 = (await w.owner2.call("GET", "/menu")).body.items.find((i: { id: string }) => i.id === id);
    expect(m2).toMatchObject({ price: 5000, status: "AVAILABLE", hasOverride: false });
    await rejects(owner(), "PUT", `/menu/items/${id}/override`, [{ price: -1 }, { price: 1.5 }, { status: "GONE" }]);
    expect((await owner().call("PUT", `/menu/items/${id}/override`, { price: 5000, status: "AVAILABLE" })).status).toBe(204);
    expect(await db.outletItemOverride.count({ where: { menuItemId: id } })).toBe(0);
  });

  it("DELETE: unsold item is removed, sold item is hidden (invoice history kept)", async () => {
    const fresh = (await owner().call("POST", "/menu/items", item())).body.id;
    expect((await owner().call("DELETE", `/menu/items/${fresh}`)).status).toBe(204);
    expect((await owner().call("GET", `/menu/items/${fresh}`)).status).toBe(404);
    const sold = (await owner().call("POST", "/menu/items", item())).body.id;
    expect((await owner().call("POST", "/orders", { orderType: "TAKEAWAY", items: [{ menuItemId: sold, quantity: 1 }] })).status).toBe(201);
    expect((await owner().call("DELETE", `/menu/items/${sold}`)).status).toBe(204);
    expect((await owner().call("GET", `/menu/items/${sold}`)).body.status).toBe("HIDDEN");
  });

  it("tax-check answers for a non-GST outlet", async () => {
    const r = await owner().call("GET", "/menu/tax-check");
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ applies: false, zeroRated: [] });
  });
});

describe("bulk import (Excel / CSV)", () => {
  it("template downloads as .xlsx", async () => {
    const r = await fetch(`${srv.base}/menu/import/template`, { headers: { authorization: `Bearer ${owner().token}`, "x-outlet-id": w.h.outletId } });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("spreadsheetml");
    expect(r.headers.get("content-disposition")).toContain(".xlsx");
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await r.arrayBuffer());
    expect(wb.getWorksheet("Menu")).toBeTruthy();
  });

  it("preview flags bad rows and duplicates and writes nothing; apply saves only the valid rows", async () => {
    const buf = await xlsx([
      ["Bulk", "", "Good One", 30, "", "5", "Veg", "", "", "", "Yes"],
      ["Bulk", "", "", 30],
      ["", "", "No Category", 30],
      ["Bulk", "", "Bad Price", "abc"],
      ["Bulk", "", "Negative", "-5"],
      ["Bulk", "", "Too Rich", "99999999"],
      ["Bulk", "", "Good One", 35],
      ["Bulk", "", "Bad Food", 20, "", "", "Meat"],
      ["Bulk", "", "Bad GST", 20, "", "500"],
      ["Bulk", "", "Sizes", "", "Small=10; Large=abc"],
      ["Bulk", "", "தமிழ் உணவு 🍛", 40],
    ]);
    const before = await db.menuItem.count({ where: { businessId: w.h.businessId } });
    const p = await upload("/menu/import", buf, "menu.xlsx");
    expect(p.status, JSON.stringify(p.body)).toBe(200);
    expect(p.body.applied).toBe(false);
    const byName = (n: string) => p.body.rows.filter((r: { name: string }) => r.name === n);
    expect(byName("Good One").map((r: { action: string }) => r.action)).toEqual(["create", "error"]);
    expect(byName("Good One")[1].errors.join()).toMatch(/more than once/);
    for (const n of ["Bad Price", "Negative", "Too Rich", "Bad Food", "Bad GST", "Sizes"]) expect(byName(n)[0].action, n).toBe("error");
    expect(p.body.rows.find((r: { row: number }) => r.row === 3).errors.join()).toMatch(/name is required/);
    expect(await db.menuItem.count({ where: { businessId: w.h.businessId } })).toBe(before);

    const a = await upload("/menu/import?apply=1", buf, "menu.xlsx");
    expect(a.status).toBe(200);
    expect(a.body.summary.create).toBe(2);
    expect(await db.menuItem.count({ where: { businessId: w.h.businessId } })).toBe(before + 2);
    expect(await db.menuItem.findFirst({ where: { businessId: w.h.businessId, name: "தமிழ் உணவு 🍛" } })).toBeTruthy();
    // Same sheet again: the valid row now updates (no duplicate item)
    const again = await upload("/menu/import?apply=1", buf, "menu.xlsx");
    expect(again.body.summary.update).toBe(2);
    expect(await db.menuItem.count({ where: { businessId: w.h.businessId } })).toBe(before + 2);
  });

  it("formula cells are taken as their cached value; formula-looking text is stored inert", async () => {
    const buf = await xlsx([
      ["Formula", "", { formula: "1+1", result: "Calc Item" }, 10],
      ["Formula", "", "=HYPERLINK(\"http://evil.example\",\"click\")", 10],
      ["Formula", "", "+cmd|' /C calc'!A0", 10],
      ["Formula", "", "@SUM(1,2)", 10],
    ]);
    const a = await upload("/menu/import?apply=1", buf, "menu.xlsx");
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    const names = (await db.menuItem.findMany({ where: { businessId: w.h.businessId, category: { name: "Formula" } }, select: { name: true } })).map((i) => i.name).sort();
    expect(names).toContain("Calc Item");
    expect(names).toContain("=HYPERLINK(\"http://evil.example\",\"click\")");
    // JSON returns the literal text (inert); spreadsheet exports must escape it (see reports.test.ts)
  });

  it("qac-3: image URLs to internal hosts are refused per row", async () => {
    const buf = await xlsx([
      ["Img", "", "Meta", 10, "", "", "", "", "", "http://169.254.169.254/latest/meta-data/"],
      ["Img", "", "Local", 10, "", "", "", "", "", "http://127.0.0.1:4000/x.png"],
      ["Img", "", "Fine", 10, "", "", "", "", "", "https://images.example.com/x.png"],
    ]);
    const p = await upload("/menu/import", buf, "menu.xlsx");
    const act = Object.fromEntries(p.body.rows.map((r: { name: string; action: string }) => [r.name, r.action]));
    expect(act).toEqual({ Meta: "error", Local: "error", Fine: "create" });
  });

  it("CSV works; garbage, empty, header-less, missing file and wrong field → 400", async () => {
    const csv = "Category,Item name,Price\nCsv,Idli,20\nCsv,Vada,15\n";
    const r = await upload("/menu/import", csv, "menu.csv");
    expect(r.status).toBe(200);
    expect(r.body.summary.create).toBe(2);
    expect((await upload("/menu/import", Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]), "menu.xlsx")).status).toBe(400);
    expect((await upload("/menu/import", "Category,Item name,Price\n", "menu.csv")).status).toBe(400);
    expect((await upload("/menu/import", "foo,bar\n1,2\n", "menu.csv")).status).toBe(400);
    expect((await upload("/menu/import", csv, "menu.csv", "notfile")).status).toBe(400);
    const none = await fetch(`${srv.base}/menu/import`, { method: "POST", headers: { authorization: `Bearer ${owner().token}`, "x-outlet-id": w.h.outletId } });
    expect(none.status).toBe(400);
  });

  it("qac-4: a file over 5 MB → 413, more than 2000 rows → 400 (never 500)", async () => {
    const big = Buffer.alloc(5 * 1024 * 1024 + 10, "a");
    const r = await upload("/menu/import", big, "menu.csv");
    expect(r.status).toBe(413);
    const many = "Category,Item name,Price\n" + Array.from({ length: 2001 }, (_, i) => `Many,Item ${i},10`).join("\n");
    const m = await upload("/menu/import", many, "menu.csv");
    expect(m.status).toBe(400);
    expect(m.body.error).toMatch(/2000/);
  });

  it("only menu managers may import", async () => {
    const csv = "Category,Item name,Price\nCsv,Idli,20\n";
    for (const role of ["CASHIER", "KITCHEN", "INVENTORY_MANAGER", "ACCOUNTANT", "AUDITOR", "WAITER"] as const) {
      expect((await upload("/menu/import?apply=1", csv, "m.csv", "file", w.as[role])).status, role).toBe(403);
    }
  });
});

describe("tax rates", () => {
  it("CRUD with shapes; duplicate name (any case) → 409; unknown → 404", async () => {
    const r = await owner().call("POST", "/tax-rates", { name: "GST 18 qa", cgst: 9, sgst: 9 });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ name: "GST 18 qa", cgst: 9, sgst: 9, igst: 18, itemCount: 0 });
    expect((await owner().call("POST", "/tax-rates", { name: "gst 18 QA", cgst: 9, sgst: 9 })).status).toBe(409);
    expect((await w.as.CASHIER.call("GET", `/tax-rates/${r.body.id}`)).status).toBe(200);
    const p = await w.as.OUTLET_MANAGER.call("PATCH", `/tax-rates/${r.body.id}`, { cgst: 6, sgst: 6 });
    expect(p.body.igst).toBe(12);
    const warn = await owner().call("POST", "/tax-rates", { name: "Odd", cgst: 2, sgst: 3 });
    expect(warn.body.warnings?.length).toBeGreaterThan(0);
    expect((await owner().call("GET", `/tax-rates/${GHOST}`)).status).toBe(404);
    expect((await owner().call("PATCH", `/tax-rates/${GHOST}`, { name: "x" })).status).toBe(404);
    expect((await owner().call("DELETE", `/tax-rates/${GHOST}`)).status).toBe(404);
    expect((await owner().call("DELETE", `/tax-rates/${r.body.id}`)).status).toBe(204);
  });

  it("validation → 400, nothing written", async () => {
    const before = await db.taxRate.count({ where: { businessId: w.h.businessId } });
    await rejects(owner(), "POST", "/tax-rates", [
      {},
      { name: "", cgst: 1, sgst: 1 },
      { name: LONG, cgst: 1, sgst: 1 },
      { name: "N", cgst: -1, sgst: 1 },
      { name: "N", cgst: 101, sgst: 1 },
      { name: "N", cgst: 1.0001, sgst: 1 },
      { name: "N", cgst: "9", sgst: 9 },
      { name: "N", cgst: 9, sgst: 9, extras: Array.from({ length: 11 }, (_, i) => ({ label: `x${i}`, percent: 1 })) },
      { name: "N", cgst: 9, sgst: 9, extras: [{ label: "x", percent: 0 }] },
      { name: "N", cgst: 9, sgst: 9, isDefault: true, active: false },
    ]);
    expect(await db.taxRate.count({ where: { businessId: w.h.businessId } })).toBe(before);
  });

  it("a rate in use can't be deleted without reassignTo (409); the default can't be unset", async () => {
    const used = (await owner().call("POST", "/tax-rates", { name: "Used qa", cgst: 2.5, sgst: 2.5 })).body;
    const target = (await owner().call("POST", "/tax-rates", { name: "Target qa", cgst: 6, sgst: 6 })).body;
    await owner().call("PATCH", `/menu/items/${w.h.items.biryani}`, { taxRateId: used.id });
    const d = await owner().call("DELETE", `/tax-rates/${used.id}`);
    expect(d.status).toBe(409);
    expect(d.body.details.itemCount).toBe(1);
    expect((await owner().call("DELETE", `/tax-rates/${used.id}?reassignTo=${used.id}`)).status).toBe(400);
    expect((await owner().call("DELETE", `/tax-rates/${used.id}?reassignTo=${GHOST}`)).status).toBe(404);
    expect((await owner().call("DELETE", `/tax-rates/${used.id}?reassignTo=${target.id}`)).status).toBe(204);
    const bi = await db.menuItem.findUniqueOrThrow({ where: { id: w.h.items.biryani } });
    expect(bi).toMatchObject({ taxRateId: target.id, gstRate: 12 });
    const def = await db.taxRate.findFirstOrThrow({ where: { businessId: w.h.businessId, isDefault: true } });
    expect((await owner().call("PATCH", `/tax-rates/${def.id}`, { isDefault: false })).status).toBe(400);
    expect((await owner().call("DELETE", `/tax-rates/${def.id}`)).status).toBe(409);
    // Another hotel's rate id can't be used to reassign
    const theirs = await db.taxRate.findFirstOrThrow({ where: { businessId: w.other.h.businessId } });
    expect((await owner().call("DELETE", `/tax-rates/${target.id}?reassignTo=${theirs.id}`)).status).toBe(404);
    expect((await owner().call("POST", "/menu/items", item({ taxRateId: theirs.id }))).status).toBe(400);
  });
});
