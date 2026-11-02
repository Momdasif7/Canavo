import { Router } from "express";
import jwt from "jsonwebtoken";
import { z } from "zod";
import {
  formatINR,
  formatReceiptText,
  orderCreateSchema,
  paymentSchema,
  receiptShareSchema,
} from "@canavo/shared";
import { prisma } from "../db";
import { env, isProd } from "../env";
import { audit } from "../lib/audit";
import { badRequest, conflict, notFound, param, parse, publicApiUrl } from "../lib/http";
import { startOfLocalDay } from "../lib/time";
import { authenticate, requireOutlet, requirePermission, requireModule } from "../middleware/auth";
import { amountPaid, buildReceipt, createOrder, getOrder, settleIfPaid } from "../services/billing";
import { createUpiQr } from "../services/razorpay";
import { renderReceiptPdf } from "../services/pdf";
import { shareReceipt } from "../services/whatsapp";
import { emitToOutlet } from "../realtime";
import { notify } from "../services/notify";
import { onOrderCancelled, onPaymentsRecorded } from "../services/promotions";
import { onOrderCancelledService } from "../services/service-context";
import { restoreStockForOrder } from "../services/inventory";
import { alertOrderCancelled } from "../services/alerts";

export const ordersRouter = Router();
ordersRouter.use(authenticate, requireOutlet, requireModule("BILLING"));

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

ordersRouter.get("/", requirePermission("bills:view"), async (req, res) => {
  const q = parse(
    z.object({
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      status: z.enum(["OPEN", "PAID", "CANCELLED"]).optional(),
      search: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(200).default(50),
    }),
    req.query,
  );
  const outlet = await prisma.outlet.findUniqueOrThrow({ where: { id: req.outletId } });
  const where = {
    outletId: req.outletId,
    ...(q.status && { status: q.status }),
    ...(q.search && {
      OR: [
        { invoiceNumber: { contains: q.search, mode: "insensitive" as const } },
        { customerPhone: { contains: q.search } },
        { customerName: { contains: q.search, mode: "insensitive" as const } },
      ],
    }),
    ...(q.date && {
      createdAt: {
        gte: startOfLocalDay(q.date, outlet.timezone),
        lt: new Date(startOfLocalDay(q.date, outlet.timezone).getTime() + 86_400_000),
      },
    }),
  };
  res.json(
    await prisma.order.findMany({
      where,
      include: { items: true, payments: true, cashier: { select: { id: true, name: true } }, delivery: { select: { id: true, status: true, cod: true, agentId: true, cashSettledAt: true, agent: { select: { id: true, name: true } } } } },
      orderBy: { createdAt: "desc" },
      take: q.limit,
    }),
  );
});

ordersRouter.get("/:id", requirePermission("order:view"), async (req, res) => {
  const order = await getOrder(param(req, "id"), req.outletId!);
  res.json({ ...order, amountPaid: amountPaid(order), balance: Math.max(0, order.grandTotal - amountPaid(order)) });
});

ordersRouter.post("/:id/cancel", requirePermission("order:cancel"), async (req, res) => {
  const { reason } = parse(z.object({ reason: z.string().min(3).max(200) }), req.body);
  const order = await getOrder(param(req, "id"), req.outletId!);
  if (order.status === "CANCELLED") throw conflict("Order already cancelled");
  const updated = await prisma.$transaction(async (tx) => {
    const u = await tx.order.update({
      where: { id: order.id },
      data: { status: "CANCELLED", cancelledAt: new Date(), cancelReason: reason },
    });
    await onOrderCancelled(tx, order.id);
    await onOrderCancelledService(tx, order.id);
    await restoreStockForOrder(tx, order.id);
    await audit(req, "order.cancel", "Order", order.id, { reason, wasPaid: order.status === "PAID", invoiceNumber: order.invoiceNumber }, tx);
    return u;
  });
  emitToOutlet(req.outletId!, "order:cancelled", { id: order.id });
  void alertOrderCancelled(req.outletId!, order.id, req.user!, reason);
  res.json(updated);
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
  const cashPart = payments.filter((p) => p.mode === "CASH").reduce((s, p) => s + p.amount, 0);
  if (tendered !== undefined && tendered < cashPart) throw badRequest("Cash tendered is less than cash amount");

  const paid = await prisma.$transaction(async (tx) => {
    await tx.payment.createMany({
      data: payments.map((p) => ({
        orderId: order.id,
        mode: p.mode,
        amount: p.amount,
        reference: p.reference,
        status: "SUCCESS" as const,
        confirmedAt: new Date(),
      })),
    });
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

  const outlet = await prisma.outlet.findUniqueOrThrow({ where: { id: req.outletId } });
  const qr = await createUpiQr({
    amount: due,
    orderId: order.id,
    invoiceNumber: order.invoiceNumber,
    payeeName: outlet.name,
    vpa: outlet.upiVpa,
  });
  // Replace any earlier pending QR only once the new one exists (a failure keeps the old QR usable).
  await prisma.payment.updateMany({ where: { orderId: order.id, mode: "UPI", status: "PENDING" }, data: { status: "FAILED" } });
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
