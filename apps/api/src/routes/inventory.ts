import { Router, type Request, type Response } from "express";
import ExcelJS from "exceljs";
import { z } from "zod";
import type { InventoryTxnType, Prisma, StockUnit } from "@prisma/client";
import {
  computePurchaseTotals,
  INVENTORY_TXN_TYPES,
  inventoryItemSchema,
  inventoryItemUpdateSchema,
  inventoryReportQuerySchema,
  purchaseCancelSchema,
  purchaseCreateSchema,
  purchasePaymentSchema,
  purchaseUpdateSchema,
  recipeUpsertSchema,
  stockAdjustSchema,
  stockAuditCountsSchema,
  stockAuditStartSchema,
  stockTransferCreateSchema,
  stockTransferRejectSchema,
  vendorSchema,
  vendorUpdateSchema,
  wastageSchema,
} from "@canavo/shared";
import { prisma } from "../db";
import { inclusiveRate, resolveItemTax } from "../services/tax";
import { audit } from "../lib/audit";
import { retryTransaction } from "../lib/tx-retry";
import { badRequest, conflict, forbidden, notFound, param, parse } from "../lib/http";
import { addDays, isValidYmd, startOfLocalDay, zonedParts } from "../lib/time";
import { authenticate, requireOutlet, requirePermission, requireModule } from "../middleware/auth";
import { emitToOutlet } from "../realtime";
import { notify, outletManagers } from "../services/notify";
import { featureOn, requireBusinessId } from "../lib/tenant";
import {
  alertLowStock,
  applyStockMovement,
  convertQuantity,
  inItemOrder,
  isLowStock,
  lowStockItems,
  netPrice,
  recipeCost,
  resolveRecipe,
  round3,
  updateWeightedCost,
} from "../services/inventory";
import { announceAvailability, refreshMenuAvailability } from "../services/stock-availability";
import { safeCellText } from "../services/report-export";

type Tx = Prisma.TransactionClient;

export const inventoryRouter = Router();
// Every inventory screen works in the context of the active outlet (X-Outlet-Id).
inventoryRouter.use(authenticate, requireOutlet, requireModule("INVENTORY"));

const view = requirePermission("inventory:view");
const manage = requirePermission("inventory:manage");
/** Stock reports (consumption, movement, valuation, wastage, purchases): owner, manager and inventory staff. */
const reports = requirePermission("inventory:manage");

const rupees = (paise: number) => Math.round(paise) / 100;
const value = (qty: number, cost: number) => Math.round(qty * cost);
const flag = (v: unknown) => v === "1" || v === "true";

async function outletTz(outletId: string) {
  const o = await prisma.outlet.findUniqueOrThrow({ where: { id: outletId }, select: { timezone: true } });
  return o.timezone;
}

/** Inclusive local-date range → UTC instants. Defaults to the last 7 days. */
async function dateRange(req: Request, from?: string, to?: string) {
  for (const d of [from, to]) if (d !== undefined && !isValidYmd(d)) throw badRequest("Dates must be real dates in YYYY-MM-DD");
  const tz = await outletTz(req.outletId!);
  const today = zonedParts(new Date(), tz).date;
  const t = to ?? today;
  const f = from ?? addDays(t, -6);
  if (f > t) throw badRequest("from must be on or before to");
  return { from: f, to: t, tz, gte: startOfLocalDay(f, tz), lt: startOfLocalDay(addDays(t, 1), tz) };
}

interface Col {
  header: string;
  key: string;
  width?: number;
}
/** Respond with JSON, or an .xlsx sheet when ?format=xlsx. */
async function respond(req: Request, res: Response, json: unknown, sheet: { name: string; filename: string; columns: Col[]; rows: Record<string, unknown>[] }) {
  if (req.query.format !== "xlsx") return res.json(json);
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheet.name);
  ws.columns = sheet.columns.map((c) => ({ width: 14, ...c }));
  ws.getRow(1).font = { bold: true };
  for (const r of sheet.rows) ws.addRow(Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === "string" ? safeCellText(v) : v])));
  res.setHeader("content-disposition", `attachment; filename="${sheet.filename}.xlsx"`);
  res.type("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  await wb.xlsx.write(res);
  res.end();
}

async function getItem(id: string) {
  const item = await prisma.inventoryItem.findUnique({ where: { id } });
  if (!item) throw notFound("Inventory item");
  return item;
}

/** Load items by id and ensure all exist and are active. */
async function loadItems(ids: string[], db: Tx | typeof prisma = prisma) {
  const unique = [...new Set(ids)];
  const items = await db.inventoryItem.findMany({ where: { id: { in: unique } } });
  if (items.length !== unique.length) throw badRequest("Unknown inventory item");
  const inactive = items.find((i) => !i.active);
  if (inactive) throw badRequest(`${inactive.name} is inactive`);
  return new Map(items.map((i) => [i.id, i]));
}

const canActFor = (req: Request, outletId: string) => req.user!.role === "SUPER_ADMIN" || req.user!.outletIds.includes(outletId);

// =====================================================================
// Items
// =====================================================================

const itemListQuery = z.object({
  search: z.string().trim().max(100).optional(),
  category: z.string().trim().max(60).optional(),
  lowStock: z.string().optional(),
  includeInactive: z.string().optional(),
});

inventoryRouter.get("/items", view, async (req, res) => {
  const q = parse(itemListQuery, req.query);
  const items = await prisma.inventoryItem.findMany({
    where: {
      ...(!flag(q.includeInactive) && { active: true }),
      ...(q.category && { category: q.category }),
      ...(q.search && {
        OR: [
          { name: { contains: q.search, mode: "insensitive" as const } },
          { sku: { contains: q.search, mode: "insensitive" as const } },
          { barcode: q.search },
        ],
      }),
    },
    include: { stocks: { where: { outletId: req.outletId } } },
    orderBy: [{ category: "asc" }, { name: "asc" }],
  });
  let rows = items.map(({ stocks, ...i }) => {
    const quantity = stocks[0]?.quantity ?? 0;
    return { ...i, quantity, value: value(Math.max(0, quantity), i.costPerUnit), lowStock: isLowStock(quantity, i.reorderLevel) };
  });
  if (flag(q.lowStock)) rows = rows.filter((r) => r.lowStock);
  res.json({
    items: rows,
    totals: { count: rows.length, value: rows.reduce((s, r) => s + r.value, 0), lowStock: rows.filter((r) => r.lowStock).length },
  });
});

inventoryRouter.get("/items/categories", view, async (_req, res) => {
  const rows = await prisma.inventoryItem.groupBy({ by: ["category"], where: { active: true }, _count: true, orderBy: { category: "asc" } });
  res.json(rows.map((r) => ({ category: r.category, count: r._count })));
});

/** Barcode / SKU lookup for USB (keyboard-wedge) and webcam scanners. */
inventoryRouter.get("/items/lookup", view, async (req, res) => {
  const { code } = parse(z.object({ code: z.string().trim().min(1).max(64) }), req.query);
  const item = await prisma.inventoryItem.findFirst({
    where: { active: true, OR: [{ barcode: code }, { sku: { equals: code, mode: "insensitive" } }] },
    include: { stocks: { where: { outletId: req.outletId } } },
  });
  if (!item) throw notFound("Item with this barcode/SKU");
  const { stocks, ...rest } = item;
  const quantity = stocks[0]?.quantity ?? 0;
  res.json({ ...rest, quantity, lowStock: isLowStock(quantity, item.reorderLevel) });
});

inventoryRouter.get("/items/:id", view, async (req, res) => {
  const id = param(req, "id");
  const item = await prisma.inventoryItem.findUnique({
    where: { id },
    include: {
      stocks: true,
      recipes: { include: { menuItem: { select: { id: true, name: true, variants: { select: { id: true, name: true } } } } } },
    },
  });
  if (!item) throw notFound("Inventory item");
  const transactions = await prisma.inventoryTransaction.findMany({
    where: { inventoryItemId: id, outletId: req.outletId },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  const { stocks, recipes, ...rest } = item;
  const quantity = stocks.find((s) => s.outletId === req.outletId)?.quantity ?? 0;
  res.json({
    ...rest,
    quantity,
    value: value(Math.max(0, quantity), item.costPerUnit),
    lowStock: isLowStock(quantity, item.reorderLevel),
    outletStocks: stocks.map((s) => ({ outletId: s.outletId, quantity: s.quantity })),
    usedIn: recipes.map((r) => ({
      menuItemId: r.menuItemId,
      menuItemName: r.menuItem.name,
      variantId: r.variantId,
      variantName: r.menuItem.variants.find((v) => v.id === r.variantId)?.name ?? null,
      quantity: r.quantity,
    })),
    transactions,
  });
});

inventoryRouter.post("/items", manage, async (req, res) => {
  const { openingStock, ...data } = parse(inventoryItemSchema, req.body);
  const item = await retryTransaction(async (tx) => {
    const created = await tx.inventoryItem.create({ data: { ...data, sku: data.sku || null, barcode: data.barcode || null, businessId: requireBusinessId() } });
    if (openingStock) {
      await applyStockMovement(tx, {
        outletId: req.outletId!,
        inventoryItemId: created.id,
        type: "OPENING",
        quantity: openingStock,
        unitCost: created.costPerUnit,
        note: "Opening stock",
        userId: req.user!.id,
      });
    }
    await audit(req, "inventory.item.create", "InventoryItem", created.id, { name: created.name, openingStock: openingStock ?? 0 }, tx);
    return created;
  });
  res.status(201).json(item);
});

inventoryRouter.patch("/items/:id", manage, async (req, res) => {
  const id = param(req, "id");
  const data = parse(inventoryItemUpdateSchema, req.body);
  const item = await getItem(id);
  if (data.unit && data.unit !== item.unit) {
    const used = await prisma.inventoryTransaction.count({ where: { inventoryItemId: id } });
    if (used) throw badRequest("Unit cannot change once the item has stock movements; create a new item instead");
  }
  const updated = await prisma.inventoryItem.update({
    where: { id },
    data: {
      ...data,
      ...(data.sku !== undefined && { sku: data.sku || null }),
      ...(data.barcode !== undefined && { barcode: data.barcode || null }),
    },
  });
  await audit(req, "inventory.item.update", "InventoryItem", id, { fields: Object.keys(data) });
  res.json(updated);
});

/** Deactivate (items stay for history; recipes using them stop deducting). */
inventoryRouter.delete("/items/:id", manage, async (req, res) => {
  const id = param(req, "id");
  await getItem(id);
  await prisma.inventoryItem.update({ where: { id }, data: { active: false } });
  await audit(req, "inventory.item.deactivate", "InventoryItem", id);
  res.status(204).end();
});

/** Opening stock or manual adjustment: signed `quantity` delta, or absolute `setTo`. */
inventoryRouter.post("/items/:id/adjust", manage, async (req, res) => {
  const id = param(req, "id");
  const data = parse(stockAdjustSchema, req.body);
  const item = await getItem(id);
  const txn = await retryTransaction(async (tx) => {
    const stock = await tx.inventoryStock.findUnique({ where: { outletId_inventoryItemId: { outletId: req.outletId!, inventoryItemId: id } } });
    const current = stock?.quantity ?? 0;
    const delta = round3(data.setTo !== undefined ? data.setTo - current : data.quantity!);
    if (delta === 0) throw badRequest("Stock is already at that quantity");
    const costIn = delta > 0 && data.unitCost !== undefined;
    if (costIn) await updateWeightedCost(tx, id, delta, data.unitCost!);
    const t = await applyStockMovement(tx, {
      outletId: req.outletId!,
      inventoryItemId: id,
      type: data.opening ? "OPENING" : "ADJUSTMENT",
      quantity: delta,
      unitCost: costIn ? data.unitCost : item.costPerUnit,
      refType: "Manual",
      note: data.reason,
      userId: req.user!.id,
    });
    await audit(req, "inventory.stock.adjust", "InventoryItem", id, { delta, setTo: data.setTo, reason: data.reason, opening: data.opening }, tx);
    return t;
  });
  if (txn && txn.quantity < 0) await alertLowStock(req.outletId!, [id]);
  res.status(201).json(txn);
});

const ledgerQuery = z.object({
  itemId: z.string().optional(),
  type: z.enum(INVENTORY_TXN_TYPES).optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(200),
});

/** Stock ledger for the outlet. */
inventoryRouter.get("/transactions", view, async (req, res) => {
  const q = parse(ledgerQuery, req.query);
  const r = await dateRange(req, q.from, q.to);
  res.json(
    await prisma.inventoryTransaction.findMany({
      where: {
        outletId: req.outletId,
        ...(q.itemId && { inventoryItemId: q.itemId }),
        ...(q.type && { type: q.type }),
        createdAt: { gte: r.gte, lt: r.lt },
      },
      include: { item: { select: { name: true, unit: true } } },
      orderBy: { createdAt: "desc" },
      take: q.limit,
    }),
  );
});

// =====================================================================
// Recipes
// =====================================================================

inventoryRouter.get("/recipes", view, async (req, res) => {
  const { menuItemId } = parse(z.object({ menuItemId: z.string().optional() }), req.query);
  const recipes = await prisma.recipe.findMany({
    where: menuItemId ? { menuItemId } : {},
    include: { item: { select: { id: true, name: true, unit: true, costPerUnit: true, active: true } } },
    orderBy: [{ menuItemId: "asc" }, { variantId: "asc" }],
  });
  res.json(recipes.map((r) => ({ ...r, cost: value(r.quantity, r.item.costPerUnit) })));
});

/** Food cost vs selling price per menu item (and variant) at the active outlet. */
/** Food cost % and margins are profit data: owner and manager only. */
inventoryRouter.get("/recipes/costing", requirePermission("report:view"), async (req, res) => {
  const outlet = await prisma.outlet.findUniqueOrThrow({
    where: { id: req.outletId },
    select: { pricesIncludeTax: true, compositionScheme: true, gstEnabled: true },
  });
  const items = await prisma.menuItem.findMany({
    where: { status: { not: "HIDDEN" } },
    include: {
      variants: true,
      overrides: { where: { outletId: req.outletId } },
      recipes: { include: { item: { select: { name: true, unit: true, costPerUnit: true } } } },
      category: { select: { name: true } },
    },
    orderBy: { name: "asc" },
  });
  // Net price strips the item's full tax composition (GST + cess + extras).
  const taxes = await resolveItemTax(items);
  const rows = items.flatMap((m) => {
    const targets = m.variants.length
      ? m.variants.map((v) => ({ variantId: v.id as string | null, variantName: v.name as string | null, price: v.price }))
      : [{ variantId: null, variantName: null, price: m.overrides[0]?.price ?? m.price }];
    return targets.map((t) => {
      const lines = resolveRecipe(m.recipes, m.id, t.variantId);
      const cost = recipeCost(lines.map((l) => ({ quantity: l.quantity, costPerUnit: l.item.costPerUnit })));
      const net = netPrice(t.price, inclusiveRate(outlet, taxes.get(m.id)!), outlet.pricesIncludeTax);
      return {
        menuItemId: m.id,
        name: m.name,
        category: m.category.name,
        variantId: t.variantId,
        variantName: t.variantName,
        price: t.price,
        netPrice: net,
        hasRecipe: lines.length > 0,
        cost,
        foodCostPercent: lines.length && net > 0 ? Math.round((cost / net) * 1000) / 10 : null,
        margin: net - cost,
        lines: lines.map((l) => ({ inventoryItemId: l.inventoryItemId, name: l.item.name, unit: l.item.unit, quantity: l.quantity, cost: value(l.quantity, l.item.costPerUnit) })),
      };
    });
  });
  const costed = rows.filter((r) => r.hasRecipe);
  await respond(
    req,
    res,
    {
      items: rows,
      summary: {
        menuRows: rows.length,
        withRecipe: costed.length,
        avgFoodCostPercent: costed.length ? Math.round((costed.reduce((s, r) => s + (r.foodCostPercent ?? 0), 0) / costed.length) * 10) / 10 : null,
      },
    },
    {
      name: "Recipe costing",
      filename: "recipe_costing",
      columns: [
        { header: "Item", key: "name", width: 30 },
        { header: "Variant", key: "variant" },
        { header: "Price (₹)", key: "price" },
        { header: "Net of GST (₹)", key: "net" },
        { header: "Ingredient cost (₹)", key: "cost", width: 18 },
        { header: "Food cost %", key: "pct" },
        { header: "Margin (₹)", key: "margin" },
      ],
      rows: rows.map((r) => ({
        name: r.name,
        variant: r.variantName ?? "",
        price: rupees(r.price),
        net: rupees(r.netPrice),
        cost: r.hasRecipe ? rupees(r.cost) : "",
        pct: r.foodCostPercent ?? "",
        margin: r.hasRecipe ? rupees(r.margin) : "",
      })),
    },
  );
});

/** Replace the recipe for a menu item (or one of its variants). */
inventoryRouter.put("/recipes/:menuItemId", manage, async (req, res) => {
  const menuItemId = param(req, "menuItemId");
  const { variantId: rawVariant, lines } = parse(recipeUpsertSchema, req.body);
  const variantId = rawVariant ?? null;
  const menuItem = await prisma.menuItem.findUnique({ where: { id: menuItemId }, include: { variants: true } });
  if (!menuItem) throw notFound("Menu item");
  if (variantId && !menuItem.variants.some((v) => v.id === variantId)) throw badRequest("Variant does not belong to this item");
  const items = await loadItems(lines.map((l) => l.inventoryItemId));
  const merged = new Map<string, number>();
  for (const l of lines) {
    const item = items.get(l.inventoryItemId)!;
    const q = convertQuantity(l.quantity, (l.unit ?? item.unit) as StockUnit, item.unit);
    if (q <= 0) throw badRequest(`Quantity for ${item.name} rounds to zero in ${item.unit}`);
    merged.set(item.id, round3((merged.get(item.id) ?? 0) + q));
  }
  const recipes = await retryTransaction(async (tx) => {
    await tx.recipe.deleteMany({ where: { menuItemId, variantId } });
    if (merged.size) {
      await tx.recipe.createMany({ data: [...merged].map(([inventoryItemId, quantity]) => ({ menuItemId, variantId, inventoryItemId, quantity })) });
    }
    await audit(req, "inventory.recipe.replace", "MenuItem", menuItemId, { variantId, lines: merged.size }, tx);
    return tx.recipe.findMany({ where: { menuItemId, variantId }, include: { item: { select: { name: true, unit: true, costPerUnit: true } } } });
  });
  if (featureOn("AUTO_STOCK_OUT")) await announceAvailability(prisma, req.outletId!, await refreshMenuAvailability(prisma, req.outletId!));
  res.json({ menuItemId, variantId, lines: recipes, cost: recipeCost(recipes.map((r) => ({ quantity: r.quantity, costPerUnit: r.item.costPerUnit }))) });
});

// =====================================================================
// Vendors
// =====================================================================

async function vendorSummaries(outletId: string, vendorIds?: string[]) {
  const rows = await prisma.purchase.groupBy({
    by: ["vendorId"],
    where: { outletId, status: "RECEIVED", ...(vendorIds && { vendorId: { in: vendorIds } }) },
    _sum: { total: true, paidAmount: true },
    _count: true,
    _max: { receivedAt: true },
  });
  return new Map(
    rows.map((r) => {
      const total = r._sum.total ?? 0;
      const paid = r._sum.paidAmount ?? 0;
      return [r.vendorId, { purchases: r._count, totalSpend: total, paid, outstanding: total - paid, lastPurchaseAt: r._max.receivedAt }];
    }),
  );
}
const emptySummary = { purchases: 0, totalSpend: 0, paid: 0, outstanding: 0, lastPurchaseAt: null };
const vendorData = <T extends { email?: string | null; gstin?: string | null }>(d: T) => ({
  ...d,
  ...(d.email !== undefined && { email: d.email || null }),
  ...(d.gstin !== undefined && { gstin: d.gstin || null }),
});

inventoryRouter.get("/vendors", view, async (req, res) => {
  const q = parse(z.object({ search: z.string().trim().max(100).optional(), includeInactive: z.string().optional() }), req.query);
  const vendors = await prisma.vendor.findMany({
    where: {
      ...(!flag(q.includeInactive) && { active: true }),
      ...(q.search && { OR: [{ name: { contains: q.search, mode: "insensitive" as const } }, { phone: { contains: q.search } }] }),
    },
    orderBy: { name: "asc" },
  });
  const sums = await vendorSummaries(req.outletId!);
  res.json(vendors.map((v) => ({ ...v, summary: sums.get(v.id) ?? emptySummary })));
});

inventoryRouter.get("/vendors/:id", view, async (req, res) => {
  const id = param(req, "id");
  const vendor = await prisma.vendor.findUnique({ where: { id } });
  if (!vendor) throw notFound("Vendor");
  const [sums, purchases] = await Promise.all([
    vendorSummaries(req.outletId!, [id]),
    prisma.purchase.findMany({ where: { vendorId: id, outletId: req.outletId }, orderBy: { createdAt: "desc" }, take: 20 }),
  ]);
  res.json({ ...vendor, summary: sums.get(id) ?? emptySummary, purchases });
});

inventoryRouter.post("/vendors", manage, async (req, res) => {
  const data = parse(vendorSchema, req.body);
  const vendor = await prisma.vendor.create({ data: { ...vendorData(data), businessId: requireBusinessId() } });
  await audit(req, "inventory.vendor.create", "Vendor", vendor.id, { name: vendor.name });
  res.status(201).json(vendor);
});

inventoryRouter.patch("/vendors/:id", manage, async (req, res) => {
  const id = param(req, "id");
  const data = parse(vendorUpdateSchema, req.body);
  const vendor = await prisma.vendor.update({ where: { id }, data: vendorData(data) });
  await audit(req, "inventory.vendor.update", "Vendor", id, { fields: Object.keys(data) });
  res.json(vendor);
});

inventoryRouter.delete("/vendors/:id", manage, async (req, res) => {
  const id = param(req, "id");
  await prisma.vendor.update({ where: { id }, data: { active: false } });
  await audit(req, "inventory.vendor.deactivate", "Vendor", id);
  res.status(204).end();
});

// =====================================================================
// Purchases
// =====================================================================

const purchaseInclude = {
  vendor: { select: { id: true, name: true, phone: true, gstin: true } },
  items: true,
  payments: { orderBy: { paidAt: "asc" } },
} as const;

async function getPurchase(id: string, outletId: string) {
  const p = await prisma.purchase.findFirst({ where: { id, outletId }, include: purchaseInclude });
  if (!p) throw notFound("Purchase");
  const items = await prisma.inventoryItem.findMany({
    where: { id: { in: p.items.map((i) => i.inventoryItemId) } },
    select: { id: true, name: true, unit: true },
  });
  const byId = new Map(items.map((i) => [i.id, i]));
  return {
    ...p,
    balance: p.total - p.paidAmount,
    items: p.items.map((i) => ({ ...i, item: byId.get(i.inventoryItemId) ?? null })),
  };
}

function purchaseLines(items: { inventoryItemId: string; quantity: number; unitCost: number; taxRate: number }[]) {
  const totals = computePurchaseTotals(items);
  return {
    subtotal: totals.subtotal,
    tax: totals.tax,
    total: totals.total,
    lines: items.map((i, idx) => ({
      inventoryItemId: i.inventoryItemId,
      quantity: round3(i.quantity),
      unitCost: i.unitCost,
      taxRate: i.taxRate,
      total: totals.lines[idx].total,
    })),
  };
}

/** Post PURCHASE movements at landed (tax-inclusive) cost and update weighted-average cost. */
async function receivePurchase(tx: Tx, purchaseId: string, outletId: string, userId: string) {
  const claimed = await tx.purchase.updateMany({ where: { id: purchaseId, outletId, status: "DRAFT" }, data: { status: "RECEIVED", receivedAt: new Date() } });
  if (!claimed.count) throw conflict("Only draft purchases can be received");
  const p = await tx.purchase.findUniqueOrThrow({ where: { id: purchaseId }, include: { items: true } });
  await loadItems(p.items.map((i) => i.inventoryItemId), tx);
  for (const line of inItemOrder(p.items)) {
    // Canteens on 5% GST can't claim input credit, so tax is part of the real cost.
    const landed = line.quantity > 0 ? line.total / line.quantity : line.unitCost;
    await updateWeightedCost(tx, line.inventoryItemId, line.quantity, landed);
    await applyStockMovement(tx, {
      outletId,
      inventoryItemId: line.inventoryItemId,
      type: "PURCHASE",
      quantity: line.quantity,
      unitCost: Math.round(landed),
      refType: "Purchase",
      refId: p.id,
      note: p.invoiceNo ?? undefined,
      userId,
    });
  }
}

const purchaseListQuery = z.object({
  vendorId: z.string().optional(),
  status: z.enum(["DRAFT", "RECEIVED", "CANCELLED"]).optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  unpaid: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

inventoryRouter.get("/purchases", view, async (req, res) => {
  const q = parse(purchaseListQuery, req.query);
  const r = q.from || q.to ? await dateRange(req, q.from, q.to) : null;
  const list = await prisma.purchase.findMany({
    where: {
      outletId: req.outletId,
      ...(q.vendorId && { vendorId: q.vendorId }),
      ...(q.status && { status: q.status }),
      ...(r && { createdAt: { gte: r.gte, lt: r.lt } }),
    },
    include: { vendor: { select: { id: true, name: true } }, _count: { select: { items: true } } },
    orderBy: { createdAt: "desc" },
    take: q.limit,
  });
  const rows = list.map((p) => ({ ...p, balance: p.total - p.paidAmount }));
  res.json(flag(q.unpaid) ? rows.filter((p) => p.status === "RECEIVED" && p.balance > 0) : rows);
});

inventoryRouter.get("/purchases/:id", view, async (req, res) => {
  res.json(await getPurchase(param(req, "id"), req.outletId!));
});

inventoryRouter.post("/purchases", manage, async (req, res) => {
  const data = parse(purchaseCreateSchema, req.body);
  const vendor = await prisma.vendor.findUnique({ where: { id: data.vendorId } });
  if (!vendor || !vendor.active) throw badRequest("Unknown or inactive vendor");
  await loadItems(data.items.map((i) => i.inventoryItemId));
  const { lines, subtotal, tax, total } = purchaseLines(data.items);
  const id = await retryTransaction(async (tx) => {
    const p = await tx.purchase.create({
      data: {
        outletId: req.outletId!,
        vendorId: data.vendorId,
        invoiceNo: data.invoiceNo || null,
        invoiceDate: data.invoiceDate || null,
        invoiceImageUrl: data.invoiceImageUrl || null,
        notes: data.notes || null,
        subtotal,
        tax,
        total,
        createdById: req.user!.id,
        items: { create: lines },
      },
    });
    if (data.receive) await receivePurchase(tx, p.id, req.outletId!, req.user!.id);
    await audit(req, "inventory.purchase.create", "Purchase", p.id, { vendorId: data.vendorId, total, received: data.receive }, tx);
    return p.id;
  });
  res.status(201).json(await getPurchase(id, req.outletId!));
});

inventoryRouter.patch("/purchases/:id", manage, async (req, res) => {
  const id = param(req, "id");
  const data = parse(purchaseUpdateSchema, req.body);
  const p = await getPurchase(id, req.outletId!);
  if (p.status === "CANCELLED") throw conflict("Purchase is cancelled");
  // After receipt only the paperwork fields may change; quantities/costs are locked into the ledger.
  if (p.status === "RECEIVED" && (data.items || data.vendorId)) throw conflict("Received purchases: only invoice details and notes can be edited");
  if (data.vendorId) {
    const v = await prisma.vendor.findUnique({ where: { id: data.vendorId } });
    if (!v?.active) throw badRequest("Unknown or inactive vendor");
  }
  if (data.items) await loadItems(data.items.map((i) => i.inventoryItemId));
  await retryTransaction(async (tx) => {
    let totals = {};
    if (data.items) {
      const { lines, subtotal, tax, total } = purchaseLines(data.items);
      if (total < p.paidAmount) throw badRequest("New total is less than the amount already paid");
      await tx.purchaseItem.deleteMany({ where: { purchaseId: id } });
      await tx.purchaseItem.createMany({ data: lines.map((l) => ({ ...l, purchaseId: id })) });
      totals = { subtotal, tax, total };
    }
    await tx.purchase.update({
      where: { id },
      data: {
        ...totals,
        ...(data.vendorId && { vendorId: data.vendorId }),
        ...(data.invoiceNo !== undefined && { invoiceNo: data.invoiceNo || null }),
        ...(data.invoiceDate !== undefined && { invoiceDate: data.invoiceDate || null }),
        ...(data.invoiceImageUrl !== undefined && { invoiceImageUrl: data.invoiceImageUrl || null }),
        ...(data.notes !== undefined && { notes: data.notes || null }),
      },
    });
    await audit(req, "inventory.purchase.update", "Purchase", id, { fields: Object.keys(data) }, tx);
  });
  res.json(await getPurchase(id, req.outletId!));
});

inventoryRouter.post("/purchases/:id/receive", manage, async (req, res) => {
  const id = param(req, "id");
  await getPurchase(id, req.outletId!);
  await retryTransaction(async (tx) => {
    await receivePurchase(tx, id, req.outletId!, req.user!.id);
    await audit(req, "inventory.purchase.receive", "Purchase", id, undefined, tx);
  });
  emitToOutlet(req.outletId!, "inventory:changed", { purchaseId: id });
  res.json(await getPurchase(id, req.outletId!));
});

inventoryRouter.post("/purchases/:id/cancel", manage, async (req, res) => {
  const id = param(req, "id");
  const { reason } = parse(purchaseCancelSchema, req.body);
  const p = await getPurchase(id, req.outletId!);
  if (p.status === "CANCELLED") throw conflict("Purchase already cancelled");
  const returned: string[] = [];
  await retryTransaction(async (tx) => {
    returned.length = 0; // a retried attempt starts again
    const claimed = await tx.purchase.updateMany({
      where: { id, status: p.status },
      data: { status: "CANCELLED", notes: [p.notes, `Cancelled: ${reason}`].filter(Boolean).join("\n") },
    });
    if (!claimed.count) throw conflict("Purchase changed meanwhile; reload and retry");
    if (p.status === "RECEIVED") {
      for (const line of inItemOrder(p.items)) {
        await applyStockMovement(tx, {
          outletId: req.outletId!,
          inventoryItemId: line.inventoryItemId,
          type: "RETURN",
          quantity: -line.quantity,
          unitCost: Math.round(line.quantity > 0 ? line.total / line.quantity : line.unitCost),
          refType: "Purchase",
          refId: id,
          note: reason,
          userId: req.user!.id,
        });
        returned.push(line.inventoryItemId);
      }
    }
    await audit(req, "inventory.purchase.cancel", "Purchase", id, { reason, wasReceived: p.status === "RECEIVED" }, tx);
  });
  if (returned.length) await alertLowStock(req.outletId!, returned);
  res.json(await getPurchase(id, req.outletId!));
});

/** Record a payment made to the vendor against this purchase. */
inventoryRouter.post("/purchases/:id/payments", manage, async (req, res) => {
  const id = param(req, "id");
  const data = parse(purchasePaymentSchema, req.body);
  const p = await getPurchase(id, req.outletId!);
  if (p.status === "CANCELLED") throw conflict("Purchase is cancelled");
  if (data.amount > p.total - p.paidAmount) throw badRequest(`Payment exceeds balance due (₹${rupees(p.total - p.paidAmount)})`);
  await retryTransaction(async (tx) => {
    // Guard against concurrent payments overshooting the total.
    const ok = await tx.purchase.updateMany({
      where: { id, paidAmount: { lte: p.total - data.amount } },
      data: { paidAmount: { increment: data.amount } },
    });
    if (!ok.count) throw conflict("Payment exceeds balance due");
    await tx.purchasePayment.create({
      data: { purchaseId: id, amount: data.amount, mode: data.mode, reference: data.reference, createdById: req.user!.id },
    });
    await audit(req, "inventory.purchase.payment", "Purchase", id, { amount: data.amount, mode: data.mode, reference: data.reference ?? null }, tx);
  });
  res.json(await getPurchase(id, req.outletId!));
});

// =====================================================================
// Wastage
// =====================================================================

inventoryRouter.post("/wastage", manage, async (req, res) => {
  const { items } = parse(wastageSchema, req.body);
  const byId = await loadItems(items.map((i) => i.inventoryItemId));
  const txns = await retryTransaction(async (tx) => {
    const out = [];
    for (const w of inItemOrder(items)) {
      const item = byId.get(w.inventoryItemId)!;
      const q = convertQuantity(w.quantity, (w.unit ?? item.unit) as StockUnit, item.unit);
      const t = await applyStockMovement(tx, {
        outletId: req.outletId!,
        inventoryItemId: item.id,
        type: "WASTAGE",
        quantity: -q,
        unitCost: item.costPerUnit,
        refType: "Wastage",
        note: w.reason,
        userId: req.user!.id,
      });
      if (t) out.push(t);
    }
    await audit(
      req,
      "inventory.wastage",
      "InventoryTransaction",
      undefined,
      { items: out.map((t) => ({ id: t.inventoryItemId, qty: t.quantity, value: value(-t.quantity, t.unitCost ?? 0) })) },
      tx,
    );
    return out;
  });
  await alertLowStock(req.outletId!, [...byId.keys()]);
  res.status(201).json({ transactions: txns, value: txns.reduce((s, t) => s + value(-t.quantity, t.unitCost ?? 0), 0) });
});

inventoryRouter.get("/wastage", view, async (req, res) => {
  const q = parse(z.object({ from: z.string().optional(), to: z.string().optional() }), req.query);
  const r = await dateRange(req, q.from, q.to);
  res.json(
    await prisma.inventoryTransaction.findMany({
      where: { outletId: req.outletId, type: "WASTAGE", createdAt: { gte: r.gte, lt: r.lt } },
      include: { item: { select: { name: true, unit: true } } },
      orderBy: { createdAt: "desc" },
    }),
  );
});

// =====================================================================
// Stock audits (physical counts)
// =====================================================================

async function getAudit(id: string, outletId: string) {
  const a = await prisma.stockAudit.findFirst({ where: { id, outletId }, include: { lines: true } });
  if (!a) throw notFound("Stock audit");
  const items = await prisma.inventoryItem.findMany({
    where: { id: { in: a.lines.map((l) => l.inventoryItemId) } },
    select: { id: true, name: true, unit: true, category: true, costPerUnit: true, barcode: true, sku: true },
  });
  const byId = new Map(items.map((i) => [i.id, i]));
  const lines = a.lines
    .map((l) => {
      const item = byId.get(l.inventoryItemId)!;
      const variance = l.countedQty == null ? null : round3(l.countedQty - l.systemQty);
      return { ...l, item, variance, varianceValue: variance == null ? null : value(variance, item.costPerUnit) };
    })
    .sort((x, y) => x.item.category.localeCompare(y.item.category) || x.item.name.localeCompare(y.item.name));
  const counted = lines.filter((l) => l.countedQty != null);
  return {
    ...a,
    lines,
    summary: {
      items: lines.length,
      counted: counted.length,
      withVariance: counted.filter((l) => l.variance !== 0).length,
      varianceValue: counted.reduce((s, l) => s + (l.varianceValue ?? 0), 0),
    },
  };
}

inventoryRouter.get("/audits", view, async (req, res) => {
  const audits = await prisma.stockAudit.findMany({
    where: { outletId: req.outletId },
    include: { _count: { select: { lines: true } } },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  res.json(audits);
});

inventoryRouter.get("/audits/:id", view, async (req, res) => {
  res.json(await getAudit(param(req, "id"), req.outletId!));
});

/** Start an audit: snapshot system quantity of every active item. */
inventoryRouter.post("/audits", manage, async (req, res) => {
  const data = parse(stockAuditStartSchema, req.body);
  const open = await prisma.stockAudit.findFirst({ where: { outletId: req.outletId, status: "IN_PROGRESS" } });
  if (open) throw conflict("An audit is already in progress for this outlet");
  const items = await prisma.inventoryItem.findMany({
    where: { active: true, ...(data.category && { category: data.category }) },
    include: { stocks: { where: { outletId: req.outletId } } },
  });
  if (!items.length) throw badRequest("No active items to audit");
  const a = await retryTransaction(async (tx) => {
    const created = await tx.stockAudit.create({
      data: {
        outletId: req.outletId!,
        notes: [data.category && `Category: ${data.category}`, data.notes].filter(Boolean).join("\n") || null,
        startedById: req.user!.id,
        lines: { create: items.map((i) => ({ inventoryItemId: i.id, systemQty: i.stocks[0]?.quantity ?? 0 })) },
      },
    });
    await audit(req, "inventory.audit.start", "StockAudit", created.id, { items: items.length }, tx);
    return created;
  });
  res.status(201).json(await getAudit(a.id, req.outletId!));
});

/** Save counts (partial saves OK; null clears a count). */
inventoryRouter.put("/audits/:id/counts", manage, async (req, res) => {
  const id = param(req, "id");
  const { counts } = parse(stockAuditCountsSchema, req.body);
  const a = await prisma.stockAudit.findFirst({ where: { id, outletId: req.outletId }, include: { lines: { select: { inventoryItemId: true } } } });
  if (!a) throw notFound("Stock audit");
  if (a.status !== "IN_PROGRESS") throw conflict(`Audit is ${a.status.toLowerCase()}`);
  const inAudit = new Set(a.lines.map((l) => l.inventoryItemId));
  const unknown = counts.find((c) => !inAudit.has(c.inventoryItemId));
  if (unknown) throw badRequest(`Item ${unknown.inventoryItemId} is not part of this audit`);
  await retryTransaction(async (tx) => {
    for (const c of counts) {
      await tx.stockAuditLine.update({
        where: { auditId_inventoryItemId: { auditId: id, inventoryItemId: c.inventoryItemId } },
        data: { countedQty: c.countedQty == null ? null : round3(c.countedQty) },
      });
    }
    await audit(req, "inventory.audit.count", "StockAudit", id, { counts: counts.length }, tx);
  });
  res.json(await getAudit(id, req.outletId!));
});

/**
 * Complete: post AUDIT adjustments for counted lines. The variance is
 * counted − snapshot, applied to current stock, so sales made while counting
 * are not lost.
 */
inventoryRouter.post("/audits/:id/complete", manage, async (req, res) => {
  const id = param(req, "id");
  const before = await getAudit(id, req.outletId!);
  if (before.status !== "IN_PROGRESS") throw conflict(`Audit is ${before.status.toLowerCase()}`);
  if (!before.summary.counted) throw badRequest("Count at least one item before completing");
  await retryTransaction(async (tx) => {
    const claimed = await tx.stockAudit.updateMany({ where: { id, status: "IN_PROGRESS" }, data: { status: "COMPLETED", completedAt: new Date() } });
    if (!claimed.count) throw conflict("Audit changed meanwhile");
    for (const l of inItemOrder(before.lines)) {
      if (l.variance == null || l.variance === 0) continue;
      await applyStockMovement(tx, {
        outletId: req.outletId!,
        inventoryItemId: l.inventoryItemId,
        type: "AUDIT",
        quantity: l.variance,
        unitCost: l.item.costPerUnit,
        refType: "StockAudit",
        refId: id,
        note: `Counted ${l.countedQty} vs system ${l.systemQty}`,
        userId: req.user!.id,
      });
    }
    await audit(req, "inventory.audit.complete", "StockAudit", id, before.summary, tx);
  });
  await alertLowStock(req.outletId!, before.lines.filter((l) => (l.variance ?? 0) < 0).map((l) => l.inventoryItemId));
  res.json(await getAudit(id, req.outletId!));
});

inventoryRouter.post("/audits/:id/cancel", manage, async (req, res) => {
  const id = param(req, "id");
  if (!(await prisma.stockAudit.findFirst({ where: { id, outletId: req.outletId }, select: { id: true } }))) throw notFound("Stock audit");
  const r = await prisma.stockAudit.updateMany({ where: { id, outletId: req.outletId, status: "IN_PROGRESS" }, data: { status: "CANCELLED" } });
  if (!r.count) throw conflict("Only in-progress audits can be cancelled");
  await audit(req, "inventory.audit.cancel", "StockAudit", id);
  res.json(await getAudit(id, req.outletId!));
});

// =====================================================================
// Inter-outlet transfers
// =====================================================================

const canApproveFor = (req: Request, outletId: string) =>
  req.user!.role === "SUPER_ADMIN" ||
  ((req.user!.role === "OUTLET_MANAGER" || req.user!.role === "BUSINESS_OWNER") && req.user!.outletIds.includes(outletId));

async function getTransfer(id: string) {
  const t = await prisma.stockTransfer.findUnique({ where: { id }, include: { items: true } });
  if (!t) throw notFound("Transfer");
  const [items, outlets] = await Promise.all([
    prisma.inventoryItem.findMany({ where: { id: { in: t.items.map((i) => i.inventoryItemId) } }, select: { id: true, name: true, unit: true, costPerUnit: true } }),
    prisma.outlet.findMany({ where: { id: { in: [t.fromOutletId, t.toOutletId] } }, select: { id: true, name: true } }),
  ]);
  const byId = new Map(items.map((i) => [i.id, i]));
  const o = new Map(outlets.map((x) => [x.id, x.name]));
  const lines = t.items.map((i) => ({ ...i, item: byId.get(i.inventoryItemId) ?? null }));
  return {
    ...t,
    fromOutletName: o.get(t.fromOutletId) ?? null,
    toOutletName: o.get(t.toOutletId) ?? null,
    items: lines,
    value: lines.reduce((s, l) => s + value(l.quantity, l.item?.costPerUnit ?? 0), 0),
  };
}

/** Load a transfer the user may see (they must have access to one of its outlets). */
async function visibleTransfer(req: Request) {
  const t = await getTransfer(param(req, "id"));
  if (!canActFor(req, t.fromOutletId) && !canActFor(req, t.toOutletId)) throw notFound("Transfer");
  return t;
}

async function transferNotify(outletId: string, title: string, body: string, transferId: string) {
  await notify(await outletManagers(outletId), title, body, "inventory.transfer");
  emitToOutlet(outletId, "inventory:transfer", { id: transferId });
}

/** Atomic status transition; throws 409 if someone else moved it first. */
async function transition(tx: Tx, id: string, from: "REQUESTED" | "APPROVED" | "DISPATCHED" | ("REQUESTED" | "APPROVED")[], data: Prisma.StockTransferUpdateManyMutationInput) {
  const r = await tx.stockTransfer.updateMany({ where: { id, status: Array.isArray(from) ? { in: from } : from }, data });
  if (!r.count) throw conflict("Transfer status changed meanwhile; reload");
}

inventoryRouter.get("/transfers", view, async (req, res) => {
  const q = parse(
    z.object({
      direction: z.enum(["incoming", "outgoing", "all"]).default("all"),
      status: z.enum(["REQUESTED", "APPROVED", "DISPATCHED", "RECEIVED", "REJECTED", "CANCELLED"]).optional(),
    }),
    req.query,
  );
  const me = req.outletId!;
  const where: Prisma.StockTransferWhereInput = {
    ...(q.direction === "incoming" ? { toOutletId: me } : q.direction === "outgoing" ? { fromOutletId: me } : { OR: [{ toOutletId: me }, { fromOutletId: me }] }),
    ...(q.status && { status: q.status }),
  };
  const list = await prisma.stockTransfer.findMany({ where, include: { _count: { select: { items: true } } }, orderBy: { createdAt: "desc" }, take: 200 });
  const outlets = await prisma.outlet.findMany({ select: { id: true, name: true } });
  const name = new Map(outlets.map((o) => [o.id, o.name]));
  res.json(
    list.map((t) => ({
      ...t,
      direction: t.toOutletId === me ? "incoming" : "outgoing",
      fromOutletName: name.get(t.fromOutletId) ?? null,
      toOutletName: name.get(t.toOutletId) ?? null,
    })),
  );
});

inventoryRouter.get("/transfers/:id", view, async (req, res) => {
  res.json(await visibleTransfer(req));
});

/** Send stock to another outlet (toOutletId) or request stock from one (fromOutletId). */
inventoryRouter.post("/transfers", manage, async (req, res) => {
  const data = parse(stockTransferCreateSchema, req.body);
  const fromOutletId = data.fromOutletId ?? req.outletId!;
  const toOutletId = data.toOutletId ?? req.outletId!;
  if (fromOutletId === toOutletId) throw badRequest("Source and destination outlets must differ");
  const other = await prisma.outlet.findUnique({ where: { id: data.fromOutletId ?? data.toOutletId! } });
  if (!other) throw badRequest("Unknown outlet");
  await loadItems(data.items.map((i) => i.inventoryItemId));
  // Sender-initiated by someone who can approve for the source → skip the approval step.
  const autoApprove = fromOutletId === req.outletId && canApproveFor(req, fromOutletId);
  const merged = new Map<string, number>();
  for (const i of data.items) merged.set(i.inventoryItemId, round3((merged.get(i.inventoryItemId) ?? 0) + i.quantity));
  const t = await retryTransaction(async (tx) => {
    const created = await tx.stockTransfer.create({
      data: {
        fromOutletId,
        toOutletId,
        notes: data.notes || null,
        requestedById: req.user!.id,
        status: autoApprove ? "APPROVED" : "REQUESTED",
        approvedById: autoApprove ? req.user!.id : null,
        items: { create: [...merged].map(([inventoryItemId, quantity]) => ({ inventoryItemId, quantity })) },
      },
    });
    await audit(req, "inventory.transfer.create", "StockTransfer", created.id, { fromOutletId, toOutletId, autoApprove }, tx);
    return created;
  });
  const otherSide = fromOutletId === req.outletId ? toOutletId : fromOutletId;
  await transferNotify(
    otherSide,
    autoApprove ? "Stock transfer on the way" : "Stock transfer requested",
    `${req.user!.name} ${autoApprove ? "is sending" : "requested"} ${merged.size} item(s)`,
    t.id,
  );
  res.status(201).json(await getTransfer(t.id));
});

inventoryRouter.post("/transfers/:id/approve", manage, async (req, res) => {
  const t = await visibleTransfer(req);
  if (!canApproveFor(req, t.fromOutletId)) throw forbidden("Only the source outlet's manager can approve");
  await retryTransaction(async (tx) => {
    await transition(tx, t.id, "REQUESTED", { status: "APPROVED", approvedById: req.user!.id });
    await audit(req, "inventory.transfer.approve", "StockTransfer", t.id, undefined, tx);
  });
  await transferNotify(t.toOutletId, "Stock transfer approved", `${t.fromOutletName} approved your request`, t.id);
  res.json(await getTransfer(t.id));
});

inventoryRouter.post("/transfers/:id/reject", manage, async (req, res) => {
  const { reason } = parse(stockTransferRejectSchema, req.body);
  const t = await visibleTransfer(req);
  if (!canApproveFor(req, t.fromOutletId)) throw forbidden("Only the source outlet's manager can reject");
  await retryTransaction(async (tx) => {
    await transition(tx, t.id, ["REQUESTED", "APPROVED"], {
      status: "REJECTED",
      approvedById: req.user!.id,
      notes: [t.notes, `Rejected: ${reason}`].filter(Boolean).join("\n"),
    });
    await audit(req, "inventory.transfer.reject", "StockTransfer", t.id, { reason }, tx);
  });
  await transferNotify(t.toOutletId, "Stock transfer rejected", `${t.fromOutletName}: ${reason}`, t.id);
  res.json(await getTransfer(t.id));
});

/** Source outlet sends the goods: TRANSFER_OUT at source. */
inventoryRouter.post("/transfers/:id/dispatch", manage, async (req, res) => {
  const t = await visibleTransfer(req);
  if (!canActFor(req, t.fromOutletId)) throw forbidden("You don't have access to the source outlet");
  await retryTransaction(async (tx) => {
    await transition(tx, t.id, "APPROVED", { status: "DISPATCHED" });
    for (const l of inItemOrder(t.items)) {
      await applyStockMovement(tx, {
        outletId: t.fromOutletId,
        inventoryItemId: l.inventoryItemId,
        type: "TRANSFER_OUT",
        quantity: -l.quantity,
        unitCost: l.item?.costPerUnit,
        refType: "StockTransfer",
        refId: t.id,
        note: `To ${t.toOutletName}`,
        userId: req.user!.id,
      });
    }
    await audit(req, "inventory.transfer.dispatch", "StockTransfer", t.id, undefined, tx);
  });
  await transferNotify(t.toOutletId, "Stock dispatched", `${t.fromOutletName} dispatched ${t.items.length} item(s)`, t.id);
  await alertLowStock(t.fromOutletId, t.items.map((l) => l.inventoryItemId));
  res.json(await getTransfer(t.id));
});

/** Destination confirms receipt: TRANSFER_IN at destination (at the source's cost). */
inventoryRouter.post("/transfers/:id/receive", manage, async (req, res) => {
  const t = await visibleTransfer(req);
  if (!canActFor(req, t.toOutletId)) throw forbidden("You don't have access to the destination outlet");
  await retryTransaction(async (tx) => {
    await transition(tx, t.id, "DISPATCHED", { status: "RECEIVED" });
    const out = await tx.inventoryTransaction.findMany({ where: { refType: "StockTransfer", refId: t.id, type: "TRANSFER_OUT" } });
    const cost = new Map(out.map((o) => [o.inventoryItemId, o.unitCost ?? undefined]));
    for (const l of inItemOrder(t.items)) {
      await applyStockMovement(tx, {
        outletId: t.toOutletId,
        inventoryItemId: l.inventoryItemId,
        type: "TRANSFER_IN",
        quantity: l.quantity,
        unitCost: cost.get(l.inventoryItemId),
        refType: "StockTransfer",
        refId: t.id,
        note: `From ${t.fromOutletName}`,
        userId: req.user!.id,
      });
    }
    await audit(req, "inventory.transfer.receive", "StockTransfer", t.id, undefined, tx);
  });
  await transferNotify(t.fromOutletId, "Stock received", `${t.toOutletName} received the transfer`, t.id);
  res.json(await getTransfer(t.id));
});

inventoryRouter.post("/transfers/:id/cancel", manage, async (req, res) => {
  const t = await visibleTransfer(req);
  if (t.requestedById !== req.user!.id && !canApproveFor(req, t.fromOutletId) && !canApproveFor(req, t.toOutletId)) {
    throw forbidden("Only the requester or a manager can cancel");
  }
  await retryTransaction(async (tx) => {
    await transition(tx, t.id, ["REQUESTED", "APPROVED"], { status: "CANCELLED" });
    await audit(req, "inventory.transfer.cancel", "StockTransfer", t.id, undefined, tx);
  });
  res.json(await getTransfer(t.id));
});

// =====================================================================
// Alerts
// =====================================================================

inventoryRouter.get("/alerts", view, async (req, res) => {
  const items = await lowStockItems(req.outletId!);
  res.json({ count: items.length, outOfStock: items.filter((i) => i.outOfStock).length, items });
});

// =====================================================================
// Reports (JSON, or ?format=xlsx)
// =====================================================================

const itemMeta = async (ids: string[]) =>
  new Map(
    (
      await prisma.inventoryItem.findMany({
        where: { id: { in: [...new Set(ids)] } },
        select: { id: true, name: true, unit: true, category: true, costPerUnit: true },
      })
    ).map((i) => [i.id, i]),
  );

/** Daily consumption per ingredient: sales (net of cancellations) and wastage. */
inventoryRouter.get("/reports/consumption", reports, async (req, res) => {
  const q = parse(inventoryReportQuerySchema, req.query);
  const r = await dateRange(req, q.from, q.to);
  const txns = await prisma.inventoryTransaction.findMany({
    where: {
      outletId: req.outletId,
      type: { in: ["SALE", "SALE_REVERSAL", "WASTAGE"] },
      createdAt: { gte: r.gte, lt: r.lt },
      ...(q.itemId && { inventoryItemId: q.itemId }),
    },
    select: { inventoryItemId: true, type: true, quantity: true, unitCost: true, createdAt: true },
  });
  const meta = await itemMeta(txns.map((t) => t.inventoryItemId));
  const rows = new Map<string, { date: string; inventoryItemId: string; sale: number; wastage: number; value: number }>();
  for (const t of txns) {
    const date = zonedParts(t.createdAt, r.tz).date;
    const k = `${date}|${t.inventoryItemId}`;
    const row = rows.get(k) ?? { date, inventoryItemId: t.inventoryItemId, sale: 0, wastage: 0, value: 0 };
    if (t.type === "WASTAGE") row.wastage -= t.quantity;
    else row.sale -= t.quantity;
    row.value += value(-t.quantity, t.unitCost ?? 0);
    rows.set(k, row);
  }
  const out = [...rows.values()]
    .map((x) => {
      const m = meta.get(x.inventoryItemId)!;
      return { ...x, name: m.name, unit: m.unit, category: m.category, sale: round3(x.sale), wastage: round3(x.wastage), total: round3(x.sale + x.wastage) };
    })
    .sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name));
  await respond(
    req,
    res,
    { from: r.from, to: r.to, rows: out, totalValue: out.reduce((s, x) => s + x.value, 0) },
    {
      name: "Consumption",
      filename: `consumption_${r.from}_${r.to}`,
      columns: [
        { header: "Date", key: "date", width: 12 },
        { header: "Ingredient", key: "name", width: 26 },
        { header: "Unit", key: "unit", width: 8 },
        { header: "Sales", key: "sale" },
        { header: "Wastage", key: "wastage" },
        { header: "Total", key: "total" },
        { header: "Value (₹)", key: "value" },
      ],
      rows: out.map((x) => ({ ...x, value: rupees(x.value) })),
    },
  );
});

/** Opening, in, out and closing per item over a range (with per-type breakdown). */
inventoryRouter.get("/reports/movement", reports, async (req, res) => {
  const q = parse(inventoryReportQuerySchema, req.query);
  const r = await dateRange(req, q.from, q.to);
  const base = { outletId: req.outletId!, ...(q.itemId && { inventoryItemId: q.itemId }) };
  const [opening, moves] = await Promise.all([
    prisma.inventoryTransaction.groupBy({ by: ["inventoryItemId"], where: { ...base, createdAt: { lt: r.gte } }, _sum: { quantity: true } }),
    prisma.inventoryTransaction.groupBy({ by: ["inventoryItemId", "type"], where: { ...base, createdAt: { gte: r.gte, lt: r.lt } }, _sum: { quantity: true } }),
  ]);
  const ids = new Set([...opening.map((o) => o.inventoryItemId), ...moves.map((m) => m.inventoryItemId)]);
  const meta = await itemMeta([...ids]);
  const rows = [...ids]
    .map((id) => {
      const m = meta.get(id)!;
      const open = round3(opening.find((o) => o.inventoryItemId === id)?._sum.quantity ?? 0);
      const byType: Partial<Record<InventoryTxnType, number>> = {};
      let inQty = 0;
      let outQty = 0;
      for (const mv of moves.filter((x) => x.inventoryItemId === id)) {
        const s = mv._sum.quantity ?? 0;
        byType[mv.type] = round3(s);
        if (s >= 0) inQty += s;
        else outQty -= s;
      }
      return {
        inventoryItemId: id,
        name: m.name,
        unit: m.unit,
        category: m.category,
        opening: open,
        in: round3(inQty),
        out: round3(outQty),
        closing: round3(open + inQty - outQty),
        closingValue: value(Math.max(0, open + inQty - outQty), m.costPerUnit),
        byType,
      };
    })
    .sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
  const typeCols = INVENTORY_TXN_TYPES.filter((t) => t !== "OPENING");
  await respond(
    req,
    res,
    { from: r.from, to: r.to, rows },
    {
      name: "Stock movement",
      filename: `stock_movement_${r.from}_${r.to}`,
      columns: [
        { header: "Item", key: "name", width: 26 },
        { header: "Unit", key: "unit", width: 8 },
        { header: "Opening", key: "opening" },
        { header: "In", key: "in" },
        { header: "Out", key: "out" },
        { header: "Closing", key: "closing" },
        ...typeCols.map((t) => ({ header: t.replace("_", " ").toLowerCase(), key: t })),
      ],
      rows: rows.map(({ byType, ...x }) => ({ ...x, ...byType })),
    },
  );
});

/** Current stock valuation (quantity × weighted-average cost). */
inventoryRouter.get("/reports/valuation", reports, async (req, res) => {
  const items = await prisma.inventoryItem.findMany({
    where: { active: true },
    include: { stocks: { where: { outletId: req.outletId } } },
    orderBy: [{ category: "asc" }, { name: "asc" }],
  });
  const rows = items.map((i) => {
    const quantity = i.stocks[0]?.quantity ?? 0;
    return { inventoryItemId: i.id, name: i.name, category: i.category, unit: i.unit, quantity, costPerUnit: i.costPerUnit, value: value(Math.max(0, quantity), i.costPerUnit) };
  });
  const byCategory = Object.entries(
    rows.reduce<Record<string, number>>((acc, r) => ({ ...acc, [r.category]: (acc[r.category] ?? 0) + r.value }), {}),
  ).map(([category, v]) => ({ category, value: v }));
  await respond(
    req,
    res,
    { rows, byCategory, totalValue: rows.reduce((s, r) => s + r.value, 0) },
    {
      name: "Valuation",
      filename: "stock_valuation",
      columns: [
        { header: "Item", key: "name", width: 26 },
        { header: "Category", key: "category", width: 16 },
        { header: "Unit", key: "unit", width: 8 },
        { header: "Quantity", key: "quantity" },
        { header: "Cost/unit (₹)", key: "cost" },
        { header: "Value (₹)", key: "value" },
      ],
      rows: rows.map((r) => ({ ...r, cost: rupees(r.costPerUnit), value: rupees(r.value) })),
    },
  );
});

inventoryRouter.get("/reports/wastage", reports, async (req, res) => {
  const q = parse(inventoryReportQuerySchema, req.query);
  const r = await dateRange(req, q.from, q.to);
  const txns = await prisma.inventoryTransaction.findMany({
    where: { outletId: req.outletId, type: "WASTAGE", createdAt: { gte: r.gte, lt: r.lt }, ...(q.itemId && { inventoryItemId: q.itemId }) },
    orderBy: { createdAt: "asc" },
  });
  const [meta, users] = await Promise.all([
    itemMeta(txns.map((t) => t.inventoryItemId)),
    prisma.user.findMany({ where: { id: { in: txns.map((t) => t.createdById).filter((x): x is string => !!x) } }, select: { id: true, name: true } }),
  ]);
  const userName = new Map(users.map((u) => [u.id, u.name]));
  const rows = txns.map((t) => {
    const m = meta.get(t.inventoryItemId)!;
    return {
      id: t.id,
      date: zonedParts(t.createdAt, r.tz).date,
      createdAt: t.createdAt,
      inventoryItemId: t.inventoryItemId,
      name: m.name,
      unit: m.unit,
      quantity: round3(-t.quantity),
      value: value(-t.quantity, t.unitCost ?? 0),
      reason: t.note,
      by: t.createdById ? (userName.get(t.createdById) ?? null) : null,
    };
  });
  const byItem = Object.values(
    rows.reduce<Record<string, { inventoryItemId: string; name: string; unit: string; quantity: number; value: number }>>((acc, x) => {
      const e = (acc[x.inventoryItemId] ??= { inventoryItemId: x.inventoryItemId, name: x.name, unit: x.unit, quantity: 0, value: 0 });
      e.quantity = round3(e.quantity + x.quantity);
      e.value += x.value;
      return acc;
    }, {}),
  ).sort((a, b) => b.value - a.value);
  await respond(
    req,
    res,
    { from: r.from, to: r.to, rows, byItem, totalValue: rows.reduce((s, x) => s + x.value, 0) },
    {
      name: "Wastage",
      filename: `wastage_${r.from}_${r.to}`,
      columns: [
        { header: "Date", key: "date", width: 12 },
        { header: "Item", key: "name", width: 26 },
        { header: "Unit", key: "unit", width: 8 },
        { header: "Quantity", key: "quantity" },
        { header: "Value (₹)", key: "value" },
        { header: "Reason", key: "reason", width: 30 },
        { header: "By", key: "by", width: 18 },
      ],
      rows: rows.map((x) => ({ ...x, value: rupees(x.value) })),
    },
  );
});

inventoryRouter.get("/reports/vendor-spend", reports, async (req, res) => {
  const q = parse(inventoryReportQuerySchema, req.query);
  const r = await dateRange(req, q.from, q.to);
  const groups = await prisma.purchase.groupBy({
    by: ["vendorId"],
    where: { outletId: req.outletId, status: "RECEIVED", receivedAt: { gte: r.gte, lt: r.lt } },
    _sum: { subtotal: true, tax: true, total: true, paidAmount: true },
    _count: true,
  });
  const vendors = await prisma.vendor.findMany({ where: { id: { in: groups.map((g) => g.vendorId) } }, select: { id: true, name: true } });
  const vname = new Map(vendors.map((v) => [v.id, v.name]));
  const rows = groups
    .map((g) => ({
      vendorId: g.vendorId,
      vendor: vname.get(g.vendorId) ?? "",
      purchases: g._count,
      subtotal: g._sum.subtotal ?? 0,
      tax: g._sum.tax ?? 0,
      total: g._sum.total ?? 0,
      paid: g._sum.paidAmount ?? 0,
      outstanding: (g._sum.total ?? 0) - (g._sum.paidAmount ?? 0),
    }))
    .sort((a, b) => b.total - a.total);
  await respond(
    req,
    res,
    { from: r.from, to: r.to, rows, total: rows.reduce((s, x) => s + x.total, 0), outstanding: rows.reduce((s, x) => s + x.outstanding, 0) },
    {
      name: "Vendor spend",
      filename: `vendor_spend_${r.from}_${r.to}`,
      columns: [
        { header: "Vendor", key: "vendor", width: 26 },
        { header: "Purchases", key: "purchases" },
        { header: "Subtotal (₹)", key: "subtotal" },
        { header: "GST (₹)", key: "tax" },
        { header: "Total (₹)", key: "total" },
        { header: "Paid (₹)", key: "paid" },
        { header: "Outstanding (₹)", key: "outstanding", width: 16 },
      ],
      rows: rows.map((x) => ({ ...x, subtotal: rupees(x.subtotal), tax: rupees(x.tax), total: rupees(x.total), paid: rupees(x.paid), outstanding: rupees(x.outstanding) })),
    },
  );
});

inventoryRouter.get("/reports/purchases", reports, async (req, res) => {
  const q = parse(inventoryReportQuerySchema, req.query);
  const r = await dateRange(req, q.from, q.to);
  const list = await prisma.purchase.findMany({
    where: { outletId: req.outletId, createdAt: { gte: r.gte, lt: r.lt } },
    include: { vendor: { select: { name: true } }, _count: { select: { items: true } } },
    orderBy: { createdAt: "asc" },
  });
  const rows = list.map((p) => ({
    id: p.id,
    date: zonedParts(p.receivedAt ?? p.createdAt, r.tz).date,
    invoiceNo: p.invoiceNo,
    invoiceDate: p.invoiceDate,
    vendor: p.vendor.name,
    status: p.status,
    items: p._count.items,
    subtotal: p.subtotal,
    tax: p.tax,
    total: p.total,
    paid: p.paidAmount,
    balance: p.total - p.paidAmount,
  }));
  const received = rows.filter((x) => x.status === "RECEIVED");
  await respond(
    req,
    res,
    { from: r.from, to: r.to, rows, totals: { received: received.length, total: received.reduce((s, x) => s + x.total, 0), tax: received.reduce((s, x) => s + x.tax, 0), balance: received.reduce((s, x) => s + x.balance, 0) } },
    {
      name: "Purchases",
      filename: `purchases_${r.from}_${r.to}`,
      columns: [
        { header: "Date", key: "date", width: 12 },
        { header: "Invoice", key: "invoiceNo", width: 14 },
        { header: "Vendor", key: "vendor", width: 24 },
        { header: "Status", key: "status", width: 11 },
        { header: "Items", key: "items", width: 8 },
        { header: "Subtotal (₹)", key: "subtotal" },
        { header: "GST (₹)", key: "tax" },
        { header: "Total (₹)", key: "total" },
        { header: "Paid (₹)", key: "paid" },
        { header: "Balance (₹)", key: "balance" },
      ],
      rows: rows.map((x) => ({ ...x, subtotal: rupees(x.subtotal), tax: rupees(x.tax), total: rupees(x.total), paid: rupees(x.paid), balance: rupees(x.balance) })),
    },
  );
});
