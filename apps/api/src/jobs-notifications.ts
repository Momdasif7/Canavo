// Time-based alerts: late deliveries, staff who haven't clocked in, missed
// clock-outs, and the end-of-day sales summary. Every alert is sent once.
import { formatINR } from "@canavo/shared";
import { platformPrisma, prisma } from "./db";
import { registerJob } from "./jobs";
import { addDays, hhmmToMinutes, startOfLocalDay, zonedParts } from "./lib/time";
import { runForOutlet } from "./lib/tenant";
import { notify, outletManagers } from "./services/notify";

const OVERDUE_GRACE_MIN = 5;
const NOT_CLOCKED_IN_AFTER_MIN = 30;
const MISSED_CLOCK_OUT_AFTER_MIN = 120;
const DAILY_SUMMARY_AT = "22:30";

/** Remember per outlet + day which alerts were sent (Setting value: string[]). */
async function sentToday(outletId: string, key: string, date: string) {
  const row = await prisma.setting.findUnique({ where: { scope_key: { scope: outletId, key } } });
  const v = row?.value as { date?: string; ids?: string[] } | null;
  return v?.date === date ? new Set(v.ids ?? []) : new Set<string>();
}
async function markSent(outletId: string, key: string, date: string, ids: Set<string>) {
  const value = { date, ids: [...ids] };
  await prisma.setting.upsert({ where: { scope_key: { scope: outletId, key } }, create: { scope: outletId, key, value }, update: { value } });
}

/** Deliveries past their ETA (+5 min) that aren't delivered: partner + managers, once. */
export async function alertOverdueDeliveries(now = new Date()) {
  const late = await prisma.delivery.findMany({
    where: {
      status: { in: ["PENDING", "ACCEPTED", "PREPARING", "OUT_FOR_DELIVERY"] },
      overdueNotifiedAt: null,
      etaAt: { lt: new Date(now.getTime() - OVERDUE_GRACE_MIN * 60_000) },
      order: { status: { not: "CANCELLED" } },
    },
    include: { order: { select: { invoiceNumber: true } }, agent: { select: { name: true } } },
    take: 100,
  });
  for (const d of late) {
    const mins = Math.round((now.getTime() - d.etaAt!.getTime()) / 60_000);
    await prisma.delivery.update({ where: { id: d.id }, data: { overdueNotifiedAt: now } });
    const who = d.agent?.name ?? "no partner assigned";
    await notify(await outletManagers(d.outletId), "Delivery running late", `${d.order.invoiceNumber} · ${d.customerName} · ${mins} min past ETA (${who})`, "delivery.late", { outletId: d.outletId });
    if (d.agentId) await notify([d.agentId], "Delivery running late", `${d.order.invoiceNumber} for ${d.customerName} is ${mins} min past its ETA`, "delivery.late", { outletId: d.outletId });
  }
  return late.length;
}

/** Per outlet: staff not clocked in 30 min after shift start, and shifts left open 2 h past their end. */
export async function alertAttendance(now = new Date()) {
  const outlets = await platformPrisma.outlet.findMany({ select: { id: true, name: true, timezone: true, business: { select: { modules: true, status: true } } } });
  for (const o of outlets) {
    if (o.business.status !== "ACTIVE" || !o.business.modules.includes("ATTENDANCE")) continue;
    await runForOutlet(o.id, async () => {
      const local = zonedParts(now, o.timezone);
      const staff = await prisma.user.findMany({
        where: { status: "ACTIVE", outlets: { some: { outletId: o.id } }, shiftId: { not: null }, role: { notIn: ["SUPER_ADMIN", "BUSINESS_OWNER"] } },
        select: { id: true, name: true, shift: true },
      });
      // Not clocked in
      const notifiedAbsent = await sentToday(o.id, "alerts.notClockedIn", local.date);
      const absent: string[] = [];
      for (const u of staff) {
        if (!u.shift || notifiedAbsent.has(u.id)) continue;
        const start = hhmmToMinutes(u.shift.startTime);
        if (local.minutes < start + NOT_CLOCKED_IN_AFTER_MIN || local.minutes > start + 6 * 60) continue;
        const [att, leave] = await Promise.all([
          prisma.staffAttendance.count({ where: { userId: u.id, workDate: local.date } }),
          prisma.leaveRequest.count({ where: { userId: u.id, status: "APPROVED", fromDate: { lte: local.date }, toDate: { gte: local.date } } }),
        ]);
        if (att || leave) continue;
        absent.push(`${u.name} (${u.shift.name} ${u.shift.startTime})`);
        notifiedAbsent.add(u.id);
      }
      if (absent.length) {
        await notify(await outletManagers(o.id), `${absent.length} staff not clocked in`, absent.join(", "), "attendance.not_clocked_in", { outletId: o.id });
        await markSent(o.id, "alerts.notClockedIn", local.date, notifiedAbsent);
      }
      // Missed clock-out
      const notifiedOpen = await sentToday(o.id, "alerts.missedClockOut", local.date);
      const open = await prisma.staffAttendance.findMany({
        where: { outletId: o.id, clockOutAt: null, status: { in: ["PRESENT", "HALF_DAY"] } },
        include: { user: { select: { id: true, name: true, shift: true } } },
      });
      for (const a of open) {
        if (notifiedOpen.has(a.id)) continue;
        const shift = a.user.shift;
        let dueAt: number;
        if (shift) {
          let end = hhmmToMinutes(shift.endTime);
          if (end <= hhmmToMinutes(shift.startTime)) end += 24 * 60;
          dueAt = startOfLocalDay(a.workDate, o.timezone).getTime() + (end + MISSED_CLOCK_OUT_AFTER_MIN) * 60_000;
        } else {
          dueAt = a.clockInAt.getTime() + 14 * 3600_000;
        }
        if (now.getTime() < dueAt) continue;
        notifiedOpen.add(a.id);
        await notify([a.user.id], "You didn't clock out", `Your shift on ${a.workDate} is still open. Clock out, or ask your manager to correct it.`, "attendance.missed_clock_out", { outletId: o.id });
        await notify((await outletManagers(o.id)).filter((id) => id !== a.user.id), "Missed clock-out", `${a.user.name} is still clocked in from ${a.workDate}`, "attendance.missed_clock_out", { outletId: o.id });
      }
      if (open.length) await markSent(o.id, "alerts.missedClockOut", local.date, notifiedOpen);
    });
  }
}

/** End-of-day summary to owners / managers, once per outlet per day. */
export async function sendDailySummaries(now = new Date()) {
  const outlets = await platformPrisma.outlet.findMany({ select: { id: true, name: true, timezone: true, business: { select: { modules: true, status: true } } } });
  for (const o of outlets) {
    if (o.business.status !== "ACTIVE" || !o.business.modules.includes("BILLING")) continue;
    const local = zonedParts(now, o.timezone);
    if (local.minutes < hhmmToMinutes(DAILY_SUMMARY_AT)) continue;
    await runForOutlet(o.id, async () => {
      const sent = await sentToday(o.id, "alerts.dailySummary", local.date);
      if (sent.has("done")) return;
      const range = { gte: startOfLocalDay(local.date, o.timezone), lt: startOfLocalDay(addDays(local.date, 1), o.timezone) };
      const [paid, cancelled, open, top] = await Promise.all([
        prisma.order.aggregate({ where: { outletId: o.id, status: "PAID", createdAt: range }, _sum: { grandTotal: true }, _count: true }),
        prisma.order.count({ where: { outletId: o.id, status: "CANCELLED", createdAt: range } }),
        prisma.order.count({ where: { outletId: o.id, status: "OPEN", createdAt: range } }),
        prisma.orderItem.groupBy({ by: ["name"], where: { order: { outletId: o.id, status: "PAID", createdAt: range } }, _sum: { quantity: true }, orderBy: { _sum: { quantity: "desc" } }, take: 3 }),
      ]);
      sent.add("done");
      await markSent(o.id, "alerts.dailySummary", local.date, sent);
      if (!paid._count && !cancelled && !open) return;
      const topText = top.map((t) => `${t.name} ×${t._sum.quantity}`).join(", ");
      await notify(
        await outletManagers(o.id),
        `Today at ${o.name}: ${formatINR(paid._sum.grandTotal ?? 0)}`,
        `${paid._count} bills paid${cancelled ? ` · ${cancelled} cancelled` : ""}${open ? ` · ${open} still unpaid` : ""}${topText ? ` · Top: ${topText}` : ""}`,
        "report.daily",
        { outletId: o.id },
      );
    });
  }
}

export function registerJobs(): void {
  registerJob("alerts-delivery-late", 60_000, async () => {
    await alertOverdueDeliveries();
  });
  registerJob("alerts-attendance", 5 * 60_000, async () => {
    await alertAttendance();
  });
  registerJob("alerts-daily-summary", 10 * 60_000, async () => {
    await sendDailySummaries();
  });
}
