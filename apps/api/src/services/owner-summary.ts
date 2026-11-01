import type { Outlet } from "@prisma/client";
import { prisma } from "../db";
import { addDays, startOfLocalDay, zonedParts } from "../lib/time";
import { openShift, shiftSummary } from "./cash-shifts";

/**
 * Owner summary (Phase 4.3): one outlet's day so far (outlet timezone) next to the
 * same weekday last week up to the same time. Feeds GET /reports/owner-summary and
 * the anomaly alerts job. Money in paise.
 */

/** Same rule as the exceptions report: discount above the outlet's approval limit. */
export const aboveApprovalLimit = (o: { discount: number; subtotal: number }, limitPercent: number) => o.discount * 100 > o.subtotal * limitPercent;

async function paidSales(outletId: string, gte: Date, lt: Date) {
  const agg = await prisma.order.aggregate({ where: { outletId, status: "PAID", createdAt: { gte, lt } }, _sum: { grandTotal: true }, _count: true });
  return { sales: agg._sum.grandTotal ?? 0, bills: agg._count };
}

export async function outletDay(outlet: Outlet, now = new Date()) {
  const tz = outlet.timezone;
  const date = zonedParts(now, tz).date;
  const start = startOfLocalDay(date, tz);
  const elapsed = now.getTime() - start.getTime();
  const lwStart = startOfLocalDay(addDays(date, -7), tz);
  const lwNow = new Date(lwStart.getTime() + elapsed);
  const lwEnd = startOfLocalDay(addDays(date, -6), tz);
  const outletId = outlet.id;
  const today = { gte: start, lt: now };

  const [sales, lastWeek, lastWeekFullDay, voids, refunds, discounted, unapproved, closedShifts, lastClosed, open, top, stocks] = await Promise.all([
    paidSales(outletId, start, now),
    paidSales(outletId, lwStart, lwNow),
    paidSales(outletId, lwStart, lwEnd),
    prisma.order.findMany({ where: { outletId, cancelledAt: today }, select: { id: true, invoiceNumber: true, grandTotal: true } }),
    prisma.creditNote.findMany({ where: { outletId, createdAt: today }, select: { id: true, number: true, amount: true } }),
    prisma.order.findMany({ where: { outletId, createdAt: today, status: { not: "CANCELLED" }, discount: { gt: 0 } }, select: { discount: true, subtotal: true } }),
    prisma.approvalLog.count({ where: { outletId, createdAt: today, approvedById: null } }),
    prisma.cashShift.findMany({ where: { outletId, status: "CLOSED", closedAt: today }, select: { id: true, variance: true } }),
    prisma.cashShift.findFirst({ where: { outletId, status: "CLOSED" }, orderBy: { closedAt: "desc" }, select: { closedAt: true, variance: true } }),
    openShift(outletId),
    prisma.orderItem.groupBy({
      by: ["name"],
      where: { order: { outletId, status: "PAID", createdAt: today } },
      _sum: { quantity: true, total: true },
      orderBy: { _sum: { quantity: "desc" } },
      take: 5,
    }),
    prisma.inventoryStock.findMany({ where: { outletId, item: { active: true, reorderLevel: { gt: 0 } } }, select: { quantity: true, item: { select: { reorderLevel: true } } } }),
  ]);
  const refundTotal = refunds.reduce((s, r) => s + r.amount, 0);
  const cash = open
    ? { status: "OPEN" as const, expectedCash: (await shiftSummary(open)).expectedCash, openedAt: open.openedAt.toISOString(), variance: null, closedAt: null }
    : lastClosed
      ? { status: "CLOSED" as const, expectedCash: null, openedAt: null, variance: lastClosed.variance ?? 0, closedAt: lastClosed.closedAt?.toISOString() ?? null }
      : { status: "NONE" as const, expectedCash: null, openedAt: null, variance: null, closedAt: null };

  return {
    outletId,
    name: outlet.name,
    date,
    grossSales: sales.sales,
    salesAfterRefunds: sales.sales - refundTotal,
    bills: sales.bills,
    averageBill: sales.bills ? Math.round(sales.sales / sales.bills) : 0,
    voids: { count: voids.length, amount: voids.reduce((s, v) => s + v.grandTotal, 0) },
    refunds: { count: refunds.length, amount: refundTotal },
    bigDiscounts: discounted.filter((o) => aboveApprovalLimit(o, outlet.approvalDiscountPercent)).length,
    discountLimitPercent: outlet.approvalDiscountPercent,
    unapprovedApprovals: unapproved,
    cash,
    topItems: top.map((t) => ({ name: t.name, quantity: t._sum.quantity ?? 0, amount: t._sum.total ?? 0 })),
    lowStock: stocks.filter((s) => s.quantity <= s.item.reorderLevel).length,
    lastWeek: {
      date: addDays(date, -7),
      /** Up to the same time of day */
      grossSales: lastWeek.sales,
      bills: lastWeek.bills,
      fullDaySales: lastWeekFullDay.sales,
    },
    // Detail the anomaly job needs (not shown on the dashboard).
    detail: {
      voids: voids.map((v) => ({ id: v.id, label: v.invoiceNumber, amount: v.grandTotal })),
      refunds: refunds.map((r) => ({ id: r.id, label: r.number, amount: r.amount })),
      closedShifts: closedShifts.map((s) => ({ id: s.id, variance: s.variance ?? 0 })),
    },
  };
}

export type OutletDay = Awaited<ReturnType<typeof outletDay>>;

/** Dashboard payload: per-outlet rows (without job detail) plus totals across outlets. */
export async function ownerSummary(outlets: Outlet[], now = new Date()) {
  const days = await Promise.all(outlets.map((o) => outletDay(o, now)));
  const rows = days.map(({ detail: _detail, ...row }) => row);
  const sum = (f: (r: (typeof rows)[number]) => number) => rows.reduce((s, r) => s + f(r), 0);
  const gross = sum((r) => r.grossSales);
  const bills = sum((r) => r.bills);
  const lwGross = sum((r) => r.lastWeek.grossSales);
  const topItems = new Map<string, { name: string; quantity: number; amount: number }>();
  for (const t of rows.flatMap((r) => r.topItems)) {
    const cur = topItems.get(t.name) ?? { name: t.name, quantity: 0, amount: 0 };
    cur.quantity += t.quantity;
    cur.amount += t.amount;
    topItems.set(t.name, cur);
  }
  return {
    generatedAt: now.toISOString(),
    outlets: rows,
    totals: {
      grossSales: gross,
      salesAfterRefunds: sum((r) => r.salesAfterRefunds),
      bills,
      averageBill: bills ? Math.round(gross / bills) : 0,
      voids: { count: sum((r) => r.voids.count), amount: sum((r) => r.voids.amount) },
      refunds: { count: sum((r) => r.refunds.count), amount: sum((r) => r.refunds.amount) },
      bigDiscounts: sum((r) => r.bigDiscounts),
      unapprovedApprovals: sum((r) => r.unapprovedApprovals),
      lowStock: sum((r) => r.lowStock),
      /** Sum of the last closed shift's difference per outlet that has no open shift */
      cashVariance: sum((r) => r.cash.variance ?? 0),
      topItems: [...topItems.values()].sort((a, b) => b.quantity - a.quantity).slice(0, 5),
      lastWeek: {
        grossSales: lwGross,
        bills: sum((r) => r.lastWeek.bills),
        changePercent: lwGross ? Math.round(((gross - lwGross) / lwGross) * 1000) / 10 : null,
      },
    },
  };
}
