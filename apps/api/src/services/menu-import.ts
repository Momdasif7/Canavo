import { Readable } from "node:stream";
import ExcelJS from "exceljs";
import type { TaxRate } from "@prisma/client";
import { effectiveGstRate, roundRate, taxFromRate, toPaise } from "@canavo/shared";
import { prisma } from "../db";
import { badRequest } from "../lib/http";
import { moduleEnabled, requireBusinessId } from "../lib/tenant";
import { defaultTaxRate } from "./tax";

/**
 * Bulk menu import from the Excel template (or a CSV with the same columns).
 * Rows are matched to existing items by category + item name (case-insensitive):
 * a match is updated, anything else is created. Missing categories are created.
 */

export const IMPORT_COLUMNS = [
  { key: "category", header: "Category *", width: 18, note: "e.g. Snacks. Created if it doesn't exist." },
  { key: "subcategory", header: "Sub-category", width: 18, note: "Optional, e.g. Hot Beverages under Beverages." },
  { key: "name", header: "Item name *", width: 26, note: "Same category + name as an existing item = that item is updated." },
  { key: "price", header: "Price (₹) *", width: 11, note: "Menu price in rupees, e.g. 30 or 32.50. Optional when Sizes are given." },
  { key: "sizes", header: "Sizes", width: 26, note: "Optional. Size=price pairs separated by ; e.g. Regular=15; Large=25" },
  { key: "gst", header: "GST %", width: 8, note: "0, 5, 12, 18 or 28 (or one of your custom rates). Blank = 0." },
  { key: "foodType", header: "Food type", width: 11, note: "Veg, Non-veg or Egg. Blank = Veg." },
  { key: "station", header: "Kitchen station", width: 15, note: "Which kitchen screen gets the ticket, e.g. MAIN or BEVERAGE. Blank = MAIN." },
  { key: "description", header: "Description", width: 30, note: "Optional." },
  { key: "imageUrl", header: "Image URL", width: 30, note: "Optional https link to a photo. You can also upload photos later in the menu." },
  { key: "available", header: "Available", width: 10, note: "Yes, No (out of stock) or Hidden. Blank = Yes." },
  { key: "ingredients", header: "Ingredients (stock used per item)", width: 36, note: "Optional. Stock item=quantity per 1 sold, in the stock item's unit, separated by ; e.g. Potato=0.08; Pav=1" },
] as const;

type ColKey = (typeof IMPORT_COLUMNS)[number]["key"];
type RawRow = Partial<Record<ColKey, string>>;

export interface ImportRow {
  row: number;
  category: string;
  subcategory: string | null;
  name: string;
  action: "create" | "update" | "error";
  price: number | null;
  sizes: { name: string; price: number }[];
  gstRate: number | null;
  errors: string[];
  warnings: string[];
}

export interface ImportResult {
  summary: { total: number; create: number; update: number; error: number };
  rows: ImportRow[];
  applied: boolean;
}

// ---------------------------------------------------------------------------
// Template
// ---------------------------------------------------------------------------

export async function buildTemplate(): Promise<Buffer> {
  const [stock, rates, cats] = await Promise.all([
    prisma.inventoryItem.findMany({ where: { active: true }, select: { name: true, unit: true }, orderBy: { name: "asc" } }),
    prisma.taxRate.findMany({ where: { active: true }, orderBy: { createdAt: "asc" } }),
    prisma.menuCategory.findMany({ select: { name: true, parentId: true }, orderBy: { name: "asc" } }),
  ]);
  const wb = new ExcelJS.Workbook();
  wb.creator = "CANAVO";
  const ws = wb.addWorksheet("Menu", { views: [{ state: "frozen", ySplit: 1 }] });
  ws.columns = IMPORT_COLUMNS.map((c) => ({ header: c.header, key: c.key, width: c.width }));
  const head = ws.getRow(1);
  head.font = { bold: true, color: { argb: "FFFFFFFF" } };
  head.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF26B3A" } };
  head.height = 22;
  IMPORT_COLUMNS.forEach((c, i) => (ws.getCell(1, i + 1).note = c.note));
  const examples: RawRow[] = [
    { category: "Snacks", name: "Vada Pav", price: "25", gst: "0", foodType: "Veg", station: "MAIN", description: "Mumbai style", available: "Yes", ingredients: stock[0] ? `${stock[0].name}=1` : "" },
    { category: "Beverages", subcategory: "Hot Beverages", name: "Masala Chai", sizes: "Regular=15; Large=25", gst: "5", foodType: "Veg", station: "BEVERAGE", available: "Yes" },
    { category: "Meals", name: "Chicken Biryani", price: "160", gst: "5", foodType: "Non-veg", station: "MAIN", available: "Yes" },
  ];
  for (const e of examples) ws.addRow(e).font = { color: { argb: "FF6B7280" }, italic: true };
  // Dropdowns for the fixed-choice columns (first 1000 rows)
  const col = (k: ColKey) => IMPORT_COLUMNS.findIndex((c) => c.key === k) + 1;
  for (let r = 2; r <= 1000; r++) {
    ws.getCell(r, col("foodType")).dataValidation = { type: "list", allowBlank: true, formulae: ['"Veg,Non-veg,Egg"'] };
    ws.getCell(r, col("available")).dataValidation = { type: "list", allowBlank: true, formulae: ['"Yes,No,Hidden"'] };
  }

  const help = wb.addWorksheet("How to fill");
  help.columns = [{ width: 34 }, { width: 90 }];
  const add = (a: string, b = "", bold = false) => {
    const row = help.addRow([a, b]);
    if (bold) row.font = { bold: true };
  };
  add("CANAVO menu upload", "", true);
  add("1.", "Fill one row per menu item on the Menu sheet. Delete the 3 grey example rows (or overwrite them).");
  add("2.", "Columns marked * are required. Point at a column header for help.");
  add("3.", "Upload the file in Menu → Bulk upload. You'll see a preview with any problems before anything is saved.");
  add("4.", "Rows whose Category + Item name already exist update that item (price, GST, sizes…), so you can also use this sheet to change prices in bulk.");
  add("");
  add("Columns", "", true);
  for (const c of IMPORT_COLUMNS) add(c.header, c.note);
  add("");
  add("Your GST rates", "", true);
  for (const r of rates) add(r.name, `${roundRate(effectiveGstRate(taxFromRate(r)))}%${r.isDefault ? " (default)" : ""}`);
  add("");
  add("Your categories", "", true);
  add(cats.filter((c) => !c.parentId).map((c) => c.name).join(", ") || "None yet: they're created from the sheet.");
  if (stock.length) {
    add("");
    add("Your stock items (for Ingredients)", "", true);
    for (const s of stock) add(s.name, `unit: ${s.unit}`);
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

function cellText(v: ExcelJS.CellValue): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") {
    if (v instanceof Date) return v.toISOString();
    if ("richText" in v) return v.richText.map((t) => t.text).join("");
    if ("text" in v && typeof v.text === "string") return v.text; // hyperlink
    if ("result" in v) return v.result === undefined || v.result === null ? "" : String(v.result); // formula
    if ("hyperlink" in v) return String(v.hyperlink);
  }
  return String(v);
}

/** Map a header cell to a column key (tolerates missing "*", "(₹)", case). */
function headerKey(text: string): ColKey | null {
  const t = norm(text).replace(/[*()₹]/g, "").replace(/\s+/g, " ").trim();
  for (const c of IMPORT_COLUMNS) {
    const h = norm(c.header).replace(/[*()₹]/g, "").replace(/\s+/g, " ").trim();
    if (t === h || t === c.key.toLowerCase() || (c.key === "ingredients" && t.startsWith("ingredients")) || (c.key === "price" && t === "price")) return c.key;
  }
  return null;
}

export async function parseSheet(buf: Buffer, filename: string): Promise<{ rows: { row: number; data: RawRow }[] }> {
  const wb = new ExcelJS.Workbook();
  const isCsv = /\.csv$/i.test(filename) || (!buf.subarray(0, 2).equals(Buffer.from("PK")) && !/\.xlsx$/i.test(filename));
  try {
    if (isCsv) await wb.csv.read(Readable.from(buf.toString("utf8").replace(/^﻿/, "")));
    else await wb.xlsx.load(buf as unknown as ArrayBuffer);
  } catch {
    throw badRequest("Couldn't read the file. Upload the CANAVO template as .xlsx, or a .csv with the same columns.");
  }
  const ws = wb.getWorksheet("Menu") ?? wb.worksheets[0];
  if (!ws) throw badRequest("The file has no sheets");
  const keys: (ColKey | null)[] = [];
  ws.getRow(1).eachCell({ includeEmpty: true }, (cell, n) => (keys[n] = headerKey(cellText(cell.value))));
  for (const required of ["category", "name"] as const) {
    if (!keys.includes(required)) throw badRequest(`Column "${IMPORT_COLUMNS.find((c) => c.key === required)!.header}" is missing. Use the CANAVO template.`);
  }
  const rows: { row: number; data: RawRow }[] = [];
  ws.eachRow({ includeEmpty: false }, (r, n) => {
    if (n === 1) return;
    const data: RawRow = {};
    r.eachCell({ includeEmpty: true }, (cell, c) => {
      const k = keys[c];
      if (k) data[k] = cellText(cell.value).trim();
    });
    if (Object.values(data).some((v) => v)) rows.push({ row: n, data });
  });
  if (rows.length > 2000) throw badRequest("At most 2000 rows per upload");
  return { rows };
}

// ---------------------------------------------------------------------------
// Validation + apply
// ---------------------------------------------------------------------------

const rupees = (s: string): number | null => {
  const v = Number(s.replace(/[₹,\s]/g, ""));
  return Number.isFinite(v) && v >= 0 && v <= 1_000_000 ? toPaise(v) : null;
};

function pairs(s: string): { key: string; value: string }[] {
  return s
    .split(/[;\n]/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const m = p.match(/^(.*?)\s*[=:]\s*([^=:]+)$/);
      return m ? { key: m[1].trim(), value: m[2].trim() } : { key: p, value: "" };
    });
}

const FOOD: Record<string, "VEG" | "NON_VEG" | "EGG"> = { veg: "VEG", vegetarian: "VEG", "non-veg": "NON_VEG", "non veg": "NON_VEG", nonveg: "NON_VEG", non_veg: "NON_VEG", egg: "EGG" };
const STATUS: Record<string, "AVAILABLE" | "OUT_OF_STOCK" | "HIDDEN"> = { yes: "AVAILABLE", y: "AVAILABLE", available: "AVAILABLE", no: "OUT_OF_STOCK", n: "OUT_OF_STOCK", "out of stock": "OUT_OF_STOCK", hidden: "HIDDEN", hide: "HIDDEN" };

interface Planned extends ImportRow {
  data?: {
    foodType: "VEG" | "NON_VEG" | "EGG";
    status: "AVAILABLE" | "OUT_OF_STOCK" | "HIDDEN";
    station: string;
    description: string | null;
    imageUrl: string | null;
    tax: { taxRateId: string | null; gstRate: number } | null;
    ingredients: { inventoryItemId: string; quantity: number }[] | null;
    existingId: string | null;
  };
}

export async function planImport(raw: { row: number; data: RawRow }[]): Promise<Planned[]> {
  const [cats, items, rates, stock, def] = await Promise.all([
    prisma.menuCategory.findMany({ select: { id: true, name: true, parentId: true } }),
    prisma.menuItem.findMany({ select: { id: true, name: true, categoryId: true } }),
    prisma.taxRate.findMany({ where: { active: true }, orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }] }),
    prisma.inventoryItem.findMany({ where: { active: true }, select: { id: true, name: true, unit: true } }),
    defaultTaxRate(),
  ]);
  const inventoryOn = moduleEnabled("INVENTORY");
  const catId = (name: string, parentId: string | null) => cats.find((c) => norm(c.name) === norm(name) && (c.parentId ?? null) === parentId)?.id ?? null;
  const gstOf = (r: TaxRate) => roundRate(effectiveGstRate(taxFromRate(r)));
  const seen = new Set<string>();

  return raw.map(({ row, data }) => {
    const errors: string[] = [];
    const warnings: string[] = [];
    const category = (data.category ?? "").trim();
    const subcategory = (data.subcategory ?? "").trim() || null;
    const name = (data.name ?? "").trim();
    if (!category) errors.push("Category is required");
    if (!name) errors.push("Item name is required");
    if (name.length > 100) errors.push("Item name is longer than 100 characters");

    const sizes: { name: string; price: number }[] = [];
    for (const p of pairs(data.sizes ?? "")) {
      const price = rupees(p.value);
      if (!p.key || price === null) errors.push(`Size "${p.key || p.value}" needs a price, e.g. Regular=15`);
      else if (sizes.some((s) => norm(s.name) === norm(p.key))) errors.push(`Size "${p.key}" is listed twice`);
      else sizes.push({ name: p.key, price });
    }
    let price: number | null = null;
    if (data.price) {
      price = rupees(data.price);
      if (price === null) errors.push(`Price "${data.price}" isn't a valid amount`);
    } else if (sizes.length) price = Math.min(...sizes.map((s) => s.price));
    else errors.push("Price is required (or give Sizes)");

    let tax: { taxRateId: string | null; gstRate: number } | null = null;
    let gstRate: number | null = null;
    if (data.gst) {
      const g = Number(data.gst.replace("%", "").trim());
      if (!Number.isFinite(g) || g < 0 || g > 100) errors.push(`GST "${data.gst}" isn't a valid percentage`);
      else {
        const match = rates.find((r) => gstOf(r) === roundRate(g) && r.cess === 0);
        tax = match ? { taxRateId: match.id, gstRate: gstOf(match) } : { taxRateId: null, gstRate: roundRate(g) };
        if (!match) warnings.push(`No GST rate of ${g}% in GST & Taxes; it will bill at ${g}% CGST+SGST`);
        gstRate = tax.gstRate;
      }
    } else {
      tax = def ? { taxRateId: def.id, gstRate: gstOf(def) } : { taxRateId: null, gstRate: 0 };
      gstRate = tax.gstRate;
    }

    const foodType = data.foodType ? FOOD[norm(data.foodType)] : "VEG";
    if (!foodType) errors.push(`Food type "${data.foodType}" should be Veg, Non-veg or Egg`);
    const status = data.available ? STATUS[norm(data.available)] : "AVAILABLE";
    if (!status) errors.push(`Available "${data.available}" should be Yes, No or Hidden`);
    const station = (data.station || "MAIN").trim().toUpperCase().slice(0, 40);
    const imageUrl = (data.imageUrl ?? "").trim() || null;
    if (imageUrl && !/^https?:\/\/\S+$/i.test(imageUrl)) errors.push("Image URL must start with http:// or https://");

    let ingredients: { inventoryItemId: string; quantity: number }[] | null = null;
    if (data.ingredients) {
      if (!inventoryOn) warnings.push("Ingredients ignored: the Inventory module is off");
      else {
        ingredients = [];
        for (const p of pairs(data.ingredients)) {
          const s = stock.find((x) => norm(x.name) === norm(p.key));
          const q = Number(p.value);
          if (!s) errors.push(`Stock item "${p.key}" not found. Add it in Inventory → Stock first (names must match).`);
          else if (!Number.isFinite(q) || q <= 0) errors.push(`Ingredient "${p.key}" needs a quantity, e.g. ${p.key}=0.08`);
          else if (ingredients.some((i) => i.inventoryItemId === s.id)) errors.push(`Ingredient "${s.name}" is listed twice`);
          else ingredients.push({ inventoryItemId: s.id, quantity: Math.round(q * 1000) / 1000 });
        }
      }
    }

    // Existing item: same category (and sub-category) + name
    const parentId = category ? catId(category, null) : null;
    const leafId = subcategory ? (parentId ? catId(subcategory, parentId) : null) : parentId;
    const existing = leafId ? items.find((i) => i.categoryId === leafId && norm(i.name) === norm(name)) : undefined;
    const dupKey = `${norm(category)}|${norm(subcategory ?? "")}|${norm(name)}`;
    if (name && seen.has(dupKey)) errors.push("This item appears more than once in the sheet");
    seen.add(dupKey);

    return {
      row,
      category,
      subcategory,
      name,
      action: errors.length ? "error" : existing ? "update" : "create",
      price,
      sizes,
      gstRate,
      errors,
      warnings,
      data: errors.length
        ? undefined
        : { foodType: foodType!, status: status!, station, description: data.description?.trim() || null, imageUrl, tax, ingredients, existingId: existing?.id ?? null },
    };
  });
}

/** Create / update the valid rows in one transaction (rows with errors are skipped). */
export async function applyImport(rows: Planned[]): Promise<void> {
  const businessId = requireBusinessId();
  await prisma.$transaction(
    async (tx) => {
      const cats = await tx.menuCategory.findMany({ select: { id: true, name: true, parentId: true } });
      const ensureCat = async (name: string, parentId: string | null) => {
        const hit = cats.find((c) => norm(c.name) === norm(name) && (c.parentId ?? null) === parentId);
        if (hit) return hit.id;
        const created = await tx.menuCategory.create({ data: { businessId, name: name.trim(), parentId, sortOrder: cats.length + 1 }, select: { id: true, name: true, parentId: true } });
        cats.push(created);
        return created.id;
      };
      for (const r of rows) {
        if (!r.data) continue;
        const d = r.data;
        const parent = await ensureCat(r.category, null);
        const categoryId = r.subcategory ? await ensureCat(r.subcategory, parent) : parent;
        const fields = {
          name: r.name,
          categoryId,
          price: r.price!,
          foodType: d.foodType,
          status: d.status,
          kitchenStation: d.station,
          ...(d.description !== null && { description: d.description }),
          ...(d.imageUrl && { imageUrl: d.imageUrl }),
          ...(d.tax && { taxRateId: d.tax.taxRateId, gstRate: d.tax.gstRate }),
        };
        let id = d.existingId;
        if (id) {
          await tx.menuItem.update({ where: { id }, data: fields });
        } else {
          id = (await tx.menuItem.create({ data: { ...fields, businessId }, select: { id: true } })).id;
        }
        if (r.sizes.length) {
          const current = await tx.itemVariant.findMany({ where: { menuItemId: id } });
          for (const s of r.sizes) {
            const hit = current.find((v) => norm(v.name) === norm(s.name));
            if (hit) await tx.itemVariant.update({ where: { id: hit.id }, data: { name: s.name, price: s.price } });
            else await tx.itemVariant.create({ data: { menuItemId: id, name: s.name, price: s.price } });
          }
          const removed = current.filter((v) => !r.sizes.some((s) => norm(s.name) === norm(v.name))).map((v) => v.id);
          if (removed.length) {
            await tx.recipe.deleteMany({ where: { menuItemId: id, variantId: { in: removed } } });
            await tx.itemVariant.deleteMany({ where: { id: { in: removed } } });
          }
        }
        if (d.ingredients) {
          await tx.recipe.deleteMany({ where: { menuItemId: id, variantId: null } });
          if (d.ingredients.length) {
            await tx.recipe.createMany({ data: d.ingredients.map((i) => ({ menuItemId: id!, variantId: null, inventoryItemId: i.inventoryItemId, quantity: i.quantity })) });
          }
        }
      }
    },
    { timeout: 60_000 },
  );
}

export function summarize(rows: ImportRow[], applied: boolean): ImportResult {
  return {
    applied,
    summary: {
      total: rows.length,
      create: rows.filter((r) => r.action === "create").length,
      update: rows.filter((r) => r.action === "update").length,
      error: rows.filter((r) => r.action === "error").length,
    },
    rows: rows.map(({ data: _d, ...r }: ImportRow & { data?: unknown }) => r),
  };
}

