import type { Request } from "express";
import type { Prisma } from "@prisma/client";
import { financialYearStart, formatInvoiceNumber, formatINR, type RefundInput } from "@canavo/shared";
import { prisma } from "../db";
import { audit } from "../lib/audit";
import { badRequest, conflict, notFound } from "../lib/http";
import { moduleEnabled } from "../lib/tenant";
import { approvalsOn, requireApproval } from "./approvals";
import { applyStockMovement, computeConsumption } from "./inventory";
import { creditGiftCard } from "./gift-cards";
import { creditWallet } from "./canteen";

/**
 * Refunds as GST credit notes (Phase 3.1). A credit note is issued against a PAID bill, for
 * some of its items (and quantities) or for a value only (e.g. overcharge). It has its own
 * series per outlet and financial year, reverses the tax proportionally, and records how the
 * money went back (cash / UPI / card, or as credit on the customer's khata). Optionally the
 * refunded items' ingredients go back into stock. The bill itself stays as issued (GST
 * invoices are never edited); reports subtract credit notes in the period they're issued.
 */
type Tx = Prisma.TransactionClient;

interface CreditedLine {
  orderItemId: string;
  name: string;
  quantity: number;
  taxableValue: number;
  cgst: number;
  sgst: number;
  igst: number;
  cess: number;
  otherTaxes: number;
  total: number;
}

const TAX_FIELDS = ["taxableValue", "cgst", "sgst", "igst", "cess", "otherTaxes"] as const;

/** "CNINV-2026-00007": CN + up to 4 characters of the outlet's invoice prefix (16-character GST limit). */
export const creditNoteNumber = (invoicePrefix: string, fyStart: number, seq: number) => formatInvoiceNumber(`CN${invoicePrefix.slice(0, 4)}`, fyStart, seq);

/**
 * `opts.systemRefund`: an automatic refund the outlet can't decline (an online order it rejected
 * after the customer had paid) — no manager approval is asked for.
 */
export async function createCreditNote(req: Request, orderId: string, input: RefundInput, opts: { systemRefund?: boolean } = {}) {
  const outletId = req.outletId!;
  return prisma.$transaction(async (tx) => {
    // Lock the bill first: two refunds (or a refund and a void) at the same moment run one after the other.
    await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${orderId} AND "outletId" = ${outletId} FOR UPDATE`;
    const order = await tx.order.findFirst({
      where: { id: orderId, outletId },
      include: { items: true, creditNotes: true, payments: { where: { status: "SUCCESS" } }, outlet: { select: { invoicePrefix: true, timezone: true } } },
    });
    if (!order) throw notFound("Order");
    if (order.status !== "PAID") throw conflict("Only paid bills can be refunded. Cancel an unpaid bill instead.");
    const remaining = order.grandTotal - order.refundedAmount;
    if (remaining <= 0) throw conflict("This bill has already been refunded in full");

    // Already credited per line (quantity and amounts).
    const credited = new Map<string, CreditedLine>();
    for (const cn of order.creditNotes) {
      for (const l of cn.items as unknown as CreditedLine[]) {
        const c = credited.get(l.orderItemId) ?? { ...l, quantity: 0, taxableValue: 0, cgst: 0, sgst: 0, igst: 0, cess: 0, otherTaxes: 0, total: 0 };
        c.quantity += l.quantity;
        for (const f of TAX_FIELDS) c[f] += l[f];
        c.total += l.total;
        credited.set(l.orderItemId, c);
      }
    }

    let lines: CreditedLine[] = [];
    let amount: number;
    const sums = { taxableValue: 0, cgst: 0, sgst: 0, igst: 0, cess: 0, otherTaxes: 0 };
    if (input.items?.length) {
      const byId = new Map(order.items.map((i) => [i.id, i]));
      lines = input.items.map((req) => {
        const item = byId.get(req.orderItemId);
        if (!item) throw badRequest("That item isn't on this bill");
        const before = credited.get(item.id);
        const left = item.quantity - (before?.quantity ?? 0);
        if (req.quantity > left) throw badRequest(`Only ${left} × ${item.name} can still be refunded`);
        // The last units take whatever is left, so rounding never leaves paise behind. Earlier refunds
        // round the running total (not each share), so their sum never passes the line and the last
        // share can't go negative (dba-1: CGST 20 on 8 units refunded one by one gave −1 on the last).
        const last = req.quantity === left;
        const doneQty = before?.quantity ?? 0;
        const part = (v: number, done: number) => (last ? v - done : Math.max(0, Math.round((v * (doneQty + req.quantity)) / item.quantity) - done));
        const out: CreditedLine = {
          orderItemId: item.id,
          name: item.name,
          quantity: req.quantity,
          taxableValue: part(item.taxableValue + item.serviceCharge, before?.taxableValue ?? 0),
          cgst: part(item.cgst, before?.cgst ?? 0),
          sgst: part(item.sgst, before?.sgst ?? 0),
          igst: part(item.igst, before?.igst ?? 0),
          cess: part(item.cess, before?.cess ?? 0),
          otherTaxes: part(item.otherTaxes, before?.otherTaxes ?? 0),
          total: part(item.total, before?.total ?? 0),
        };
        return out;
      });
      for (const l of lines) for (const f of TAX_FIELDS) sums[f] += l[f];
      amount = lines.reduce((s, l) => s + l.total, 0);
      // Refunding everything that's left: include the bill's round-off and extra charges.
      const allDone = order.items.every((i) => {
        const q = (credited.get(i.id)?.quantity ?? 0) + lines.filter((l) => l.orderItemId === i.id).reduce((s, l) => s + l.quantity, 0);
        return q >= i.quantity;
      });
      if (allDone) amount = remaining;
      amount = Math.min(amount, remaining);
    } else {
      amount = input.amount ?? 0;
      if (amount <= 0) throw badRequest("Enter the amount to refund");
      if (amount > remaining) throw badRequest(`At most ${formatINR(remaining)} can still be refunded on this bill`);
      // Value credit: tax reversed in the bill's own proportions.
      const ratio = amount / order.grandTotal;
      for (const f of ["cgst", "sgst", "igst", "cess", "otherTaxes"] as const) sums[f] = Math.round(order[f] * ratio);
      sums.taxableValue = amount - sums.cgst - sums.sgst - sums.igst - sums.cess - sums.otherTaxes;
    }

    // Phase 5.1: the company's share goes back to the company (its statement), the rest to the employee.
    const corporatePaid = order.payments.filter((p) => p.mode === "CORPORATE").reduce((s, p) => s + p.amount, 0);
    if (corporatePaid > 0 || input.refundMode === "CORPORATE") {
      const byMode = await tx.creditNote.groupBy({ by: ["refundMode"], where: { orderId: order.id }, _sum: { amount: true } });
      const corporateRefunded = byMode.find((m) => m.refundMode === "CORPORATE")?._sum.amount ?? 0;
      const otherRefunded = byMode.filter((m) => m.refundMode !== "CORPORATE").reduce((s, m) => s + (m._sum.amount ?? 0), 0);
      if (input.refundMode === "CORPORATE" && amount > corporatePaid - corporateRefunded) {
        throw badRequest(`At most ${formatINR(Math.max(0, corporatePaid - corporateRefunded))} of this bill was paid by the company`);
      }
      if (input.refundMode !== "CORPORATE" && amount > order.grandTotal - corporatePaid - otherRefunded) {
        throw badRequest(`The member paid ${formatINR(order.grandTotal - corporatePaid)} of this bill; refund the company's share as "Company"`);
      }
    }
    if (input.refundMode === "WALLET") {
      const member = order.customerId ? await tx.customer.findFirst({ where: { id: order.customerId, canteenMember: true }, select: { id: true } }) : null;
      if (!member) throw badRequest("Refund to wallet needs a canteen member on the bill");
      await creditWallet(tx, member.id, amount, { outletId, type: "REFUND", orderId: order.id, note: `Refund on bill ${order.invoiceNumber}`, userId: req.user!.id });
    }
    if (input.refundMode === "KHATA") await creditKhata(tx, req, order, amount);
    if (input.refundMode === "GIFT_CARD") {
      // Back onto the gift card the bill was paid with, at most what was paid by gift card.
      const gc = order.payments.filter((p) => p.mode === "GIFT_CARD" && p.giftCardId);
      const already = await tx.creditNote.aggregate({ where: { orderId: order.id, refundMode: "GIFT_CARD" }, _sum: { amount: true } });
      if (!gc.length || amount > gc.reduce((s, p) => s + p.amount, 0) - (already._sum.amount ?? 0)) {
        throw badRequest("Only the part of the bill paid by gift card can be refunded to the gift card");
      }
      await creditGiftCard(tx, gc[0]!.giftCardId!, amount, { outletId, orderId: order.id, note: `Refund on bill ${order.invoiceNumber}`, userId: req.user!.id });
    }

    const approvedById = approvalsOn() && !opts.systemRefund
      ? await requireApproval(req, { action: "REFUND", outletId, orderId: order.id, amount, reason: input.note ?? input.reason, approval: input.approval }, tx)
      : null;

    const fy = financialYearStart(new Date(), order.outlet.timezone);
    const counter = await tx.creditNoteCounter.upsert({
      where: { outletId_fyStart: { outletId, fyStart: fy } },
      create: { outletId, fyStart: fy, lastSeq: 1 },
      update: { lastSeq: { increment: 1 } },
    });
    const restock = input.restock && lines.length > 0 && moduleEnabled("INVENTORY");
    const note = await tx.creditNote.create({
      data: {
        outletId,
        orderId: order.id,
        number: creditNoteNumber(order.outlet.invoicePrefix, fy, counter.lastSeq),
        fyStart: fy,
        reason: input.reason,
        note: input.note,
        refundMode: input.refundMode,
        items: lines as unknown as Prisma.InputJsonValue,
        ...sums,
        amount,
        restocked: restock,
        createdById: req.user!.id,
        approvedById,
      },
    });
    await tx.order.update({ where: { id: order.id }, data: { refundedAmount: { increment: amount } } });
    if (restock) await restockLines(tx, outletId, note.id, order.items, lines, req.user!.id);
    await audit(req, "order.refund", "Order", order.id, { creditNote: note.number, amount, mode: input.refundMode, reason: input.reason, restock }, tx);
    return note;
  });
}

/** Refund to khata: a CREDIT on the customer's ledger, at most what this bill put on khata. */
async function creditKhata(tx: Tx, req: Request, order: { id: string; outletId: string; customerId: string | null; invoiceNumber: string; payments: { mode: string; amount: number }[] }, amount: number) {
  if (!order.customerId) throw badRequest("Refund to khata needs the bill's customer");
  const khataPaid = order.payments.filter((p) => p.mode === "KHATA").reduce((s, p) => s + p.amount, 0);
  const already = await tx.creditNote.aggregate({ where: { orderId: order.id, refundMode: "KHATA" }, _sum: { amount: true } });
  if (amount > khataPaid - (already._sum.amount ?? 0)) throw badRequest("Only the part of the bill that was put on khata can be refunded to khata");
  await tx.khataTransaction.create({
    data: { customerId: order.customerId, outletId: order.outletId, orderId: order.id, type: "CREDIT", amount, mode: "REFUND", note: `Refund on bill ${order.invoiceNumber}`, createdById: req.user!.id },
  });
  await tx.customer.update({ where: { id: order.customerId }, data: { khataBalance: { decrement: amount } } });
}

/** Put the refunded items' ingredients back (recipe × quantity), booked against the credit note. */
async function restockLines(tx: Tx, outletId: string, creditNoteId: string, items: { id: string; menuItemId: string; variantId: string | null }[], lines: CreditedLine[], userId: string) {
  const byId = new Map(items.map((i) => [i.id, i]));
  const sold = lines.map((l) => ({ menuItemId: byId.get(l.orderItemId)!.menuItemId, variantId: byId.get(l.orderItemId)!.variantId, quantity: l.quantity }));
  const recipes = await tx.recipe.findMany({
    where: { menuItemId: { in: [...new Set(sold.map((s) => s.menuItemId))] }, item: { active: true } },
    select: { menuItemId: true, variantId: true, inventoryItemId: true, quantity: true },
  });
  for (const [inventoryItemId, qty] of [...computeConsumption(sold, recipes)].sort(([a], [b]) => a.localeCompare(b))) {
    if (qty <= 0) continue;
    await applyStockMovement(tx, { outletId, inventoryItemId, type: "SALE_REVERSAL", quantity: qty, refType: "CreditNote", refId: creditNoteId, note: "Refund (restocked)", userId });
  }
}
