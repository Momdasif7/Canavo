import { Router } from "express";
import { giftCardIssueSchema } from "@canavo/shared";
import { prisma } from "../db";
import { audit } from "../lib/audit";
import { forbidden, param, parse } from "../lib/http";
import { featureOn } from "../lib/tenant";
import { authenticate, requireModule, requireOutlet, requirePermission } from "../middleware/auth";
import { findGiftCard, issueGiftCard } from "../services/gift-cards";
import { assertCashShiftOpen } from "../services/cash-shifts";

/** Closed-loop gift cards (Phase 3.8, feature GIFT_CARDS). */
export const giftCardsRouter = Router();
giftCardsRouter.use(authenticate, requireOutlet, requireModule("BILLING"), (_req, _res, next) => {
  if (!featureOn("GIFT_CARDS")) throw forbidden("Gift cards are not enabled for this hotel");
  next();
});

/** Sell a card (no GST now; GST applies on the bill it's spent on). */
giftCardsRouter.post("/", requirePermission("payment:collect"), async (req, res) => {
  const input = parse(giftCardIssueSchema, req.body);
  await assertCashShiftOpen(req.outletId!, [input.soldMode]);
  res.status(201).json(await issueGiftCard(req, input));
});

/** Balance and history by code (the cashier checks a card before taking it). */
giftCardsRouter.get("/code/:code", requirePermission("payment:collect"), async (req, res) => {
  const card = await findGiftCard(param(req, "code"));
  const transactions = await prisma.giftCardTxn.findMany({ where: { giftCardId: card.id }, orderBy: { createdAt: "desc" }, take: 50 });
  res.json({ ...card, expired: Boolean(card.expiresAt && card.expiresAt < new Date()), transactions });
});

giftCardsRouter.get("/", requirePermission("report:view"), async (_req, res) => {
  const cards = await prisma.giftCard.findMany({ orderBy: { createdAt: "desc" }, take: 200 });
  const outstanding = await prisma.giftCard.aggregate({ where: { active: true }, _sum: { balance: true }, _count: true });
  res.json({ cards, outstanding: { count: outstanding._count, balance: outstanding._sum.balance ?? 0 } });
});

/** Owner: block / unblock a lost or stolen card. */
giftCardsRouter.post("/:id/active", requirePermission("outlet:manage"), async (req, res) => {
  const id = param(req, "id");
  const card = await prisma.giftCard.findFirstOrThrow({ where: { id } });
  const updated = await prisma.giftCard.update({ where: { id: card.id }, data: { active: !card.active } });
  await audit(req, updated.active ? "gift_card.unblock" : "gift_card.block", "GiftCard", id);
  res.json(updated);
});
