import crypto from "node:crypto";
import type { Request } from "express";
import type { Prisma } from "@prisma/client";
import { formatINR, type GiftCardIssueInput } from "@canavo/shared";
import { prisma } from "../db";
import { audit } from "../lib/audit";
import { badRequest, conflict, notFound } from "../lib/http";
import { requireBusinessId } from "../lib/tenant";

/**
 * Closed-loop gift cards (Phase 3.8, D6 — usable only at this business, no cash-out, so no
 * RBI PPI authorisation). Selling a card is not a supply (no GST, not in sales): it's a
 * liability until spent; the bill it's spent on carries the GST. Balances only move through
 * GiftCardTxn rows with compare-and-set updates, so two tills can't overspend a card.
 */
type Tx = Prisma.TransactionClient;
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export const newGiftCardCode = () => `GC-${Array.from(crypto.randomBytes(10), (b) => ALPHABET[b % ALPHABET.length]).join("").replace(/(.{5})(?=.)/, "$1-")}`;

export async function issueGiftCard(req: Request, input: GiftCardIssueInput) {
  const businessId = requireBusinessId();
  const code = input.code ?? newGiftCardCode();
  if (await prisma.giftCard.findFirst({ where: { code }, select: { id: true } })) throw conflict(`Gift card ${code} already exists`);
  const card = await prisma.$transaction(async (tx) => {
    const c = await tx.giftCard.create({
      data: {
        businessId,
        code,
        initialValue: input.value,
        balance: input.value,
        soldMode: input.soldMode,
        soldOutletId: req.outletId,
        customerName: input.customerName,
        customerPhone: input.customerPhone,
        expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
        createdById: req.user!.id,
      },
    });
    await tx.giftCardTxn.create({ data: { giftCardId: c.id, outletId: req.outletId, type: "ISSUE", amount: input.value, note: `Sold (${input.soldMode})`, createdById: req.user!.id } });
    return c;
  });
  await audit(req, "gift_card.issue", "GiftCard", card.id, { code, value: input.value, soldMode: input.soldMode });
  return card;
}

export async function findGiftCard(code: string, db: Tx | typeof prisma = prisma) {
  const card = await db.giftCard.findFirst({ where: { code: code.trim().toUpperCase() } });
  if (!card) throw notFound("Gift card");
  return card;
}

/** Spend from a card inside the payment transaction. */
export async function redeemGiftCard(tx: Tx, code: string, amount: number, ctx: { outletId: string; orderId: string; invoiceNumber: string; userId: string }) {
  const card = await findGiftCard(code, tx);
  if (!card.active) throw badRequest(`Gift card ${card.code} is blocked`);
  if (card.expiresAt && card.expiresAt < new Date()) throw badRequest(`Gift card ${card.code} has expired`);
  const r = await tx.giftCard.updateMany({ where: { id: card.id, balance: { gte: amount } }, data: { balance: { decrement: amount } } });
  if (!r.count) throw badRequest(`Gift card ${card.code} has only ${formatINR(card.balance)} left`);
  await tx.giftCardTxn.create({ data: { giftCardId: card.id, outletId: ctx.outletId, type: "REDEEM", amount: -amount, orderId: ctx.orderId, note: `Bill ${ctx.invoiceNumber}`, createdById: ctx.userId } });
  return card;
}

/** Put money back on a card (refund / cancelled bill). */
export async function creditGiftCard(tx: Tx, giftCardId: string, amount: number, ctx: { outletId: string; orderId: string; note: string; userId: string }) {
  await tx.giftCard.update({ where: { id: giftCardId }, data: { balance: { increment: amount } } });
  await tx.giftCardTxn.create({ data: { giftCardId, outletId: ctx.outletId, type: "REFUND", amount, orderId: ctx.orderId, note: ctx.note, createdById: ctx.userId } });
}
