import express, { Router } from "express";
import { z } from "zod";
import type { TaxRate } from "@prisma/client";
import { categorySchema, totalTaxPercent, effectiveGstRate, menuItemSchema, roundRate, taxFromRate, toPaise } from "@canavo/shared";
import { prisma } from "../db";
import { audit } from "../lib/audit";
import { badRequest, notFound, param, parse } from "../lib/http";
import { authenticate, requireOutlet, requirePermission, requireAnyModule } from "../middleware/auth";
import { emitToOutlet } from "../realtime";
import { featureOn, moduleEnabled, requireBusinessId } from "../lib/tenant";
import { slotAt } from "../services/meal-slots";
import { defaultTaxRate, resolveItemTax, taxRateBrief } from "../services/tax";
import multer from "multer";
import { announceAvailability, refreshMenuAvailability } from "../services/stock-availability";
import { applyImport, buildTemplate, parseSheet, planImport, summarize } from "../services/menu-import";

export const menuRouter = Router();
menuRouter.use(authenticate, requireOutlet, requireAnyModule("BILLING", "INVENTORY"));

const itemInclude = { variants: true, addons: true, taxRate: true } as const;

/** Item JSON: `taxRate` is the item's own rate ({id, name, cgst, sgst, igst, cess, extras}) or null. */
function itemJson<T extends { taxRate: TaxRate | null }>(item: T) {
  return { ...item, taxRate: taxRateBrief(item.taxRate) };
}

const gstOf = (r: TaxRate) => effectiveGstRate(taxFromRate(r));

/**
 * Resolve taxRateId + gstRate for a create/update so gstRate always equals the
 * effective GST (cgst + sgst) of the rate the item bills at.
 *  - taxRateId given: must belong to the business (foreign ids are "not found").
 *  - taxRateId null: business default (gstRate follows it), else legacy gstRate.
 *  - only gstRate given (older clients): link the matching plain GST rate if one exists.
 */
async function resolveTaxFields(data: { taxRateId?: string | null; gstRate?: number }, isCreate: boolean) {
  if (data.taxRateId) {
    const rate = await prisma.taxRate.findUnique({ where: { id: data.taxRateId } });
    if (!rate) throw badRequest("Tax rate not found");
    return { taxRateId: rate.id, gstRate: gstOf(rate) };
  }
  if (data.taxRateId === undefined && data.gstRate !== undefined) {
    const candidates = await prisma.taxRate.findMany({ where: { active: true, cess: 0 }, orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }] });
    const match = candidates.find(
      (r) => gstOf(r) === roundRate(data.gstRate!) && r.cgst === r.sgst && taxFromRate(r).extras!.length === 0,
    );
    if (match) return { taxRateId: match.id, gstRate: gstOf(match) };
    return { taxRateId: null, gstRate: data.gstRate };
  }
  if (data.taxRateId === null || isCreate) {
    const def = await defaultTaxRate();
    return { taxRateId: null, gstRate: def ? gstOf(def) : (data.gstRate ?? 0) };
  }
  return {};
}

/** Full menu for the active outlet with outlet overrides applied. */
/**
 * 0% GST safeguard (Phase 3.6): on a GST-registered outlet, list menu items whose tax
 * works out to 0%. New items default to 0% (owner request 2026-10-31), so this catches
 * items nobody set a rate for. Only food that is really exempt should stay at 0%.
 */
menuRouter.get("/tax-check", requirePermission("menu:view"), async (req, res) => {
  const outlet = await prisma.outlet.findUniqueOrThrow({ where: { id: req.outletId! }, select: { gstEnabled: true, compositionScheme: true } });
  if (!outlet.gstEnabled || outlet.compositionScheme) return res.json({ applies: false, zeroRated: [] });
  const items = await prisma.menuItem.findMany({ where: {}, select: { id: true, name: true, taxRateId: true, gstRate: true } });
  const taxes = await resolveItemTax(items, requireBusinessId());
  const zeroRated = items.filter((i) => totalTaxPercent(taxes.get(i.id)!, false) === 0).map((i) => ({ id: i.id, name: i.name }));
  res.json({ applies: true, zeroRated });
});

/**
 * Full menu. `?slot=current` (the POS, CANTEEN module, outlet has meal slots): only what sells in
 * the slot open now: items on that slot (at the slot price) plus items on no slot, which sell all day.
 */
menuRouter.get("/", requirePermission("menu:view"), async (req, res) => {
  const slotView = req.query.slot === "current" && moduleEnabled("CANTEEN") ? await currentSlotMenu(req.outletId!) : null;
  const [categories, allItems] = await Promise.all([
    prisma.menuCategory.findMany({ orderBy: [{ sortOrder: "asc" }, { name: "asc" }] }),
    prisma.menuItem.findMany({
      include: { ...itemInclude, overrides: { where: { outletId: req.outletId } } },
      orderBy: { name: "asc" },
    }),
  ]);
  const def = taxRateBrief(await defaultTaxRate());
  const autoStock = featureOn("AUTO_STOCK_OUT");
  const items = slotView ? allItems.filter((i) => !slotView.onSomeSlot.has(i.id) || slotView.prices.has(i.id)) : allItems;
  res.json({
    categories,
    ...(slotView && { mealSlot: slotView.slot }),
    items: items.map(({ overrides, ...item }) => ({
      ...itemJson(item),
      /** Rate the item is billed at: its own, else the business default (null = legacy gstRate split equally) */
      effectiveTaxRate: taxRateBrief(item.taxRate) ?? def,
      basePrice: item.price,
      price: slotView?.prices.get(item.id) ?? overrides[0]?.price ?? item.price,
      /** Effective status at this outlet: an ingredient that ran out makes an available item OUT_OF_STOCK */
      status: autoStock && overrides[0]?.stockOut && (overrides[0]?.status ?? item.status) === "AVAILABLE" ? "OUT_OF_STOCK" : (overrides[0]?.status ?? item.status),
      /** The status a manager set (outlet override or the item's own) */
      manualStatus: overrides[0]?.status ?? item.status,
      /** Automatic out-of-stock from inventory (comes back by itself when restocked) */
      stockOut: autoStock && (overrides[0]?.stockOut ?? false),
      stockOutReason: autoStock ? (overrides[0]?.stockOutReason ?? null) : null,
      /** Sizes that can't be sold right now (ingredient ran out) */
      unavailableVariantIds: autoStock ? (overrides[0]?.stockOutVariantIds ?? []) : [],
      hasOverride: overrides[0]?.price != null || overrides[0]?.status != null,
    })),
  });
});

/** Phase 5.3: the slot open now and its menu; null when the outlet has no active slots (normal menu). */
export async function currentSlotMenu(outletId: string) {
  const rows = await prisma.mealSlotItem.findMany({ where: { slot: { outletId, active: true } }, select: { slotId: true, menuItemId: true, price: true } });
  if (!(await prisma.mealSlot.count({ where: { outletId, active: true } }))) return null;
  const outlet = await prisma.outlet.findUniqueOrThrow({ where: { id: outletId }, select: { timezone: true } });
  const slot = await slotAt(outletId, new Date(), outlet.timezone);
  const prices = new Map<string, number | null>();
  for (const r of rows) if (r.slotId === slot?.id) prices.set(r.menuItemId, r.price);
  return {
    slot: slot && { id: slot.id, name: slot.name, startTime: slot.startTime, endTime: slot.endTime },
    onSomeSlot: new Set(rows.map((r) => r.menuItemId)),
    /** Items on the current slot → slot price (null = normal price) */
    prices,
  };
}

// ---------- Categories ----------
menuRouter.post("/categories", requirePermission("menu:manage"), async (req, res) => {
  const data = parse(categorySchema, req.body);
  res.status(201).json(await prisma.menuCategory.create({ data: { ...data, businessId: requireBusinessId() } }));
});

menuRouter.patch("/categories/:id", requirePermission("menu:manage"), async (req, res) => {
  const data = parse(categorySchema.partial(), req.body);
  res.json(await prisma.menuCategory.update({ where: { id: param(req, "id") }, data }));
});

menuRouter.delete("/categories/:id", requirePermission("menu:manage"), async (req, res) => {
  const id = param(req, "id");
  const used = await prisma.menuItem.count({ where: { categoryId: id } });
  if (used) throw badRequest(`Category has ${used} item(s); move or delete them first`);
  await prisma.menuCategory.updateMany({ where: { parentId: id }, data: { parentId: null } });
  await prisma.menuCategory.delete({ where: { id } });
  res.status(204).end();
});

// ---------- Items ----------
function itemData(data: z.infer<typeof menuItemSchema>) {
  const { variants: _v, addons: _a, ...rest } = data;
  return { ...rest, imageUrl: rest.imageUrl || null };
}

menuRouter.post("/items", requirePermission("menu:manage"), async (req, res) => {
  const body = req.body as { gstRate?: unknown } | undefined;
  const data = parse(menuItemSchema, req.body);
  // gstRate has a schema default; only treat it as the client's choice when actually sent.
  const tax = await resolveTaxFields({ taxRateId: data.taxRateId, gstRate: body?.gstRate !== undefined ? data.gstRate : undefined }, true);
  const item = await prisma.menuItem.create({
    data: {
      ...itemData(data),
      ...tax,
      businessId: requireBusinessId(),
      variants: { create: data.variants },
      addons: { create: data.addons },
    },
    include: itemInclude,
  });
  await audit(req, "menu.item.create", "MenuItem", item.id);
  emitToOutlet(req.outletId!, "menu:changed", { id: item.id });
  res.status(201).json(itemJson(item));
});

menuRouter.patch("/items/:id", requirePermission("menu:manage"), async (req, res) => {
  const id = param(req, "id");
  const data = parse(menuItemSchema.partial(), req.body);
  const { variants, addons, ...rest } = data;
  if (!(await prisma.menuItem.findUnique({ where: { id }, select: { id: true } }))) throw notFound("Menu item");
  const tax = await resolveTaxFields({ taxRateId: data.taxRateId, gstRate: data.gstRate }, false);
  const item = await prisma.menuItem.update({
    where: { id },
    data: {
      ...rest,
      ...tax,
      ...(rest.imageUrl !== undefined && { imageUrl: rest.imageUrl || null }),
      ...(variants && { variants: { deleteMany: {}, create: variants } }),
      ...(addons && { addons: { deleteMany: {}, create: addons } }),
    },
    include: itemInclude,
  });
  await audit(req, "menu.item.update", "MenuItem", id, { fields: Object.keys(data), ...(tax.taxRateId !== undefined && { taxRateId: tax.taxRateId }) });
  emitToOutlet(req.outletId!, "menu:changed", { id });
  res.json(itemJson(item));
});

menuRouter.delete("/items/:id", requirePermission("menu:manage"), async (req, res) => {
  const id = param(req, "id");
  const sold = await prisma.orderItem.count({ where: { menuItemId: id } });
  // Items on past invoices are hidden, not deleted, to keep invoice history intact.
  if (sold) await prisma.menuItem.update({ where: { id }, data: { status: "HIDDEN" } });
  else await prisma.menuItem.delete({ where: { id } });
  emitToOutlet(req.outletId!, "menu:changed", { id });
  res.status(204).end();
});

/** Outlet-level price / availability override (e.g. "out of stock at this branch only"). */
menuRouter.put("/items/:id/override", requirePermission("menu:manage"), async (req, res) => {
  const id = param(req, "id");
  const data = parse(
    z.object({
      price: z.number().int().nonnegative().nullable().optional(),
      status: z.enum(["AVAILABLE", "OUT_OF_STOCK", "HIDDEN"]).nullable().optional(),
    }),
    req.body,
  );
  const item = await prisma.menuItem.findUnique({ where: { id }, include: { overrides: { where: { outletId: req.outletId } } } });
  if (!item) throw notFound("Menu item");
  // Omitted fields keep their current override; null clears it. A value equal
  // to the global one is stored as "no override" so later global changes apply.
  const current = item.overrides[0];
  let price = data.price === undefined ? (current?.price ?? null) : data.price;
  let status = data.status === undefined ? (current?.status ?? null) : data.status;
  if (price === item.price) price = null;
  if (status === item.status) status = null;

  const key = { outletId_menuItemId: { outletId: req.outletId!, menuItemId: id } };
  if (price == null && status == null) {
    await prisma.outletItemOverride.deleteMany({ where: { outletId: req.outletId, menuItemId: id } });
    emitToOutlet(req.outletId!, "menu:changed", { id });
    return res.status(204).end();
  }
  const override = await prisma.outletItemOverride.upsert({
    where: key,
    create: { outletId: req.outletId!, menuItemId: id, price, status },
    update: { price, status },
  });
  emitToOutlet(req.outletId!, "menu:changed", { id });
  res.json(override);
});

menuRouter.get("/items/:id", requirePermission("menu:view"), async (req, res) => {
  const item = await prisma.menuItem.findUnique({ where: { id: param(req, "id") }, include: itemInclude });
  if (!item) throw notFound("Menu item");
  res.json(itemJson(item));
});

// ---------- Bulk import (Excel template / CSV) ----------
const importUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1 } });

/** Excel template with the columns, examples, the business's GST rates, categories and stock items. */
menuRouter.get("/import/template", requirePermission("menu:manage"), async (_req, res) => {
  const buf = await buildTemplate();
  res.setHeader("content-disposition", 'attachment; filename="canavo-menu-template.xlsx"');
  res.type("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet").send(buf);
});

/**
 * Upload a filled template (field "file"). Without ?apply=1 nothing is saved:
 * returns a per-row preview (create / update / error). With ?apply=1 the valid
 * rows are saved in one transaction; rows with errors are skipped.
 */
menuRouter.post("/import", requirePermission("menu:manage"), importUpload.single("file"), async (req, res) => {
  if (!req.file) throw badRequest("Attach the filled template as \"file\"");
  const { rows } = await parseSheet(req.file.buffer, req.file.originalname);
  if (!rows.length) throw badRequest("The sheet has no item rows");
  const planned = await planImport(rows);
  const apply = req.query.apply === "1" || req.query.apply === "true";
  if (apply) {
    if (!planned.some((r) => r.action !== "error")) throw badRequest("No valid rows to import");
    await applyImport(planned);
    // Imported ingredients may already be out of stock at this outlet
    if (featureOn("AUTO_STOCK_OUT")) await announceAvailability(prisma, req.outletId!, await refreshMenuAvailability(prisma, req.outletId!));
    const result = summarize(planned, true);
    await audit(req, "menu.import", "MenuItem", undefined, result.summary);
    emitToOutlet(req.outletId!, "menu:changed", { import: true });
    return res.json(result);
  }
  res.json(summarize(planned, false));
});
