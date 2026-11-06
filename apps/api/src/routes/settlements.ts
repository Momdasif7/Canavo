import { Router } from "express";
import { z } from "zod";
import { settlementUploadSchema } from "@canavo/shared";
import { prisma } from "../db";
import { audit } from "../lib/audit";
import { parse } from "../lib/http";
import { addDays, startOfLocalDay } from "../lib/time";
import { authenticate, requireModule, requireOutlet, requirePermission } from "../middleware/auth";

/**
 * Card / UPI settlement reconciliation (Phase 3.8). The owner uploads the acquirer's or
 * bank's settlement rows (date, amount, reference); each row is matched to one unsettled
 * payment of that mode on that day — by reference (approval code / UTR) first, then by the
 * exact amount (incl. tip). What's left on either side is what to chase.
 */
export const settlementsRouter = Router();
settlementsRouter.use(authenticate, requireOutlet, requireModule("BILLING"), requirePermission("report:view"));

const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

// Reading the reconciliation is a report; uploading a file writes (marks payments settled).
settlementsRouter.post("/", requirePermission("settlement:manage"), async (req, res) => {
  const { mode, rows } = parse(settlementUploadSchema, req.body);
  const outlet = await prisma.outlet.findUniqueOrThrow({ where: { id: req.outletId! }, select: { timezone: true } });
  const dates = [...new Set(rows.map((r) => r.date))].sort();
  const from = startOfLocalDay(dates[0]!, outlet.timezone);
  const to = startOfLocalDay(addDays(dates[dates.length - 1]!, 1), outlet.timezone);
  const candidates = await prisma.payment.findMany({
    where: { mode, status: "SUCCESS", settledAt: null, createdAt: { gte: from, lt: to }, order: { outletId: req.outletId! } },
    select: { id: true, amount: true, tip: true, reference: true, authCode: true, createdAt: true, order: { select: { invoiceNumber: true } } },
    orderBy: { createdAt: "asc" },
  });
  const dayOf = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: outlet.timezone }).format(d);
  const used = new Set<string>();
  const matched: { row: number; paymentId: string; invoiceNumber: string; by: "reference" | "amount" }[] = [];
  const unmatched: { row: number; date: string; amount: number; reference?: string }[] = [];
  const now = new Date();
  rows.forEach((r, i) => {
    const sameDay = candidates.filter((p) => !used.has(p.id) && dayOf(p.createdAt) === r.date && p.amount + p.tip === r.amount);
    const byRef = r.reference ? sameDay.find((p) => p.reference === r.reference || p.authCode === r.reference) : undefined;
    const hit = byRef ?? sameDay[0];
    if (!hit) return unmatched.push({ row: i + 1, ...r });
    used.add(hit.id);
    matched.push({ row: i + 1, paymentId: hit.id, invoiceNumber: hit.order.invoiceNumber, by: byRef ? "reference" : "amount" });
  });
  await prisma.$transaction(async (tx) => {
    for (const m of matched) {
      const r = rows[m.row - 1]!;
      await tx.payment.update({ where: { id: m.paymentId }, data: { settledAt: now, settlementRef: r.reference ?? `file ${r.date}` } });
    }
  });
  await audit(req, "settlement.upload", "Payment", undefined, { mode, rows: rows.length, matched: matched.length, unmatched: unmatched.length });
  res.json({ matched, unmatched });
});

/** Expected vs settled per mode, and the payments still waiting for the bank. */
settlementsRouter.get("/", async (req, res) => {
  const outlet = await prisma.outlet.findUniqueOrThrow({ where: { id: req.outletId! }, select: { timezone: true } });
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: outlet.timezone }).format(new Date());
  const q = parse(z.object({ from: ymd.optional(), to: ymd.optional() }), req.query);
  const toDay = q.to ?? today;
  const fromDay = q.from ?? addDays(toDay, -6);
  const where = {
    mode: { in: ["CARD", "UPI"] as ("CARD" | "UPI")[] },
    status: "SUCCESS" as const,
    createdAt: { gte: startOfLocalDay(fromDay, outlet.timezone), lt: startOfLocalDay(addDays(toDay, 1), outlet.timezone) },
    order: { outletId: req.outletId! },
  };
  const [all, settled, pending] = await Promise.all([
    prisma.payment.groupBy({ by: ["mode"], where, _sum: { amount: true, tip: true }, _count: true }),
    prisma.payment.groupBy({ by: ["mode"], where: { ...where, settledAt: { not: null } }, _sum: { amount: true, tip: true }, _count: true }),
    prisma.payment.findMany({
      where: { ...where, settledAt: null },
      select: { id: true, mode: true, amount: true, tip: true, reference: true, cardLast4: true, authCode: true, createdAt: true, order: { select: { invoiceNumber: true } } },
      orderBy: { createdAt: "asc" },
      take: 500,
    }),
  ]);
  const total = (g: typeof all, mode: string) => {
    const r = g.find((x) => x.mode === mode);
    return { count: r?._count ?? 0, amount: (r?._sum.amount ?? 0) + (r?._sum.tip ?? 0) };
  };
  res.json({
    from: fromDay,
    to: toDay,
    byMode: Object.fromEntries(["CARD", "UPI"].map((m) => [m, { expected: total(all, m), settled: total(settled, m) }])),
    pending: pending.map((p) => ({ ...p, amount: p.amount + p.tip, invoiceNumber: p.order.invoiceNumber, order: undefined })),
  });
});
