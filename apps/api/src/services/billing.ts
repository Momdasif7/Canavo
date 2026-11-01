import type { Request } from "express";
import { Prisma } from "@prisma/client";
import {
  computeBill,
  financialYearStart,
  formatInvoiceNumber,
  gstPercent,
  OrderCreateInput,
  ReceiptData,
  type ReceiptTaxBreakup,
  type TaxDetail,
} from "@canavo/shared";
import { prisma } from "../db";
import { audit } from "../lib/audit";
import { badRequest, notFound } from "../lib/http";
import { hhmmToMinutes, zonedParts, startOfLocalDay } from "../lib/time";
import { emitToOutlet } from "../realtime";
import { featureOn, moduleEnabled } from "../lib/tenant";
import { applyPromotions, onOrderCreated, onOrderPaid } from "./promotions";
import { onOrderCreatedService, onOrderPaidService, prepareServiceContext } from "./service-context";
import { checkLowStockAfterOrder, deductStockForOrder } from "./inventory";
import { resolveItemTax, taxConfigForOutlet, taxSnapshot } from "./tax";
import { alertKitchenNewKots } from "./alerts";

/**
 * Failure-injection seam for integration tests only (never active outside NODE_ENV=test):
 * runs at the end of the order transaction, before commit.
 */
export const billingTestHooks: { beforeCommit?: (input: OrderCreateInput) => void | Promise<void> } = {};

export interface CreateOrderOptions {
  /** Items were already sent to the kitchen (dine-in running tab) — don't fire KOTs again */
  skipKot?: boolean;
  /** Dine-in running tab being billed */
  tableSessionId?: string;
  /** Items were already served (running tab) — don't reject for out-of-stock or serving hours */
  skipAvailability?: boolean;
  /**
   * Run inside the caller's transaction (e.g. a tab split billing several orders
   * atomically). Side effects that must only happen after commit (socket events,
   * kitchen alerts, low-stock checks) are then returned as `effects` for the
   * caller to run after its transaction commits, instead of being run here.
   */
  tx?: Prisma.TransactionClient;
}

const orderInclude = {
  items: true,
  kots: true,
  payments: { orderBy: { createdAt: "asc" } },
  cashier: { select: { id: true, name: true } },
  delivery: { select: { id: true, status: true, cod: true, agentId: true, cashSettledAt: true, agent: { select: { id: true, name: true } } } },
} satisfies Prisma.OrderInclude;

export type OrderWithRelations = Prisma.OrderGetPayload<{ include: typeof orderInclude }>;

export async function getOrder(id: string, outletId: string) {
  const order = await prisma.order.findFirst({ where: { id, outletId }, include: orderInclude });
  if (!order) throw notFound("Order");
  return order;
}

/**
 * Create a bill. Prices and tax are always recomputed server-side from the
 * menu — client totals are never trusted. Offline-raised bills (with
 * `clientOrderId`) are idempotent and skip live availability checks, since the
 * sale already happened.
 */
export async function createOrder(req: Request, input: OrderCreateInput, opts: CreateOrderOptions = {}) {
  const outletId = req.outletId!;
  const offline = Boolean(input.createdAt);
  const checkAvailability = !offline && !opts.skipAvailability;

  if (input.clientOrderId) {
    const existing = await prisma.order.findUnique({
      where: { clientOrderId: input.clientOrderId },
      include: orderInclude,
    });
    if (existing) {
      if (existing.outletId !== outletId) throw badRequest("clientOrderId belongs to another outlet");
      return { order: existing, duplicate: true, effects: () => undefined };
    }
  }

  const outlet = await prisma.outlet.findUniqueOrThrow({ where: { id: outletId } });
  const ids = [...new Set(input.items.map((i) => i.menuItemId))];
  const menuItems = await prisma.menuItem.findMany({
    where: { id: { in: ids } },
    include: { variants: true, addons: true, overrides: { where: { outletId } } },
  });
  const byId = new Map(menuItems.map((m) => [m.id, m]));
  const createdAt = input.createdAt ? new Date(input.createdAt) : new Date();
  const nowMinutes = zonedParts(createdAt, outlet.timezone).minutes;

  const autoStock = featureOn("AUTO_STOCK_OUT");
  const lines = input.items.map((line) => {
    const item = byId.get(line.menuItemId);
    if (!item) throw badRequest(`Unknown menu item ${line.menuItemId}`);
    const override = item.overrides[0];
    const status = override?.status ?? item.status;
    if (checkAvailability) {
      if (status !== "AVAILABLE") throw badRequest(`${item.name} is not available`);
      // Automatic out-of-stock (an ingredient can't cover one portion). Offline bills skip this
      // check (checkAvailability=false): the sale already happened and must be recorded.
      if (autoStock && override?.stockOut) throw badRequest(`${item.name} is out of stock${override.stockOutReason ? ` (${override.stockOutReason} ran out)` : ""}`);
      if (item.availableFrom && item.availableTo) {
        const from = hhmmToMinutes(item.availableFrom);
        const to = hhmmToMinutes(item.availableTo);
        const inWindow = from <= to ? nowMinutes >= from && nowMinutes < to : nowMinutes >= from || nowMinutes < to;
        if (!inWindow) throw badRequest(`${item.name} is only served ${item.availableFrom}–${item.availableTo}`);
      }
    }
    const variant = line.variantId ? item.variants.find((v) => v.id === line.variantId) : undefined;
    if (line.variantId && !variant) throw badRequest(`Invalid size for ${item.name}`);
    if (checkAvailability && autoStock && variant && override?.stockOutVariantIds.includes(variant.id)) {
      throw badRequest(`${item.name} (${variant.name}) is out of stock${override.stockOutReason ? ` (${override.stockOutReason} ran out)` : ""}`);
    }
    const addons = line.addonIds.map((aid) => {
      const a = item.addons.find((x) => x.id === aid);
      if (!a) throw badRequest(`Invalid add-on for ${item.name}`);
      return a;
    });
    const basePrice = variant?.price ?? override?.price ?? item.price;
    const unitPrice = basePrice + addons.reduce((s, a) => s + a.price, 0);
    const displayName = [item.name, variant && `(${variant.name})`].filter(Boolean).join(" ");
    return { line, item, variant, addons, unitPrice, displayName };
  });

  // Module hooks: promotions/loyalty, then order-type specifics (delivery fee, pre-order timing).
  const pricing = await applyPromotions({
    outletId,
    at: createdAt,
    timezone: outlet.timezone,
    input,
    lines: lines.map((l) => ({
      menuItemId: l.item.id,
      variantId: l.variant?.id,
      categoryId: l.item.categoryId,
      name: l.displayName,
      unitPrice: l.unitPrice,
      quantity: l.line.quantity,
      manualDiscount: l.line.discount ?? 0,
    })),
  });
  const service = await prepareServiceContext(req, input, outlet);
  if (input.orderType === "DELIVERY" && !moduleEnabled("DELIVERY")) throw badRequest("Delivery is not enabled for this business");
  if (input.orderType === "PRE_ORDER" && !moduleEnabled("RESERVATIONS")) throw badRequest("Pre-orders are not enabled for this business");

  // Tax composition per item: its tax rate → business default → legacy gstRate.
  const taxes = await resolveItemTax(menuItems);
  const lineTaxes = lines.map((l) => taxes.get(l.item.id)!);
  const bill = computeBill(
    lines.map((l, i) => ({
      unitPrice: l.unitPrice,
      quantity: l.line.quantity,
      tax: lineTaxes[i],
      lineDiscount: (l.line.discount ?? 0) + (pricing.lineDiscounts[i] ?? 0),
    })),
    taxConfigForOutlet(outlet, { interState: input.interState, orderType: input.orderType, extraCharges: service.extraCharges }),
    [...(input.discount ? [input.discount] : []), ...pricing.billDiscounts],
  );

  const fy = financialYearStart(createdAt, outlet.timezone);

  const persist = async (tx: Prisma.TransactionClient) => {
    const counter = await tx.invoiceCounter.upsert({
      where: { outletId_fyStart: { outletId, fyStart: fy } },
      create: { outletId, fyStart: fy, lastSeq: 1 },
      update: { lastSeq: { increment: 1 } },
    });
    const invoiceNumber = formatInvoiceNumber(outlet.invoicePrefix, fy, counter.lastSeq);

    const created = await tx.order.create({
      data: {
        clientOrderId: input.clientOrderId,
        outletId,
        cashierId: req.user!.id,
        invoiceNumber,
        documentType: bill.documentType,
        orderType: input.orderType,
        tableLabel: input.tableLabel,
        customerName: input.customerName,
        customerPhone: input.customerPhone,
        interState: input.interState,
        notes: input.notes,
        subtotal: bill.subtotal,
        discount: bill.discount,
        taxableValue: bill.taxableValue,
        serviceCharge: bill.serviceCharge,
        cgst: bill.cgst,
        sgst: bill.sgst,
        igst: bill.igst,
        cess: bill.cess,
        otherTaxes: bill.otherTaxes,
        taxDetails: bill.taxDetails as unknown as Prisma.InputJsonValue,
        roundOff: bill.roundOff,
        grandTotal: bill.grandTotal,
        taxBreakup: bill.taxBreakup as unknown as Prisma.InputJsonValue,
        syncedOffline: offline,
        customerId: pricing.customerId,
        scheduledFor: input.scheduledFor ? new Date(input.scheduledFor) : undefined,
        tableSessionId: opts.tableSessionId,
        promoDiscount: pricing.applied.reduce((s, a) => s + a.amount, 0),
        couponCode: pricing.couponCode,
        pointsRedeemed: pricing.pointsRedeemed,
        appliedOffers: pricing.applied as unknown as Prisma.InputJsonValue,
        extraCharges: bill.extraCharges,
        chargesBreakup: service.extraCharges as unknown as Prisma.InputJsonValue,
        createdAt,
        items: {
          create: lines.map((l, i) => ({
            menuItemId: l.item.id,
            variantId: l.variant?.id,
            name: l.displayName,
            variantName: l.variant?.name,
            addons: l.addons.map((a) => ({ name: a.name, price: a.price })),
            quantity: l.line.quantity,
            unitPrice: l.unitPrice,
            // Rate actually charged: IGST inter-state, else CGST + SGST; 0 on a plain BILL.
            gstRate: bill.documentType === "BILL" ? 0 : gstPercent(lineTaxes[i], input.interState),
            hsnCode: l.item.hsnCode,
            discount: bill.lines[i].discount,
            taxableValue: bill.lines[i].taxableValue,
            serviceCharge: bill.lines[i].serviceCharge,
            cgst: bill.lines[i].cgst,
            sgst: bill.lines[i].sgst,
            igst: bill.lines[i].igst,
            cess: bill.lines[i].cess,
            otherTaxes: bill.lines[i].otherTaxes,
            taxRates: taxSnapshot(lineTaxes[i]) as unknown as Prisma.InputJsonValue,
            total: bill.lines[i].total,
            notes: l.line.notes,
          })),
        },
      },
    });

    await onOrderCreated(tx, created.id, pricing);
    await onOrderCreatedService(tx, created.id, input, service);
    if (moduleEnabled("INVENTORY")) await deductStockForOrder(tx, created.id);

    // One KOT per kitchen station (e.g. beverages vs main kitchen).
    const byStation = new Map<string, typeof lines>();
    for (const l of opts.skipKot || !moduleEnabled("KOT") ? [] : lines) {
      const arr = byStation.get(l.item.kitchenStation) ?? [];
      arr.push(l);
      byStation.set(l.item.kitchenStation, arr);
    }
    const today = zonedParts(createdAt, outlet.timezone).date;
    let kotNumber = await tx.kotTicket.count({
      where: { outletId, createdAt: { gte: startOfLocalDay(today, outlet.timezone) } },
    });
    for (const [station, stationLines] of byStation) {
      await tx.kotTicket.create({
        data: {
          orderId: created.id,
          outletId,
          station,
          kotNumber: ++kotNumber,
          releaseAt: service.kotReleaseAt,
          items: stationLines.map((l) => ({
            name: l.displayName,
            quantity: l.line.quantity,
            addons: l.addons.map((a) => a.name),
            notes: l.line.notes ?? null,
          })),
        },
      });
    }

    await audit(req, "order.create", "Order", created.id, { invoiceNumber, grandTotal: bill.grandTotal, offline }, tx);
    if (process.env.NODE_ENV === "test") await billingTestHooks.beforeCommit?.(input);
    return tx.order.findUniqueOrThrow({ where: { id: created.id }, include: orderInclude });
  };
  const order = opts.tx ? await persist(opts.tx) : await prisma.$transaction(persist);

  const orderSummary = {
    id: order.id,
    invoiceNumber: order.invoiceNumber,
    orderType: order.orderType,
    tableLabel: order.tableLabel,
    notes: order.notes,
    status: order.status,
  };
  const effects = () => {
    // Same shape as GET /kot so displays can insert tickets without refetching.
    const released = order.kots.filter((k) => !k.releaseAt || k.releaseAt <= new Date());
    if (released.length) {
      emitToOutlet(outletId, "kot:new", released.map((k) => ({ ...k, order: orderSummary })));
      const where = order.tableLabel ? `Table ${order.tableLabel}` : order.orderType === "DELIVERY" ? "Delivery" : order.orderType === "PRE_ORDER" ? "Pre-order" : "Takeaway";
      void alertKitchenNewKots(outletId, released, `${where} · ${order.invoiceNumber}`);
    }
    checkLowStockAfterOrder(outletId, order.id).catch((e) => console.error("[inventory] low-stock check failed", e));
    emitToOutlet(outletId, "order:created", { id: order.id, invoiceNumber: order.invoiceNumber });
  };
  // In the caller's transaction nothing is committed yet: the caller runs effects after commit.
  if (opts.tx) return { order, duplicate: false, effects };
  effects();
  return { order, duplicate: false, effects: () => undefined };
}

export const amountPaid = (order: { payments: { status: string; amount: number }[] }) =>
  order.payments.filter((p) => p.status === "SUCCESS").reduce((s, p) => s + p.amount, 0);

/** Mark the order PAID once successful payments cover the grand total. */
export async function settleIfPaid(orderId: string, tx: Prisma.TransactionClient | typeof prisma = prisma) {
  const order = await tx.order.findUniqueOrThrow({ where: { id: orderId }, include: { payments: true } });
  if (order.status === "OPEN" && amountPaid(order) >= order.grandTotal) {
    await tx.order.update({ where: { id: orderId }, data: { status: "PAID", paidAt: new Date() } });
    await onOrderPaid(tx, orderId);
    await onOrderPaidService(tx, orderId);
    return true;
  }
  return order.status === "PAID";
}

export async function buildReceipt(order: OrderWithRelations): Promise<ReceiptData> {
  const outlet = await prisma.outlet.findUniqueOrThrow({ where: { id: order.outletId } });
  return {
    documentType: order.documentType,
    invoiceNumber: order.invoiceNumber,
    issuedAt: order.createdAt.toISOString(),
    outlet: {
      name: outlet.name,
      legalName: outlet.legalName,
      address: outlet.address,
      // Plain bills (not GST registered) carry no GSTIN.
      gstin: order.documentType === "BILL" ? null : outlet.gstin,
      fssai: outlet.fssai,
      phone: outlet.phone,
    },
    orderType: order.orderType,
    tableLabel: order.tableLabel,
    cashierName: order.cashier.name,
    customerName: order.customerName,
    // Lines show pre-tax value so they add up to the subtotal even when menu
    // prices are tax-inclusive (the GST is then shown separately below).
    items: order.items.map((i) => ({
      name: i.name,
      quantity: i.quantity,
      unitPrice: Math.round((i.taxableValue + i.discount) / i.quantity),
      amount: i.taxableValue + i.discount,
      gstRate: i.gstRate,
      hsnCode: i.hsnCode,
    })),
    subtotal: order.subtotal,
    discount: order.discount,
    serviceCharge: order.serviceCharge,
    charges: order.chargesBreakup as unknown as { label: string; amount: number }[],
    cgst: order.cgst,
    sgst: order.sgst,
    igst: order.igst,
    cess: order.cess,
    otherTaxes: order.otherTaxes,
    taxDetails: (order.taxDetails ?? []) as unknown as TaxDetail[],
    roundOff: order.roundOff,
    grandTotal: order.grandTotal,
    taxBreakup: (order.taxBreakup ?? []) as unknown as ReceiptTaxBreakup[],
    interState: order.interState,
    gstEnabled: outlet.gstEnabled,
    legalName: outlet.legalName,
    payments: order.payments.filter((p) => p.status === "SUCCESS").map((p) => ({ mode: p.mode, amount: p.amount })),
    ...(order.delivery?.cod && order.status === "OPEN" && { codDue: Math.max(0, order.grandTotal - amountPaid(order)) }),
  };
}
