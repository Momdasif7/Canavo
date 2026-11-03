/**
 * QA Phase 5 — group B — Menu bulk upload (Excel template / CSV): template,
 * preview vs ?apply=1, matching, defaults, bad rows, limits, regressions.
 */
import { beforeAll, describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import { createDefaultTaxRates } from "../../src/services/tax-defaults";
import { csv, db, IMPORT_HEADERS, mkCategory, mkItem, tenant, uid, upload, xlsx, type ImportRowIn } from "./fx-b";

let T: Awaited<ReturnType<typeof tenant>>;
let token: string;
let potatoId: string;
let pavId: string;

const imp = (buf: Buffer, name = "menu.xlsx", apply = false, field = "file") =>
  upload(`/menu/import${apply ? "?apply=1" : ""}`, token, T.outlet.id, buf, name, field);
const rowsOf = (body: { rows: { name: string; action: string; errors: string[]; warnings: string[] }[] }) => body.rows;
const itemsNamed = (name: string) => db.menuItem.findMany({ where: { businessId: T.business.id, name }, include: { variants: true, category: true, recipes: true } });

beforeAll(async () => {
  T = await tenant();
  await createDefaultTaxRates(db as never, T.business.id);
  token = (await T.owner()).token;
  potatoId = (await db.inventoryItem.create({ data: { businessId: T.business.id, name: "Potato", unit: "KG", costPerUnit: 3000 } })).id;
  pavId = (await db.inventoryItem.create({ data: { businessId: T.business.id, name: "Pav", unit: "PIECE", costPerUnit: 300 } })).id;
  await mkCategory(T.business.id, "Existing Cat");
});

describe("Template @regression", () => {
  it("IT-IMP-001 template download is an .xlsx with the columns, GST rates, categories and stock items @regression", async () => {
    const owner = await T.owner();
    const res = await owner.get("/menu/import/template").buffer(true).parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on("data", (c: Buffer) => chunks.push(c));
      r.on("end", () => cb(null, Buffer.concat(chunks)));
    });
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/spreadsheetml/);
    expect(res.headers["content-disposition"]).toMatch(/canavo-menu-template\.xlsx/);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(res.body as never);
    const menu = wb.getWorksheet("Menu")!;
    const headers = (menu.getRow(1).values as unknown[]).slice(1);
    expect(headers).toEqual(IMPORT_HEADERS);
    const help: string[] = [];
    wb.getWorksheet("How to fill")!.eachRow((r) => help.push((r.values as unknown[]).slice(1).join(" | ")));
    const text = help.join("\n");
    for (const s of ["GST 0% (Exempt) | 0% (default)", "GST 18% | 18%", "Existing Cat", "Potato | unit: KG", "Pav | unit: PIECE"]) expect(text).toContain(s);
  });

  it("IT-IMP-002 the downloaded template itself uploads cleanly (3 example rows preview) @regression", async () => {
    const owner = await T.owner();
    const res = await owner.get("/menu/import/template").buffer(true).parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on("data", (c: Buffer) => chunks.push(c));
      r.on("end", () => cb(null, Buffer.concat(chunks)));
    });
    const prev = await imp(res.body as Buffer);
    expect(prev.status).toBe(200);
    expect(prev.body.summary).toMatchObject({ total: 3, error: 0 });
  });
});

describe("Preview vs apply @regression", () => {
  it("IT-IMP-010 preview (no ?apply) returns per-row New/Update/Error and saves nothing @regression", async () => {
    const name = `Prev ${uid()}`;
    const before = await db.menuItem.count({ where: { businessId: T.business.id } });
    const res = await imp(await xlsx([{ category: "Snacks", name, price: 25 }, { category: "Snacks", name: "", price: 10 }]));
    expect(res.status).toBe(200);
    expect(res.body.applied).toBe(false);
    expect(res.body.summary).toEqual({ total: 2, create: 1, update: 0, error: 1 });
    expect(rowsOf(res.body).map((r) => r.action)).toEqual(["create", "error"]);
    expect(await db.menuItem.count({ where: { businessId: T.business.id } })).toBe(before);
  });

  it("IT-IMP-011 ?apply=1 saves valid rows and skips error rows @regression", async () => {
    const good = `Good ${uid()}`;
    const res = await imp(await xlsx([{ category: "Snacks", name: good, price: 30 }, { category: "Snacks", name: `Bad ${uid()}`, price: "-5" }]), "m.xlsx", true);
    expect(res.status).toBe(200);
    expect(res.body.applied).toBe(true);
    expect(res.body.summary).toMatchObject({ create: 1, error: 1 });
    const [item] = await itemsNamed(good);
    expect(item.price).toBe(3000);
    expect(item.category.name).toBe("Snacks");
  });

  it("IT-IMP-012 .csv upload works the same as .xlsx @regression", async () => {
    const name = `Csv ${uid()}`;
    const res = await imp(csv([{ category: "Csv Cat", name, price: "45.50", foodType: "Non-veg", available: "No" }]), "menu.csv", true);
    expect(res.status).toBe(200);
    const [item] = await itemsNamed(name);
    expect(item).toMatchObject({ price: 4550, foodType: "NON_VEG", status: "OUT_OF_STOCK" });
  });

  it("IT-IMP-013 CSV with a UTF-8 BOM and Tamil / emoji names is parsed @regression", async () => {
    const name = `மசாலா ☕ ${uid()}`;
    const res = await imp(csv([{ category: "Bom Cat", name, price: 20 }], { bom: true }), "bom.csv", true);
    expect(res.status).toBe(200);
    expect(res.body.summary.create).toBe(1);
    expect(await itemsNamed(name)).toHaveLength(1);
  });

  it("IT-IMP-014 apply with only error rows → 400 \"No valid rows\" @regression", async () => {
    const res = await imp(await xlsx([{ category: "Snacks", price: 10 }]), "m.xlsx", true);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/No valid rows/);
  });
});

describe("Matching, creation and defaults @regression", () => {
  it("IT-IMP-020 category + name (case-insensitive) updates the existing item — bulk price change, no duplicate @critical @regression", async () => {
    const cat = await mkCategory(T.business.id, `Bulk ${uid()}`);
    const item = await mkItem(T.business.id, cat.id, 10000, { name: "Masala Dosa" });
    const prev = await imp(await xlsx([{ category: cat.name.toUpperCase(), name: "  masala   dosa ", price: 120 }]));
    expect(rowsOf(prev.body)[0].action).toBe("update");
    await imp(await xlsx([{ category: cat.name, name: "Masala Dosa", price: 120 }]), "m.xlsx", true);
    expect((await db.menuItem.findUniqueOrThrow({ where: { id: item.id } })).price).toBe(12000);
    expect(await db.menuItem.count({ where: { categoryId: cat.id } })).toBe(1);
  });

  it("IT-IMP-021 missing categories and sub-categories are created (sub under its parent) @regression", async () => {
    const parent = `NewParent ${uid()}`;
    const name = `Chai ${uid()}`;
    await imp(await xlsx([{ category: parent, subcategory: "Hot Beverages", name, price: 15 }]), "m.xlsx", true);
    const [item] = await itemsNamed(name);
    expect(item.category.name).toBe("Hot Beverages");
    const p = await db.menuCategory.findUniqueOrThrow({ where: { id: item.category.parentId! } });
    expect(p.name).toBe(parent);
    expect(p.parentId).toBeNull();
  });

  it("IT-IMP-022 same name in a different sub-category is a new item, not an update @regression", async () => {
    const parent = `Bev ${uid()}`;
    await imp(await xlsx([{ category: parent, subcategory: "Hot", name: "Coffee", price: 20 }]), "m.xlsx", true);
    const prev = await imp(await xlsx([{ category: parent, subcategory: "Cold", name: "Coffee", price: 40 }]));
    expect(rowsOf(prev.body)[0].action).toBe("create");
  });

  it("IT-IMP-023 Sizes \"Regular=15; Large=25\" → variants in paise; price = cheapest size @critical @regression", async () => {
    const name = `Sized ${uid()}`;
    const res = await imp(await xlsx([{ category: "Beverages", name, sizes: "Regular=15; Large=25" }]), "m.xlsx", true);
    expect(rowsOf(res.body)[0].action).toBe("create");
    const [item] = await itemsNamed(name);
    expect(item.price).toBe(1500);
    expect(item.variants.map((v) => [v.name, v.price]).sort()).toEqual([["Large", 2500], ["Regular", 1500]]);
  });

  it("IT-IMP-024 re-import with different sizes updates prices, adds new and removes dropped sizes @regression", async () => {
    const name = `Resize ${uid()}`;
    await imp(await xlsx([{ category: "Beverages", name, sizes: "Small=10; Large=25" }]), "m.xlsx", true);
    await imp(await xlsx([{ category: "Beverages", name, sizes: "Large=30; Jumbo=40" }]), "m.xlsx", true);
    const [item] = await itemsNamed(name);
    expect(item.variants.map((v) => [v.name, v.price]).sort()).toEqual([["Jumbo", 4000], ["Large", 3000]]);
  });

  it("IT-IMP-025 Ingredients \"Potato=0.08; Pav=1\" become the item's recipe @regression", async () => {
    const name = `Vada Pav ${uid()}`;
    await imp(await xlsx([{ category: "Snacks", name, price: 25, ingredients: "Potato=0.08; Pav=1" }]), "m.xlsx", true);
    const [item] = await itemsNamed(name);
    const rec = item.recipes.map((r) => [r.inventoryItemId, r.quantity, r.variantId]);
    expect(rec).toEqual(expect.arrayContaining([[potatoId, 0.08, null], [pavId, 1, null]]));
    expect(rec).toHaveLength(2);
  });

  it("IT-IMP-026 unknown ingredient / zero quantity / duplicate ingredient → error rows @regression", async () => {
    const res = await imp(await xlsx([
      { category: "Snacks", name: `I1 ${uid()}`, price: 10, ingredients: "Unobtainium=1" },
      { category: "Snacks", name: `I2 ${uid()}`, price: 10, ingredients: "Potato=0" },
      { category: "Snacks", name: `I3 ${uid()}`, price: 10, ingredients: "Potato=1; potato=2" },
    ]));
    const rows = rowsOf(res.body);
    expect(rows.map((r) => r.action)).toEqual(["error", "error", "error"]);
    expect(rows[0].errors.join()).toMatch(/not found/);
    expect(rows[2].errors.join()).toMatch(/twice/);
  });

  it("IT-IMP-027 Ingredients are ignored with a warning when the Inventory module is off @regression", async () => {
    const t = await tenant({ modules: ["BILLING"] });
    const tok = (await t.owner()).token;
    const res = await upload("/menu/import", tok, t.outlet.id, await xlsx([{ category: "S", name: "X", price: 10, ingredients: "Potato=1" }]), "m.xlsx");
    expect(res.status).toBe(200);
    expect(rowsOf(res.body)[0].action).toBe("create");
    expect(rowsOf(res.body)[0].warnings.join()).toMatch(/Inventory module is off/);
  });

  it("IT-IMP-028 blank GST = 0% (linked to the business's GST 0% rate) for new items @critical @regression", async () => {
    const name = `NoGst ${uid()}`;
    await imp(await xlsx([{ category: "Snacks", name, price: 10 }]), "m.xlsx", true);
    const [item] = await itemsNamed(name);
    const zero = await db.taxRate.findFirstOrThrow({ where: { businessId: T.business.id, name: "GST 0% (Exempt)" } });
    expect(item.gstRate).toBe(0);
    expect(item.taxRateId).toBe(zero.id);
  });

  // README: "blank GST = 0%. New items default to GST 0% everywhere, and existing items keep their rate."
  // Expected: an UPDATE row with a blank GST cell leaves the existing item's 18% rate alone.
  // Actual: planImport always resolves blank GST to the business default rate and applyImport writes it,
  // so a bulk PRICE change silently re-rates every existing item to 0% (or the default) → under-charged GST.
  it.fails("IT-IMP-029 (BUG-CANDIDATE-B3) blank GST on an UPDATE row keeps the existing item's rate @critical @regression", async () => {
    const cat = await mkCategory(T.business.id, `Gst ${uid()}`);
    const r18 = await db.taxRate.findFirstOrThrow({ where: { businessId: T.business.id, name: "GST 18%" } });
    const item = await db.menuItem.create({ data: { businessId: T.business.id, categoryId: cat.id, name: "Cola", price: 5000, gstRate: 18, taxRateId: r18.id } });
    const res = await imp(await xlsx([{ category: cat.name, name: "Cola", price: 60 }]), "m.xlsx", true);
    expect(rowsOf(res.body)[0].action).toBe("update");
    const after = await db.menuItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(after.price).toBe(6000);
    expect(after.gstRate).toBe(18);
    expect(after.taxRateId).toBe(r18.id);
  });

  it("IT-IMP-030 GST \"18\" links the 18% rate; unknown \"7\" warns and bills 7%; \"abc\" / \"150\" are errors @critical @regression", async () => {
    const a = `G18 ${uid()}`;
    const b = `G7 ${uid()}`;
    const res = await imp(await xlsx([
      { category: "Snacks", name: a, price: 10, gst: "18%" },
      { category: "Snacks", name: b, price: 10, gst: 7 },
      { category: "Snacks", name: `Gx ${uid()}`, price: 10, gst: "abc" },
      { category: "Snacks", name: `Gy ${uid()}`, price: 10, gst: 150 },
    ]), "m.xlsx", true);
    const rows = rowsOf(res.body);
    expect(rows.map((r) => r.action)).toEqual(["create", "create", "error", "error"]);
    expect(rows[1].warnings.join()).toMatch(/No GST rate of 7%/);
    const r18 = await db.taxRate.findFirstOrThrow({ where: { businessId: T.business.id, name: "GST 18%" } });
    expect((await itemsNamed(a))[0]).toMatchObject({ gstRate: 18, taxRateId: r18.id });
    expect((await itemsNamed(b))[0]).toMatchObject({ gstRate: 7, taxRateId: null });
  });

  it("IT-IMP-031 Food type / Available / station mapping (Egg, Hidden, blank station = MAIN) @regression", async () => {
    const name = `Omelette ${uid()}`;
    await imp(await xlsx([{ category: "Snacks", name, price: 40, foodType: "egg", available: "Hidden", description: "  fluffy  " }]), "m.xlsx", true);
    expect((await itemsNamed(name))[0]).toMatchObject({ foodType: "EGG", status: "HIDDEN", kitchenStation: "MAIN", description: "fluffy" });
  });

  it("IT-IMP-032 import never matches or updates another business's item with the same category + name @critical @regression", async () => {
    const other = await tenant();
    const oc = await mkCategory(other.business.id, "Shared Name Cat");
    const victim = await mkItem(other.business.id, oc.id, 7777, { name: "Shared Item" });
    const res = await imp(await xlsx([{ category: "Shared Name Cat", name: "Shared Item", price: 1 }]), "m.xlsx", true);
    expect(rowsOf(res.body)[0].action).toBe("create");
    expect((await db.menuItem.findUniqueOrThrow({ where: { id: victim.id } })).price).toBe(7777);
  });
});

describe("Bad rows and files @regression", () => {
  it("IT-IMP-040 each bad row is flagged with a reason @regression", async () => {
    const cases: [ImportRowIn, RegExp][] = [
      [{ category: "S", price: 10 }, /name is required/],
      [{ name: "No cat", price: 10 }, /Category is required/],
      [{ category: "S", name: "Neg", price: "-5" }, /isn't a valid amount/],
      [{ category: "S", name: "Nan", price: "ten" }, /isn't a valid amount/],
      [{ category: "S", name: "NoPrice" }, /Price is required/],
      [{ category: "S", name: "Huge", price: 1000001 }, /isn't a valid amount/],
      [{ category: "S", name: "BadFood", price: 10, foodType: "Vegan" }, /Food type/],
      [{ category: "S", name: "BadAvail", price: 10, available: "Maybe" }, /Available/],
      [{ category: "S", name: "BadImg", price: 10, imageUrl: "javascript:alert(1)" }, /Image URL/],
      [{ category: "S", name: "BadSize", price: 10, sizes: "Regular; Large=abc" }, /needs a price/],
      [{ category: "S", name: "DupSize", sizes: "L=1; l=2" }, /listed twice/],
      [{ category: "S", name: "n".repeat(101), price: 10 }, /longer than 100/],
    ];
    const res = await imp(await xlsx(cases.map(([r]) => r)));
    expect(res.status).toBe(200);
    rowsOf(res.body).forEach((r, i) => {
      expect(r.action, String(cases[i][1])).toBe("error");
      expect(r.errors.join(" | ")).toMatch(cases[i][1]);
    });
  });

  it("IT-IMP-041 price BVA: 0 and 1000000 rupees accepted; \"₹1,250.50\" parsed to 125050 paise @regression", async () => {
    const a = `Zero ${uid()}`;
    const c = `Comma ${uid()}`;
    const res = await imp(await xlsx([{ category: "S", name: a, price: 0 }, { category: "S", name: `Max ${uid()}`, price: 1000000 }, { category: "S", name: c, price: "₹1,250.50" }]), "m.xlsx", true);
    expect(rowsOf(res.body).map((r) => r.action)).toEqual(["create", "create", "create"]);
    expect((await itemsNamed(c))[0].price).toBe(125050);
  });

  it("IT-IMP-042 duplicate rows within the file: the second is an error, only one item saved @regression", async () => {
    const name = `Dup ${uid()}`;
    const res = await imp(await xlsx([{ category: "S", name, price: 10 }, { category: "s", name: name.toUpperCase(), price: 12 }]), "m.xlsx", true);
    expect(rowsOf(res.body).map((r) => r.action)).toEqual(["create", "error"]);
    expect(rowsOf(res.body)[1].errors.join()).toMatch(/more than once/);
    expect(await db.menuItem.count({ where: { businessId: T.business.id, name: { equals: name, mode: "insensitive" } } })).toBe(1);
  });

  it("IT-IMP-043 no file → 400; missing required column → 400; header-only sheet → 400 @regression", async () => {
    const owner = await T.owner();
    expect((await owner.post("/menu/import")).status).toBe(400);
    const noName = await imp(await xlsx([{ category: "S" }], ["Category *", "Price"]));
    expect(noName.status).toBe(400);
    expect(noName.body.error).toMatch(/Item name/);
    expect((await imp(await xlsx([]))).status).toBe(400);
  });

  it("IT-IMP-044 non-spreadsheet files are rejected with 400 (PNG, corrupt .xlsx, zip, PDF) @regression", async () => {
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200, 7)]);
    for (const [buf, name] of [
      [png, "photo.png"],
      [Buffer.from("this is not a workbook"), "menu.xlsx"],
      [Buffer.concat([Buffer.from("PK\x03\x04"), Buffer.alloc(100)]), "menu.zip"],
      [Buffer.from("%PDF-1.4\n%âãÏÓ\n1 0 obj<<>>endobj"), "menu.pdf"],
    ] as const) {
      const res = await imp(buf, name);
      expect(res.status, name).toBe(400);
    }
  });

  // Expected: an upload over the 5 MB limit is refused with 413 (as POST /uploads/image does) or 400.
  // Actual: multer's LIMIT_FILE_SIZE MulterError reaches the generic error handler → 500 "Internal server error".
  it.fails("IT-IMP-045 (BUG-CANDIDATE-B4) file over 5 MB → 413/400, not 500 @regression", async () => {
    const big = Buffer.concat([Buffer.from(IMPORT_HEADERS.join(",") + "\n"), Buffer.alloc(5 * 1024 * 1024 + 10, 0x41)]);
    const res = await imp(big, "big.csv");
    expect([400, 413]).toContain(res.status);
  });

  // Same root cause: any multer error (wrong field name, two files) → 500.
  it.fails("IT-IMP-046 (BUG-CANDIDATE-B4) upload under the wrong form field → 400, not 500 @regression", async () => {
    const res = await imp(await xlsx([{ category: "S", name: "x", price: 1 }]), "m.xlsx", false, "upload");
    expect(res.status).toBe(400);
  });

  it("IT-IMP-047 2,001 item rows → 400 (at most 2000 per upload) @regression", async () => {
    const rows = Array.from({ length: 2001 }, (_, i) => ({ category: "Big", name: `R${i}`, price: 10 }));
    const res = await imp(csv(rows), "big.csv");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/2000/);
  });

  it("IT-IMP-048 2,000-row file previews and applies in reasonable time (< 45 s) @regression", async () => {
    const tag = uid();
    const rows = Array.from({ length: 2000 }, (_, i) => ({ category: `Big ${tag} ${i % 20}`, name: `Row ${i}`, price: 10 + (i % 50), sizes: i % 3 ? "" : "S=10; L=20" }));
    const buf = await xlsx(rows);
    const t0 = Date.now();
    const prev = await imp(buf);
    expect(prev.status).toBe(200);
    expect(prev.body.summary).toMatchObject({ total: 2000, create: 2000, error: 0 });
    const app1 = await imp(buf, "m.xlsx", true);
    expect(app1.status).toBe(200);
    expect(Date.now() - t0).toBeLessThan(45_000);
    expect(await db.menuItem.count({ where: { businessId: T.business.id, category: { name: { startsWith: `Big ${tag}` } } } })).toBe(2000);
  }, 120_000);

  it("IT-IMP-049 formula-like values (=HYPERLINK, +, -, @) are stored as literal text (record; export escaping is Phase 8) @regression", async () => {
    const vals = ['=HYPERLINK("http://evil.example","click")', "+cmd|' /C calc'!A0", "@SUM(1+1)"];
    const tag = uid();
    const res = await imp(csv(vals.map((v, i) => ({ category: `Inj ${tag}`, name: `${v} ${i}`, price: 10, description: v }))), "inj.csv", true);
    expect(res.status).toBe(200);
    const saved = await db.menuItem.findMany({ where: { businessId: T.business.id, category: { name: `Inj ${tag}` } }, orderBy: { name: "asc" } });
    expect(saved).toHaveLength(3);
    for (const s of saved) expect(vals).toContain(s.description);
  });

  it("IT-IMP-050 xlsx formula cell imports its cached result, not the formula @regression", async () => {
    const name = `Formula ${uid()}`;
    const buf = await xlsx([{ category: "S", name, price: { formula: "20+5", result: 25 } as ExcelJS.CellValue }]);
    await imp(buf, "m.xlsx", true);
    expect((await itemsNamed(name))[0].price).toBe(2500);
  });

  it("IT-IMP-051 BUG-016 regression: #N/A error cells are blank, never \"[object Object]\" @regression", async () => {
    const res = await imp(await xlsx([
      { category: "S", name: { error: "#N/A" } as ExcelJS.CellValue, price: 10 },
      { category: "S", name: `Err ${uid()}`, price: { formula: "VLOOKUP(A1,B:C,2,0)", result: { error: "#REF!" } } as ExcelJS.CellValue },
    ]));
    expect(JSON.stringify(res.body)).not.toContain("[object Object]");
    const rows = rowsOf(res.body);
    expect(rows[0].errors.join()).toMatch(/name is required/);
    expect(rows[1].errors.join()).toMatch(/Price is required/);
  });

  it("IT-IMP-052 BUG-006 regression: a 200k-char Sizes cell is parsed in linear time (< 3 s) @regression", async () => {
    const evil = "a".repeat(100_000) + "=" + "b".repeat(100_000) + "=";
    const t0 = Date.now();
    const res = await imp(csv([{ category: "S", name: "ReDoS", sizes: evil, ingredients: evil }]), "redos.csv");
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(res.status).toBe(200);
    expect(rowsOf(res.body)[0].action).toBe("error");
  });

  // Expected: categories created by import obey the same 60-char limit as POST /menu/categories (categorySchema max 60).
  // Actual: import creates a category of any length (200 chars accepted, row action "create").
  it.fails("IT-IMP-053 (BUG-CANDIDATE-B5) category names longer than 60 chars are rejected by import @regression", async () => {
    const res = await imp(await xlsx([{ category: "C".repeat(200), name: `Long ${uid()}`, price: 10 }]));
    expect(rowsOf(res.body)[0].action).toBe("error");
  });

  it("IT-IMP-054 cashier cannot preview or apply an import (403) @regression", async () => {
    const cashier = await T.cashier();
    const res = await upload("/menu/import?apply=1", cashier.token, T.outlet.id, await xlsx([{ category: "S", name: "x", price: 1 }]), "m.xlsx");
    expect(res.status).toBe(403);
  });
});
