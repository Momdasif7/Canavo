import { prisma } from "../db";

/**
 * Delivery partner cash ledger.
 *
 *   cash in hand = Σ cash collected at the door (Payment CASH, collectedById = partner)
 *                − Σ cash handed over (DeliveryCashHandover, entered by the outlet)
 *
 * Handovers are free-form amounts (partial handovers and corrections are
 * fine), so per-order "handed over" flags are derived first-in-first-out.
 */

const cashWhere = (outletId: string, agentId: string) => ({
  collectedById: agentId,
  mode: "CASH" as const,
  status: "SUCCESS" as const,
  order: { outletId },
});

export async function cashCollected(outletId: string, agentId: string, range?: { gte?: Date; lt?: Date }): Promise<number> {
  const agg = await prisma.payment.aggregate({
    where: { ...cashWhere(outletId, agentId), ...(range && { confirmedAt: range }) },
    _sum: { amount: true },
  });
  return agg._sum.amount ?? 0;
}

export async function cashHandedOver(outletId: string, agentId: string, range?: { gte?: Date; lt?: Date }): Promise<number> {
  const agg = await prisma.deliveryCashHandover.aggregate({
    where: { outletId, agentId, ...(range && { receivedAt: range }) },
    _sum: { amount: true },
  });
  return agg._sum.amount ?? 0;
}

/** Cash the partner still holds (as of `at`, default now). */
export async function cashBalance(outletId: string, agentId: string, at?: Date): Promise<number> {
  const upTo = at ? { lt: at } : undefined;
  const [collected, handed] = await Promise.all([cashCollected(outletId, agentId, upTo), cashHandedOver(outletId, agentId, upTo)]);
  return collected - handed;
}

/** Cash collections not yet covered by handovers (oldest first), with per-order amounts. */
export async function pendingCollections(outletId: string, agentId: string) {
  const [payments, handed] = await Promise.all([
    prisma.payment.findMany({
      where: cashWhere(outletId, agentId),
      select: { amount: true, confirmedAt: true, order: { select: { id: true, invoiceNumber: true, delivery: { select: { id: true, customerName: true, address: true } } } } },
      orderBy: { confirmedAt: "asc" },
    }),
    cashHandedOver(outletId, agentId),
  ]);
  let covered = handed;
  const pending: { orderId: string; deliveryId: string | null; invoiceNumber: string; customerName: string | null; address: string | null; amount: number; collectedAt: Date | null }[] = [];
  for (const p of payments) {
    const take = Math.min(covered, p.amount);
    covered -= take;
    const left = p.amount - take;
    if (left > 0) {
      pending.push({
        orderId: p.order.id,
        deliveryId: p.order.delivery?.id ?? null,
        invoiceNumber: p.order.invoiceNumber,
        customerName: p.order.delivery?.customerName ?? null,
        address: p.order.delivery?.address ?? null,
        amount: left,
        collectedAt: p.confirmedAt,
      });
    }
  }
  return pending;
}

/**
 * Keep Delivery.cashSettledAt in step with the ledger (FIFO): a delivery is
 * "cash handed over" once handovers cover all cash collected on it.
 */
export async function reallocateHandovers(outletId: string, agentId: string) {
  const [payments, handed] = await Promise.all([
    prisma.payment.findMany({
      where: cashWhere(outletId, agentId),
      select: { amount: true, order: { select: { delivery: { select: { id: true, cashSettledAt: true } } } } },
      orderBy: { confirmedAt: "asc" },
    }),
    cashHandedOver(outletId, agentId),
  ]);
  let covered = handed;
  const settle: string[] = [];
  const unsettle: string[] = [];
  for (const p of payments) {
    const d = p.order.delivery;
    if (!d) continue;
    const full = covered >= p.amount;
    covered = Math.max(0, covered - p.amount);
    if (full && !d.cashSettledAt) settle.push(d.id);
    if (!full && d.cashSettledAt) unsettle.push(d.id);
  }
  if (settle.length) await prisma.delivery.updateMany({ where: { id: { in: settle } }, data: { cashSettledAt: new Date() } });
  if (unsettle.length) await prisma.delivery.updateMany({ where: { id: { in: unsettle } }, data: { cashSettledAt: null, cashSettledById: null } });
}
