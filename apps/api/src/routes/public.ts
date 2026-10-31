import express, { Router } from "express";
import jwt from "jsonwebtoken";
import { prisma } from "../db";
import { env } from "../env";
import { notFound, param, unauthorized } from "../lib/http";
import { buildReceipt, getOrder, settleIfPaid } from "../services/billing";
import { renderReceiptPdf } from "../services/pdf";
import { verifyWebhookSignature } from "../services/razorpay";
import { emitToOutlet } from "../realtime";
import { runForOutlet } from "../lib/tenant";
import { alertPaymentReceived } from "../services/alerts";

export const publicRouter = Router();

/** Signed, unauthenticated receipt link shared with customers on WhatsApp. */
publicRouter.get("/public/receipts/:token", async (req, res) => {
  let oid: string;
  try {
    oid = (jwt.verify(param(req, "token"), env.RECEIPT_LINK_SECRET) as { oid: string }).oid;
  } catch {
    throw notFound("Receipt");
  }
  const { outletId } = await prisma.order.findUniqueOrThrow({ where: { id: oid }, select: { outletId: true } });
  const order = await getOrder(oid, outletId);
  const pdf = await renderReceiptPdf(await buildReceipt(order));
  res.type("application/pdf").setHeader("content-disposition", `inline; filename="${order.invoiceNumber}.pdf"`);
  res.send(pdf);
});

interface RazorpayQrWebhook {
  event: string;
  payload: {
    qr_code?: { entity: { id: string } };
    payment?: { entity: { id: string; amount: number; vpa?: string; contact?: string } };
  };
}

/**
 * Razorpay webhook. Must receive the raw body for signature verification, so
 * it is mounted before the JSON body parser.
 */
publicRouter.post("/webhooks/razorpay", express.raw({ type: "application/json" }), async (req, res) => {
  if (!verifyWebhookSignature(req.body as Buffer, req.header("x-razorpay-signature"))) throw unauthorized("Bad signature");
  const event = JSON.parse((req.body as Buffer).toString("utf8")) as RazorpayQrWebhook;
  if (event.event !== "qr_code.credited") return res.json({ ignored: event.event });

  const qrId = event.payload.qr_code?.entity.id;
  const rzpPayment = event.payload.payment?.entity;
  if (!qrId || !rzpPayment) return res.json({ ignored: "missing payload" });

  const payment = await prisma.payment.findUnique({ where: { gatewayRef: qrId }, include: { order: true } });
  if (!payment) return res.json({ ignored: "unknown qr" });
  if (payment.status === "SUCCESS") return res.json({ ok: true, duplicate: true });

  // Webhooks arrive without a login: act inside the order's business.
  const paid = await runForOutlet(payment.order.outletId, () => prisma.$transaction(async (tx) => {
    await tx.payment.update({
      where: { id: payment.id },
      data: { status: "SUCCESS", confirmedAt: new Date(), reference: rzpPayment.id, amount: rzpPayment.amount },
    });
    await tx.auditLog.create({
      data: {
        outletId: payment.order.outletId,
        action: "payment.webhook",
        entity: "Payment",
        entityId: payment.id,
        meta: { razorpayPaymentId: rzpPayment.id, amount: rzpPayment.amount },
      },
    });
    // Capture the payer's phone before settling so loyalty credits this customer.
    const phone = rzpPayment.contact?.replace(/^\+?91/, "");
    if (phone && /^[6-9]\d{9}$/.test(phone) && !payment.order.customerPhone) {
      await tx.order.update({ where: { id: payment.orderId }, data: { customerPhone: phone } });
    }
    return settleIfPaid(payment.orderId, tx);
  }));

  emitToOutlet(payment.order.outletId, "payment:confirmed", { orderId: payment.orderId, paymentId: payment.id, paid });
  void runForOutlet(payment.order.outletId, () => alertPaymentReceived(payment.order.outletId, payment.orderId, rzpPayment.amount));
  if (paid) emitToOutlet(payment.order.outletId, "order:paid", { id: payment.orderId, invoiceNumber: payment.order.invoiceNumber });
  res.json({ ok: true });
});
