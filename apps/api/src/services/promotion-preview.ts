import type { Request } from "express";
import { withTaxMode, computeBill, type OrderCreateInput } from "@canavo/shared";
import { prisma } from "../db";
import { badRequest, HttpError } from "../lib/http";
import { evaluatePromotions, getLoyaltyConfig, redeemableNow } from "./promotions";
import { prepareServiceContext } from "./service-context";
import { resolveItemTax, taxConfigForOutlet } from "./tax";

/**
 * Dry-run of POST /orders pricing for the POS: resolves prices exactly like
 * billing.createOrder (variant → outlet override → base, plus add-ons), runs
 * the promotions engine without writing anything, and computes the bill with
 * the outlet's tax settings. Availability windows are not enforced here.
 */
export async function previewPromotions(req: Request, input: OrderCreateInput) {
  const outletId = req.outletId!;
  const outlet = await prisma.outlet.findUniqueOrThrow({ where: { id: outletId } });
  const ids = [...new Set(input.items.map((i) => i.menuItemId))];
  const menuItems = await prisma.menuItem.findMany({
    where: { id: { in: ids } },
    include: { variants: true, addons: true, overrides: { where: { outletId } } },
  });
  const byId = new Map(menuItems.map((m) => [m.id, m]));
  const at = input.createdAt ? new Date(input.createdAt) : new Date();

  const lines = input.items.map((line) => {
    const item = byId.get(line.menuItemId);
    if (!item) throw badRequest(`Unknown menu item ${line.menuItemId}`);
    const override = item.overrides[0];
    const variant = line.variantId ? item.variants.find((v) => v.id === line.variantId) : undefined;
    if (line.variantId && !variant) throw badRequest(`Invalid size for ${item.name}`);
    const addons = line.addonIds.map((aid) => {
      const a = item.addons.find((x) => x.id === aid);
      if (!a) throw badRequest(`Invalid add-on for ${item.name}`);
      return a;
    });
    const basePrice = variant?.price ?? override?.price ?? item.price;
    const unitPrice = basePrice + addons.reduce((s, a) => s + a.price, 0);
    const name = [item.name, variant && `(${variant.name})`].filter(Boolean).join(" ");
    return { line, item, variant, unitPrice, name };
  });

  const promo = await evaluatePromotions(
    {
      outletId,
      at,
      timezone: outlet.timezone,
      input,
      lines: lines.map((l) => ({
        menuItemId: l.item.id,
        variantId: l.variant?.id,
        categoryId: l.item.categoryId,
        name: l.name,
        unitPrice: l.unitPrice,
        quantity: l.line.quantity,
        manualDiscount: l.line.discount ?? 0,
      })),
    },
    { dryRun: true },
  );
  // Delivery/pre-order details are often incomplete while the cashier types; report, don't fail.
  const warnings = [...promo.warnings];
  let service: Awaited<ReturnType<typeof prepareServiceContext>>;
  try {
    service = await prepareServiceContext(req, input, outlet);
  } catch (e) {
    if (!(e instanceof HttpError) || e.status !== 400) throw e;
    warnings.push(e.message);
    service = { extraCharges: [] };
  }

  const taxes = await resolveItemTax(menuItems);
  const bill = computeBill(
    lines.map((l, i) => ({
      unitPrice: l.unitPrice,
      quantity: l.line.quantity,
      tax: taxes.get(l.item.id)!,
      lineDiscount: (l.line.discount ?? 0) + (promo.lineDiscounts[i] ?? 0),
    })),
    taxConfigForOutlet(outlet, { interState: input.interState, orderType: input.orderType, extraCharges: service.extraCharges }),
    [...(input.discount ? [withTaxMode(input.discount, outlet.flatDiscountsIncludeTax)] : []), ...promo.billDiscounts],
  );

  const cfg = await getLoyaltyConfig();
  const c = promo.customer;
  // Free items to add (Buy X Get Y): resolve name, cheapest size and price so the POS can add them in one tap.
  const freeIds = [...new Set(promo.suggestions.map((x) => x.menuItemId))];
  const freeItems = freeIds.length
    ? await prisma.menuItem.findMany({
        where: { id: { in: freeIds } },
        include: { variants: { orderBy: { price: "asc" } }, overrides: { where: { outletId } } },
      })
    : [];
  const suggestions = promo.suggestions.flatMap((sug) => {
    const item = freeItems.find((i) => i.id === sug.menuItemId);
    const status = item?.overrides[0]?.status ?? item?.status;
    if (!item || status !== "AVAILABLE") return [];
    const variant = item.variants[0];
    return [{
      ...sug,
      name: item.name,
      variantId: variant?.id ?? null,
      variantName: variant?.name ?? null,
      unitPrice: variant?.price ?? item.overrides[0]?.price ?? item.price,
      label: `${sug.getDiscountPercent === 100 ? "Free" : `${sug.getDiscountPercent}% off`} ${item.name}${variant ? ` (${variant.name})` : ""} — ${sug.offerName}`,
    }];
  });
  return {
    warnings,
    suggestions,
    applied: promo.applied,
    /** Phase 3.7: every offer / coupon checked, what it would save, and why it was (not) used */
    comparison: promo.comparison,
    promoDiscount: promo.applied.reduce((s, a) => s + a.amount, 0),
    couponCode: promo.couponCode ?? null,
    pointsRedeemed: promo.pointsRedeemed,
    pointsValue: promo.pointsRedeemed * cfg.pointValuePaise,
    lines: lines.map((l, i) => ({
      menuItemId: l.item.id,
      name: l.name,
      quantity: l.line.quantity,
      unitPrice: l.unitPrice,
      manualDiscount: l.line.discount ?? 0,
      /** Menu-price terms */
      promoDiscount: promo.lineDiscounts[i] ?? 0,
      taxableValue: bill.lines[i].taxableValue,
      tax: bill.lines[i].tax,
      total: bill.lines[i].total,
    })),
    billDiscounts: promo.billDiscounts,
    charges: service.extraCharges,
    bill: {
      documentType: bill.documentType,
      subtotal: bill.subtotal,
      discount: bill.discount,
      taxableValue: bill.taxableValue,
      serviceCharge: bill.serviceCharge,
      extraCharges: bill.extraCharges,
      cgst: bill.cgst,
      sgst: bill.sgst,
      igst: bill.igst,
      cess: bill.cess,
      otherTaxes: bill.otherTaxes,
      taxDetails: bill.taxDetails,
      totalTax: bill.totalTax,
      roundOff: bill.roundOff,
      grandTotal: bill.grandTotal,
      taxBreakup: bill.taxBreakup,
    },
    customer: input.customerPhone
      ? c
        ? {
            found: true,
            id: c.id,
            phone: c.phone,
            name: c.name,
            tier: c.tier,
            points: c.points,
            redeemablePoints: redeemableNow(c.points, cfg),
            khataBalance: c.khataBalance,
            blocked: c.blocked,
          }
        : { found: false, phone: input.customerPhone }
      : null,
  };
}
