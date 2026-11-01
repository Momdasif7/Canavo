import { Router } from "express";
import jwt from "jsonwebtoken";
import { z } from "zod";
import {
  formatINR,
  formatReceiptText,
  approvalSchema,
  orderCreateSchema,
  ORDER_CHANNELS,
  ORDER_CHANNEL_LABELS,
  refundSchema,
  paymentSchema,
  receiptShareSchema,
} from "@canavo/shared";
import { prisma } from "../db";
import { env, isProd } from "../env";
import { audit } from "../lib/audit";
import { badRequest, conflict, forbidden, notFound, param, parse, publicApiUrl } from "../lib/http";
import { startOfLocalDay } from "../lib/time";
import { authenticate, requireAnyPermission, requireOutlet, requirePermission, requireModule } from "../middleware/auth";
import { approvalsOn, approversFor, canActWithApproval, requireApproval } from "../services/approvals";
import { createCreditNote } from "../services/credit-notes";
import { assertCashShiftOpen } from "../services/cash-shifts";
import { redeemGiftCard } from "../services/gift-cards";
import { seriesForDevice } from "../services/offline-series";
import { featureOn, moduleEnabled } from "../lib/tenant";
import { redeemTokens, spendWallet } from "../services/canteen";
import { amountPaid, buildReceipt, createOrder, getOrder, settleIfPaid } from "../services/billing";
import { createUpiQr } from "../services/razorpay";
import { sendExport } from "../services/report-export";
import { renderReceiptPdf } from "../services/pdf";
import { shareReceipt } from "../services/whatsapp";
import { emitToOutlet } from "../realtime";
import { notify } from "../services/notify";
import { onPaymentsRecorded } from "../services/promotions";
import { alertOrderCancelled } from "../services/alerts";
import { cancelOrderInTx } from "../services/order-cancel";
import { queueChannelStatus } from "../services/channels/service";

export const ordersRouter = Router();
ordersRouter.use(authenticate, requireOutlet, requireModule("BILLING"));

/** This device's offline invoice series (Phase 3.4, OFFLINE_INVOICE_SERIES). */
ordersRouter.post("/offline-series", requirePermission("order:create"), async (req, res) => {
  if (!featureOn("OFFLINE_INVOICE_SERIES")) return res.json({ enabled: false });
  const { deviceId } = parse(z.object({ deviceId: z.string().trim().min(8).max(200) }), req.body);
  const outlet = await prisma.outlet.findUniqueOrThrow({ where: { id: req.outletId! }, select: { invoicePrefix: true } });
  res.json({ enabled: true, ...(await seriesForDevice(req.outletId!, deviceId, outlet.invoicePrefix)) });
});

/** Managers / owners who can approve at this outlet with their PIN (Phase 3.3). */
ordersRouter.get("/approvers", requireAnyPermission("order:create", "payment:collect", "order:cancel"), async (req, res) => {
  res.json({ enabled: approvalsOn(), discountLimitPercent: (await prisma.outlet.findUniqueOrThrow({ where: { id: req.outletId! }, select: { approvalDiscountPercent: true } })).approvalDiscountPercent, approvers: await approversFor(req.outletId!, req.businessId!) });
});

ordersRouter.post("/", requirePermission("order:create"), async (req, res) => {
  const { order, duplicate } = await createOrder(req, parse(orderCreateSchema, req.body));
  res.status(duplicate ? 200 : 201).json(order);
});

/**
 * Offline queue flush. Each queued bill is created independently so one bad
 * entry doesn't block the rest; clientOrderId makes retries safe.
 */
ordersRouter.post("/sync", requirePermission("order:create"), async (req, res) => {
  const { orders } = parse(z.object({ orders: z.array(z.unknown()).max(200) }), req.body);
  const results = [];
  for (const raw of orders) {
    const parsed = orderCreateSchema.safeParse(raw);
    const clientOrderId = (raw as { clientOrderId?: string })?.clientOrderId;
    if (!parsed.success || !parsed.data.clientOrderId) {
      results.push({ clientOrderId, ok: false, error: "Invalid order or missing clientOrderId" });
      continue;
    }
    try {
      const { order, duplicate } = await createOrder(req, parsed.data);
      results.push({ clientOrderId, ok: true, duplicate, orderId: order.id, invoiceNumber: order.invoiceNumber, grandTotal: order.grandTotal });
    } catch (e) {
      results.push({ clientOrderId, ok: false, error: e instanceof Error ? e.message : "Failed" });
    }
  }
  res.json({ results });
});

// ---------- Bills list: filters shared by the list, its summary and its export ----------
const ymdDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const billFilterSchema = z.object({
  /** One day (kept for older clients); use from/to for a range */
  date: ymdDate.optional(),
  from: ymdDate.optional(),
  to: ymdDate.optional(),
  status: z.enum(["OPEN", "PAID", "CANCELLED"]).optional(),
  /** COD = delivery orders paid cash on delivery */
  paymentMode: z.enum(["CASH", "UPI", "CARD", "KHATA", "ONLINE", "COD"]).optional(),
  orderType: z.enum(["DINE_IN", "TAKEAWAY", "DELIVERY", "PRE_ORDER"]).optional(),
  /** Phase 6: where the order came from (POS, QR, ONLINE, ZOMATO, SWIGGY, …) */
  channel: z.enum(ORDER_CHANNELS).optional(),
  search: z.string().trim().max(100).optional(),
});
const MAX_RANGE_DAYS = 366;

async function billWhere(req: Express.Request, q: z.infer<typeof billFilterSchema>) {
  const outlet = await prisma.outlet.findUniqueOrThrow({ where: { id: req.outletId }, select: { timezone: true } });
  const from = q.from ?? q.date;
  const to = q.to ?? q.from ?? q.date;
  if (from && to && from > to) throw badRequest("'from' date is after 'to' date");
  let createdAt: { gte: Date; lt: Date } | undefined;
  if (from && to) {
    const gte = startOfLocalDay(from, outlet.timezone);
    const lt = new Date(startOfLocalDay(to, outlet.timezone).getTime() + 86_400_000);
    if ((lt.getTime() - gte.getTime()) / 86_400_000 > MAX_RANGE_DAYS) throw badRequest(`Pick at most ${MAX_RANGE_DAYS} days`);
    createdAt = { gte, lt };
  }
  return {
    outletId: req.outletId,
    ...(q.status && { status: q.status }),
    ...(q.orderType && { orderType: q.orderType }),
    ...(q.channel && { channel: q.channel }),
    ...(q.paymentMode === "COD"
      ? { delivery: { is: { cod: true } } }
      : q.paymentMode && { payments: { some: { mode: q.paymentMode, status: "SUCCESS" as const } } }),
    ...(q.search && {
      OR: [
        { invoiceNumber: { contains: q.search, mode: "insensitive" as const } },
        { customerPhone: { contains: q.search } },
        { customerName: { contains: q.search, mode: "insensitive" as const } },
      ],
    }),
    ...(createdAt && { createdAt }),
  };
}

const billInclude = {
  items: true,
  payments: true,
  cashier: { select: { id: true, name: true } },
  delivery: { select: { id: true, status: true, cod: true, agentId: true, cashSettledAt: true, agent: { select: { id: true, name: true } } } },
} as const;

ordersRouter.get("/", requirePermission("bills:view"), async (req, res) => {
  const q = parse(
    billFilterSchema.extend({
      limit: z.coerce.number().int().min(1).max(200).default(50),
      offset: z.coerce.number().int().min(0).max(100_000).default(0),
    }),
    req.query,
  );
  const where = await billWhere(req, q);
  res.json(await prisma.order.findMany({ where, include: billInclude, orderBy: { createdAt: "desc" }, skip: q.offset, take: q.limit }));
});

/** Totals for the filtered bills: count, amounts, collected by payment mode (cancelled bills counted apart). */
ordersRouter.get("/summary", requirePermission("bills:view"), async (req, res) => {
  const q = parse(billFilterSchema, req.query);
  const where = await billWhere(req, q);
  const [all, byStatus, byMode, cod, refunds] = await Promise.all([
    prisma.order.count({ where }),
    prisma.order.groupBy({ by: ["status"], where, _count: true, _sum: { grandTotal: true } }),
    // Only money actually received: failed / pending UPI QR attempts don't count (BUG-004)
    prisma.payment.groupBy({ by: ["mode"], where: { status: "SUCCESS", order: { ...where, status: { not: "CANCELLED" } } }, _sum: { amount: true }, _count: true }),
    prisma.order.aggregate({ where: { ...where, status: { not: "CANCELLED" }, delivery: { is: { cod: true } } }, _count: true, _sum: { grandTotal: true } }),
    // Refunds on the listed bills (Phase 3.1)
    prisma.order.aggregate({ where: { ...where, refundedAmount: { gt: 0 } }, _count: true, _sum: { refundedAmount: true } }),
  ]);
  const st = (s: string) => byStatus.find((b) => b.status === s);
  res.json({
    count: all,
    billed: (st("OPEN")?._sum.grandTotal ?? 0) + (st("PAID")?._sum.grandTotal ?? 0),
    paidCount: st("PAID")?._count ?? 0,
    openCount: st("OPEN")?._count ?? 0,
    openAmount: st("OPEN")?._sum.grandTotal ?? 0,
    cancelledCount: st("CANCELLED")?._count ?? 0,
    cancelledAmount: st("CANCELLED")?._sum.grandTotal ?? 0,
    byMode: Object.fromEntries(byMode.map((m) => [m.mode, { amount: m._sum.amount ?? 0, count: m._count }])),
    cod: { count: cod._count, amount: cod._sum.grandTotal ?? 0 },
    refunds: { count: refunds._count, amount: refunds._sum.refundedAmount ?? 0 },
  });
});

/** The filtered bills as an Excel file (up to 10,000 rows). */
ordersRouter.get("/export", requirePermission("bills:view"), async (req, res) => {
  const q = parse(billFilterSchema, req.query);
  const where = await billWhere(req, q);
  const outlet = await prisma.outlet.findUniqueOrThrow({ where: { id: req.outletId }, select: { name: true, timezone: true } });
  const rows = await prisma.order.findMany({ where, include: billInclude, orderBy: { createdAt: "desc" }, take: 10_000 });
  const when = (d: Date) => d.toLocaleString("en-IN", { timeZone: outlet.timezone, dateStyle: "medium", timeStyle: "short" });
  const modes = (o: (typeof rows)[number]) => [...new Set(o.payments.filter((p) => p.status === "SUCCESS").map((p) => p.mode))].join(" + ") || (o.delivery?.cod ? "COD" : "");
  const range = q.from || q.date ? `${q.from ?? q.date}${q.to && q.to !== (q.from ?? q.date) ? ` to ${q.to}` : ""}` : "all dates";
  await audit(req, "bills.export", "Order", undefined, { rows: rows.length, ...q });
  await sendExport(res, "xlsx", `bills_${(q.from ?? q.date ?? "all")}${q.to ? `_${q.to}` : ""}`, [
    {
      title: `Bills · ${outlet.name}`,
      subtitle: range,
      columns: [
        { key: "invoice", header: "Invoice", width: 18 },
        { key: "date", header: "Date & time", width: 20 },
        { key: "type", header: "Type", width: 11 },
        { key: "channel", header: "Channel", width: 11 },
        { key: "customer", header: "Customer", width: 18 },
        { key: "phone", header: "Phone", width: 13 },
        { key: "mode", header: "Payment", width: 14 },
        { key: "status", header: "Status", width: 11 },
        { key: "cashier", header: "Cashier", width: 14 },
        { key: "total", header: "Total", type: "money", width: 12 },
      ],
      rows: rows.map((o) => ({
        invoice: o.invoiceNumber,
        date: when(o.createdAt),
        type: o.orderType.replace("_", "-"),
        channel: ORDER_CHANNEL_LABELS[o.channel as keyof typeof ORDER_CHANNEL_LABELS] ?? o.channel,
        customer: o.customerName ?? "",
        phone: o.customerPhone ?? "",
        mode: modes(o),
        status: o.status,
        cashier: o.cashier?.name ?? "",
        total: o.status === "CANCELLED" ? 0 : o.grandTotal,
      })),
      totals: true,
    },
  ]);
});

ordersRouter.get("/:id", requirePermission("order:view"), async (req, res) => {
  const order = await getOrder(param(req, "id"), req.outletId!);
  res.json({ ...order, amountPaid: amountPaid(order), balance: Math.max(0, order.grandTotal - amountPaid(order)) });
});

/**
 * Void a bill. Needs order:cancel as before; with APPROVAL_PINS on, a cashier can also void
 * with a manager's PIN, and every void is logged as an approval (Phase 3.3).
 */
ordersRouter.post("/:id/cancel", requireAnyPermission("order:cancel", "payment:collect"), async (req, res) => {
  if (!canActWithApproval(req, "order:cancel", "payment:collect")) throw forbidden("Insufficient permissions");
  const { reason, approval } = parse(z.object({ reason: z.string().min(3).max(200), approval: approvalSchema.optional() }), req.body);
  const order = await getOrder(param(req, "id"), req.outletId!);
  if (order.status === "CANCELLED") throw conflict("Order already cancelled");
  if (order.refundedAmount > 0) throw conflict("This bill has refunds. Refund the rest instead of cancelling it.");
  const updated = await prisma.$transaction(async (tx) => {
    if (approvalsOn()) await requireApproval(req, { action: "VOID", outletId: req.outletId!, orderId: order.id, amount: order.grandTotal, reason, approval }, tx);
    const u = await cancelOrderInTx(tx, req, order, reason);
    // Phase 6.1: an aggregator order is cancelled on the channel too (outbox: retried until the hub answers).
    await queueChannelStatus(tx, order.id, "CANCELLED", reason);
    return u;
  });
  emitToOutlet(req.outletId!, "order:cancelled", { id: order.id });
  void alertOrderCancelled(req.outletId!, order.id, req.user!, reason);
  res.json(updated);
});

/**
 * Refund (credit note) on a paid bill (Phase 3.1). Same people who can void: order:cancel, or
 * with APPROVAL_PINS on, a cashier with a manager's PIN.
 */
ordersRouter.post("/:id/refunds", requireAnyPermission("order:cancel", "payment:collect"), async (req, res) => {
  if (!canActWithApproval(req, "order:cancel", "payment:collect")) throw forbidden("Insufficient permissions");
  const note = await createCreditNote(req, param(req, "id"), parse(refundSchema, req.body));
  emitToOutlet(req.outletId!, "order:refunded", { id: note.orderId, creditNote: note.number });
  res.status(201).json(note);
});

ordersRouter.get("/:id/credit-notes", requirePermission("order:view"), async (req, res) => {
  const order = await getOrder(param(req, "id"), req.outletId!);
  res.json(await prisma.creditNote.findMany({ where: { orderId: order.id }, orderBy: { createdAt: "asc" } }));
});

// ---------- Payments ----------
ordersRouter.post("/:id/payments", requirePermission("payment:collect"), async (req, res) => {
  const { payments, tendered } = parse(paymentSchema, req.body);
  const order = await getOrder(param(req, "id"), req.outletId!);
  if (order.status !== "OPEN") throw conflict(`Order is ${order.status.toLowerCase()}`);
  const balance = order.grandTotal - amountPaid(order);
  const total = payments.reduce((s, p) => s + p.amount, 0);
  if (total > balance) throw badRequest(`Payment ${formatINR(total)} exceeds balance ${formatINR(balance)}`);
  if (payments.some((p) => p.mode === "KHATA") && !order.customerPhone) {
    throw badRequest("Khata (credit) needs a customer phone number on the bill");
  }
  // Cash tips go into the drawer too, so the customer's cash covers amount + tip.
  const cashPart = payments.filter((p) => p.mode === "CASH").reduce((s, p) => s + p.amount + (p.tip ?? 0), 0);
  if (tendered !== undefined && tendered < cashPart) throw badRequest("Cash tendered is less than cash amount");
  // Offline bills already happened: their payments sync even if no shift is open now.
  if (!order.syncedOffline) await assertCashShiftOpen(req.outletId!, payments.map((p) => p.mode));

  if (payments.some((p) => p.mode === "GIFT_CARD") && !featureOn("GIFT_CARDS")) throw badRequest("Gift cards are not enabled for this hotel");
  if (payments.some((p) => p.mode === "GIFT_CARD" && !p.giftCardCode)) throw badRequest("Enter the gift card code");
  // Phase 5 (CANTEEN): the company's share is added when the bill is made, never typed at the counter.
  // Phase 6: "Paid online" is money a channel took (aggregator / online page), not something typed at the counter.
  if (payments.some((p) => p.mode === "ONLINE") && order.channel === "POS") throw badRequest("Paid online is only for orders from an online channel");
  if (payments.some((p) => p.mode === "CORPORATE")) throw badRequest("The company's share is added automatically when the member's card is on the bill");
  if (payments.some((p) => p.mode === "WALLET" || p.mode === "MEAL_TOKEN")) {
    if (!moduleEnabled("CANTEEN")) throw badRequest("Canteen is not enabled for this business");
    if (!order.customerId) throw badRequest("Wallet and meal tokens need the member's card on the bill");
  }

  const paid = await prisma.$transaction(async (tx) => {
    for (const p of payments) {
      // Gift cards are spent with a compare-and-set inside this transaction (Phase 3.8).
      const card = p.mode === "GIFT_CARD" ? await redeemGiftCard(tx, p.giftCardCode!, p.amount, { outletId: req.outletId!, orderId: order.id, invoiceNumber: order.invoiceNumber, userId: req.user!.id }) : null;
      const ctx = { outletId: req.outletId!, orderId: order.id, invoiceNumber: order.invoiceNumber, userId: req.user!.id };
      if (p.mode === "WALLET") await spendWallet(tx, order.customerId!, p.amount, ctx);
      if (p.mode === "MEAL_TOKEN") await redeemTokens(tx, { ...ctx, customerId: order.customerId!, mealSlotId: order.mealSlotId, tokens: p.tokens ?? 1, amount: p.amount });
      await tx.payment.create({
        data: {
          orderId: order.id,
          mode: p.mode,
          amount: p.amount,
          reference: p.reference,
          tip: p.tip ?? 0,
          cardLast4: p.mode === "CARD" ? p.cardLast4 : undefined,
          authCode: p.mode === "CARD" ? p.authCode : undefined,
          giftCardId: card?.id,
          tokens: p.mode === "MEAL_TOKEN" ? (p.tokens ?? 1) : undefined,
          status: "SUCCESS" as const,
          confirmedAt: new Date(),
        },
      });
    }
    await onPaymentsRecorded(tx, order.id, payments, req.user!.id);
    await audit(req, "payment.collect", "Order", order.id, { payments, tendered }, tx);
    return settleIfPaid(order.id, tx);
  });
  const updated = await getOrder(order.id, req.outletId!);
  if (paid) emitToOutlet(req.outletId!, "order:paid", { id: order.id, invoiceNumber: order.invoiceNumber });
  res.json({
    order: updated,
    paid,
    balance: Math.max(0, updated.grandTotal - amountPaid(updated)),
    change: tendered !== undefined ? tendered - cashPart : 0,
  });
});

/** Create a dynamic UPI QR for the outstanding balance. */
ordersRouter.post("/:id/upi-qr", requirePermission("payment:collect"), async (req, res) => {
  const order = await getOrder(param(req, "id"), req.outletId!);
  if (order.status !== "OPEN") throw conflict(`Order is ${order.status.toLowerCase()}`);
  const amount = parse(z.object({ amount: z.number().int().positive().optional() }), req.body ?? {}).amount;
  const balance = order.grandTotal - amountPaid(order);
  const due = amount ?? balance;
  if (due <= 0 || due > balance) throw badRequest("Invalid UPI amount");

  // Replace any earlier pending QR for this order.
  await prisma.payment.updateMany({ where: { orderId: order.id, mode: "UPI", status: "PENDING" }, data: { status: "FAILED" } });
  const outlet = await prisma.outlet.findUniqueOrThrow({ where: { id: req.outletId } });
  const qr = await createUpiQr({
    amount: due,
    orderId: order.id,
    invoiceNumber: order.invoiceNumber,
    payeeName: outlet.name,
    vpa: outlet.upiVpa,
  });
  const payment = await prisma.payment.create({
    data: { orderId: order.id, mode: "UPI", amount: due, status: "PENDING", gatewayRef: qr.gatewayRef, qrPayload: qr.qrPayload },
  });
  res.status(201).json({ paymentId: payment.id, amount: due, ...qr });
});

ordersRouter.get("/:id/payment-status", requirePermission("order:view"), async (req, res) => {
  const order = await getOrder(param(req, "id"), req.outletId!);
  res.json({
    status: order.status,
    amountPaid: amountPaid(order),
    balance: Math.max(0, order.grandTotal - amountPaid(order)),
    payments: order.payments,
  });
});

/** Cashier confirms a UPI payment seen on the merchant app (no webhook / mock mode). */
ordersRouter.post("/:id/payments/:paymentId/confirm", requirePermission("payment:collect"), async (req, res) => {
  const { reference } = parse(z.object({ reference: z.string().max(100).optional() }), req.body ?? {});
  const order = await getOrder(param(req, "id"), req.outletId!);
  const payment = order.payments.find((p) => p.id === param(req, "paymentId"));
  if (!payment) throw notFound("Payment");
  if (payment.status !== "PENDING") throw conflict(`Payment is ${payment.status.toLowerCase()}`);
  const paid = await prisma.$transaction(async (tx) => {
    await tx.payment.update({ where: { id: payment.id }, data: { status: "SUCCESS", confirmedAt: new Date(), reference } });
    await audit(req, "payment.manual_confirm", "Payment", payment.id, { reference }, tx);
    return settleIfPaid(order.id, tx);
  });
  if (paid) emitToOutlet(req.outletId!, "order:paid", { id: order.id, invoiceNumber: order.invoiceNumber });
  res.json({ paid });
});

/**
 * Cash on Delivery: take no payment now — the assigned delivery partner collects
 * the bill amount in cash at the door (it then counts in their cash in hand).
 * `{ cod: false }` undoes it (e.g. the customer decides to pay at the counter).
 */
ordersRouter.post("/:id/cod", requirePermission("payment:collect"), async (req, res) => {
  const cod = req.body?.cod !== false;
  const order = await getOrder(param(req, "id"), req.outletId!);
  if (!order.delivery) throw badRequest("Cash on Delivery is only for delivery orders");
  if (order.status !== "OPEN") throw conflict(order.status === "PAID" ? "This order is already paid" : "Order was cancelled");
  if (order.delivery.status === "DELIVERED" || order.delivery.status === "CANCELLED") throw conflict(`Delivery is ${order.delivery.status.toLowerCase()}`);
  const due = order.grandTotal - amountPaid(order);
  await prisma.$transaction(async (tx) => {
    // Any QR shown at the counter is no longer valid once it's COD.
    if (cod) await tx.payment.updateMany({ where: { orderId: order.id, status: "PENDING" }, data: { status: "FAILED" } });
    await tx.delivery.update({ where: { id: order.delivery!.id }, data: { cod } });
    await audit(req, cod ? "order.cod" : "order.cod_cancel", "Order", order.id, { amountDue: due }, tx);
  });
  const updated = await getOrder(order.id, req.outletId!);
  const agentId = updated.delivery?.agentId;
  if (cod && agentId) {
    await notify([agentId], "Cash on Delivery", `${updated.invoiceNumber}: collect ₹${(due / 100).toFixed(2)} in cash`, "delivery");
  }
  emitToOutlet(req.outletId!, "delivery:updated", { id: updated.delivery?.id, orderId: updated.id, cod });
  res.json({ ...updated, amountPaid: amountPaid(updated), balance: Math.max(0, updated.grandTotal - amountPaid(updated)) });
});

// ---------- Receipts ----------
export function receiptToken(orderId: string) {
  return jwt.sign({ oid: orderId }, env.RECEIPT_LINK_SECRET, { expiresIn: "90d" });
}

ordersRouter.get("/:id/receipt", requirePermission("order:view"), async (req, res) => {
  const order = await getOrder(param(req, "id"), req.outletId!);
  const receipt = await buildReceipt(order);
  if (req.query.format === "text") {
    const paper = req.query.paper === "80" ? 80 : 58;
    return res.type("text/plain").send(formatReceiptText(receipt, paper).join("\n"));
  }
  res.json({ ...receipt, publicUrl: `${publicApiUrl(req, env.PUBLIC_API_URL)}/public/receipts/${receiptToken(order.id)}` });
});

ordersRouter.get("/:id/receipt.pdf", requirePermission("order:view"), async (req, res) => {
  const order = await getOrder(param(req, "id"), req.outletId!);
  const pdf = await renderReceiptPdf(await buildReceipt(order));
  res.type("application/pdf").setHeader("content-disposition", `inline; filename="${order.invoiceNumber}.pdf"`);
  res.send(pdf);
});

ordersRouter.post("/:id/share/whatsapp", requirePermission("order:view"), async (req, res) => {
  const { phone } = parse(receiptShareSchema, req.body);
  const order = await getOrder(param(req, "id"), req.outletId!);
  const outlet = await prisma.outlet.findUniqueOrThrow({ where: { id: req.outletId } });
  const receiptUrl = `${publicApiUrl(req, env.PUBLIC_API_URL)}/public/receipts/${receiptToken(order.id)}`;
  const result = await shareReceipt({
    phone,
    outletName: outlet.name,
    invoiceNumber: order.invoiceNumber,
    amountText: formatINR(order.grandTotal),
    receiptUrl,
  });
  if (!order.customerPhone) await prisma.order.update({ where: { id: order.id }, data: { customerPhone: phone } });
  await audit(req, "receipt.share", "Order", order.id, { channel: "whatsapp", method: result.method });
  res.json({ ...result, receiptUrl });
});

// ---------- Dev helpers ----------
if (!isProd) {
  /** Simulate the customer paying a mock UPI QR (stands in for the Razorpay webhook). */
  ordersRouter.post("/:id/payments/:paymentId/dev-simulate", requirePermission("payment:collect"), async (req, res) => {
    const order = await getOrder(param(req, "id"), req.outletId!);
    const payment = order.payments.find((p) => p.id === param(req, "paymentId") && p.status === "PENDING");
    if (!payment) throw notFound("Pending payment");
    await prisma.payment.update({ where: { id: payment.id }, data: { status: "SUCCESS", confirmedAt: new Date(), reference: "SIMULATED" } });
    const paid = await settleIfPaid(order.id);
    if (paid) emitToOutlet(req.outletId!, "order:paid", { id: order.id, invoiceNumber: order.invoiceNumber });
    res.json({ paid });
  });
}
