import type { InventoryTxnType, Prisma, StockUnit } from "@prisma/client";
import { prisma } from "../db";
import { badRequest } from "../lib/http";
import { emitToOutlet } from "../realtime";
import { notify, outletManagers } from "./notify";

type Tx = Prisma.TransactionClient;

// =====================================================================
// Pure helpers (unit-tested without a DB)
// =====================================================================

/** Round a stock quantity to 3 decimals (grams / millilitres precision for KG / L). */
export const round3 = (n: number): number => Math.round((n + Number.EPSILON) * 1000) / 1000;

/** Base unit + factor for each convertible unit family. PACKET / BOX only convert to themselves. */
const UNIT_BASE: Record<StockUnit, { base: string; factor: number }> = {
  KG: { base: "G", factor: 1000 },
  G: { base: "G", factor: 1 },
  L: { base: "ML", factor: 1000 },
  ML: { base: "ML", factor: 1 },
  DOZEN: { base: "PIECE", factor: 12 },
  PIECE: { base: "PIECE", factor: 1 },
  PACKET: { base: "PACKET", factor: 1 },
  BOX: { base: "BOX", factor: 1 },
};

export function unitsCompatible(from: StockUnit, to: StockUnit): boolean {
  return UNIT_BASE[from].base === UNIT_BASE[to].base;
}

/** Convert a quantity between units of the same family (KG↔G, L↔ML, DOZEN↔PIECE). Throws a 400 otherwise. */
export function convertQuantity(quantity: number, from: StockUnit, to: StockUnit): number {
  if (from === to) return quantity;
  if (!unitsCompatible(from, to)) throw badRequest(`Cannot convert ${from} to ${to}`);
  return round3((quantity * UNIT_BASE[from].factor) / UNIT_BASE[to].factor);
}

/**
 * Weighted-average cost (paise per unit) after adding `addQty` at `addCost`
 * to `existingQty` valued at `existingCost`. Negative/zero existing stock is
 * ignored so a stock-out doesn't distort the new cost.
 */
export function weightedAverageCost(existingQty: number, existingCost: number, addQty: number, addCost: number): number {
  const eq = Math.max(0, existingQty);
  if (addQty <= 0) return existingCost;
  if (eq === 0) return Math.round(addCost);
  return Math.round((eq * existingCost + addQty * addCost) / (eq + addQty));
}

export interface RecipeRow {
  menuItemId: string;
  variantId: string | null;
  inventoryItemId: string;
  quantity: number;
}

/**
 * Recipe lines for a sold item: rows for the exact variant override the
 * variant-less default rows for the same menu item (whole-recipe override).
 */
export function resolveRecipe<R extends RecipeRow>(recipes: R[], menuItemId: string, variantId: string | null | undefined): R[] {
  const forItem = recipes.filter((r) => r.menuItemId === menuItemId);
  if (variantId) {
    const specific = forItem.filter((r) => r.variantId === variantId);
    if (specific.length) return specific;
  }
  return forItem.filter((r) => r.variantId === null);
}

/** Total ingredient consumption (item's unit) for a set of order lines. */
export function computeConsumption(
  lines: { menuItemId: string; variantId: string | null; quantity: number }[],
  recipes: RecipeRow[],
): Map<string, number> {
  const out = new Map<string, number>();
  for (const line of lines) {
    for (const r of resolveRecipe(recipes, line.menuItemId, line.variantId)) {
      out.set(r.inventoryItemId, round3((out.get(r.inventoryItemId) ?? 0) + r.quantity * line.quantity));
    }
  }
  return out;
}

/** Ingredient cost (paise) of one unit of a recipe. */
export function recipeCost(lines: { quantity: number; costPerUnit: number }[]): number {
  return Math.round(lines.reduce((s, l) => s + l.quantity * l.costPerUnit, 0));
}

/** Net (pre-tax) selling price in paise; `gstRate` is the item's total inclusive tax rate. */
export function netPrice(price: number, gstRate: number, pricesIncludeTax: boolean): number {
  return pricesIncludeTax ? Math.round((price * 100) / (100 + gstRate)) : price;
}

export const isLowStock = (quantity: number, reorderLevel: number) => reorderLevel > 0 && quantity <= reorderLevel;

// =====================================================================
// Stock movements — every change to InventoryStock goes through here
// =====================================================================

export interface StockMovement {
  outletId: string;
  inventoryItemId: string;
  type: InventoryTxnType;
  /** Signed, in the item's unit (+ in, − out) */
  quantity: number;
  /** Paise per unit; defaults to the item's current cost */
  unitCost?: number;
  refType?: string;
  refId?: string;
  note?: string;
  userId?: string;
}

export async function applyStockMovement(tx: Tx, m: StockMovement) {
  const quantity = round3(m.quantity);
  if (quantity === 0) return null;
  let unitCost = m.unitCost;
  if (unitCost === undefined) {
    const item = await tx.inventoryItem.findUnique({ where: { id: m.inventoryItemId }, select: { costPerUnit: true } });
    unitCost = item?.costPerUnit ?? 0;
  }
  const key = { outletId_inventoryItemId: { outletId: m.outletId, inventoryItemId: m.inventoryItemId } };
  // Atomic increment; the returned row reflects this movement (row lock held until commit).
  let stock = await tx.inventoryStock.upsert({
    where: key,
    create: { outletId: m.outletId, inventoryItemId: m.inventoryItemId, quantity },
    update: { quantity: { increment: quantity } },
  });
  const rounded = round3(stock.quantity);
  if (rounded !== stock.quantity) stock = await tx.inventoryStock.update({ where: key, data: { quantity: rounded } });
  return tx.inventoryTransaction.create({
    data: {
      outletId: m.outletId,
      inventoryItemId: m.inventoryItemId,
      type: m.type,
      quantity,
      unitCost,
      balanceAfter: rounded,
      refType: m.refType,
      refId: m.refId,
      note: m.note,
      createdById: m.userId,
    },
  });
}

/** Update an item's weighted-average cost for stock coming in (call BEFORE applying the movement). */
export async function updateWeightedCost(tx: Tx, inventoryItemId: string, addQty: number, addCost: number) {
  const item = await tx.inventoryItem.findUniqueOrThrow({ where: { id: inventoryItemId }, select: { costPerUnit: true } });
  const stocks = await tx.inventoryStock.findMany({ where: { inventoryItemId }, select: { quantity: true } });
  const existing = stocks.reduce((s, x) => s + Math.max(0, x.quantity), 0);
  const cost = weightedAverageCost(existing, item.costPerUnit, addQty, addCost);
  if (cost !== item.costPerUnit) await tx.inventoryItem.update({ where: { id: inventoryItemId }, data: { costPerUnit: cost } });
  return cost;
}

// =====================================================================
// Billing hooks
// =====================================================================

/**
 * Billing hook (owned by the Inventory module): deduct ingredient stock for
 * every item on a newly created bill, using recipes. Called inside the order
 * transaction. Must never throw because stock is short — billing always wins;
 * negative stock is allowed and surfaces as an alert.
 */
export async function deductStockForOrder(tx: Tx, orderId: string): Promise<void> {
  const already = await tx.inventoryTransaction.count({ where: { refType: "Order", refId: orderId, type: "SALE" } });
  if (already) return;
  const order = await tx.order.findUnique({
    where: { id: orderId },
    select: { outletId: true, cashierId: true, invoiceNumber: true, items: { select: { menuItemId: true, variantId: true, quantity: true } } },
  });
  if (!order || order.items.length === 0) return;
  const recipes = await tx.recipe.findMany({
    where: { menuItemId: { in: [...new Set(order.items.map((i) => i.menuItemId))] }, item: { active: true } },
    select: { menuItemId: true, variantId: true, inventoryItemId: true, quantity: true, item: { select: { costPerUnit: true } } },
  });
  if (recipes.length === 0) return;
  const cost = new Map(recipes.map((r) => [r.inventoryItemId, r.item.costPerUnit]));
  const usage = computeConsumption(order.items, recipes);
  for (const [inventoryItemId, qty] of [...usage].sort(([a], [b]) => a.localeCompare(b))) {
    await applyStockMovement(tx, {
      outletId: order.outletId,
      inventoryItemId,
      type: "SALE",
      quantity: -qty,
      unitCost: cost.get(inventoryItemId),
      refType: "Order",
      refId: orderId,
      note: order.invoiceNumber,
      userId: order.cashierId,
    });
  }
}

/** Billing hook: put stock back when a bill is cancelled (idempotent). */
export async function restoreStockForOrder(tx: Tx, orderId: string): Promise<void> {
  const txns = await tx.inventoryTransaction.findMany({
    where: { refType: "Order", refId: orderId, type: { in: ["SALE", "SALE_REVERSAL"] } },
    orderBy: { inventoryItemId: "asc" },
  });
  // Net still-deducted quantity per (outlet, item): SALE is negative, reversal positive.
  const net = new Map<string, { outletId: string; inventoryItemId: string; qty: number; unitCost: number | null }>();
  for (const t of txns) {
    const k = `${t.outletId}:${t.inventoryItemId}`;
    const e = net.get(k) ?? { outletId: t.outletId, inventoryItemId: t.inventoryItemId, qty: 0, unitCost: null };
    e.qty += t.quantity;
    if (t.type === "SALE") e.unitCost = t.unitCost;
    net.set(k, e);
  }
  for (const e of net.values()) {
    const restore = round3(-e.qty);
    if (restore <= 0) continue;
    await applyStockMovement(tx, {
      outletId: e.outletId,
      inventoryItemId: e.inventoryItemId,
      type: "SALE_REVERSAL",
      quantity: restore,
      unitCost: e.unitCost ?? undefined,
      refType: "Order",
      refId: orderId,
      note: "Bill cancelled",
    });
  }
}

// =====================================================================
// Low-stock alerts
// =====================================================================

const ALERT_COOLDOWN_MS = 6 * 60 * 60 * 1000;
const alertKey = (itemId: string) => `inventory.lowStockAlert.${itemId}`;

/** Outlet managers, super admins and inventory managers assigned to the outlet. */
export async function inventoryRecipients(outletId: string): Promise<string[]> {
  const [managers, inv] = await Promise.all([
    outletManagers(outletId),
    prisma.user.findMany({
      where: { status: "ACTIVE", role: "INVENTORY_MANAGER", outlets: { some: { outletId } } },
      select: { id: true },
    }),
  ]);
  return [...new Set([...managers, ...inv.map((u) => u.id)])];
}

/** Active items at or below their reorder level at an outlet. */
export async function lowStockItems(outletId: string, itemIds?: string[]) {
  const items = await prisma.inventoryItem.findMany({
    where: { active: true, reorderLevel: { gt: 0 }, ...(itemIds && { id: { in: itemIds } }) },
    include: { stocks: { where: { outletId } } },
    orderBy: { name: "asc" },
  });
  return items
    .map(({ stocks, ...i }) => ({ ...i, quantity: stocks[0]?.quantity ?? 0 }))
    .filter((i) => isLowStock(i.quantity, i.reorderLevel))
    .map((i) => ({
      ...i,
      outOfStock: i.quantity <= 0,
      suggestedOrderQty: round3(Math.max(i.reorderQty, i.reorderLevel - i.quantity)),
    }));
}

/**
 * Notify about low stock for the given items, at most once per item per
 * outlet every 6 hours. Returns the items that were alerted.
 */
export async function alertLowStock(outletId: string, itemIds: string[]) {
  if (itemIds.length === 0) return [];
  const low = await lowStockItems(outletId, itemIds);
  if (low.length === 0) return [];
  const now = Date.now();
  const recent = await prisma.setting.findMany({
    where: { scope: outletId, key: { in: low.map((i) => alertKey(i.id)) } },
  });
  const lastAt = new Map(recent.map((s) => [s.key, Date.parse(String((s.value as { at?: string })?.at ?? ""))]));
  const fresh = low.filter((i) => !(now - (lastAt.get(alertKey(i.id)) ?? 0) < ALERT_COOLDOWN_MS));
  if (fresh.length === 0) return [];
  for (const i of fresh) {
    const value = { at: new Date(now).toISOString(), quantity: i.quantity };
    await prisma.setting.upsert({
      where: { scope_key: { scope: outletId, key: alertKey(i.id) } },
      create: { scope: outletId, key: alertKey(i.id), value },
      update: { value },
    });
  }
  const list = fresh.map((i) => `${i.name}: ${i.quantity} ${i.unit} (reorder at ${i.reorderLevel})`);
  const title = fresh.length === 1 ? `Low stock: ${fresh[0].name}` : `Low stock: ${fresh.length} items`;
  await notify(await inventoryRecipients(outletId), title, list.join("\n"), "inventory.low");
  emitToOutlet(outletId, "inventory:low", {
    items: fresh.map((i) => ({ id: i.id, name: i.name, unit: i.unit, quantity: i.quantity, reorderLevel: i.reorderLevel })),
  });
  return fresh;
}

/** Called after the order transaction commits: emit low-stock alerts (outside tx). */
export async function checkLowStockAfterOrder(outletId: string, orderId: string): Promise<void> {
  const txns = await prisma.inventoryTransaction.findMany({
    where: { refType: "Order", refId: orderId, type: "SALE", outletId },
    select: { inventoryItemId: true },
  });
  await alertLowStock(outletId, [...new Set(txns.map((t) => t.inventoryItemId))]);
}
