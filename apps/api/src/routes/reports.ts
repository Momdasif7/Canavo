import { Router, type Request, type Response } from "express";
import { z } from "zod";
import type { Outlet } from "@prisma/client";
import { exclusiveOf, financialYearLabel, ORDER_CHANNEL_LABELS, REPORT_KEYS, type OrderChannel, type ReportKey } from "@canavo/shared";
import { prisma } from "../db";
import { dayOutcome } from "../services/attendance";
import { badRequest, forbidden, parse } from "../lib/http";
import { moduleEnabled } from "../lib/tenant";
import { addDays, isValidYmd, startOfLocalDay, zonedParts } from "../lib/time";
import { authenticate, requireOutlet, requirePermission, requireModule } from "../middleware/auth";
import { sendExport, type ExportColumn, type ExportFormat, type ExportTable } from "../services/report-export";
import { buildGstr1, type Gstr1Order } from "../services/gstr1";
import { inclusiveRate, resolveItemTax } from "../services/tax";
import { aboveApprovalLimit, ownerSummary } from "../services/owner-summary";

export const reportsRouter = Router();
reportsRouter.use(authenticate, requireModule("REPORTS"));

// =====================================================================
// Shared helpers
// =====================================================================

const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(isValidYmd, "Use a real date (YYYY-MM-DD)");
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MAX_RANGE_DAYS = 366;

export interface ReportCtx {
  outlet: Outlet;
  from: string;
  to: string;
  start: Date;
  end: Date;
  q: Record<string, unknown>;
}

export interface BuiltReport {
  title: string;
  data: Record<string, unknown>;
  tables: ExportTable[];
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const pct = (part: number, whole: number) => (whole ? round1((part / whole) * 100) : 0);
const avg = (sum: number, n: number) => (n ? Math.round(sum / n) : 0);
const fmtRs = (p: number) => `Rs ${(p / 100).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Cached local-time formatter per timezone → { date: YYYY-MM-DD, hour, weekday (0 = Mon) }. */
const formatters = new Map<string, Intl.DateTimeFormat>();
export function localParts(d: Date, tz: string) {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" });
    formatters.set(tz, f);
  }
  const p = f.formatToParts(d);
  const get = (t: string) => p.find((x) => x.type === t)!.value;
  const date = `${get("year")}-${get("month")}-${get("day")}`;
  return { date, hour: Number(get("hour")), weekday: weekdayOf(date) };
}

/** 0 = Monday … 6 = Sunday for a YYYY-MM-DD date. */
export const weekdayOf = (date: string) => (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7;

export function eachDay(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

export function periodKey(date: string, groupBy: "day" | "week" | "month"): string {
  if (groupBy === "month") return date.slice(0, 7);
  if (groupBy === "week") return addDays(date, -weekdayOf(date)); // Monday of the week
  return date;
}

const daysInMonth = (date: string) => new Date(Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)), 0)).getUTCDate();

export function makeCtx(outlet: Outlet, from: string, to: string, q: Record<string, unknown> = {}): ReportCtx {
  if (from > to) throw badRequest("`from` must be on or before `to`");
  if (eachDay(from, to).length > MAX_RANGE_DAYS) throw badRequest(`Date range is limited to ${MAX_RANGE_DAYS} days`);
  return {
    outlet,
    from,
    to,
    start: startOfLocalDay(from, outlet.timezone),
    end: startOfLocalDay(addDays(to, 1), outlet.timezone),
    q,
  };
}

const window = (ctx: ReportCtx) => ({ outletId: ctx.outlet.id, createdAt: { gte: ctx.start, lt: ctx.end } });

/**
 * PostgreSQL takes at most 32,767 bind values per statement and Prisma sends `in: ids` (and a
 * filtered relation load) as one `IN ($1 … $n)`: a busy outlet's year holds more bills than that.
 * Run the query per slice of the id list instead (QA Phase 7).
 */
const IN_CHUNK = 10_000;
async function inChunks<T>(ids: string[], run: (slice: string[]) => Promise<T[]>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += IN_CHUNK) out.push(...(await run(ids.slice(i, i + IN_CHUNK))));
  return out;
}
const subtitle = (ctx: ReportCtx, extra?: string) =>
  [`${ctx.outlet.name}`, `${ctx.from} to ${ctx.to}`, extra].filter(Boolean).join(" · ");

/** Tax (GST, cess and other taxes) and round-off are excluded from net sales. */
const taxOf = (o: { cgst: number; sgst: number; igst: number; cess: number; otherTaxes: number }) =>
  o.cgst + o.sgst + o.igst + o.cess + o.otherTaxes;

// =====================================================================
// Sales
// =====================================================================

async function salesReport(ctx: ReportCtx): Promise<BuiltReport> {
  const groupBy = parse(z.enum(["day", "week", "month"]).default("day"), ctx.q.groupBy);
  const orders = await prisma.order.findMany({
    where: { ...window(ctx), status: { in: ["PAID", "CANCELLED"] } },
    select: {
      status: true, createdAt: true, orderType: true, channel: true, grandTotal: true, discount: true, promoDiscount: true,
      extraCharges: true, serviceCharge: true, cgst: true, sgst: true, igst: true, cess: true, otherTaxes: true, roundOff: true,
      // Filtered in code: a `where` here overflows the bind-value cap on >32k bills (QA Phase 7)
      payments: { select: { mode: true, amount: true, status: true } },
    },
  });

  type Bucket = {
    period: string; orders: number; gross: number; net: number; tax: number; discounts: number; promoDiscounts: number;
    extraCharges: number; serviceCharge: number; roundOff: number; aov: number; cancelled: number; cancelledValue: number;
  };
  const blank = (period: string): Bucket => ({
    period, orders: 0, gross: 0, net: 0, tax: 0, discounts: 0, promoDiscounts: 0, extraCharges: 0, serviceCharge: 0,
    roundOff: 0, aov: 0, cancelled: 0, cancelledValue: 0,
  });
  const buckets = new Map<string, Bucket>();
  for (const d of eachDay(ctx.from, ctx.to)) {
    const k = periodKey(d, groupBy);
    if (!buckets.has(k)) buckets.set(k, blank(k));
  }
  const total = blank("Total");
  const byType = new Map<string, { orderType: string; orders: number; gross: number; net: number }>();
  const byMode = new Map<string, { mode: string; count: number; amount: number }>();
  const byChannel = new Map<string, { channel: string; orders: number; gross: number; net: number }>();

  for (const o of orders) {
    const b = buckets.get(periodKey(localParts(o.createdAt, ctx.outlet.timezone).date, groupBy))!;
    for (const t of [b, total]) {
      if (o.status === "CANCELLED") {
        t.cancelled++;
        t.cancelledValue += o.grandTotal;
        continue;
      }
      const tax = taxOf(o);
      t.orders++;
      t.gross += o.grandTotal;
      t.tax += tax;
      t.net += o.grandTotal - tax - o.roundOff;
      t.promoDiscounts += o.promoDiscount;
      t.discounts += Math.max(0, o.discount - o.promoDiscount);
      t.extraCharges += o.extraCharges;
      t.serviceCharge += o.serviceCharge;
      t.roundOff += o.roundOff;
    }
    if (o.status !== "PAID") continue;
    const ty = byType.get(o.orderType) ?? { orderType: o.orderType, orders: 0, gross: 0, net: 0 };
    ty.orders++;
    ty.gross += o.grandTotal;
    ty.net += o.grandTotal - taxOf(o) - o.roundOff;
    byType.set(o.orderType, ty);
    const ch = byChannel.get(o.channel) ?? { channel: o.channel, orders: 0, gross: 0, net: 0 };
    ch.orders++;
    ch.gross += o.grandTotal;
    ch.net += o.grandTotal - taxOf(o) - o.roundOff;
    byChannel.set(o.channel, ch);
    for (const p of o.payments) {
      if (p.status !== "SUCCESS") continue;
      const m = byMode.get(p.mode) ?? { mode: p.mode, count: 0, amount: 0 };
      m.count++;
      m.amount += p.amount;
      byMode.set(p.mode, m);
    }
  }
  const periods = [...buckets.values()].map((b) => ({ ...b, aov: avg(b.gross, b.orders) }));
  total.aov = avg(total.gross, total.orders);
  const orderTypes = [...byType.values()].map((t) => ({ ...t, share: pct(t.gross, total.gross) })).sort((a, b) => b.gross - a.gross);
  const paymentModes = [...byMode.values()].map((m) => ({ ...m, share: pct(m.amount, total.gross) })).sort((a, b) => b.amount - a.amount);
  // Phase 6.1: sales by channel, with the aggregator commission estimated from Settings → Channels.
  const channelsOn = moduleEnabled("CHANNELS");
  const commission = channelsOn
    ? (((await prisma.channelConnection.findFirst({ where: { outletId: ctx.outlet.id }, select: { commission: true } }))?.commission ?? {}) as Record<string, number>)
    : {};
  const channels = [...byChannel.values()]
    .map((c) => {
      const commissionPercent = Number(commission[c.channel] ?? 0);
      const est = Math.round((c.gross * commissionPercent) / 100);
      return { ...c, label: ORDER_CHANNEL_LABELS[c.channel as OrderChannel] ?? c.channel, share: pct(c.gross, total.gross), commissionPercent, commission: est, afterCommission: c.gross - est };
    })
    .sort((a, b) => b.gross - a.gross);

  const cols: ExportColumn[] = [
    { key: "period", header: groupBy === "day" ? "Date" : groupBy === "week" ? "Week of" : "Month", width: 12 },
    { key: "orders", header: "Orders", type: "int", width: 8 },
    { key: "gross", header: "Gross", type: "money", width: 12 },
    { key: "discounts", header: "Discounts", type: "money", width: 11 },
    { key: "promoDiscounts", header: "Promo", type: "money", width: 10 },
    { key: "extraCharges", header: "Charges", type: "money", width: 10 },
    { key: "serviceCharge", header: "Service chg", type: "money", width: 10 },
    { key: "tax", header: "Tax", type: "money", width: 11 },
    { key: "net", header: "Net", type: "money", width: 12 },
    { key: "aov", header: "AOV", type: "money", width: 10 },
    { key: "cancelled", header: "Cancelled", type: "int", width: 9 },
    { key: "cancelledValue", header: "Cancelled value", type: "money", width: 12 },
  ];
  return {
    title: "Sales report",
    data: { from: ctx.from, to: ctx.to, groupBy, totals: total, periods, byOrderType: orderTypes, byPaymentMode: paymentModes, ...(channelsOn && { byChannel: channels }) },
    tables: [
      { title: "Sales", subtitle: subtitle(ctx, `grouped by ${groupBy}`), columns: cols, rows: periods, totals: { ...total, period: "Total" } },
      {
        title: "By order type",
        columns: [
          { key: "orderType", header: "Order type", width: 14 },
          { key: "orders", header: "Orders", type: "int" },
          { key: "gross", header: "Gross", type: "money", width: 14 },
          { key: "net", header: "Net", type: "money", width: 14 },
          { key: "share", header: "Share", type: "percent" },
        ],
        rows: orderTypes,
        totals: true,
      },
      {
        title: "By payment mode",
        columns: [
          { key: "mode", header: "Mode", width: 12 },
          { key: "count", header: "Payments", type: "int" },
          { key: "amount", header: "Amount", type: "money", width: 14 },
          { key: "share", header: "Share", type: "percent" },
        ],
        rows: paymentModes,
        totals: true,
      },
      ...(channelsOn
        ? [
            {
              title: "By channel",
              subtitle: "Commission is an estimate from the % set in Settings → Channels",
              columns: [
                { key: "label", header: "Channel", width: 14 },
                { key: "orders", header: "Orders", type: "int" },
                { key: "gross", header: "Gross", type: "money", width: 14 },
                { key: "net", header: "Net", type: "money", width: 14 },
                { key: "commissionPercent", header: "Commission %", width: 12 },
                { key: "commission", header: "Commission (est.)", type: "money", width: 14 },
                { key: "afterCommission", header: "After commission", type: "money", width: 14 },
                { key: "share", header: "Share", type: "percent" },
              ] as ExportColumn[],
              rows: channels,
              totals: true as const,
            },
          ]
        : []),
    ],
  };
}

// =====================================================================
// Items & categories
// =====================================================================

async function itemSales(ctx: ReportCtx) {
  const [lines, menu] = await Promise.all([
    prisma.orderItem.findMany({
      where: { order: { ...window(ctx), status: "PAID" } },
      select: { menuItemId: true, quantity: true, total: true, cgst: true, sgst: true, igst: true, cess: true, otherTaxes: true },
    }),
    prisma.menuItem.findMany({
      select: { id: true, name: true, status: true, categoryId: true, category: { select: { name: true, parent: { select: { name: true } } } } },
    }),
  ]);
  const agg = new Map<string, { quantity: number; revenue: number; net: number }>();
  for (const l of lines) {
    const a = agg.get(l.menuItemId) ?? { quantity: 0, revenue: 0, net: 0 };
    a.quantity += l.quantity;
    a.revenue += l.total;
    a.net += l.total - taxOf(l);
    agg.set(l.menuItemId, a);
  }
  const totalRevenue = [...agg.values()].reduce((s, a) => s + a.revenue, 0);
  const totalQty = [...agg.values()].reduce((s, a) => s + a.quantity, 0);
  const rows = menu
    .filter((m) => m.status !== "HIDDEN" || agg.has(m.id))
    .map((m) => {
      const a = agg.get(m.id) ?? { quantity: 0, revenue: 0, net: 0 };
      return {
        menuItemId: m.id,
        name: m.name,
        categoryId: m.categoryId,
        category: m.category.parent ? `${m.category.parent.name} / ${m.category.name}` : m.category.name,
        status: m.status,
        quantity: a.quantity,
        revenue: a.revenue,
        netRevenue: a.net,
        share: pct(a.revenue, totalRevenue),
        qtyShare: pct(a.quantity, totalQty),
      };
    });
  return { rows, totalRevenue, totalQty };
}

const itemCols: ExportColumn[] = [
  { key: "name", header: "Item", width: 28 },
  { key: "category", header: "Category", width: 22 },
  { key: "quantity", header: "Qty", type: "int", width: 8 },
  { key: "revenue", header: "Revenue", type: "money", width: 12 },
  { key: "netRevenue", header: "Net (ex-tax)", type: "money", width: 12 },
  { key: "share", header: "Share", type: "percent", width: 8 },
];

async function itemsReport(ctx: ReportCtx): Promise<BuiltReport> {
  const limit = parse(z.coerce.number().int().min(1).max(100).default(10), ctx.q.limit);
  const { rows, totalRevenue, totalQty } = await itemSales(ctx);
  const byRevenue = [...rows].sort((a, b) => b.revenue - a.revenue || b.quantity - a.quantity);
  const bestSellers = [...rows].filter((r) => r.quantity > 0).sort((a, b) => b.quantity - a.quantity).slice(0, limit);
  const slowMovers = [...rows]
    .filter((r) => r.status !== "HIDDEN")
    .sort((a, b) => a.quantity - b.quantity || a.revenue - b.revenue)
    .slice(0, limit);
  const zeroSales = rows.filter((r) => r.quantity === 0 && r.status !== "HIDDEN");
  return {
    title: "Item sales report",
    data: { from: ctx.from, to: ctx.to, totalRevenue, totalQuantity: totalQty, items: byRevenue, bestSellers, slowMovers, zeroSales: zeroSales.map((z) => ({ menuItemId: z.menuItemId, name: z.name })) },
    tables: [
      { title: "Item sales", subtitle: subtitle(ctx), columns: itemCols, rows: byRevenue, totals: true },
      { title: "Best sellers", subtitle: `Top ${limit} by quantity`, columns: itemCols, rows: bestSellers },
      { title: "Slow movers", subtitle: `Bottom ${limit} by quantity (incl. zero sales)`, columns: itemCols, rows: slowMovers },
    ],
  };
}

async function categoriesReport(ctx: ReportCtx): Promise<BuiltReport> {
  const { rows, totalRevenue } = await itemSales(ctx);
  const cats = new Map<string, { categoryId: string; category: string; items: number; itemsSold: number; quantity: number; revenue: number; netRevenue: number }>();
  for (const r of rows) {
    const c = cats.get(r.categoryId) ?? { categoryId: r.categoryId, category: r.category, items: 0, itemsSold: 0, quantity: 0, revenue: 0, netRevenue: 0 };
    c.items++;
    if (r.quantity > 0) c.itemsSold++;
    c.quantity += r.quantity;
    c.revenue += r.revenue;
    c.netRevenue += r.netRevenue;
    cats.set(r.categoryId, c);
  }
  const out = [...cats.values()].map((c) => ({ ...c, share: pct(c.revenue, totalRevenue) })).sort((a, b) => b.revenue - a.revenue);
  return {
    title: "Category sales report",
    data: { from: ctx.from, to: ctx.to, totalRevenue, categories: out },
    tables: [{
      title: "Category sales",
      subtitle: subtitle(ctx),
      columns: [
        { key: "category", header: "Category", width: 28 },
        { key: "items", header: "Items", type: "int" },
        { key: "itemsSold", header: "Items sold", type: "int" },
        { key: "quantity", header: "Qty", type: "int" },
        { key: "revenue", header: "Revenue", type: "money", width: 14 },
        { key: "netRevenue", header: "Net (ex-tax)", type: "money", width: 14 },
        { key: "share", header: "Share", type: "percent" },
      ],
      rows: out,
      totals: true,
    }],
  };
}

// =====================================================================
// Peak hours heatmap
// =====================================================================

async function peakHoursReport(ctx: ReportCtx): Promise<BuiltReport> {
  const orders = await prisma.order.findMany({ where: { ...window(ctx), status: "PAID" }, select: { createdAt: true, grandTotal: true } });
  const ordersM = WEEKDAYS.map(() => Array<number>(24).fill(0));
  const revenueM = WEEKDAYS.map(() => Array<number>(24).fill(0));
  for (const o of orders) {
    const { weekday, hour } = localParts(o.createdAt, ctx.outlet.timezone);
    ordersM[weekday][hour]++;
    revenueM[weekday][hour] += o.grandTotal;
  }
  // Number of each weekday in the range, for per-day averages.
  const dayCounts = WEEKDAYS.map(() => 0);
  for (const d of eachDay(ctx.from, ctx.to)) dayCounts[weekdayOf(d)]++;

  const cells = WEEKDAYS.flatMap((weekday, w) =>
    Array.from({ length: 24 }, (_, hour) => ({
      weekday, hour, orders: ordersM[w][hour], revenue: revenueM[w][hour],
      avgOrders: dayCounts[w] ? round1(ordersM[w][hour] / dayCounts[w]) : 0,
    })),
  );
  const peaks = [...cells].filter((c) => c.orders > 0).sort((a, b) => b.orders - a.orders || b.revenue - a.revenue).slice(0, 5);
  const byHour = Array.from({ length: 24 }, (_, hour) => ({
    hour, orders: ordersM.reduce((s, r) => s + r[hour], 0), revenue: revenueM.reduce((s, r) => s + r[hour], 0),
  }));
  const byWeekday = WEEKDAYS.map((weekday, w) => ({
    weekday, days: dayCounts[w], orders: ordersM[w].reduce((a, b) => a + b, 0), revenue: revenueM[w].reduce((a, b) => a + b, 0),
  }));

  const activeHours = byHour.filter((h) => h.orders > 0).map((h) => h.hour);
  const matrixTable = (title: string, m: number[][], type: "int" | "money"): ExportTable => ({
    title,
    subtitle: subtitle(ctx, "rows = hour of day, columns = weekday"),
    columns: [
      { key: "hour", header: "Hour", width: 8 },
      ...WEEKDAYS.map((d) => ({ key: d, header: d, type, width: type === "money" ? 11 : 6 })),
      { key: "total", header: "Total", type, width: type === "money" ? 12 : 7 },
    ],
    rows: activeHours.map((h) => ({
      hour: `${String(h).padStart(2, "0")}:00`,
      ...Object.fromEntries(WEEKDAYS.map((d, w) => [d, m[w][h]])),
      total: m.reduce((s, r) => s + r[h], 0),
    })),
    totals: true,
  });

  return {
    title: "Peak hours",
    data: { from: ctx.from, to: ctx.to, weekdays: WEEKDAYS, orders: ordersM, revenue: revenueM, cells, peaks, byHour, byWeekday },
    tables: [
      matrixTable("Orders by hour and weekday", ordersM, "int"),
      matrixTable("Revenue by hour and weekday", revenueM, "money"),
      {
        title: "Busiest slots",
        columns: [
          { key: "weekday", header: "Weekday" },
          { key: "slot", header: "Hour" },
          { key: "orders", header: "Orders", type: "int" },
          { key: "avgOrders", header: "Avg / day", type: "number" },
          { key: "revenue", header: "Revenue", type: "money", width: 14 },
        ],
        rows: peaks.map((p) => ({ ...p, slot: `${String(p.hour).padStart(2, "0")}:00-${String((p.hour + 1) % 24).padStart(2, "0")}:00` })),
      },
    ],
  };
}

// =====================================================================
// GST summary & GSTR-1
// =====================================================================

interface Breakup { rate: number; cessRate?: number; taxableValue: number; cgst: number; sgst: number; igst: number; cess?: number; otherTaxes?: number }

async function gstReport(ctx: ReportCtx): Promise<BuiltReport> {
  const orders = await prisma.order.findMany({
    where: window(ctx),
    select: {
      invoiceNumber: true, status: true, documentType: true, interState: true, grandTotal: true, roundOff: true,
      taxBreakup: true, createdAt: true, cancelledAt: true, cancelReason: true, cgst: true, sgst: true, igst: true, cess: true, otherTaxes: true,
    },
    orderBy: { createdAt: "asc" },
  });
  const rates = new Map<string, {
    rate: number; cessRate: number; supply: string; taxable: number; cgst: number; sgst: number; igst: number; cess: number; otherTaxes: number;
    totalTax: number; invoices: Set<string>;
  }>();
  const docs = new Map<string, { documentType: string; issued: number; paid: number; open: number; cancelled: number; value: number }>();
  let bosTurnover = 0;
  let plainBillTurnover = 0;
  let plainBills = 0;
  let roundOff = 0;
  const cancelled: { invoiceNumber: string; documentType: string; date: string; value: number; reason: string }[] = [];

  for (const o of orders) {
    const d = docs.get(o.documentType) ?? { documentType: o.documentType, issued: 0, paid: 0, open: 0, cancelled: 0, value: 0 };
    d.issued++;
    if (o.status === "PAID") {
      d.paid++;
      d.value += o.grandTotal;
    } else if (o.status === "OPEN") d.open++;
    else d.cancelled++;
    docs.set(o.documentType, d);

    if (o.status === "CANCELLED") {
      cancelled.push({
        invoiceNumber: o.invoiceNumber, documentType: o.documentType, date: localParts(o.createdAt, ctx.outlet.timezone).date,
        value: o.grandTotal, reason: o.cancelReason ?? "",
      });
      continue;
    }
    if (o.status !== "PAID") continue;
    if (o.documentType === "BILL_OF_SUPPLY") {
      bosTurnover += o.grandTotal;
      continue;
    }
    if (o.documentType === "BILL") {
      // Not GST registered / GST switched off: no tax, not part of the GST summary.
      plainBills++;
      plainBillTurnover += o.grandTotal;
      continue;
    }
    roundOff += o.roundOff;
    for (const b of (o.taxBreakup as unknown as Breakup[]) ?? []) {
      const supply = o.interState ? "INTER" : "INTRA";
      const cessRate = b.cessRate ?? 0;
      const k = `${b.rate}|${cessRate}|${supply}`;
      const r = rates.get(k) ?? {
        rate: b.rate, cessRate, supply, taxable: 0, cgst: 0, sgst: 0, igst: 0, cess: 0, otherTaxes: 0, totalTax: 0, invoices: new Set<string>(),
      };
      r.taxable += b.taxableValue;
      r.cgst += b.cgst;
      r.sgst += b.sgst;
      r.igst += b.igst;
      r.cess += b.cess ?? 0;
      r.otherTaxes += b.otherTaxes ?? 0;
      r.totalTax += b.cgst + b.sgst + b.igst + (b.cess ?? 0) + (b.otherTaxes ?? 0);
      r.invoices.add(o.invoiceNumber);
      rates.set(k, r);
    }
  }
  const byRate = [...rates.values()]
    .sort((a, b) => a.rate - b.rate || a.cessRate - b.cessRate || a.supply.localeCompare(b.supply))
    .map(({ invoices, ...r }) => ({ ...r, invoices: invoices.size }));
  const totals = byRate.reduce(
    (t, r) => ({
      taxable: t.taxable + r.taxable, cgst: t.cgst + r.cgst, sgst: t.sgst + r.sgst, igst: t.igst + r.igst,
      cess: t.cess + r.cess, otherTaxes: t.otherTaxes + r.otherTaxes, totalTax: t.totalTax + r.totalTax,
    }),
    { taxable: 0, cgst: 0, sgst: 0, igst: 0, cess: 0, otherTaxes: 0, totalTax: 0 },
  );
  const documentTypes = [...docs.values()];
  return {
    title: "GST summary",
    data: {
      from: ctx.from, to: ctx.to, gstin: ctx.outlet.gstin, stateCode: ctx.outlet.stateCode, compositionScheme: ctx.outlet.compositionScheme,
      byRate, totals: { ...totals, invoiceValue: totals.taxable + totals.totalTax + roundOff, roundOff },
      billOfSupplyTurnover: bosTurnover, plainBillTurnover, plainBills, documentTypes, cancelledInvoices: cancelled,
      notes: [
        "Only PAID invoices are counted as supplies; OPEN (unpaid) bills are listed under document types.",
        "Taxable value includes service charge and extra charges (delivery/packaging), which are part of the composite supply.",
        "Other taxes (e.g. VAT) are non-GST levies shown for reference; Total tax includes cess and other taxes.",
        ...(plainBills ? [`${plainBills} plain BILL(s) issued while GST was switched off are excluded (no tax charged).`] : []),
      ],
    },
    tables: [
      {
        title: "GST by rate",
        subtitle: subtitle(ctx, `GSTIN ${ctx.outlet.gstin ?? "not set"}`),
        columns: [
          { key: "rate", header: "Rate %", type: "number", width: 8 },
          { key: "cessRate", header: "Cess %", type: "number", width: 8 },
          { key: "supply", header: "Supply", width: 8 },
          { key: "invoices", header: "Invoices", type: "int" },
          { key: "taxable", header: "Taxable value", type: "money", width: 14 },
          { key: "cgst", header: "CGST", type: "money", width: 12 },
          { key: "sgst", header: "SGST", type: "money", width: 12 },
          { key: "igst", header: "IGST", type: "money", width: 12 },
          { key: "cess", header: "Cess", type: "money", width: 12 },
          { key: "otherTaxes", header: "Other taxes", type: "money", width: 12 },
          { key: "totalTax", header: "Total tax", type: "money", width: 12 },
        ],
        rows: byRate,
        totals: { supply: "Total", ...totals, invoices: undefined, cessRate: undefined },
      },
      {
        title: "Documents issued",
        columns: [
          { key: "documentType", header: "Document type", width: 16 },
          { key: "issued", header: "Issued", type: "int" },
          { key: "paid", header: "Paid", type: "int" },
          { key: "open", header: "Open", type: "int" },
          { key: "cancelled", header: "Cancelled", type: "int" },
          { key: "value", header: "Paid value", type: "money", width: 14 },
        ],
        rows: documentTypes,
        totals: true,
      },
      {
        title: "Cancelled invoices",
        columns: [
          { key: "invoiceNumber", header: "Invoice", width: 18 },
          { key: "documentType", header: "Type", width: 14 },
          { key: "date", header: "Date", width: 11 },
          { key: "value", header: "Value", type: "money", width: 12 },
          { key: "reason", header: "Reason", width: 30 },
        ],
        rows: cancelled,
        totals: true,
      },
    ],
  };
}

export async function gstr1For(outlet: Outlet, month: string) {
  const [y, m] = month.split("-").map(Number);
  const from = `${month}-01`;
  const to = `${month}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, "0")}`;
  const ctx = makeCtx(outlet, from, to);
  const orders = await prisma.order.findMany({
    where: window(ctx),
    select: {
      invoiceNumber: true, status: true, documentType: true, interState: true,
      items: {
        select: {
          hsnCode: true, gstRate: true, quantity: true, taxableValue: true, serviceCharge: true, cgst: true, sgst: true, igst: true,
          cess: true, otherTaxes: true, taxRates: true, total: true,
        },
      },
    },
  });
  // Credit notes issued in the month (Phase 3.1) → negative lines at the original items' rates.
  const cns = await prisma.creditNote.findMany({
    where: window(ctx),
    select: {
      number: true, items: true, amount: true, taxableValue: true, cgst: true, sgst: true, igst: true, cess: true, otherTaxes: true,
      order: { select: { documentType: true, interState: true, items: { select: { id: true, hsnCode: true, gstRate: true, quantity: true, taxableValue: true, serviceCharge: true, cgst: true, sgst: true, igst: true, cess: true, otherTaxes: true, taxRates: true, total: true } } } },
    },
  });
  const creditNotes = cns.map((c) => ({ number: c.number, documentType: c.order.documentType, interState: c.order.interState, items: creditLines(c) }));
  const result = buildGstr1({
    creditNotes,
    gstin: outlet.gstin,
    stateCode: outlet.stateCode,
    month,
    compositionScheme: outlet.compositionScheme,
    orders: orders as Gstr1Order[],
  });
  return { ctx, result };
}

// =====================================================================
// Profit / food cost
// =====================================================================

interface RecipeLite { menuItemId: string; variantId: string | null; quantity: number; item: { costPerUnit: number } }

/** Variant-specific recipe rows override the default (variant-less) rows. */
function recipeFor(recipes: RecipeLite[], menuItemId: string, variantId: string | null) {
  const forItem = recipes.filter((r) => r.menuItemId === menuItemId);
  if (variantId) {
    const specific = forItem.filter((r) => r.variantId === variantId);
    if (specific.length) return specific;
  }
  return forItem.filter((r) => r.variantId === null);
}
const recipeCost = (rows: RecipeLite[]) => Math.round(rows.reduce((s, r) => s + r.quantity * r.item.costPerUnit, 0));

async function profitReport(ctx: ReportCtx): Promise<BuiltReport> {
  const [orders, stockTxns, wastage, purchases, recipes, menu] = await Promise.all([
    prisma.order.findMany({
      where: { ...window(ctx), status: "PAID" },
      select: {
        id: true, grandTotal: true, cgst: true, sgst: true, igst: true, cess: true, otherTaxes: true, roundOff: true,
        items: { select: { menuItemId: true, variantId: true, quantity: true, total: true, cgst: true, sgst: true, igst: true, cess: true, otherTaxes: true } },
      },
    }),
    prisma.inventoryTransaction.findMany({
      where: { ...window(ctx), type: { in: ["SALE", "SALE_REVERSAL"] } },
      select: { quantity: true, unitCost: true, refType: true, refId: true, item: { select: { costPerUnit: true } } },
    }),
    prisma.inventoryTransaction.findMany({
      where: { ...window(ctx), type: "WASTAGE" },
      select: { quantity: true, unitCost: true, item: { select: { costPerUnit: true } } },
    }),
    prisma.purchase.findMany({
      where: { outletId: ctx.outlet.id, status: "RECEIVED", OR: [{ receivedAt: { gte: ctx.start, lt: ctx.end } }, { receivedAt: null, createdAt: { gte: ctx.start, lt: ctx.end } }] },
      select: { total: true, tax: true, subtotal: true },
    }),
    prisma.recipe.findMany({ select: { menuItemId: true, variantId: true, quantity: true, item: { select: { costPerUnit: true } } } }),
    prisma.menuItem.findMany({ where: { status: { not: "HIDDEN" } }, select: { id: true, name: true, price: true, gstRate: true, taxRateId: true, variants: { select: { id: true, name: true, price: true } } } }),
  ]);

  const revenue = orders.reduce((s, o) => s + o.grandTotal - taxOf(o) - o.roundOff, 0);
  // Actual COGS from stock deductions (SALE − SALE_REVERSAL) at the unit cost recorded on each movement.
  let cogsFromStock = 0;
  const ordersWithStock = new Set<string>();
  for (const t of stockTxns) {
    cogsFromStock += -t.quantity * (t.unitCost ?? t.item.costPerUnit);
    if (t.refType === "Order" && t.refId) ordersWithStock.add(t.refId);
  }
  cogsFromStock = Math.round(cogsFromStock);
  // Orders without stock movements (e.g. sold before recipes were set up): estimate from recipes × current cost.
  let cogsEstimated = 0;
  let estimatedOrders = 0;
  const sold = new Map<string, { quantity: number; net: number }>();
  for (const o of orders) {
    const estimate = !ordersWithStock.has(o.id);
    if (estimate) estimatedOrders++;
    for (const l of o.items) {
      const k = `${l.menuItemId}|${l.variantId ?? ""}`;
      const s = sold.get(k) ?? { quantity: 0, net: 0 };
      s.quantity += l.quantity;
      s.net += l.total - taxOf(l);
      sold.set(k, s);
      if (estimate) cogsEstimated += recipeCost(recipeFor(recipes, l.menuItemId, l.variantId)) * l.quantity;
    }
  }
  const cogs = cogsFromStock + cogsEstimated;
  const wastageValue = Math.round(wastage.reduce((s, t) => s + Math.abs(t.quantity) * (t.unitCost ?? t.item.costPerUnit), 0));
  const purchasesTotal = purchases.reduce((s, p) => s + p.total, 0);
  const grossProfit = revenue - cogs;

  // Pre-tax price strips the item's full tax composition (GST + cess + extras); nothing when the outlet charges no tax.
  const itemTaxes = await resolveItemTax(menu);
  const exTax = (price: number, id: string) =>
    ctx.outlet.pricesIncludeTax ? exclusiveOf(price, inclusiveRate(ctx.outlet, itemTaxes.get(id)!)) : price;
  const items = menu.flatMap((m) => {
    const variants: { id: string | null; name: string | null; price: number }[] = m.variants.length ? m.variants : [{ id: null, name: null, price: m.price }];
    return variants.map((v) => {
      const rec = recipeFor(recipes, m.id, v.id);
      const unitCost = rec.length ? recipeCost(rec) : null;
      const price = exTax(v.price, m.id);
      const s = sold.get(`${m.id}|${v.id ?? ""}`) ?? { quantity: 0, net: 0 };
      const estCogs = unitCost != null ? unitCost * s.quantity : null;
      return {
        menuItemId: m.id,
        variantId: v.id,
        name: v.name ? `${m.name} (${v.name})` : m.name,
        price,
        recipeCost: unitCost,
        foodCostPercent: unitCost != null && price ? round1((unitCost / price) * 100) : null,
        quantitySold: s.quantity,
        netRevenue: s.net,
        estimatedCogs: estCogs,
        marginPercent: estCogs != null && s.net ? round1(((s.net - estCogs) / s.net) * 100) : null,
        hasRecipe: rec.length > 0,
      };
    });
  }).sort((a, b) => (b.foodCostPercent ?? -1) - (a.foodCostPercent ?? -1));

  const summary = {
    revenue, cogs, cogsFromStock, cogsEstimated, estimatedOrders, grossProfit,
    grossMarginPercent: pct(grossProfit, revenue), foodCostPercent: pct(cogs, revenue),
    purchases: purchasesTotal, purchaseBills: purchases.length, wastageValue, wastagePercent: pct(wastageValue, revenue),
  };
  return {
    title: "Profit & food cost",
    data: {
      from: ctx.from, to: ctx.to, ...summary, items,
      notes: [
        "Revenue is net of GST and round-off (includes service and extra charges).",
        "COGS uses stock deductions at the recorded unit cost; orders without stock movements are estimated from recipes × current cost per unit.",
        "Item food cost % = recipe cost ÷ pre-tax selling price.",
      ],
    },
    tables: [
      {
        title: "Profit summary",
        subtitle: subtitle(ctx),
        columns: [{ key: "metric", header: "Metric", width: 30 }, { key: "money", header: "Amount", type: "money", width: 16 }, { key: "pct", header: "% of revenue", type: "percent", width: 12 }],
        rows: [
          { metric: "Revenue (net of tax)", money: revenue, pct: 100 },
          { metric: "Cost of goods sold", money: cogs, pct: summary.foodCostPercent },
          { metric: "  from stock movements", money: cogsFromStock },
          { metric: `  estimated from recipes (${estimatedOrders} orders)`, money: cogsEstimated },
          { metric: "Gross profit", money: grossProfit, pct: summary.grossMarginPercent },
          { metric: "Purchases received", money: purchasesTotal },
          { metric: "Wastage", money: wastageValue, pct: summary.wastagePercent },
        ],
      },
      {
        title: "Item food cost",
        columns: [
          { key: "name", header: "Item", width: 30 },
          { key: "price", header: "Price ex-tax", type: "money", width: 11 },
          { key: "recipeCost", header: "Recipe cost", type: "money", width: 11 },
          { key: "foodCostPercent", header: "Food cost", type: "percent", width: 9 },
          { key: "quantitySold", header: "Qty sold", type: "int", width: 8 },
          { key: "netRevenue", header: "Net revenue", type: "money", width: 12 },
          { key: "estimatedCogs", header: "Est. COGS", type: "money", width: 11 },
          { key: "marginPercent", header: "Margin", type: "percent", width: 8 },
        ],
        rows: items,
      },
    ],
  };
}

// =====================================================================
// Staff
// =====================================================================

async function staffReport(ctx: ReportCtx): Promise<BuiltReport> {
  const [orders, staff] = await Promise.all([
    prisma.order.groupBy({
      by: ["cashierId", "status"],
      where: { ...window(ctx), status: { in: ["PAID", "CANCELLED"] } },
      _count: true,
      _sum: { grandTotal: true },
    }),
    prisma.user.findMany({
      where: { OR: [{ outlets: { some: { outletId: ctx.outlet.id } }, role: { not: "SUPER_ADMIN" } }, { orders: { some: window(ctx) } }] },
      select: {
        id: true, name: true, role: true, salaryType: true, salaryAmount: true,
        attendance: { where: { outletId: ctx.outlet.id, workDate: { gte: ctx.from, lte: ctx.to } } },
        leaves: { where: { status: "APPROVED", fromDate: { lte: ctx.to }, toDate: { gte: ctx.from } } },
      },
      orderBy: { name: "asc" },
    }),
  ]);
  const days = eachDay(ctx.from, ctx.to);
  const rows = staff.map((u) => {
    const paid = orders.find((o) => o.cashierId === u.id && o.status === "PAID");
    const canc = orders.find((o) => o.cashierId === u.id && o.status === "CANCELLED");
    // Same payable-day rules as /attendance/salary: present = 1, half day = 0.5, paid (casual/sick) leave = 1.
    let present = 0, half = 0, paidLeave = 0, payable = 0, pay = 0;
    for (const date of days) {
      const recs = u.attendance.filter((a) => a.workDate === date);
      const leave = u.leaves.find((l) => l.fromDate <= date && l.toDate >= date);
      const o = dayOutcome(recs, leave);
      const units = o.units;
      if (o.status === "PRESENT") present++;
      else if (o.status === "HALF_DAY") half++;
      else if (o.paidLeave) paidLeave++;
      payable += units;
      const rate = u.salaryType === "DAILY" ? u.salaryAmount : u.salaryAmount / daysInMonth(date);
      pay += rate * units;
    }
    const bills = paid?._count ?? 0;
    const sales = paid?._sum.grandTotal ?? 0;
    return {
      userId: u.id, name: u.name, role: u.role,
      bills, sales, avgBill: avg(sales, bills),
      cancellations: canc?._count ?? 0, cancelledValue: canc?._sum.grandTotal ?? 0,
      presentDays: present, halfDays: half, paidLeaveDays: paidLeave,
      lateCount: u.attendance.filter((a) => a.lateByMinutes > 0).length,
      lateMinutes: u.attendance.reduce((s, a) => s + a.lateByMinutes, 0),
      overtimeMinutes: u.attendance.reduce((s, a) => s + a.overtimeMinutes, 0),
      workedHours: round1(u.attendance.reduce((s, a) => s + (a.workedMinutes ?? 0), 0) / 60),
      payableDays: payable,
      estimatedPay: Math.round(pay),
    };
  }).sort((a, b) => b.sales - a.sales || a.name.localeCompare(b.name));

  return {
    title: "Staff performance",
    data: { from: ctx.from, to: ctx.to, staff: rows, notes: ["Estimated pay pro-rates monthly salaries per calendar day using the /attendance/salary rules."] },
    tables: [
      {
        title: "Billing by staff",
        subtitle: subtitle(ctx),
        columns: [
          { key: "name", header: "Name", width: 20 },
          { key: "role", header: "Role", width: 16 },
          { key: "bills", header: "Bills", type: "int" },
          { key: "sales", header: "Sales", type: "money", width: 14 },
          { key: "avgBill", header: "Avg bill", type: "money", width: 11 },
          { key: "cancellations", header: "Cancelled", type: "int" },
          { key: "cancelledValue", header: "Cancelled value", type: "money", width: 13 },
        ],
        rows: rows.filter((r) => r.bills || r.cancellations),
        totals: true,
      },
      {
        title: "Attendance and pay",
        columns: [
          { key: "name", header: "Name", width: 20 },
          { key: "presentDays", header: "Present", type: "int" },
          { key: "halfDays", header: "Half", type: "int" },
          { key: "paidLeaveDays", header: "Paid leave", type: "int" },
          { key: "lateCount", header: "Late", type: "int" },
          { key: "lateMinutes", header: "Late min", type: "int" },
          { key: "overtimeMinutes", header: "OT min", type: "int" },
          { key: "workedHours", header: "Hours", type: "number" },
          { key: "payableDays", header: "Payable days", type: "number" },
          { key: "estimatedPay", header: "Est. pay", type: "money", width: 13 },
        ],
        rows,
        totals: true,
      },
    ],
  };
}

// =====================================================================
// Customers
// =====================================================================

async function customersReport(ctx: ReportCtx): Promise<BuiltReport> {
  const limit = parse(z.coerce.number().int().min(1).max(100).default(10), ctx.q.limit);
  const orders = await prisma.order.findMany({
    where: window(ctx),
    select: { id: true, status: true, customerId: true, grandTotal: true },
  });
  const paid = orders.filter((o) => o.status === "PAID");
  const per = new Map<string, { orders: number; spend: number }>();
  let walkIn = 0;
  for (const o of paid) {
    if (!o.customerId) { walkIn++; continue; }
    const p = per.get(o.customerId) ?? { orders: 0, spend: 0 };
    p.orders++;
    p.spend += o.grandTotal;
    per.set(o.customerId, p);
  }
  const ids = [...per.keys()];
  const orderIds = orders.map((o) => o.id);
  const [firsts, customers, loyalty, khata, khataCustomers] = await Promise.all([
    inChunks(ids, (slice) => prisma.order.groupBy({ by: ["customerId"], where: { outletId: ctx.outlet.id, status: "PAID", customerId: { in: slice } }, _min: { createdAt: true } })),
    inChunks(ids, (slice) => prisma.customer.findMany({ where: { id: { in: slice } }, select: { id: true, name: true, phone: true, tier: true, points: true, khataBalance: true } })),
    inChunks(orderIds, (slice) => prisma.loyaltyTransaction.groupBy({ by: ["type"], where: { createdAt: { gte: ctx.start, lt: ctx.end }, orderId: { in: slice } }, _sum: { points: true }, _count: true })),
    prisma.khataTransaction.groupBy({ by: ["type"], where: window(ctx), _sum: { amount: true }, _count: true }),
    prisma.customer.findMany({ where: { khataBalance: { gt: 0 }, khataTxns: { some: { outletId: ctx.outlet.id } } }, select: { khataBalance: true } }),
  ]);
  const firstAt = new Map(firsts.map((f) => [f.customerId!, f._min.createdAt!]));
  const newCustomers = ids.filter((id) => (firstAt.get(id) ?? ctx.start) >= ctx.start).length;
  const repeat = [...per.values()].filter((p) => p.orders >= 2).length;
  const custOrders = [...per.values()].reduce((s, p) => s + p.orders, 0);
  const custSpend = [...per.values()].reduce((s, p) => s + p.spend, 0);
  const byId = new Map(customers.map((c) => [c.id, c]));
  const top = [...per.entries()]
    .sort((a, b) => b[1].spend - a[1].spend)
    .slice(0, limit)
    .map(([id, p]) => {
      const c = byId.get(id);
      return { customerId: id, name: c?.name ?? "", phone: c?.phone ?? "", tier: c?.tier ?? "", orders: p.orders, spend: p.spend, avgOrder: avg(p.spend, p.orders), points: c?.points ?? 0 };
    });
  const pts = (t: string) => Math.abs(loyalty.filter((l) => l.type === t).reduce((sum, l) => sum + (l._sum.points ?? 0), 0));
  const kh = (t: string) => khata.find((k) => k.type === t)?._sum.amount ?? 0;
  const summary = {
    uniqueCustomers: ids.length,
    newCustomers,
    returningCustomers: ids.length - newCustomers,
    repeatCustomers: repeat,
    repeatRate: pct(repeat, ids.length),
    customerOrders: custOrders,
    walkInOrders: walkIn,
    identifiedOrderShare: pct(custOrders, paid.length),
    customerAov: avg(custSpend, custOrders),
    overallAov: avg(paid.reduce((s, o) => s + o.grandTotal, 0), paid.length),
    pointsIssued: pts("EARN"),
    pointsRedeemed: pts("REDEEM"),
    khataDebits: kh("DEBIT"),
    khataCredits: kh("CREDIT"),
    khataOutstanding: khataCustomers.reduce((s, c) => s + c.khataBalance, 0),
    khataCustomersWithDues: khataCustomers.length,
  };
  const metric = (label: string, value: number, type: "int" | "money" | "percent") => ({ metric: label, [type]: value });
  return {
    title: "Customer report",
    data: {
      from: ctx.from, to: ctx.to, ...summary, topCustomers: top,
      notes: ["New = first paid order at this outlet falls in the period. Repeat = 2+ paid orders in the period.", "Khata outstanding is the customers' global balance (khata is shared across outlets)."],
    },
    tables: [
      {
        title: "Customer summary",
        subtitle: subtitle(ctx),
        columns: [{ key: "metric", header: "Metric", width: 30 }, { key: "int", header: "Count", type: "int" }, { key: "money", header: "Amount", type: "money", width: 14 }, { key: "percent", header: "%", type: "percent" }],
        rows: [
          metric("Unique customers", summary.uniqueCustomers, "int"),
          metric("New customers", summary.newCustomers, "int"),
          metric("Returning customers", summary.returningCustomers, "int"),
          metric("Repeat customers (2+ orders)", summary.repeatCustomers, "int"),
          metric("Repeat rate", summary.repeatRate, "percent"),
          metric("Orders by known customers", summary.customerOrders, "int"),
          metric("Walk-in orders", summary.walkInOrders, "int"),
          metric("Customer AOV", summary.customerAov, "money"),
          metric("Overall AOV", summary.overallAov, "money"),
          metric("Loyalty points issued", summary.pointsIssued, "int"),
          metric("Loyalty points redeemed", summary.pointsRedeemed, "int"),
          metric("Khata given (debits)", summary.khataDebits, "money"),
          metric("Khata collected (credits)", summary.khataCredits, "money"),
          metric("Khata outstanding", summary.khataOutstanding, "money"),
        ],
      },
      {
        title: "Top customers",
        columns: [
          { key: "name", header: "Name", width: 20 },
          { key: "phone", header: "Phone", width: 13 },
          { key: "tier", header: "Tier", width: 10 },
          { key: "orders", header: "Orders", type: "int" },
          { key: "spend", header: "Spend", type: "money", width: 13 },
          { key: "avgOrder", header: "Avg order", type: "money", width: 11 },
          { key: "points", header: "Points", type: "int" },
        ],
        rows: top,
      },
    ],
  };
}

// =====================================================================
// Inventory
// =====================================================================

async function inventoryReport(ctx: ReportCtx): Promise<BuiltReport> {
  const [items, opening, txns, stocks, purchases] = await Promise.all([
    prisma.inventoryItem.findMany({ select: { id: true, name: true, unit: true, category: true, costPerUnit: true, active: true } }),
    prisma.inventoryTransaction.groupBy({ by: ["inventoryItemId"], where: { outletId: ctx.outlet.id, createdAt: { lt: ctx.start } }, _sum: { quantity: true } }),
    prisma.inventoryTransaction.findMany({ where: window(ctx), select: { inventoryItemId: true, type: true, quantity: true, unitCost: true } }),
    prisma.inventoryStock.findMany({ where: { outletId: ctx.outlet.id }, select: { inventoryItemId: true, quantity: true } }),
    prisma.purchase.findMany({
      where: { outletId: ctx.outlet.id, status: "RECEIVED", OR: [{ receivedAt: { gte: ctx.start, lt: ctx.end } }, { receivedAt: null, createdAt: { gte: ctx.start, lt: ctx.end } }] },
      select: { subtotal: true, tax: true, total: true, paidAmount: true, vendor: { select: { id: true, name: true } } },
    }),
  ]);
  const r3 = (n: number) => Math.round(n * 1000) / 1000;
  const openMap = new Map(opening.map((o) => [o.inventoryItemId, o._sum.quantity ?? 0]));
  const stockMap = new Map(stocks.map((s) => [s.inventoryItemId, s.quantity]));
  type Mv = { purchased: number; sold: number; wasted: number; wastageValue: number; otherIn: number; otherOut: number };
  const mv = new Map<string, Mv>();
  for (const t of txns) {
    const m = mv.get(t.inventoryItemId) ?? { purchased: 0, sold: 0, wasted: 0, wastageValue: 0, otherIn: 0, otherOut: 0 };
    if (t.type === "PURCHASE") m.purchased += t.quantity;
    else if (t.type === "SALE" || t.type === "SALE_REVERSAL") m.sold -= t.quantity;
    else if (t.type === "WASTAGE") {
      m.wasted += Math.abs(t.quantity);
      m.wastageValue += Math.abs(t.quantity) * (t.unitCost ?? items.find((i) => i.id === t.inventoryItemId)?.costPerUnit ?? 0);
    } else if (t.quantity >= 0) m.otherIn += t.quantity;
    else m.otherOut -= t.quantity;
    mv.set(t.inventoryItemId, m);
  }
  const rows = items
    .filter((i) => i.active || mv.has(i.id) || openMap.has(i.id))
    .map((i) => {
      const m = mv.get(i.id) ?? { purchased: 0, sold: 0, wasted: 0, wastageValue: 0, otherIn: 0, otherOut: 0 };
      const open = openMap.get(i.id) ?? 0;
      const totalIn = m.purchased + m.otherIn;
      const totalOut = m.sold + m.wasted + m.otherOut;
      const closing = open + totalIn - totalOut;
      return {
        inventoryItemId: i.id, name: i.name, category: i.category, unit: i.unit,
        opening: r3(open), purchased: r3(m.purchased), otherIn: r3(m.otherIn), in: r3(totalIn),
        sold: r3(m.sold), wasted: r3(m.wasted), otherOut: r3(m.otherOut), out: r3(totalOut),
        closing: r3(closing), closingValue: Math.round(closing * i.costPerUnit), wastageValue: Math.round(m.wastageValue),
        currentStock: r3(stockMap.get(i.id) ?? 0),
      };
    })
    .sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));

  const vendors = new Map<string, { vendorId: string; vendor: string; bills: number; subtotal: number; tax: number; total: number; paid: number; due: number }>();
  for (const p of purchases) {
    const v = vendors.get(p.vendor.id) ?? { vendorId: p.vendor.id, vendor: p.vendor.name, bills: 0, subtotal: 0, tax: 0, total: 0, paid: 0, due: 0 };
    v.bills++;
    v.subtotal += p.subtotal;
    v.tax += p.tax;
    v.total += p.total;
    v.paid += p.paidAmount;
    v.due += p.total - p.paidAmount;
    vendors.set(p.vendor.id, v);
  }
  const vendorRows = [...vendors.values()].sort((a, b) => b.total - a.total);
  return {
    title: "Inventory movement",
    data: {
      from: ctx.from, to: ctx.to, items: rows, vendors: vendorRows,
      totals: { wastageValue: rows.reduce((s, r) => s + r.wastageValue, 0), closingValue: rows.reduce((s, r) => s + r.closingValue, 0), purchases: vendorRows.reduce((s, v) => s + v.total, 0) },
    },
    tables: [
      {
        title: "Stock movement",
        subtitle: subtitle(ctx, "quantities in each item's unit"),
        columns: [
          { key: "name", header: "Item", width: 22 },
          { key: "unit", header: "Unit", width: 7 },
          { key: "opening", header: "Opening", type: "number" },
          { key: "purchased", header: "Purchased", type: "number" },
          { key: "otherIn", header: "Other in", type: "number" },
          { key: "sold", header: "Consumed", type: "number" },
          { key: "wasted", header: "Wasted", type: "number" },
          { key: "otherOut", header: "Other out", type: "number" },
          { key: "closing", header: "Closing", type: "number" },
          { key: "closingValue", header: "Closing value", type: "money", width: 12 },
          { key: "wastageValue", header: "Wastage value", type: "money", width: 12 },
        ],
        rows,
        totals: { name: "Total", closingValue: rows.reduce((s, r) => s + r.closingValue, 0), wastageValue: rows.reduce((s, r) => s + r.wastageValue, 0) },
      },
      {
        title: "Vendor purchases",
        columns: [
          { key: "vendor", header: "Vendor", width: 24 },
          { key: "bills", header: "Bills", type: "int" },
          { key: "subtotal", header: "Subtotal", type: "money", width: 13 },
          { key: "tax", header: "Tax", type: "money", width: 11 },
          { key: "total", header: "Total", type: "money", width: 13 },
          { key: "paid", header: "Paid", type: "money", width: 13 },
          { key: "due", header: "Due", type: "money", width: 13 },
        ],
        rows: vendorRows,
        totals: true,
      },
    ],
  };
}

// =====================================================================
// Delivery
// =====================================================================

async function deliveryReport(ctx: ReportCtx): Promise<BuiltReport> {
  const deliveries = await prisma.delivery.findMany({
    where: window(ctx),
    select: {
      status: true, createdAt: true, assignedAt: true, acceptedAt: true, pickedAt: true, deliveredAt: true, etaAt: true, distanceKm: true,
      agentId: true, agent: { select: { name: true } }, order: { select: { grandTotal: true, status: true } },
    },
  });
  const mins = (a: Date, b: Date) => (b.getTime() - a.getTime()) / 60_000;
  const byStatus: Record<string, number> = {};
  type Ag = { agentId: string; agent: string; deliveries: number; delivered: number; cancelled: number; value: number; acceptToDeliverSum: number; acceptToDeliverN: number; onTime: number; withEta: number; distanceKm: number };
  const agents = new Map<string, Ag>();
  const blankAgent = (agentId: string, agent: string): Ag => ({ agentId, agent, deliveries: 0, delivered: 0, cancelled: 0, value: 0, acceptToDeliverSum: 0, acceptToDeliverN: 0, onTime: 0, withEta: 0, distanceKm: 0 });
  const all = blankAgent("", "All");
  let totalSum = 0, totalN = 0;
  for (const d of deliveries) {
    byStatus[d.status] = (byStatus[d.status] ?? 0) + 1;
    const key = d.agentId ?? "unassigned";
    const a = agents.get(key) ?? blankAgent(key, d.agent?.name ?? "Unassigned");
    for (const t of [a, all]) {
      t.deliveries++;
      if (d.status === "CANCELLED") t.cancelled++;
      if (d.status !== "DELIVERED" || !d.deliveredAt) continue;
      t.delivered++;
      t.value += d.order.grandTotal;
      t.distanceKm += d.distanceKm ?? 0;
      const acceptedAt = d.acceptedAt ?? d.assignedAt;
      if (acceptedAt) { t.acceptToDeliverSum += mins(acceptedAt, d.deliveredAt); t.acceptToDeliverN++; }
      if (d.etaAt) { t.withEta++; if (d.deliveredAt <= d.etaAt) t.onTime++; }
    }
    if (d.status === "DELIVERED" && d.deliveredAt) { totalSum += mins(d.createdAt, d.deliveredAt); totalN++; }
    agents.set(key, a);
  }
  const shape = (a: Ag) => ({
    agentId: a.agentId, agent: a.agent, deliveries: a.deliveries, delivered: a.delivered, cancelled: a.cancelled, value: a.value,
    avgDeliveryMinutes: a.acceptToDeliverN ? round1(a.acceptToDeliverSum / a.acceptToDeliverN) : null,
    onTimePercent: a.withEta ? pct(a.onTime, a.withEta) : null,
    distanceKm: round1(a.distanceKm),
  });
  const agentRows = [...agents.values()].map(shape).sort((a, b) => b.delivered - a.delivered);
  const summary = { ...shape(all), avgOrderToDeliveryMinutes: totalN ? round1(totalSum / totalN) : null, byStatus };
  return {
    title: "Delivery report",
    data: {
      from: ctx.from, to: ctx.to, ...summary, agents: agentRows,
      notes: ["Delivery time = assignment to agent (accepted) → delivered. Order-to-delivery = order created → delivered."],
    },
    tables: [
      {
        title: "Delivery by agent",
        subtitle: subtitle(ctx, `avg order→delivery ${summary.avgOrderToDeliveryMinutes ?? "-"} min`),
        columns: [
          { key: "agent", header: "Agent", width: 20 },
          { key: "deliveries", header: "Orders", type: "int" },
          { key: "delivered", header: "Delivered", type: "int" },
          { key: "cancelled", header: "Cancelled", type: "int" },
          { key: "value", header: "Value", type: "money", width: 13 },
          { key: "avgDeliveryMinutes", header: "Avg min", type: "number" },
          { key: "onTimePercent", header: "On time", type: "percent" },
          { key: "distanceKm", header: "Km", type: "number" },
        ],
        rows: agentRows,
        totals: { ...shape(all), agent: "Total" },
      },
      {
        title: "Delivery status",
        columns: [{ key: "status", header: "Status", width: 20 }, { key: "count", header: "Count", type: "int" }],
        rows: Object.entries(byStatus).map(([status, count]) => ({ status, count })),
        totals: true,
      },
    ],
  };
}

// =====================================================================
// Exceptions (Phase 3.3): voids, refunds, big discounts, approvals, reprints
// =====================================================================

async function exceptionsReport(ctx: ReportCtx): Promise<BuiltReport> {
  const w = window(ctx);
  const outletId = ctx.outlet.id;
  const limit = ctx.outlet.approvalDiscountPercent;
  const [voids, refunds, discounted, approvals, reprints] = await Promise.all([
    prisma.order.findMany({
      where: { outletId, cancelledAt: { gte: ctx.start, lt: ctx.end } },
      select: { id: true, invoiceNumber: true, grandTotal: true, cancelledAt: true, cancelReason: true, paidAt: true, cashier: { select: { name: true } } },
      orderBy: { cancelledAt: "asc" },
    }),
    prisma.creditNote.findMany({ where: w, select: { id: true, number: true, amount: true, reason: true, note: true, refundMode: true, createdAt: true, createdById: true, approvedById: true, order: { select: { invoiceNumber: true } } }, orderBy: { createdAt: "asc" } }),
    prisma.order.findMany({
      where: { ...w, status: { not: "CANCELLED" }, discount: { gt: 0 } },
      select: { id: true, invoiceNumber: true, subtotal: true, discount: true, createdAt: true, cashier: { select: { name: true } } },
    }),
    prisma.approvalLog.findMany({ where: w, orderBy: { createdAt: "asc" } }),
    prisma.auditLog.findMany({ where: { ...w, action: "kot.reprint" }, select: { createdAt: true, entityId: true, user: { select: { name: true } } }, orderBy: { createdAt: "asc" } }),
  ]);
  // Who cancelled: from the audit log.
  const cancelAudit = await prisma.auditLog.findMany({ where: { action: "order.cancel", entityId: { in: voids.map((v) => v.id) } }, select: { entityId: true, user: { select: { name: true } } } });
  const cancelledBy = new Map(cancelAudit.map((a) => [a.entityId, a.user?.name ?? ""]));
  const userIds = [...new Set([...approvals.flatMap((a) => [a.requestedById, a.approvedById]), ...refunds.flatMap((r) => [r.createdById, r.approvedById])].filter((x): x is string => !!x))];
  const names = new Map((await prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));
  const name = (id: string | null) => (id ? (names.get(id) ?? "") : "");
  const when = (d: Date) => d.toLocaleString("en-IN", { timeZone: ctx.outlet.timezone, dateStyle: "medium", timeStyle: "short" });
  const bigDiscounts = discounted.filter((o) => aboveApprovalLimit(o, limit));
  const unapproved = approvals.filter((a) => !a.approvedById);

  const data = {
    discountLimitPercent: limit,
    totals: {
      voids: { count: voids.length, amount: voids.reduce((s, v) => s + v.grandTotal, 0), afterPayment: voids.filter((v) => v.paidAt).length },
      refunds: { count: refunds.length, amount: refunds.reduce((s, r) => s + r.amount, 0) },
      bigDiscounts: { count: bigDiscounts.length, amount: bigDiscounts.reduce((s, o) => s + o.discount, 0) },
      approvals: approvals.length,
      unapproved: unapproved.length,
      reprints: reprints.length,
    },
    voids: voids.map((v) => ({ invoiceNumber: v.invoiceNumber, at: when(v.cancelledAt!), amount: v.grandTotal, reason: v.cancelReason ?? "", wasPaid: Boolean(v.paidAt), cashier: v.cashier.name, by: cancelledBy.get(v.id) ?? "" })),
    refunds: refunds.map((r) => ({ number: r.number, invoiceNumber: r.order.invoiceNumber, at: when(r.createdAt), amount: r.amount, reason: r.reason, note: r.note ?? "", mode: r.refundMode, by: name(r.createdById), approvedBy: name(r.approvedById) })),
    bigDiscounts: bigDiscounts.map((o) => ({ invoiceNumber: o.invoiceNumber, at: when(o.createdAt), subtotal: o.subtotal, discount: o.discount, percent: pct(o.discount, o.subtotal), cashier: o.cashier.name })),
    approvals: approvals.map((a) => ({ at: when(a.createdAt), action: a.action, amount: a.amount, reason: a.reason ?? "", requestedBy: name(a.requestedById), approvedBy: a.approvedById ? name(a.approvedById) : "NOT APPROVED (offline)" })),
    reprints: reprints.map((r) => ({ at: when(r.createdAt), kot: r.entityId ?? "", by: r.user?.name ?? "" })),
  };
  return {
    title: "Exceptions",
    data,
    tables: [
      {
        title: "Voided bills",
        subtitle: subtitle(ctx),
        columns: [
          { key: "invoiceNumber", header: "Bill", width: 16 }, { key: "at", header: "Voided", width: 20 }, { key: "amount", header: "Amount", type: "money" },
          { key: "reason", header: "Reason", width: 30 }, { key: "cashier", header: "Billed by", width: 16 }, { key: "by", header: "Voided by", width: 16 },
        ],
        rows: data.voids,
        totals: true,
      },
      {
        title: "Refunds (credit notes)",
        columns: [
          { key: "number", header: "Credit note", width: 16 }, { key: "invoiceNumber", header: "Bill", width: 16 }, { key: "at", header: "Issued", width: 20 },
          { key: "amount", header: "Amount", type: "money" }, { key: "mode", header: "Mode" }, { key: "reason", header: "Reason", width: 18 },
          { key: "by", header: "By", width: 16 }, { key: "approvedBy", header: "Approved by", width: 16 },
        ],
        rows: data.refunds,
        totals: true,
      },
      {
        title: `Discounts above ${limit}%`,
        columns: [
          { key: "invoiceNumber", header: "Bill", width: 16 }, { key: "at", header: "Billed", width: 20 }, { key: "subtotal", header: "Subtotal", type: "money" },
          { key: "discount", header: "Discount", type: "money" }, { key: "percent", header: "%", type: "number" }, { key: "cashier", header: "Cashier", width: 16 },
        ],
        rows: data.bigDiscounts,
        totals: true,
      },
      {
        title: "Approvals",
        columns: [
          { key: "at", header: "When", width: 20 }, { key: "action", header: "Action" }, { key: "amount", header: "Amount", type: "money" },
          { key: "requestedBy", header: "Requested by", width: 16 }, { key: "approvedBy", header: "Approved by", width: 22 }, { key: "reason", header: "Reason", width: 30 },
        ],
        rows: data.approvals,
      },
      {
        title: "KOT reprints",
        columns: [{ key: "at", header: "When", width: 20 }, { key: "kot", header: "KOT", width: 26 }, { key: "by", header: "By", width: 16 }],
        rows: data.reprints,
      },
    ],
  };
}

// =====================================================================
// Canteen (Phase 5.5): meals by company and department, who paid, wallet liability
// =====================================================================

async function canteenReport(ctx: ReportCtx): Promise<BuiltReport> {
  if (!moduleEnabled("CANTEEN")) throw forbidden("This feature is not enabled for your business");
  const w = window(ctx);
  const [orders, wallets, tokens, topups, tokenSales] = await Promise.all([
    prisma.order.findMany({
      where: { ...w, status: "PAID", customer: { canteenMember: true } },
      select: {
        grandTotal: true,
        payments: { select: { mode: true, amount: true, tokens: true, status: true } }, // SUCCESS filtered below (bind-value cap)
        customer: { select: { department: true, corporateAccount: { select: { name: true } } } },
      },
    }),
    prisma.customer.aggregate({ where: { canteenMember: true }, _sum: { walletBalance: true }, _count: { _all: true } }),
    prisma.mealTokenAccount.aggregate({ _sum: { balance: true, value: true } }),
    prisma.walletTxn.groupBy({ by: ["mode"], where: { ...w, type: "TOPUP" }, _sum: { amount: true }, _count: true }),
    prisma.mealTokenTxn.aggregate({ where: { ...w, type: "PURCHASE" }, _sum: { amount: true, count: true } }),
  ]);

  type Row = { key: string; meals: number; gross: number; employerShare: number; employeeShare: number; walletSpend: number; tokensRedeemed: number; tokenValue: number };
  const blank = (key: string): Row => ({ key, meals: 0, gross: 0, employerShare: 0, employeeShare: 0, walletSpend: 0, tokensRedeemed: 0, tokenValue: 0 });
  const byAccount = new Map<string, Row>();
  const byDept = new Map<string, Row>();
  const total = blank("Total");
  for (const o of orders) {
    const payments = o.payments.filter((p) => p.status === "SUCCESS");
    const sum = (mode: string) => payments.filter((p) => p.mode === mode).reduce((s, p) => s + p.amount, 0);
    const employer = sum("CORPORATE");
    const add = (r: Row) => {
      r.meals += 1;
      r.gross += o.grandTotal;
      r.employerShare += employer;
      r.employeeShare += o.grandTotal - employer;
      r.walletSpend += sum("WALLET");
      r.tokensRedeemed += payments.filter((p) => p.mode === "MEAL_TOKEN").reduce((s, p) => s + (p.tokens ?? 1), 0);
      r.tokenValue += sum("MEAL_TOKEN");
    };
    const account = o.customer?.corporateAccount?.name ?? "No company";
    const dept = `${account} · ${o.customer?.department || "No department"}`;
    if (!byAccount.has(account)) byAccount.set(account, blank(account));
    if (!byDept.has(dept)) byDept.set(dept, blank(dept));
    add(byAccount.get(account)!);
    add(byDept.get(dept)!);
    add(total);
  }
  const sorted = (m: Map<string, Row>) => [...m.values()].sort((a, b) => b.gross - a.gross);
  const data = {
    totals: total,
    byAccount: sorted(byAccount),
    byDepartment: sorted(byDept),
    // Liability (business-wide, now): prepaid money not yet eaten. Not sales; no GST until spent.
    liability: {
      members: wallets._count._all,
      walletBalance: wallets._sum.walletBalance ?? 0,
      tokensOutstanding: tokens._sum.balance ?? 0,
      tokenValue: tokens._sum.value ?? 0,
    },
    topups: {
      byMode: Object.fromEntries(topups.map((t) => [t.mode ?? "OTHER", { count: t._count, amount: t._sum.amount ?? 0 }])),
      wallet: topups.reduce((s, t) => s + (t._sum.amount ?? 0), 0),
      tokensSold: tokenSales._sum.count ?? 0,
      tokenSales: tokenSales._sum.amount ?? 0,
    },
  };
  const columns = (first: string): ExportColumn[] => [
    { key: "key", header: first, width: 28 },
    { key: "meals", header: "Meals", type: "int" },
    { key: "gross", header: "Gross", type: "money", width: 13 },
    { key: "employerShare", header: "Company share", type: "money", width: 14 },
    { key: "employeeShare", header: "Employee share", type: "money", width: 14 },
    { key: "walletSpend", header: "Wallet", type: "money", width: 12 },
    { key: "tokensRedeemed", header: "Tokens", type: "int" },
  ];
  return {
    title: "Canteen",
    data,
    tables: [
      { title: "Canteen by company", subtitle: subtitle(ctx, "paid bills of canteen members"), columns: columns("Company"), rows: data.byAccount, totals: true },
      { title: "Canteen by department", columns: columns("Company · department"), rows: data.byDepartment, totals: true },
      {
        title: "Prepaid liability (now, all outlets)",
        columns: [{ key: "what", header: "What", width: 30 }, { key: "amount", header: "Amount", type: "money", width: 14 }],
        rows: [
          { what: `Wallet balances (${data.liability.members} members)`, amount: data.liability.walletBalance },
          { what: `Meal tokens not used (${data.liability.tokensOutstanding})`, amount: data.liability.tokenValue },
        ],
        totals: true,
      },
    ],
  };
}

// =====================================================================
// Registry (also used by scheduled emails)
// =====================================================================

export const REPORTS: Record<ReportKey, { title: string; build: (ctx: ReportCtx) => Promise<BuiltReport> }> = {
  sales: { title: "Sales", build: salesReport },
  items: { title: "Items", build: itemsReport },
  categories: { title: "Categories", build: categoriesReport },
  "peak-hours": { title: "Peak hours", build: peakHoursReport },
  gst: { title: "GST summary", build: gstReport },
  profit: { title: "Profit & food cost", build: profitReport },
  staff: { title: "Staff", build: staffReport },
  customers: { title: "Customers", build: customersReport },
  inventory: { title: "Inventory", build: inventoryReport },
  delivery: { title: "Delivery", build: deliveryReport },
  exceptions: { title: "Exceptions", build: exceptionsReport },
  canteen: { title: "Canteen", build: canteenReport },
};

export async function buildReport(key: ReportKey, outlet: Outlet, from: string, to: string, q: Record<string, unknown> = {}) {
  return REPORTS[key].build(makeCtx(outlet, from, to, q));
}

// =====================================================================
// Routes
// =====================================================================

/** Multi-outlet central dashboard — not outlet-scoped. */
reportsRouter.get("/outlets/overview", requirePermission("report:view"), async (req, res) => {
  const outlets = await prisma.outlet.findMany({
    where: req.user!.role === "SUPER_ADMIN" ? {} : { id: { in: req.user!.outletIds } },
    orderBy: { name: "asc" },
  });
  const tz = outlets[0]?.timezone ?? "Asia/Kolkata";
  const { date } = parse(z.object({ date: ymd.default(zonedParts(new Date(), tz).date) }), req.query);
  const rows = await Promise.all(
    outlets.map(async (o) => {
      const start = startOfLocalDay(date, o.timezone);
      const end = startOfLocalDay(addDays(date, 1), o.timezone);
      const [paid, cancelled, open, stocks, clockedIn] = await Promise.all([
        prisma.order.aggregate({ where: { outletId: o.id, status: "PAID", createdAt: { gte: start, lt: end } }, _sum: { grandTotal: true }, _count: true }),
        prisma.order.count({ where: { outletId: o.id, status: "CANCELLED", createdAt: { gte: start, lt: end } } }),
        prisma.order.aggregate({ where: { outletId: o.id, status: "OPEN" }, _sum: { grandTotal: true }, _count: true }),
        prisma.inventoryStock.findMany({ where: { outletId: o.id, item: { active: true, reorderLevel: { gt: 0 } } }, select: { quantity: true, item: { select: { reorderLevel: true } } } }),
        prisma.staffAttendance.count({ where: { outletId: o.id, clockOutAt: null } }),
      ]);
      const gross = paid._sum.grandTotal ?? 0;
      return {
        outletId: o.id, name: o.name, gross, orders: paid._count, aov: avg(gross, paid._count), cancelled,
        openBills: open._count, openBillsValue: open._sum.grandTotal ?? 0,
        lowStock: stocks.filter((s) => s.quantity <= s.item.reorderLevel).length,
        staffClockedIn: clockedIn,
      };
    }),
  );
  const sum = (k: "gross" | "orders" | "openBills" | "openBillsValue" | "lowStock" | "staffClockedIn" | "cancelled") => rows.reduce((s, r) => s + r[k], 0);
  const totals = {
    gross: sum("gross"), orders: sum("orders"), aov: avg(sum("gross"), sum("orders")), cancelled: sum("cancelled"),
    openBills: sum("openBills"), openBillsValue: sum("openBillsValue"), lowStock: sum("lowStock"), staffClockedIn: sum("staffClockedIn"),
  };
  const format = parse(z.enum(["json", "xlsx", "pdf"]).default("json"), req.query.format);
  if (format === "json") return res.json({ date, outlets: rows, totals });
  await sendExport(res, format, `outlets_overview_${date}`, [{
    title: "Outlets overview",
    subtitle: date,
    columns: [
      { key: "name", header: "Outlet", width: 24 },
      { key: "gross", header: "Gross", type: "money", width: 13 },
      { key: "orders", header: "Orders", type: "int" },
      { key: "aov", header: "AOV", type: "money" },
      { key: "openBills", header: "Open bills", type: "int" },
      { key: "lowStock", header: "Low stock", type: "int" },
      { key: "staffClockedIn", header: "Clocked in", type: "int" },
    ],
    rows,
    totals: { ...totals, name: "Total" },
  }]);
});

/** Owner home (Phase 4.3): today so far vs the same weekday last week, per outlet + totals — not outlet-scoped. */
reportsRouter.get("/owner-summary", requirePermission("report:view"), async (req, res) => {
  const outlets = await prisma.outlet.findMany({
    where: req.user!.role === "SUPER_ADMIN" ? {} : { id: { in: req.user!.outletIds } },
    orderBy: { name: "asc" },
  });
  res.json(await ownerSummary(outlets));
});

reportsRouter.use(requireOutlet, requirePermission("report:view"));

async function currentOutlet(req: Request) {
  return prisma.outlet.findUniqueOrThrow({ where: { id: req.outletId } });
}

const rangeSchema = z.object({ from: ymd.optional(), to: ymd.optional(), format: z.enum(["json", "xlsx", "pdf"]).default("json") });

async function respond(res: Response, format: "json" | ExportFormat, filename: string, built: BuiltReport) {
  if (format === "json") return res.json(built.data);
  await sendExport(res, format, filename, built.tables, built.title);
}

for (const key of REPORT_KEYS) {
  reportsRouter.get(`/${key}`, async (req, res) => {
    const outlet = await currentOutlet(req);
    const today = zonedParts(new Date(), outlet.timezone).date;
    const q = parse(rangeSchema, req.query);
    const to = q.to ?? today;
    const from = q.from ?? addDays(to, -6);
    const built = await buildReport(key, outlet, from, to, req.query as Record<string, unknown>);
    await respond(res, q.format, `${key}_${from}_${to}`, built);
  });
}

/** GSTR-1 for a month. format=json returns {gstr1, totals, notes, warnings}; add download=1 for the bare GSTN payload file. */
type CnLine = { orderItemId: string; quantity: number; taxableValue: number; cgst: number; sgst: number; igst: number; cess: number; otherTaxes: number; total: number };
type OrderLine = { id: string; hsnCode: string; gstRate: number; quantity: number; taxableValue: number; serviceCharge: number; cgst: number; sgst: number; igst: number; cess: number; otherTaxes: number; taxRates: unknown; total: number };

/** A credit note as negative GSTR-1 lines; value-only credits are spread over the bill's lines by taxable value. */
function creditLines(c: { items: unknown; amount: number; cgst: number; sgst: number; igst: number; cess: number; otherTaxes: number; order: { items: OrderLine[] } }) {
  const neg = (l: OrderLine, v: Omit<CnLine, "orderItemId">) => ({
    hsnCode: l.hsnCode, gstRate: l.gstRate, taxRates: l.taxRates, serviceCharge: 0,
    quantity: -v.quantity, taxableValue: -v.taxableValue, cgst: -v.cgst, sgst: -v.sgst, igst: -v.igst, cess: -v.cess, otherTaxes: -v.otherTaxes, total: -v.total,
  });
  const lines = c.items as CnLine[];
  const byId = new Map(c.order.items.map((l) => [l.id, l]));
  if (lines.length) return lines.filter((l) => byId.has(l.orderItemId)).map((l) => neg(byId.get(l.orderItemId)!, l));
  const base = c.order.items.reduce((s, l) => s + l.total, 0) || 1;
  return c.order.items.map((l) => {
    const share = l.total / base;
    const part = (v: number) => Math.round(v * share);
    return neg(l, { quantity: 0, taxableValue: 0, cgst: part(c.cgst), sgst: part(c.sgst), igst: part(c.igst), cess: part(c.cess), otherTaxes: part(c.otherTaxes), total: part(c.amount) });
  });
}

reportsRouter.get("/gstr1", async (req, res) => {
  const q = parse(
    z.object({
      month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Use YYYY-MM"),
      format: z.enum(["json", "xlsx", "pdf"]).default("json"),
      download: z.enum(["0", "1", "true", "false"]).optional(),
    }),
    req.query,
  );
  const outlet = await currentOutlet(req);
  const { result } = await gstr1For(outlet, q.month);
  const fp = result.payload.fp;
  if (q.format === "json") {
    if (q.download === "1" || q.download === "true") {
      res.setHeader("content-disposition", `attachment; filename="GSTR1_${outlet.gstin ?? outlet.id}_${fp}.json"`);
      return res.type("application/json").send(JSON.stringify(result.payload, null, 2));
    }
    return res.json({
      month: q.month, financialYear: financialYearLabel(Number(q.month.slice(0, 4)) - (Number(q.month.slice(5, 7)) < 4 ? 1 : 0)),
      excluded: result.excluded, gstr1: result.payload, totals: result.totals, notes: result.notes, warnings: result.warnings,
    });
  }
  const p = result.payload;
  const money = (r: number) => Math.round(r * 100); // export helper expects paise
  const tables: ExportTable[] = [
    {
      title: "B2CS",
      subtitle: `GSTIN ${p.gstin || "-"} · period ${fp}${result.excluded ? " · EXCLUDED (composition scheme)" : ""}`,
      columns: [
        { key: "sply_ty", header: "Supply type" }, { key: "pos", header: "Place of supply" }, { key: "typ", header: "Type" },
        { key: "rt", header: "Rate %", type: "number" }, { key: "txval", header: "Taxable value", type: "money", width: 14 },
        { key: "iamt", header: "IGST", type: "money" }, { key: "camt", header: "CGST", type: "money" }, { key: "samt", header: "SGST", type: "money" },
        { key: "csamt", header: "Cess", type: "money" },
      ],
      rows: p.b2cs.map((b) => ({ ...b, txval: money(b.txval), iamt: money(b.iamt), camt: money(b.camt), samt: money(b.samt), csamt: money(b.csamt) })),
      totals: true,
    },
    {
      title: "HSN",
      columns: [
        { key: "hsn_sc", header: "HSN/SAC" }, { key: "desc", header: "Description", width: 30 }, { key: "uqc", header: "UQC" },
        { key: "qty", header: "Qty", type: "int" }, { key: "rt", header: "Rate %", type: "number" },
        { key: "txval", header: "Taxable value", type: "money", width: 14 }, { key: "iamt", header: "IGST", type: "money" },
        { key: "camt", header: "CGST", type: "money" }, { key: "samt", header: "SGST", type: "money" }, { key: "csamt", header: "Cess", type: "money" },
      ],
      rows: p.hsn.data.map((h) => ({ ...h, txval: money(h.txval), iamt: money(h.iamt), camt: money(h.camt), samt: money(h.samt), csamt: money(h.csamt) })),
      totals: { hsn_sc: "Total", qty: p.hsn.data.reduce((s, h) => s + h.qty, 0), txval: result.totals.paise.taxable, iamt: result.totals.paise.igst, camt: result.totals.paise.cgst, samt: result.totals.paise.sgst, csamt: result.totals.paise.cess },
    },
    {
      title: "Documents",
      columns: [
        { key: "doc_typ", header: "Nature of document", width: 26 }, { key: "from", header: "Sr. No. from", width: 18 }, { key: "to", header: "Sr. No. to", width: 18 },
        { key: "totnum", header: "Total", type: "int" }, { key: "cancel", header: "Cancelled", type: "int" }, { key: "net_issue", header: "Net issued", type: "int" },
      ],
      rows: p.doc_issue.doc_det.flatMap((d) => d.docs.map((x) => ({ ...x, doc_typ: d.doc_typ }))),
    },
    {
      title: "Notes",
      columns: [{ key: "kind", header: "Kind", width: 10 }, { key: "text", header: "Text", width: 100 }],
      rows: [...result.notes.map((text) => ({ kind: "Note", text })), ...result.warnings.map((text) => ({ kind: "Warning", text }))],
    },
  ];
  await sendExport(res, q.format, `GSTR1_${fp}`, tables, `GSTR-1 ${fp} - ${outlet.name}`);
});

// ---------- Daily summary dashboard ----------

async function daySales(outletId: string, date: string, tz: string) {
  const from = startOfLocalDay(date, tz);
  const to = startOfLocalDay(addDays(date, 1), tz);
  const agg = await prisma.order.aggregate({
    where: { outletId, status: "PAID", createdAt: { gte: from, lt: to } },
    _sum: { grandTotal: true, discount: true },
    _count: true,
  });
  return { gross: agg._sum.grandTotal ?? 0, orders: agg._count };
}

/** Daily summary dashboard: totals, mix by order type/payment mode, top items, staff, comparisons, hourly curve. */
reportsRouter.get("/daily", async (req, res) => {
  const outlet = await currentOutlet(req);
  const today = zonedParts(new Date(), outlet.timezone).date;
  const { date, format } = parse(
    z.object({ date: ymd.default(today), format: z.enum(["json", "xlsx", "pdf"]).default("json") }),
    req.query,
  );
  const from = startOfLocalDay(date, outlet.timezone);
  const to = startOfLocalDay(addDays(date, 1), outlet.timezone);
  const window = { outletId: req.outletId, createdAt: { gte: from, lt: to } };

  const [orders, cancelled, payments, items, yesterday, lastWeek] = await Promise.all([
    prisma.order.findMany({
      where: { ...window, status: "PAID" },
      select: {
        grandTotal: true, subtotal: true, discount: true, cgst: true, sgst: true, igst: true, cess: true, otherTaxes: true,
        serviceCharge: true, orderType: true, createdAt: true, cashier: { select: { id: true, name: true } },
      },
    }),
    prisma.order.count({ where: { ...window, status: "CANCELLED" } }),
    prisma.payment.groupBy({
      by: ["mode"],
      where: { status: "SUCCESS", order: { ...window, status: "PAID" } },
      _sum: { amount: true, tip: true },
      _count: true,
    }),
    prisma.orderItem.groupBy({
      by: ["menuItemId", "name"],
      where: { order: { ...window, status: "PAID" } },
      _sum: { quantity: true, total: true },
      orderBy: { _sum: { quantity: "desc" } },
      take: 5,
    }),
    daySales(req.outletId!, addDays(date, -1), outlet.timezone),
    daySales(req.outletId!, addDays(date, -7), outlet.timezone),
  ]);
  // Credit notes issued on this day (Phase 3.1), whatever day the bill was from.
  const refundRows = await prisma.creditNote.groupBy({ by: ["refundMode"], where: window, _sum: { amount: true, cgst: true, sgst: true, igst: true, cess: true, otherTaxes: true }, _count: true });
  const refundTotal = refundRows.reduce((s, r) => s + (r._sum.amount ?? 0), 0);
  // Exceptions for the dashboard tiles: bills voided on this day, and cash shifts closed on it.
  const [voided, shifts] = await Promise.all([
    prisma.order.aggregate({ where: { outletId: req.outletId, cancelledAt: { gte: from, lt: to } }, _count: true, _sum: { grandTotal: true } }),
    prisma.cashShift.findMany({ where: { outletId: req.outletId, status: "CLOSED", closedAt: { gte: from, lt: to } }, select: { variance: true } }),
  ]);
  const refundTax = refundRows.reduce((s, r) => s + (r._sum.cgst ?? 0) + (r._sum.sgst ?? 0) + (r._sum.igst ?? 0) + (r._sum.cess ?? 0) + (r._sum.otherTaxes ?? 0), 0);

  const sum = (f: (o: (typeof orders)[number]) => number) => orders.reduce((s, o) => s + f(o), 0);
  const gross = sum((o) => o.grandTotal);
  const byType: Record<string, { orders: number; amount: number }> = {};
  const byStaff = new Map<string, { id: string; name: string; bills: number; amount: number }>();
  const hourly = Array.from({ length: 24 }, (_, hour) => ({ hour, orders: 0, amount: 0 }));
  for (const o of orders) {
    byType[o.orderType] ??= { orders: 0, amount: 0 };
    byType[o.orderType].orders++;
    byType[o.orderType].amount += o.grandTotal;
    const s = byStaff.get(o.cashier.id) ?? { ...o.cashier, bills: 0, amount: 0 };
    s.bills++;
    s.amount += o.grandTotal;
    byStaff.set(o.cashier.id, s);
    const h = Math.floor(zonedParts(o.createdAt, outlet.timezone).minutes / 60);
    hourly[h].orders++;
    hourly[h].amount += o.grandTotal;
  }
  const change = (cur: number, prev: number) => (prev === 0 ? null : Math.round(((cur - prev) / prev) * 1000) / 10);

  const data = {
    date,
    grossSales: gross,
    netSales: gross - sum(taxOf),
    discounts: sum((o) => o.discount),
    tax: { cgst: sum((o) => o.cgst), sgst: sum((o) => o.sgst), igst: sum((o) => o.igst), cess: sum((o) => o.cess), otherTaxes: sum((o) => o.otherTaxes) },
    serviceCharge: sum((o) => o.serviceCharge),
    orders: orders.length,
    cancelledOrders: cancelled,
    refunds: {
      count: refundRows.reduce((s, r) => s + r._count, 0),
      amount: refundTotal,
      tax: refundTax,
      byMode: Object.fromEntries(refundRows.map((r) => [r.refundMode, { count: r._count, amount: r._sum.amount ?? 0 }])),
    },
    voids: { count: voided._count, amount: voided._sum.grandTotal ?? 0 },
    /** Cash shifts closed on this day: counted − expected (negative = short) */
    cashDifference: { shifts: shifts.length, amount: shifts.reduce((s, x) => s + (x.variance ?? 0), 0) },
    /** Gross sales minus refunds issued today */
    salesAfterRefunds: gross - refundTotal,
    /** Tips received on top of bills (not sales, not taxed) — Phase 3.8 */
    tips: payments.reduce((s, p) => s + (p._sum.tip ?? 0), 0),
    averageOrderValue: orders.length ? Math.round(gross / orders.length) : 0,
    byOrderType: byType,
    byPaymentMode: Object.fromEntries(payments.map((p) => [p.mode, { count: p._count, amount: p._sum.amount ?? 0 }])),
    topItems: items.map((i) => ({ menuItemId: i.menuItemId, name: i.name, quantity: i._sum.quantity ?? 0, amount: i._sum.total ?? 0 })),
    staff: [...byStaff.values()].sort((a, b) => b.amount - a.amount),
    hourly,
    comparison: {
      yesterday: { ...yesterday, changePercent: change(gross, yesterday.gross) },
      lastWeek: { ...lastWeek, changePercent: change(gross, lastWeek.gross) },
    },
  };
  if (format === "json") return res.json(data);
  await sendExport(res, format, `daily_${date}`, [
    {
      title: "Daily summary",
      subtitle: `${outlet.name} · ${date}`,
      columns: [{ key: "metric", header: "Metric", width: 26 }, { key: "value", header: "Amount", type: "money", width: 16 }, { key: "count", header: "Count", type: "int" }],
      rows: [
        { metric: "Gross sales", value: data.grossSales, count: data.orders },
        { metric: "Net sales", value: data.netSales },
        { metric: "Discounts", value: data.discounts },
        { metric: "CGST", value: data.tax.cgst },
        { metric: "SGST", value: data.tax.sgst },
        { metric: "IGST", value: data.tax.igst },
        { metric: "Cess", value: data.tax.cess },
        { metric: "Other taxes", value: data.tax.otherTaxes },
        { metric: "Service charge", value: data.serviceCharge },
        { metric: "Average order value", value: data.averageOrderValue },
        { metric: "Cancelled orders", count: data.cancelledOrders },
        { metric: "Refunds (credit notes)", value: data.refunds.amount, count: data.refunds.count },
        { metric: "Sales after refunds", value: data.salesAfterRefunds },
        { metric: "Tips (not sales)", value: data.tips },
        { metric: `Yesterday (${data.comparison.yesterday.changePercent ?? "-"}%)`, value: yesterday.gross, count: yesterday.orders },
        { metric: `Same day last week (${data.comparison.lastWeek.changePercent ?? "-"}%)`, value: lastWeek.gross, count: lastWeek.orders },
      ],
    },
    {
      title: "Payment modes",
      columns: [{ key: "mode", header: "Mode" }, { key: "count", header: "Count", type: "int" }, { key: "amount", header: "Amount", type: "money", width: 14 }],
      rows: Object.entries(data.byPaymentMode).map(([mode, v]) => ({ mode, ...v })),
      totals: true,
    },
    {
      title: "Top items",
      columns: [{ key: "name", header: "Item", width: 28 }, { key: "quantity", header: "Qty", type: "int" }, { key: "amount", header: "Amount", type: "money", width: 14 }],
      rows: data.topItems,
    },
    {
      title: "Staff",
      columns: [{ key: "name", header: "Name", width: 22 }, { key: "bills", header: "Bills", type: "int" }, { key: "amount", header: "Amount", type: "money", width: 14 }],
      rows: data.staff,
      totals: true,
    },
  ], "Daily summary");
});

/** Small HTML summary used in scheduled report emails. */
export function summaryHtml(built: BuiltReport): string {
  const d = built.data as Record<string, unknown>;
  const t = (d.totals ?? d) as Record<string, unknown>;
  const pick: [string, string, "money" | "int" | "pct"][] = [
    ["gross", "Gross sales", "money"], ["net", "Net sales", "money"], ["orders", "Orders", "int"], ["aov", "Average order", "money"],
    ["cancelled", "Cancelled", "int"], ["taxable", "Taxable value", "money"], ["totalTax", "Total GST", "money"],
    ["revenue", "Revenue (ex-tax)", "money"], ["grossProfit", "Gross profit", "money"], ["grossMarginPercent", "Gross margin", "pct"],
    ["totalRevenue", "Item revenue", "money"], ["uniqueCustomers", "Customers", "int"], ["repeatRate", "Repeat rate", "pct"],
    ["delivered", "Delivered", "int"],
  ];
  const rows = pick
    .filter(([k]) => typeof t[k] === "number")
    .map(([k, label, type]) => {
      const v = t[k] as number;
      const txt = type === "money" ? fmtRs(v) : type === "pct" ? `${v}%` : String(v);
      return `<tr><td style="padding:2px 12px 2px 0;color:#555">${label}</td><td style="padding:2px 0;text-align:right"><b>${txt}</b></td></tr>`;
    });
  return `<h3 style="margin:16px 0 4px;color:#FF6B35">${built.title}</h3>${rows.length ? `<table>${rows.join("")}</table>` : "<p>See attachment.</p>"}`;
}
