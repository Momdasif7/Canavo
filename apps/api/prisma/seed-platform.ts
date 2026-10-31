import type { PaymentMode, PrismaClient, Prisma, OrderType } from "@prisma/client";
import { startOfLocalDay } from "../src/lib/time";
import {
  computeBill,
  effectiveGstRate,
  financialYearStart,
  formatInvoiceNumber,
  gstPercent,
  legacyTax,
  taxFromRate,
  type BillDiscount,
  type LineTax,
} from "@canavo/shared";

const MARKER = "seed:history";
const DAYS = 30;

/** Deterministic PRNG so re-seeding a fresh DB gives the same history. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Relative order volume per local hour (canteen: breakfast, lunch, evening snacks, dinner). */
const HOUR_WEIGHTS: Record<number, number> = {
  7: 3, 8: 6, 9: 7, 10: 4, 11: 4, 12: 9, 13: 10, 14: 6, 15: 3, 16: 5, 17: 7, 18: 6, 19: 6, 20: 5, 21: 3, 22: 1,
};

function pickWeighted<T>(r: () => number, entries: [T, number][]): T {
  const total = entries.reduce((s, [, w]) => s + w, 0);
  let x = r() * total;
  for (const [v, w] of entries) if ((x -= w) < 0) return v;
  return entries[entries.length - 1][0];
}

/** UTC instant for a local wall-clock time (exact for fixed-offset zones like IST). */
const localInstant = (ymd: string, hour: number, minute: number, timeZone: string) =>
  new Date(startOfLocalDay(ymd, timeZone).getTime() + (hour * 60 + minute) * 60_000);

const addDays = (ymd: string, n: number) => {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/**
 * Platform demo data: ~30 days of PAID (and a few cancelled) historical orders
 * for the first outlet so reports and heatmaps have data, plus attendance
 * history and one report schedule. Idempotent: skipped if any order has the
 * "seed:history" note.
 */
export async function seedPlatform(prisma: PrismaClient): Promise<void> {
  const outlet = await prisma.outlet.findFirst({ orderBy: { createdAt: "asc" } });
  if (!outlet) return;

  if (!(await prisma.reportSchedule.count())) {
    await prisma.reportSchedule.create({
      data: { outletId: outlet.id, email: "owner@canavo.local", frequency: "DAILY", reports: ["sales", "items", "gst"] },
    });
    console.info("[seed:platform] created a daily report schedule for owner@canavo.local");
  }

  if (await prisma.order.findFirst({ where: { notes: MARKER } })) {
    console.info("[seed:platform] historical orders already seeded — skipping.");
    return;
  }

  const r = rng(20261002);
  const tz = outlet.timezone;
  const [menu, staff, customers] = await Promise.all([
    prisma.menuItem.findMany({ where: { status: { not: "HIDDEN" }, businessId: outlet.businessId }, include: { variants: true, addons: true, taxRate: true } }),
    prisma.user.findMany({ where: { outlets: { some: { outletId: outlet.id } }, status: "ACTIVE" }, include: { shift: true } }),
    prisma.customer.findMany({ take: 40, orderBy: { createdAt: "asc" } }),
  ]);
  if (!menu.length || !staff.length) return;
  // Same tax resolution as billing: item rate → business default → legacy gstRate.
  const defaultRate = await prisma.taxRate.findFirst({ where: { businessId: outlet.businessId, isDefault: true, active: true } });
  const taxOf = (item: (typeof menu)[number]): LineTax =>
    item.taxRate ? taxFromRate(item.taxRate) : defaultRate ? taxFromRate(defaultRate) : legacyTax(item.gstRate);
  const cashiers = staff.filter((s) => s.role === "CASHIER" || s.role === "OUTLET_MANAGER");
  const billers = cashiers.length ? cashiers : staff;
  const agent = staff.find((s) => s.role === "DELIVERY");
  const popularity = menu.map((m, i) => [m, 1 + ((i * 7) % 5) + (m.price < 5000 ? 3 : 0)] as [typeof m, number]);
  // A couple of items are deliberately never sold (slow movers with zero sales).
  const sellable = popularity.slice(0, Math.max(1, popularity.length - 2));

  const today = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date());
  type Planned = {
    createdAt: Date; data: Omit<Prisma.OrderUncheckedCreateInput, "invoiceNumber">; cancelled: boolean;
    delivery?: Omit<Prisma.DeliveryUncheckedCreateInput, "orderId">;
  };
  const planned: Planned[] = [];

  for (let d = DAYS; d >= 1; d--) {
    const date = addDays(today, -d);
    const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
    const volume = Math.round((weekday === 0 || weekday === 6 ? 70 : 52) * (0.85 + r() * 0.3));
    for (let n = 0; n < volume; n++) {
      const hour = pickWeighted(r, Object.entries(HOUR_WEIGHTS).map(([h, w]) => [Number(h), w] as [number, number]));
      const createdAt = localInstant(date, hour, Math.floor(r() * 60), tz);
      const orderType = pickWeighted<OrderType>(r, [["DINE_IN", 50], ["TAKEAWAY", 36], ["DELIVERY", agent ? 10 : 0], ["PRE_ORDER", 4]]);
      const lineCount = pickWeighted(r, [[1, 40], [2, 35], [3, 18], [4, 7]]);
      const chosen = new Map<string, { item: (typeof menu)[number]; variant?: (typeof menu)[number]["variants"][number]; addons: (typeof menu)[number]["addons"]; qty: number }>();
      for (let l = 0; l < lineCount; l++) {
        const item = pickWeighted(r, sellable);
        const variant = item.variants.length ? item.variants[Math.floor(r() * item.variants.length)] : undefined;
        const addons = item.addons.length && r() < 0.2 ? [item.addons[0]] : [];
        const key = `${item.id}|${variant?.id ?? ""}|${addons.map((a) => a.id).join(",")}`;
        const e = chosen.get(key) ?? { item, variant, addons, qty: 0 };
        e.qty += r() < 0.8 ? 1 : 2;
        chosen.set(key, e);
      }
      const lines = [...chosen.values()].map((c) => ({
        ...c,
        unitPrice: (c.variant?.price ?? c.item.price) + c.addons.reduce((s, a) => s + a.price, 0),
      }));
      const discount: BillDiscount | undefined = r() < 0.06 ? { type: "PERCENT", value: 10 } : undefined;
      const extraCharges =
        (orderType === "TAKEAWAY" || orderType === "DELIVERY") && outlet.packagingCharge > 0
          ? [{ label: "Packaging", amount: outlet.packagingCharge }]
          : orderType === "DELIVERY"
            ? [{ label: "Delivery fee", amount: 3000 }]
            : [];
      const bill = computeBill(
        lines.map((l) => ({ unitPrice: l.unitPrice, quantity: l.qty, tax: taxOf(l.item) })),
        {
          pricesIncludeTax: outlet.pricesIncludeTax,
          interState: false,
          compositionScheme: outlet.compositionScheme,
          taxEnabled: outlet.gstEnabled,
          serviceChargeEnabled: outlet.serviceChargeEnabled && orderType === "DINE_IN",
          serviceChargePercent: outlet.serviceChargePercent,
          roundOff: outlet.roundOff,
          extraCharges,
        },
        discount,
      );
      const cancelled = r() < 0.03;
      const cashier = billers[Math.floor(r() * billers.length)];
      const customer = customers.length && r() < 0.35 ? customers[Math.floor(r() * customers.length)] : undefined;
      const payments: { mode: PaymentMode; amount: number }[] = [];
      if (!cancelled) {
        const mode = pickWeighted<PaymentMode | "SPLIT">(r, [["CASH", 44], ["UPI", 44], ["CARD", 9], ["SPLIT", 3]]);
        if (mode === "SPLIT") {
          const cash = Math.min(bill.grandTotal, Math.round((bill.grandTotal * 0.4) / 100) * 100);
          payments.push({ mode: "CASH", amount: cash }, { mode: "UPI", amount: bill.grandTotal - cash });
        } else payments.push({ mode, amount: bill.grandTotal });
      }
      const paidAt = new Date(createdAt.getTime() + (2 + Math.floor(r() * 10)) * 60_000);
      planned.push({
        createdAt,
        cancelled,
        data: {
          outletId: outlet.id,
          cashierId: cashier.id,
          documentType: bill.documentType,
          orderType,
          status: cancelled ? "CANCELLED" : "PAID",
          tableLabel: orderType === "DINE_IN" ? `T${1 + Math.floor(r() * 12)}` : null,
          customerId: customer?.id,
          customerName: customer?.name ?? null,
          customerPhone: customer?.phone ?? null,
          notes: MARKER,
          subtotal: bill.subtotal,
          discount: bill.discount,
          taxableValue: bill.taxableValue,
          serviceCharge: bill.serviceCharge,
          cgst: bill.cgst,
          sgst: bill.sgst,
          igst: bill.igst,
          cess: bill.cess,
          otherTaxes: bill.otherTaxes,
          taxDetails: bill.taxDetails as unknown as Prisma.InputJsonValue,
          roundOff: bill.roundOff,
          grandTotal: bill.grandTotal,
          taxBreakup: bill.taxBreakup as unknown as Prisma.InputJsonValue,
          extraCharges: bill.extraCharges,
          chargesBreakup: extraCharges as unknown as Prisma.InputJsonValue,
          paidAt: cancelled ? null : paidAt,
          cancelledAt: cancelled ? paidAt : null,
          cancelReason: cancelled ? pickWeighted(r, [["Customer left", 2], ["Wrong order", 2], ["Item unavailable", 1]]) : null,
          createdAt,
          updatedAt: paidAt,
          items: {
            create: lines.map((l, i) => ({
              menuItemId: l.item.id,
              variantId: l.variant?.id,
              name: [l.item.name, l.variant && `(${l.variant.name})`].filter(Boolean).join(" "),
              variantName: l.variant?.name,
              addons: l.addons.map((a) => ({ name: a.name, price: a.price })),
              quantity: l.qty,
              unitPrice: l.unitPrice,
              gstRate: bill.documentType === "BILL" ? 0 : gstPercent(taxOf(l.item)),
              hsnCode: l.item.hsnCode,
              discount: bill.lines[i].discount,
              taxableValue: bill.lines[i].taxableValue,
              serviceCharge: bill.lines[i].serviceCharge,
              cgst: bill.lines[i].cgst,
              sgst: bill.lines[i].sgst,
              igst: bill.lines[i].igst,
              cess: bill.lines[i].cess,
              otherTaxes: bill.lines[i].otherTaxes,
              taxRates: (() => {
                const t = taxOf(l.item);
                const snap = { name: t.name ?? `GST ${effectiveGstRate(t)}%`, cgst: t.cgst, sgst: t.sgst, igst: t.igst, cess: t.cess ?? 0, extras: t.extras ?? [] };
                return snap as unknown as Prisma.InputJsonValue;
              })(),
              total: bill.lines[i].total,
            })),
          },
          payments: { create: payments.map((p) => ({ ...p, status: "SUCCESS" as const, createdAt: paidAt, confirmedAt: paidAt })) },
        },
        delivery:
          orderType === "DELIVERY" && agent
            ? (() => {
                const assignedAt = new Date(createdAt.getTime() + (3 + Math.floor(r() * 5)) * 60_000);
                const pickedAt = new Date(assignedAt.getTime() + (8 + Math.floor(r() * 10)) * 60_000);
                const deliveredAt = new Date(pickedAt.getTime() + (10 + Math.floor(r() * 20)) * 60_000);
                return {
                  outletId: outlet.id,
                  agentId: agent.id,
                  status: cancelled ? ("CANCELLED" as const) : ("DELIVERED" as const),
                  customerName: customer?.name ?? "Walk-in",
                  customerPhone: customer?.phone ?? "9000000000",
                  address: "Koramangala, Bengaluru",
                  distanceKm: Math.round((1 + r() * 4) * 10) / 10,
                  etaAt: new Date(createdAt.getTime() + 40 * 60_000),
                  assignedAt,
                  pickedAt: cancelled ? null : pickedAt,
                  deliveredAt: cancelled ? null : deliveredAt,
                  createdAt,
                };
              })()
            : undefined,
      });
    }
  }
  planned.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

  // Reserve invoice numbers per FY by atomically bumping the outlet's counter.
  const byFy = new Map<number, Planned[]>();
  for (const p of planned) {
    const fy = financialYearStart(p.createdAt, tz);
    byFy.set(fy, [...(byFy.get(fy) ?? []), p]);
  }
  let created = 0;
  for (const [fy, list] of byFy) {
    const counter = await prisma.invoiceCounter.upsert({
      where: { outletId_fyStart: { outletId: outlet.id, fyStart: fy } },
      create: { outletId: outlet.id, fyStart: fy, lastSeq: list.length },
      update: { lastSeq: { increment: list.length } },
    });
    let seq = counter.lastSeq - list.length;
    for (let i = 0; i < list.length; i += 50) {
      const chunk = list.slice(i, i + 50);
      await prisma.$transaction(
        chunk.map((p) => {
          const invoiceNumber = formatInvoiceNumber(outlet.invoicePrefix, fy, ++seq);
          return prisma.order.create({
            data: { ...p.data, invoiceNumber, ...(p.delivery && { delivery: { create: p.delivery } }) } as Prisma.OrderUncheckedCreateInput,
          });
        }),
      );
      created += chunk.length;
    }
  }

  // Attendance history for outlet staff (skips days that already have records).
  const existing = await prisma.staffAttendance.findMany({
    where: { outletId: outlet.id, workDate: { gte: addDays(today, -DAYS), lt: today } },
    select: { userId: true, workDate: true },
  });
  const has = new Set(existing.map((e) => `${e.userId}|${e.workDate}`));
  const att: Prisma.StaffAttendanceCreateManyInput[] = [];
  for (const u of staff.filter((s) => s.role !== "SUPER_ADMIN")) {
    const [sh, sm] = (u.shift?.startTime ?? "09:00").split(":").map(Number);
    for (let d = DAYS; d >= 1; d--) {
      const date = addDays(today, -d);
      if (has.has(`${u.id}|${date}`) || r() < 0.1) continue; // ~10% absent
      const late = r() < 0.15 ? 11 + Math.floor(r() * 25) : 0;
      const inAt = localInstant(date, sh, sm, tz);
      const clockInAt = new Date(inAt.getTime() + (late ? late : -Math.floor(r() * 10)) * 60_000);
      const worked = 8 * 60 + Math.floor(r() * 90) - 30;
      att.push({
        userId: u.id, outletId: outlet.id, workDate: date, clockInAt,
        clockOutAt: new Date(clockInAt.getTime() + worked * 60_000),
        clockInLat: outlet.latitude ?? 0, clockInLng: outlet.longitude ?? 0, clockInDistance: Math.floor(r() * 60),
        workedMinutes: worked, overtimeMinutes: Math.max(0, worked - 480), lateByMinutes: late,
        status: worked < 240 ? "HALF_DAY" : "PRESENT",
      });
    }
  }
  if (att.length) await prisma.staffAttendance.createMany({ data: att });

  console.info(`[seed:platform] created ${created} historical orders (${planned.filter((p) => p.cancelled).length} cancelled) and ${att.length} attendance records`);
}
