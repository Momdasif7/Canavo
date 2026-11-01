import type { Outlet, Prisma, TaxRate } from "@prisma/client";
import {
  effectiveGstRate,
  legacyTax,
  parseTaxExtras,
  taxFromRate,
  totalTaxPercent,
  type LineTax,
  type TaxConfig,
} from "@canavo/shared";
import { prisma } from "../db";

type Db = Prisma.TransactionClient | typeof prisma;

/** Minimal menu-item shape needed to resolve its tax. */
export interface TaxableItem {
  id: string;
  gstRate: number;
  taxRateId: string | null;
}

/** API JSON for a tax rate (extras normalised). */
export function taxRateJson(r: TaxRate) {
  return {
    id: r.id,
    name: r.name,
    cgst: r.cgst,
    sgst: r.sgst,
    igst: r.igst,
    cess: r.cess,
    extras: parseTaxExtras(r.extras),
    isDefault: r.isDefault,
    active: r.active,
  };
}

/** Compact rate for embedding in menu items: {id, name, cgst, sgst, igst, cess, extras}. */
export function taxRateBrief(r: TaxRate | null | undefined) {
  if (!r) return null;
  const { id, name, cgst, sgst, igst, cess, extras } = taxRateJson(r);
  return { id, name, cgst, sgst, igst, cess, extras };
}

/**
 * The business default tax rate. Inside a request the tenant filter scopes it;
 * pass `businessId` outside a request (seeds, jobs).
 */
export function defaultTaxRate(businessId?: string, db: Db = prisma) {
  return db.taxRate.findFirst({
    where: { isDefault: true, active: true, ...(businessId && { businessId }) },
    orderBy: { createdAt: "asc" },
  });
}

/** Item tax: its own rate → business default rate → legacy gstRate split equally. */
export function itemTax(item: Pick<TaxableItem, "gstRate">, rate: TaxRate | null | undefined, fallback: TaxRate | null | undefined): LineTax {
  if (rate) return taxFromRate(rate);
  if (fallback) return taxFromRate(fallback);
  return legacyTax(item.gstRate);
}

/**
 * Resolve the tax composition of each menu item (keyed by item id). Used by
 * billing, previews, table estimates, promotions and costing so they all agree.
 */
export async function resolveItemTax(items: TaxableItem[], businessId?: string, db: Db = prisma): Promise<Map<string, LineTax>> {
  const ids = [...new Set(items.map((i) => i.taxRateId).filter((x): x is string => Boolean(x)))];
  const needsDefault = items.some((i) => !i.taxRateId);
  const [rates, fallback] = await Promise.all([
    ids.length ? db.taxRate.findMany({ where: { id: { in: ids }, ...(businessId && { businessId }) } }) : Promise.resolve([] as TaxRate[]),
    needsDefault ? defaultTaxRate(businessId, db) : Promise.resolve(null),
  ]);
  const byId = new Map(rates.map((r) => [r.id, r]));
  const def = fallback ?? (ids.length && items.some((i) => i.taxRateId && !byId.has(i.taxRateId)) ? await defaultTaxRate(businessId, db) : null);
  return new Map(items.map((i) => [i.id, itemTax(i, i.taxRateId ? byId.get(i.taxRateId) : null, def)]));
}

type OutletTax = Pick<
  Outlet,
  "pricesIncludeTax" | "compositionScheme" | "gstEnabled" | "serviceChargeEnabled" | "serviceChargePercent" | "roundOff"
> & { flatDiscountsIncludeTax?: boolean };

/** computeBill config for an outlet. Service charge applies to dine-in only. */
export function taxConfigForOutlet(
  outlet: OutletTax,
  opts: { interState?: boolean; orderType?: string; extraCharges?: TaxConfig["extraCharges"] } = {},
): TaxConfig {
  return {
    pricesIncludeTax: outlet.pricesIncludeTax,
    interState: Boolean(opts.interState),
    compositionScheme: outlet.compositionScheme,
    taxEnabled: outlet.gstEnabled,
    serviceChargeEnabled: outlet.serviceChargeEnabled && (opts.orderType ?? "DINE_IN") === "DINE_IN",
    serviceChargePercent: outlet.serviceChargePercent,
    roundOff: outlet.roundOff,
    extraCharges: opts.extraCharges,
    flatDiscountsIncludeTax: outlet.flatDiscountsIncludeTax ?? false,
  };
}

/** True when the outlet charges no tax on its bills (GST off or composition). */
export const outletChargesNoTax = (outlet: Pick<Outlet, "gstEnabled" | "compositionScheme">) =>
  !outlet.gstEnabled || outlet.compositionScheme;

/** Rate to strip from tax-inclusive prices (0 when the outlet charges no tax). */
export function inclusiveRate(outlet: Pick<Outlet, "gstEnabled" | "compositionScheme">, tax: LineTax, interState = false) {
  return outletChargesNoTax(outlet) ? 0 : totalTaxPercent(tax, interState);
}

/** Snapshot stored on OrderItem.taxRates. */
export function taxSnapshot(t: LineTax) {
  return { name: t.name ?? `GST ${effectiveGstRate(t)}%`, cgst: t.cgst, sgst: t.sgst, igst: t.igst, cess: t.cess ?? 0, extras: t.extras ?? [] };
}
