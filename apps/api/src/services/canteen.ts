import type { Request } from "express";
import type { CorporateAccount, CorporateSubsidyRule, Customer, Prisma } from "@prisma/client";
import { employerShare, formatINR, type MemberLookup } from "@canavo/shared";
import { prisma } from "../db";
import { audit } from "../lib/audit";
import { badRequest, conflict, HttpError, notFound } from "../lib/http";
import { addDays, startOfLocalDay, zonedParts } from "../lib/time";
import { assertCashShiftOpen } from "./cash-shifts";
import { slotAt } from "./meal-slots";

/**
 * Canteen money (Phase 5.1 / 5.2, CANTEEN module).
 *
 * - Corporate subsidy: when a member is on a bill, the employer's share is recorded as a
 *   CORPORATE payment at billing time (never collected at the counter; the company gets a
 *   monthly statement). The bill itself is issued to the employee at full value with GST —
 *   the subsidy is who pays, not a discount, so tax and sales figures don't change.
 * - Wallet: prepaid balance on the member (Customer.walletBalance). Top-ups are not sales
 *   (no GST, a liability like gift cards); GST is on the bill the wallet pays for. Balances
 *   only move through WalletTxn rows with compare-and-set updates.
 * - Meal tokens: prepaid "one meal of this slot" tokens. Selling them is a liability too; a
 *   token pays a normal bill (payment mode MEAL_TOKEN) up to the token's price, so the
 *   meal's GST invoice is the usual one.
 */
type Tx = Prisma.TransactionClient;
type Db = Tx | typeof prisma;

export function dayWindow(at: Date, timezone: string) {
  const day = zonedParts(at, timezone).date;
  return { gte: startOfLocalDay(day, timezone), lt: startOfLocalDay(addDays(day, 1), timezone) };
}

/** Card UID first (what a reader types), then employee code, then phone. */
export async function findMember(q: string, db: Db = prisma): Promise<Customer> {
  const v = q.trim();
  if (!v) throw badRequest("Scan a card or type an employee code / phone");
  const byCard = await db.customer.findFirst({ where: { canteenMember: true, cardUid: v.toUpperCase() } });
  if (byCard) return byCard;
  const byCode = await db.customer.findMany({ where: { canteenMember: true, employeeCode: { equals: v, mode: "insensitive" } }, take: 2 });
  if (byCode.length > 1) throw conflict("Two members share this employee code. Scan the card or type the phone number.");
  if (byCode[0]) return byCode[0];
  if (/^[6-9]\d{9}$/.test(v)) {
    const byPhone = await db.customer.findFirst({ where: { canteenMember: true, phone: v } });
    if (byPhone) return byPhone;
  }
  throw notFound("Member");
}

/** The account's rule for a slot: a rule for that slot wins over the all-slots rule. */
export async function ruleFor(db: Db, accountId: string, mealSlotId: string | null): Promise<CorporateSubsidyRule | null> {
  const rules = await db.corporateSubsidyRule.findMany({
    where: { corporateAccountId: accountId, active: true, OR: [{ mealSlotId: null }, ...(mealSlotId ? [{ mealSlotId }] : [])] },
    orderBy: { createdAt: "asc" },
  });
  return (mealSlotId && rules.find((r) => r.mealSlotId === mealSlotId)) || rules.find((r) => r.mealSlotId === null) || null;
}

/** A member's meals and employer share so far today (cancelled bills don't count). */
async function usageToday(db: Db, memberId: string, mealSlotId: string | null, win: { gte: Date; lt: Date }, excludeOrderId?: string) {
  const base: Prisma.OrderWhereInput = { customerId: memberId, status: { not: "CANCELLED" }, createdAt: win, ...(excludeOrderId && { id: { not: excludeOrderId } }) };
  const [mealsToday, mealsInSlot, used] = await Promise.all([
    db.order.count({ where: base }),
    db.order.count({ where: { ...base, mealSlotId } }),
    db.payment.aggregate({ where: { mode: "CORPORATE", status: "SUCCESS", order: base }, _sum: { amount: true } }),
  ]);
  return { mealsToday, mealsInSlot, subsidyUsedToday: used._sum.amount ?? 0 };
}

type Usage = Awaited<ReturnType<typeof usageToday>>;

function quotaLeft(account: Pick<CorporateAccount, "dailyMealLimit">, rule: Pick<CorporateSubsidyRule, "slotMealLimit"> | null, u: Usage) {
  const day = account.dailyMealLimit != null ? account.dailyMealLimit - u.mealsToday : null;
  const slot = rule?.slotMealLimit != null ? rule.slotMealLimit - u.mealsInSlot : null;
  const left = [day, slot].filter((x): x is number => x !== null);
  return { left: left.length ? Math.max(0, Math.min(...left)) : null, dayFull: day !== null && day <= 0, slotFull: slot !== null && slot <= 0 };
}

/** Employer share not yet paid: CORPORATE payments − refunds to the company − paid statements. */
export async function corporateOutstanding(db: Db, accountId: string) {
  const [billed, refunded, paid] = await Promise.all([
    db.payment.aggregate({ where: { corporateAccountId: accountId, mode: "CORPORATE", status: "SUCCESS", order: { status: { not: "CANCELLED" } } }, _sum: { amount: true } }),
    db.creditNote.aggregate({ where: { refundMode: "CORPORATE", order: { payments: { some: { corporateAccountId: accountId } } } }, _sum: { amount: true } }),
    db.corporateStatement.aggregate({ where: { corporateAccountId: accountId, status: "PAID" }, _sum: { amount: true } }),
  ]);
  return (billed._sum.amount ?? 0) - (refunded._sum.amount ?? 0) - (paid._sum.amount ?? 0);
}

/** What the POS shows after a card scan: wallet, quota left, the subsidy that will apply, tokens. */
export async function memberSnapshot(member: Customer, outlet: { id: string; timezone: string }): Promise<MemberLookup> {
  const now = new Date();
  const slot = await slotAt(outlet.id, now, outlet.timezone);
  const account = member.corporateAccountId ? await prisma.corporateAccount.findFirst({ where: { id: member.corporateAccountId } }) : null;
  const rule = account?.active ? await ruleFor(prisma, account.id, slot?.id ?? null) : null;
  const u = await usageToday(prisma, member.id, slot?.id ?? null, dayWindow(now, outlet.timezone));
  const tokenAccounts = await prisma.mealTokenAccount.findMany({ where: { customerId: member.id, balance: { gt: 0 } } });
  const slotIds = tokenAccounts.map((t) => t.mealSlotId).filter((x): x is string => !!x);
  const slotNames = new Map((await prisma.mealSlot.findMany({ where: { id: { in: slotIds } }, select: { id: true, name: true } })).map((s) => [s.id, s.name]));
  return {
    id: member.id,
    name: member.name,
    phone: member.phone,
    employeeCode: member.employeeCode,
    department: member.department,
    cardUid: member.cardUid,
    memberActive: member.memberActive,
    walletBalance: member.walletBalance,
    account: account && { id: account.id, name: account.name, active: account.active },
    slot: slot && { id: slot.id, name: slot.name },
    rule: rule && { type: rule.type, value: rule.value, maxPerMeal: rule.maxPerMeal, maxPerDay: rule.maxPerDay },
    subsidyUsedToday: u.subsidyUsedToday,
    mealsLeftToday: account?.active ? quotaLeft(account, rule, u).left : null,
    tokens: tokenAccounts.map((t) => ({ mealSlotId: t.mealSlotId, slotName: t.mealSlotId ? (slotNames.get(t.mealSlotId) ?? "Slot") : null, balance: t.balance, unitValue: Math.round(t.value / t.balance) })),
  };
}

/**
 * Inside the bill's transaction: check the member's quota and add the employer's share as a
 * CORPORATE payment. The member row is locked so two counters can't both use the last meal
 * or the day's cap. Offline bills already happened: they skip the refusals.
 */
export async function applyMemberShare(
  tx: Tx,
  o: { orderId: string; grandTotal: number; memberId: string; mealSlotId: string | null; createdAt: Date; timezone: string; offline: boolean },
): Promise<number> {
  await tx.$queryRaw`SELECT id FROM "Customer" WHERE id = ${o.memberId} FOR UPDATE`;
  const member = await tx.customer.findFirstOrThrow({ where: { id: o.memberId } });
  if (!member.corporateAccountId) return 0;
  const account = await tx.corporateAccount.findFirst({ where: { id: member.corporateAccountId } });
  if (!account?.active) return 0;
  const rule = await ruleFor(tx, account.id, o.mealSlotId);
  const u = await usageToday(tx, member.id, o.mealSlotId, dayWindow(o.createdAt, o.timezone), o.orderId);
  const quota = quotaLeft(account, rule, u);
  if (quota.left === 0 && !o.offline) {
    const which = quota.slotFull ? `${rule!.slotMealLimit} meal${rule!.slotMealLimit === 1 ? "" : "s"} in this slot` : `${account.dailyMealLimit} meal${account.dailyMealLimit === 1 ? "" : "s"} a day`;
    throw new HttpError(409, `${member.name ?? "This member"} has already had today's quota (${account.name} allows ${which}). Bill without the card to charge the full price.`, { code: "MEAL_QUOTA_REACHED" });
  }
  const share = employerShare(rule, o.grandTotal, u.subsidyUsedToday);
  if (share <= 0) return 0;
  if (account.creditLimit > 0 && !o.offline && (await corporateOutstanding(tx, account.id)) + share > account.creditLimit) {
    throw new HttpError(409, `${account.name} has reached its credit limit of ${formatINR(account.creditLimit)}. Ask them to clear their statement, or bill without the card.`, { code: "CORPORATE_CREDIT_LIMIT" });
  }
  await tx.payment.create({
    data: { orderId: o.orderId, mode: "CORPORATE", amount: share, corporateAccountId: account.id, reference: account.name.slice(0, 100), status: "SUCCESS", confirmedAt: new Date() },
  });
  return share;
}

// ---------- Wallet ----------

/** Spend from a member's wallet inside the payment transaction (compare-and-set). */
export async function spendWallet(tx: Tx, customerId: string, amount: number, ctx: { outletId: string; orderId: string; invoiceNumber: string; userId: string }) {
  const r = await tx.customer.updateMany({ where: { id: customerId, canteenMember: true, walletBalance: { gte: amount } }, data: { walletBalance: { decrement: amount } } });
  if (!r.count) {
    const c = await tx.customer.findFirst({ where: { id: customerId }, select: { walletBalance: true, canteenMember: true } });
    if (!c?.canteenMember) throw badRequest("Wallet payments need a canteen member on the bill");
    throw badRequest(`Wallet has only ${formatINR(c.walletBalance)} left`);
  }
  await tx.walletTxn.create({ data: { customerId, outletId: ctx.outletId, type: "SPEND", amount: -amount, orderId: ctx.orderId, note: `Bill ${ctx.invoiceNumber}`, createdById: ctx.userId } });
}

/** Put money on a wallet (top-up, refund, cancelled bill, + adjustment). */
export async function creditWallet(
  tx: Tx,
  customerId: string,
  amount: number,
  ctx: { outletId: string; type: "TOPUP" | "REFUND" | "ADJUST"; orderId?: string; mode?: string; note: string; userId: string },
) {
  await tx.customer.update({ where: { id: customerId }, data: { walletBalance: { increment: amount } } });
  return tx.walletTxn.create({ data: { customerId, outletId: ctx.outletId, type: ctx.type, amount, mode: ctx.mode, orderId: ctx.orderId, note: ctx.note, createdById: ctx.userId } });
}

async function getMember(db: Db, id: string) {
  const m = await db.customer.findFirst({ where: { id, canteenMember: true } });
  if (!m) throw notFound("Member");
  return m;
}

/** Counter top-up (cash / UPI / card). Not a sale: no GST, no invoice; cash goes in the drawer. */
export async function topUpWallet(req: Request, customerId: string, input: { amount: number; mode: string; reference?: string }) {
  await assertCashShiftOpen(req.outletId!, [input.mode]);
  const result = await prisma.$transaction(async (tx) => {
    const m = await getMember(tx, customerId);
    if (!m.memberActive) throw badRequest(`${m.name ?? "This member"}'s card is inactive`);
    const txn = await creditWallet(tx, m.id, input.amount, { outletId: req.outletId!, type: "TOPUP", mode: input.mode, note: input.reference ? `Top-up (${input.reference})` : "Top-up", userId: req.user!.id });
    await audit(req, "wallet.topup", "Customer", m.id, { amount: input.amount, mode: input.mode }, tx);
    return { txn, walletBalance: m.walletBalance + input.amount };
  });
  return result;
}

/** Manager correction (+ or −); a deduction can't take the balance below zero. */
export async function adjustWallet(req: Request, customerId: string, input: { amount: number; note: string }) {
  return prisma.$transaction(async (tx) => {
    const m = await getMember(tx, customerId);
    if (input.amount > 0) await creditWallet(tx, m.id, input.amount, { outletId: req.outletId!, type: "ADJUST", note: input.note, userId: req.user!.id });
    else {
      const r = await tx.customer.updateMany({ where: { id: m.id, walletBalance: { gte: -input.amount } }, data: { walletBalance: { increment: input.amount } } });
      if (!r.count) throw badRequest(`Wallet has only ${formatINR(m.walletBalance)}`);
      await tx.walletTxn.create({ data: { customerId: m.id, outletId: req.outletId!, type: "ADJUST", amount: input.amount, note: input.note, createdById: req.user!.id } });
    }
    await audit(req, "wallet.adjust", "Customer", m.id, { amount: input.amount, note: input.note }, tx);
    return tx.customer.findFirstOrThrow({ where: { id: m.id } });
  });
}

// ---------- Meal tokens ----------

/** Sell tokens (paid like a top-up: a liability, no GST until a meal is served). */
export async function purchaseTokens(req: Request, customerId: string, input: { mealSlotId?: string | null; count: number; unitPrice: number; mode: string; reference?: string }) {
  await assertCashShiftOpen(req.outletId!, [input.mode]);
  const mealSlotId = input.mealSlotId ?? null;
  if (mealSlotId && !(await prisma.mealSlot.findFirst({ where: { id: mealSlotId }, select: { id: true } }))) throw badRequest("Unknown meal slot");
  const amount = input.count * input.unitPrice;
  return prisma.$transaction(async (tx) => {
    const m = await getMember(tx, customerId);
    if (!m.memberActive) throw badRequest(`${m.name ?? "This member"}'s card is inactive`);
    const acc = (await tx.mealTokenAccount.findFirst({ where: { customerId: m.id, mealSlotId } })) ?? (await tx.mealTokenAccount.create({ data: { customerId: m.id, mealSlotId } }));
    const updated = await tx.mealTokenAccount.update({ where: { id: acc.id }, data: { balance: { increment: input.count }, value: { increment: amount } } });
    await tx.mealTokenTxn.create({
      data: { accountId: acc.id, customerId: m.id, outletId: req.outletId!, type: "PURCHASE", count: input.count, amount, mode: input.mode, note: input.reference ? `Bought (${input.reference})` : "Bought", createdById: req.user!.id },
    });
    await audit(req, "meal_tokens.purchase", "Customer", m.id, { count: input.count, amount, mode: input.mode, mealSlotId }, tx);
    return updated;
  });
}

/**
 * Use tokens on a bill (inside the payment transaction). Tokens for the bill's slot are used
 * before any-slot tokens. They cover at most their price; if the meal costs less, the token is
 * still used up in full (a token is "one meal").
 */
export async function redeemTokens(tx: Tx, o: { customerId: string; mealSlotId: string | null; tokens: number; amount: number; outletId: string; orderId: string; invoiceNumber: string; userId: string }) {
  const accounts = await tx.mealTokenAccount.findMany({
    where: { customerId: o.customerId, balance: { gte: o.tokens }, OR: [{ mealSlotId: null }, ...(o.mealSlotId ? [{ mealSlotId: o.mealSlotId }] : [])] },
  });
  const acc = accounts.find((a) => a.mealSlotId && a.mealSlotId === o.mealSlotId) ?? accounts.find((a) => a.mealSlotId === null);
  if (!acc) throw badRequest(o.tokens === 1 ? "No meal tokens left for this meal" : `Fewer than ${o.tokens} meal tokens left for this meal`);
  const released = o.tokens === acc.balance ? acc.value : Math.round(acc.value / acc.balance) * o.tokens;
  if (o.amount > released) throw badRequest(`${o.tokens} token${o.tokens === 1 ? "" : "s"} cover at most ${formatINR(released)}`);
  // Exact compare-and-set: another counter using the same tokens makes this one retry.
  const r = await tx.mealTokenAccount.updateMany({ where: { id: acc.id, balance: acc.balance, value: acc.value }, data: { balance: { decrement: o.tokens }, value: { decrement: released } } });
  if (!r.count) throw conflict("These meal tokens were just used at another counter. Try again.");
  await tx.mealTokenTxn.create({
    data: { accountId: acc.id, customerId: o.customerId, outletId: o.outletId, type: "REDEEM", count: -o.tokens, amount: -released, orderId: o.orderId, note: `Bill ${o.invoiceNumber}`, createdById: o.userId },
  });
}

/** Cancelled bill: give back what it took from wallets and meal tokens. */
export async function restoreCanteenForOrder(tx: Tx, orderId: string, ctx: { outletId: string; invoiceNumber: string; userId: string }) {
  const wallet = await tx.walletTxn.groupBy({ by: ["customerId"], where: { orderId }, _sum: { amount: true } });
  for (const w of wallet) {
    const net = -(w._sum.amount ?? 0);
    if (net > 0) await creditWallet(tx, w.customerId, net, { outletId: ctx.outletId, type: "REFUND", orderId, note: `Bill ${ctx.invoiceNumber} cancelled`, userId: ctx.userId });
  }
  const tokens = await tx.mealTokenTxn.groupBy({ by: ["accountId", "customerId"], where: { orderId }, _sum: { count: true, amount: true } });
  for (const t of tokens) {
    const count = -(t._sum.count ?? 0);
    const amount = -(t._sum.amount ?? 0);
    if (count <= 0) continue;
    await tx.mealTokenAccount.update({ where: { id: t.accountId }, data: { balance: { increment: count }, value: { increment: amount } } });
    await tx.mealTokenTxn.create({ data: { accountId: t.accountId, customerId: t.customerId, outletId: ctx.outletId, type: "RESTORE", count, amount, orderId, note: `Bill ${ctx.invoiceNumber} cancelled`, createdById: ctx.userId } });
  }
}

// ---------- Statements ----------

/** The company's share of meals in a period (bill date, outlet timezone), with refunds to the company. */
export async function corporateStatement(accountId: string, from: string, to: string, timezone: string) {
  const createdAt = { gte: startOfLocalDay(from, timezone), lt: startOfLocalDay(addDays(to, 1), timezone) };
  const [payments, refunds] = await Promise.all([
    prisma.payment.findMany({
      where: { corporateAccountId: accountId, mode: "CORPORATE", status: "SUCCESS", order: { status: { not: "CANCELLED" }, createdAt } },
      select: {
        amount: true,
        order: {
          select: {
            id: true, invoiceNumber: true, createdAt: true, grandTotal: true, mealSlotId: true,
            outlet: { select: { name: true } },
            customer: { select: { name: true, phone: true, employeeCode: true, department: true } },
          },
        },
      },
    }),
    prisma.creditNote.findMany({
      where: { refundMode: "CORPORATE", createdAt, order: { payments: { some: { corporateAccountId: accountId } } } },
      select: { number: true, amount: true, createdAt: true, order: { select: { invoiceNumber: true } } },
      orderBy: { createdAt: "asc" },
    }),
  ]);
  const slotIds = [...new Set(payments.map((p) => p.order.mealSlotId).filter((x): x is string => !!x))];
  const slots = new Map((await prisma.mealSlot.findMany({ where: { id: { in: slotIds } }, select: { id: true, name: true } })).map((s) => [s.id, s.name]));
  const when = (d: Date) => d.toLocaleString("en-IN", { timeZone: timezone, dateStyle: "medium", timeStyle: "short" });
  const rows = payments
    .sort((a, b) => a.order.createdAt.getTime() - b.order.createdAt.getTime())
    .map((p) => ({
      date: when(p.order.createdAt),
      bill: p.order.invoiceNumber,
      outlet: p.order.outlet.name,
      member: p.order.customer?.name ?? p.order.customer?.phone ?? "",
      employeeCode: p.order.customer?.employeeCode ?? "",
      department: p.order.customer?.department ?? "",
      slot: p.order.mealSlotId ? (slots.get(p.order.mealSlotId) ?? "") : "",
      billTotal: p.order.grandTotal,
      amount: p.amount,
    }));
  const employerShare = rows.reduce((s, r) => s + r.amount, 0);
  const refunded = refunds.reduce((s, r) => s + r.amount, 0);
  return {
    from,
    to,
    rows,
    refunds: refunds.map((r) => ({ number: r.number, bill: r.order.invoiceNumber, date: when(r.createdAt), amount: r.amount })),
    totals: { meals: new Set(payments.map((p) => p.order.id)).size, billTotal: rows.reduce((s, r) => s + r.billTotal, 0), employerShare, refunds: refunded, net: employerShare - refunded },
  };
}
