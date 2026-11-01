import type { Request } from "express";
import type { Prisma } from "@prisma/client";
import { prisma } from "../db";
import { audit } from "../lib/audit";
import { conflict, HttpError, notFound } from "../lib/http";
import { featureOn } from "../lib/tenant";
import { approvalsOn, requireApproval } from "./approvals";

/**
 * Cash drawer shifts and the X/Z report (Phase 3.2). One open shift per outlet (one drawer).
 * Expected cash = opening float + counter cash payments + delivery cash handed over
 *   + pay-ins − pay-outs − cash refunds.
 */
type Tx = Prisma.TransactionClient;

export interface ShiftSummary {
  from: string;
  to: string;
  openingFloat: number;
  bills: { count: number; gross: number; discounts: number; tax: number };
  voids: { count: number; amount: number };
  payments: Record<string, { count: number; amount: number }>;
  counterCash: number;
  deliveryCashHandedOver: number;
  refunds: Record<string, { count: number; amount: number }>;
  cashRefunds: number;
  payIns: number;
  payOuts: number;
  expectedCash: number;
}

export async function shiftSummary(shift: { outletId: string; openedAt: Date; closedAt: Date | null; openingFloat: number; id: string }, db: Tx | typeof prisma = prisma): Promise<ShiftSummary> {
  const to = shift.closedAt ?? new Date();
  const win = { gte: shift.openedAt, lt: to };
  const [orders, voids, payments, counterCash, handovers, refunds, moves] = await Promise.all([
    db.order.aggregate({ where: { outletId: shift.outletId, status: "PAID", paidAt: win }, _count: true, _sum: { grandTotal: true, discount: true, cgst: true, sgst: true, igst: true, cess: true, otherTaxes: true } }),
    db.order.aggregate({ where: { outletId: shift.outletId, cancelledAt: win }, _count: true, _sum: { grandTotal: true } }),
    db.payment.groupBy({ by: ["mode"], where: { status: "SUCCESS", createdAt: win, order: { outletId: shift.outletId } }, _count: true, _sum: { amount: true } }),
    db.payment.aggregate({ where: { status: "SUCCESS", mode: "CASH", collectedById: null, createdAt: win, order: { outletId: shift.outletId } }, _sum: { amount: true } }),
    db.deliveryCashHandover.aggregate({ where: { outletId: shift.outletId, receivedAt: win }, _sum: { amount: true } }),
    db.creditNote.groupBy({ by: ["refundMode"], where: { outletId: shift.outletId, createdAt: win }, _count: true, _sum: { amount: true } }),
    db.cashMovement.groupBy({ by: ["type"], where: { shiftId: shift.id }, _sum: { amount: true } }),
  ]);
  const s = orders._sum;
  const cashRefunds = refunds.find((r) => r.refundMode === "CASH")?._sum.amount ?? 0;
  const payIns = moves.find((m) => m.type === "PAY_IN")?._sum.amount ?? 0;
  const payOuts = moves.find((m) => m.type === "PAY_OUT")?._sum.amount ?? 0;
  const counter = counterCash._sum.amount ?? 0;
  const handed = handovers._sum.amount ?? 0;
  return {
    from: shift.openedAt.toISOString(),
    to: to.toISOString(),
    openingFloat: shift.openingFloat,
    bills: {
      count: orders._count,
      gross: s.grandTotal ?? 0,
      discounts: s.discount ?? 0,
      tax: (s.cgst ?? 0) + (s.sgst ?? 0) + (s.igst ?? 0) + (s.cess ?? 0) + (s.otherTaxes ?? 0),
    },
    voids: { count: voids._count, amount: voids._sum.grandTotal ?? 0 },
    payments: Object.fromEntries(payments.map((p) => [p.mode, { count: p._count, amount: p._sum.amount ?? 0 }])),
    counterCash: counter,
    deliveryCashHandedOver: handed,
    refunds: Object.fromEntries(refunds.map((r) => [r.refundMode, { count: r._count, amount: r._sum.amount ?? 0 }])),
    cashRefunds,
    payIns,
    payOuts,
    expectedCash: shift.openingFloat + counter + handed + payIns - payOuts - cashRefunds,
  };
}

export const openShift = (outletId: string) => prisma.cashShift.findFirst({ where: { outletId, status: "OPEN" }, include: { movements: { orderBy: { createdAt: "asc" } } } });

export async function startShift(req: Request, openingFloat: number) {
  const outletId = req.outletId!;
  if (await openShift(outletId)) throw conflict("A cash shift is already open at this outlet. Close it first.");
  try {
    const shift = await prisma.cashShift.create({ data: { outletId, openedById: req.user!.id, openingFloat } });
    await audit(req, "cash_shift.open", "CashShift", shift.id, { openingFloat });
    return shift;
  } catch (e) {
    // The partial unique index keeps two devices from opening at the same moment.
    if ((e as { code?: string }).code === "P2002") throw conflict("A cash shift is already open at this outlet.");
    throw e;
  }
}

export async function addMovement(req: Request, input: { type: "PAY_IN" | "PAY_OUT"; amount: number; reason: string; approval?: { approverId: string; pin: string } }) {
  const shift = await openShift(req.outletId!);
  if (!shift) throw conflict("Open a cash shift first");
  return prisma.$transaction(async (tx) => {
    const approvedById =
      input.type === "PAY_OUT" && approvalsOn()
        ? await requireApproval(req, { action: "CASH_PAYOUT", outletId: shift.outletId, amount: input.amount, reason: input.reason, approval: input.approval }, tx)
        : null;
    const m = await tx.cashMovement.create({ data: { shiftId: shift.id, outletId: shift.outletId, type: input.type, amount: input.amount, reason: input.reason, createdById: req.user!.id, approvedById } });
    await audit(req, input.type === "PAY_IN" ? "cash_shift.pay_in" : "cash_shift.pay_out", "CashShift", shift.id, { amount: input.amount, reason: input.reason }, tx);
    return m;
  });
}

export async function closeShift(req: Request, input: { countedCash: number; denominations?: Record<string, number>; note?: string }) {
  const shift = await openShift(req.outletId!);
  if (!shift) throw conflict("No cash shift is open");
  const closedAt = new Date();
  const summary = await shiftSummary({ ...shift, closedAt });
  const variance = input.countedCash - summary.expectedCash;
  const closed = await prisma.cashShift.update({
    where: { id: shift.id },
    data: {
      status: "CLOSED",
      closedAt,
      closedById: req.user!.id,
      countedCash: input.countedCash,
      expectedCash: summary.expectedCash,
      variance,
      denominations: input.denominations,
      note: input.note,
      summary: summary as unknown as Prisma.InputJsonValue,
    },
  });
  await audit(req, "cash_shift.close", "CashShift", shift.id, { expectedCash: summary.expectedCash, countedCash: input.countedCash, variance });
  return { ...closed, summary };
}

export async function getShift(outletId: string, id: string) {
  const shift = await prisma.cashShift.findFirst({ where: { id, outletId }, include: { movements: { orderBy: { createdAt: "asc" } } } });
  if (!shift) throw notFound("Cash shift");
  return { ...shift, summary: (shift.summary as unknown as ShiftSummary | null) ?? (await shiftSummary(shift)) };
}

/** REQUIRE_CASH_SHIFT: cash can only be taken while a shift is open. */
export async function assertCashShiftOpen(outletId: string, modes: string[], db: Tx | typeof prisma = prisma) {
  if (!modes.includes("CASH") || !featureOn("REQUIRE_CASH_SHIFT")) return;
  if (!(await db.cashShift.findFirst({ where: { outletId, status: "OPEN" }, select: { id: true } }))) {
    throw new HttpError(409, "Open a cash shift (count the opening float) before taking cash.", { code: "CASH_SHIFT_CLOSED" });
  }
}
