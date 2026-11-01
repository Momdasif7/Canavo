import { Router, type NextFunction, type Request, type Response } from "express";
import type { Prisma, TaxRate } from "@prisma/client";
import {
  effectiveGstRate,
  permissionEnabled,
  roundRate,
  taxFromRate,
  taxRateSchema,
  taxRateUpdateSchema,
  type Permission,
} from "@canavo/shared";
import { prisma } from "../db";
import { audit } from "../lib/audit";
import { badRequest, conflict, forbidden, HttpError, notFound, param, parse, unauthorized } from "../lib/http";
import { requireBusinessId, tenant } from "../lib/tenant";
import { authenticate, requireBusiness, requireOutlet, requirePermission, userCan } from "../middleware/auth";
import { taxRateJson } from "../services/tax";

/**
 * Custom tax rates of the business (CGST/SGST/IGST, cess and extra named
 * taxes). Menu items link to a rate; items without one use the default rate.
 */
export const taxRatesRouter = Router();

/** Enter the outlet's business when X-Outlet-Id is sent (super admins); owners/staff already have one. */
const outletIfGiven = (req: Request, res: Response, next: NextFunction) =>
  req.header("x-outlet-id") ? requireOutlet(req, res, next) : next();

/** Any one of the permissions (role ∩ business modules). */
const requireAnyPermission =
  (...permissions: Permission[]) =>
  (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) throw unauthorized();
    const modules = tenant()?.modules ?? null;
    if (!permissions.some((p) => userCan(req, p) && permissionEnabled(p, modules))) throw forbidden("Insufficient permissions");
    next();
  };

taxRatesRouter.use(authenticate, outletIfGiven, requireBusiness);

const CGST_SGST_WARNING = "CGST and SGST are normally equal (each is half of the GST rate). Check the rate before using it.";
const IGST_WARNING = "IGST is normally CGST + SGST. Inter-state bills will charge the IGST you entered.";

function warningsFor(r: { cgst: number; sgst: number; igst: number }): string[] {
  const w: string[] = [];
  if (r.cgst !== r.sgst) w.push(CGST_SGST_WARNING);
  if (roundRate(r.cgst + r.sgst) !== roundRate(r.igst)) w.push(IGST_WARNING);
  return w;
}

const withCount = { _count: { select: { menuItems: true } } } as const;
type RateWithCount = TaxRate & { _count: { menuItems: number } };
const rateOut = (r: RateWithCount) => ({ ...taxRateJson(r), itemCount: r._count.menuItems });

async function assertUniqueName(name: string, exceptId?: string) {
  const clash = await prisma.taxRate.findFirst({
    where: { name: { equals: name, mode: "insensitive" }, ...(exceptId && { id: { not: exceptId } }) },
    select: { id: true },
  });
  if (clash) throw conflict(`A tax rate named "${name}" already exists`);
}

/**
 * Keep MenuItem.gstRate (display / back-compat) equal to the effective GST of
 * the rate the item bills at: its own rate, or the default for unlinked items.
 */
async function syncItemGstRates(tx: Prisma.TransactionClient, rate: TaxRate) {
  const gstRate = effectiveGstRate(taxFromRate(rate));
  await tx.menuItem.updateMany({ where: { taxRateId: rate.id }, data: { gstRate } });
  if (rate.isDefault && rate.active) await tx.menuItem.updateMany({ where: { taxRateId: null }, data: { gstRate } });
}

taxRatesRouter.get("/", requireAnyPermission("menu:view", "settings:billing"), async (_req, res) => {
  const rates = await prisma.taxRate.findMany({ include: withCount, orderBy: [{ isDefault: "desc" }, { active: "desc" }, { name: "asc" }] });
  res.json(rates.map(rateOut));
});

taxRatesRouter.get("/:id", requireAnyPermission("menu:view", "settings:billing"), async (req, res) => {
  const rate = await prisma.taxRate.findUnique({ where: { id: param(req, "id") }, include: withCount });
  if (!rate) throw notFound("Tax rate");
  res.json(rateOut(rate));
});

taxRatesRouter.post("/", requirePermission("settings:billing"), async (req, res) => {
  const data = parse(taxRateSchema, req.body);
  const igst = data.igst ?? roundRate(data.cgst + data.sgst);
  if (data.isDefault && !data.active) throw badRequest("An inactive rate cannot be the default");
  await assertUniqueName(data.name);
  const rate = await prisma.$transaction(async (tx) => {
    // Exactly one default per business: the first active rate becomes the default automatically.
    const hasDefault = await tx.taxRate.count({ where: { isDefault: true } });
    const isDefault = data.isDefault || (!hasDefault && data.active);
    if (isDefault) await tx.taxRate.updateMany({ where: { isDefault: true }, data: { isDefault: false } });
    const created = await tx.taxRate.create({
      data: { ...data, igst, isDefault, extras: data.extras, businessId: requireBusinessId() },
      include: withCount,
    });
    if (isDefault) await syncItemGstRates(tx, created);
    await audit(req, "tax_rate.create", "TaxRate", created.id, { name: created.name, cgst: created.cgst, sgst: created.sgst, igst, cess: created.cess, extras: data.extras, isDefault }, tx);
    return created;
  });
  const warnings = warningsFor(rate);
  res.status(201).json({ ...rateOut(rate), ...(warnings.length && { warnings }) });
});

taxRatesRouter.patch("/:id", requirePermission("settings:billing"), async (req, res) => {
  const id = param(req, "id");
  const data = parse(taxRateUpdateSchema, req.body);
  const current = await prisma.taxRate.findUnique({ where: { id } });
  if (!current) throw notFound("Tax rate");
  if (data.name !== undefined) await assertUniqueName(data.name, id);

  const cgst = data.cgst ?? current.cgst;
  const sgst = data.sgst ?? current.sgst;
  // IGST follows CGST + SGST unless given explicitly.
  const igst = data.igst ?? (data.cgst !== undefined || data.sgst !== undefined ? roundRate(cgst + sgst) : current.igst);
  const active = data.active ?? current.active;
  const isDefault = data.isDefault ?? current.isDefault;
  if (current.isDefault && data.isDefault === false) throw badRequest("Make another rate the default instead of unsetting it");
  if (isDefault && !active) throw badRequest(current.isDefault ? "Make another rate the default before deactivating this one" : "An inactive rate cannot be the default");

  const rate = await prisma.$transaction(async (tx) => {
    if (isDefault && !current.isDefault) await tx.taxRate.updateMany({ where: { isDefault: true, id: { not: id } }, data: { isDefault: false } });
    const updated = await tx.taxRate.update({
      where: { id },
      data: { ...data, igst, ...(data.extras && { extras: data.extras }) },
      include: withCount,
    });
    await syncItemGstRates(tx, updated);
    await audit(req, "tax_rate.update", "TaxRate", id, { fields: Object.keys(data), before: taxRateJson(current), after: taxRateJson(updated) } as unknown as Prisma.InputJsonValue, tx);
    return updated;
  });
  const warnings = warningsFor(rate);
  res.json({ ...rateOut(rate), ...(warnings.length && { warnings }) });
});

/**
 * Delete a rate. A rate used by menu items is refused with 409 and the item
 * count, unless `?reassignTo=<rateId>` moves those items first. Deleting the
 * default needs `reassignTo` (which then becomes the default) while other rates exist.
 */
taxRatesRouter.delete("/:id", requirePermission("settings:billing"), async (req, res) => {
  const id = param(req, "id");
  const reassignTo = typeof req.query.reassignTo === "string" && req.query.reassignTo ? req.query.reassignTo : undefined;
  const rate = await prisma.taxRate.findUnique({ where: { id }, include: withCount });
  if (!rate) throw notFound("Tax rate");
  if (reassignTo === id) throw badRequest("reassignTo must be a different tax rate");
  const target = reassignTo ? await prisma.taxRate.findUnique({ where: { id: reassignTo } }) : null;
  if (reassignTo && !target) throw notFound("Tax rate to reassign to");
  if (target && !target.active) throw badRequest("Reassign items to an active tax rate");

  const itemCount = rate._count.menuItems;
  if (itemCount && !target) {
    throw new HttpError(409, `This tax rate is used by ${itemCount} menu item(s). Reassign them to another rate first.`, { itemCount });
  }
  if (rate.isDefault && !target && (await prisma.taxRate.count({ where: { id: { not: id } } }))) {
    throw new HttpError(409, "This is the default tax rate. Make another rate the default first, or pass reassignTo.", { itemCount });
  }

  await prisma.$transaction(async (tx) => {
    if (target) {
      await tx.menuItem.updateMany({ where: { taxRateId: id }, data: { taxRateId: target.id } });
      if (rate.isDefault) await tx.taxRate.update({ where: { id: target.id }, data: { isDefault: true } });
    }
    await tx.taxRate.delete({ where: { id } });
    if (target) await syncItemGstRates(tx, { ...target, isDefault: target.isDefault || rate.isDefault });
    await audit(req, "tax_rate.delete", "TaxRate", id, { name: rate.name, itemCount, reassignTo: target?.id ?? null }, tx);
  });
  res.status(204).end();
});
