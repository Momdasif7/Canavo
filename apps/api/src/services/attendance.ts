import bcrypt from "bcryptjs";
import type { Request } from "express";
import { distanceMeters } from "@canavo/shared";
import type { z } from "zod";
import type { clockSchema } from "@canavo/shared";
import { prisma } from "../db";
import { badRequest, forbidden, HttpError } from "../lib/http";
import { addDays, hhmmToMinutes, startOfLocalDay, zonedParts } from "../lib/time";
import { audit } from "../lib/audit";
import { notify, outletManagers } from "./notify";
import { assignWaitingDeliveries, markBackAtOutlet } from "./delivery-assign";
import { alertAttendanceMarked } from "./alerts";

type ClockInput = z.infer<typeof clockSchema>;

const DEFAULT_SHIFT_MINUTES = 8 * 60;
/** GPS on cheap phones drifts; tolerate up to 100m of reported accuracy on top of the geofence. */
const MAX_ACCURACY_ALLOWANCE = 100;

async function loadContext(req: Request, input: ClockInput, action: "in" | "out" = "in") {
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: req.user!.id },
    include: { shift: true, outlets: true },
  });
  const outletId = input.outletId ?? (user.outlets.length === 1 ? user.outlets[0].outletId : undefined);
  if (!outletId) throw badRequest("outletId is required for staff assigned to multiple outlets");
  if (user.role !== "SUPER_ADMIN" && !user.outlets.some((o) => o.outletId === outletId)) {
    throw forbidden("You are not assigned to this outlet");
  }
  const outlet = await prisma.outlet.findUniqueOrThrow({ where: { id: outletId } });

  if (user.pinHash) {
    if (!input.pin) throw new HttpError(400, "PIN is required to clock in/out", { code: "PIN_REQUIRED" });
    if (!(await bcrypt.compare(input.pin, user.pinHash))) throw new HttpError(403, "Incorrect PIN", { code: "WRONG_PIN" });
  }

  let distance = -1; // -1 = outlet has no location configured
  if (outlet.latitude != null && outlet.longitude != null) {
    distance = Math.round(
      distanceMeters(input, { latitude: outlet.latitude, longitude: outlet.longitude }),
    );
    const allowance = Math.min(input.accuracy ?? 0, MAX_ACCURACY_ALLOWANCE);
    // Delivery partners usually finish their last run away from the outlet: they may clock out anywhere
    // (the location is still recorded); clocking in still has to happen at the outlet.
    const roaming = action === "out" && user.role === "DELIVERY";
    if (!roaming && distance > outlet.geofenceMeters + allowance) {
      throw new HttpError(
        403,
        `You are ${distance}m from ${outlet.name}. Clock-in is allowed within ${outlet.geofenceMeters}m.`,
        { code: "OUTSIDE_GEOFENCE", distance, allowed: outlet.geofenceMeters },
      );
    }
  }
  return { user, outlet, distance };
}

function shiftWindow(shift: { startTime: string; endTime: string } | null) {
  if (!shift) return null;
  const start = hhmmToMinutes(shift.startTime);
  let end = hhmmToMinutes(shift.endTime);
  if (end <= start) end += 24 * 60; // overnight shift
  return { start, end, length: end - start };
}

export async function clockIn(req: Request, input: ClockInput) {
  const { user, outlet, distance } = await loadContext(req, input);
  const open = await prisma.staffAttendance.findFirst({ where: { userId: user.id, clockOutAt: null } });
  if (open) throw new HttpError(409, "You are already clocked in", { code: "ALREADY_CLOCKED_IN" });

  const now = new Date();
  const local = zonedParts(now, outlet.timezone);
  const win = shiftWindow(user.shift);
  const grace = user.shift?.graceMinutes ?? 0;
  // After midnight on an overnight shift, the shift belongs to the previous day.
  let workDate = local.date;
  let minutes = local.minutes;
  if (win && win.end > 24 * 60 && local.minutes < win.end - 24 * 60) {
    workDate = addDays(local.date, -1);
    minutes += 24 * 60;
  }
  const lateBy = win && minutes > win.start + grace ? minutes - win.start : 0;

  const record = await prisma.staffAttendance.create({
    data: {
      userId: user.id,
      outletId: outlet.id,
      workDate,
      clockInAt: now,
      clockInLat: input.latitude,
      clockInLng: input.longitude,
      clockInDistance: distance,
      lateByMinutes: lateBy,
    },
  });
  await audit(req, "attendance.clock_in", "StaffAttendance", record.id, { distance, lateBy });
  // A delivery partner coming on duty picks up deliveries that were waiting for someone.
  if (user.role === "DELIVERY") {
    // Clocking in happens at the outlet, so the partner is here and can take orders.
    markBackAtOutlet(outlet.id, user.id, "clock-in")
      .then((changed) => (changed ? undefined : assignWaitingDeliveries(outlet.id)))
      .catch((e) => console.error("[delivery] auto-assign on clock-in failed", e));
  }
  if (lateBy > 0) {
    await notify(
      await outletManagers(outlet.id),
      "Late arrival",
      `${user.name} clocked in ${lateBy} min late at ${outlet.name}`,
      "attendance.late",
    );
  }
  return record;
}

export async function clockOut(req: Request, input: ClockInput) {
  const { user, outlet } = await loadContext(req, input, "out");
  const open = await prisma.staffAttendance.findFirst({
    where: { userId: user.id, clockOutAt: null },
    orderBy: { clockInAt: "desc" },
  });
  if (!open) throw new HttpError(409, "You are not clocked in", { code: "NOT_CLOCKED_IN" });

  const now = new Date();
  const worked = Math.round((now.getTime() - open.clockInAt.getTime()) / 60_000);
  const win = shiftWindow(user.shift);
  const scheduled = win?.length ?? DEFAULT_SHIFT_MINUTES;
  const overtime = Math.max(0, worked - scheduled);
  let earlyBy = 0;
  if (win) {
    const shiftEnd = startOfLocalDay(open.workDate, outlet.timezone).getTime() + win.end * 60_000;
    earlyBy = Math.max(0, Math.round((shiftEnd - now.getTime()) / 60_000));
  }
  const status = worked < scheduled / 2 ? "HALF_DAY" : "PRESENT";

  const record = await prisma.staffAttendance.update({
    where: { id: open.id },
    data: {
      clockOutAt: now,
      clockOutLat: input.latitude,
      clockOutLng: input.longitude,
      workedMinutes: worked,
      overtimeMinutes: overtime,
      earlyByMinutes: earlyBy,
      status,
    },
  });
  await audit(req, "attendance.clock_out", "StaffAttendance", record.id, { worked, overtime, earlyBy });

  const alerts: string[] = [];
  if (earlyBy > 15) alerts.push(`left ${earlyBy} min early`);
  if (overtime > 0) alerts.push(`worked ${overtime} min overtime`);
  if (alerts.length) {
    await notify(
      await outletManagers(outlet.id),
      "Attendance alert",
      `${user.name} ${alerts.join(" and ")} at ${outlet.name}`,
      earlyBy > 15 ? "attendance.early" : "attendance.overtime",
    );
  }
  return record;
}

// =====================================================================
// Manual attendance (manager / owner)
// =====================================================================

const MANAGE_RANK: Record<string, number> = {
  SUPER_ADMIN: 0,
  BUSINESS_OWNER: 1,
  OUTLET_MANAGER: 2,
  CASHIER: 3,
  KITCHEN: 3,
  DELIVERY: 3,
  INVENTORY_MANAGER: 3,
};

/** Owners / super admins manage everyone below them incl. managers; managers manage staff. Never yourself. */
export function canManageAttendanceOf(actor: { id: string; role: string }, target: { id: string; role: string }) {
  if (actor.id === target.id) return false;
  return MANAGE_RANK[target.role] > MANAGE_RANK[actor.role];
}

export interface ManualEntry {
  status: "PRESENT" | "HALF_DAY" | "ABSENT" | "LEAVE";
  clockIn?: string;
  clockOut?: string | null;
  note?: string | null;
}

/**
 * Turn a manual entry (local HH:MM on `date`) into record fields: instants,
 * worked / late / early / overtime minutes against the employee's shift.
 * Absent / leave become zero-length closed records so they never look like an
 * open shift (which would block the employee from clocking in).
 */
export function manualRecordFields(
  date: string,
  timezone: string,
  shift: { startTime: string; endTime: string; graceMinutes: number } | null,
  e: ManualEntry,
) {
  const dayStart = startOfLocalDay(date, timezone).getTime();
  const at = (hhmm: string) => new Date(dayStart + hhmmToMinutes(hhmm) * 60_000);
  if (e.status === "ABSENT" || e.status === "LEAVE" || !e.clockIn) {
    const t = new Date(dayStart);
    return { clockInAt: t, clockOutAt: t, workedMinutes: 0, lateByMinutes: 0, earlyByMinutes: 0, overtimeMinutes: 0 };
  }
  const clockInAt = at(e.clockIn);
  let clockOutAt: Date | null = e.clockOut ? at(e.clockOut) : null;
  if (clockOutAt && clockOutAt <= clockInAt) clockOutAt = new Date(clockOutAt.getTime() + 86_400_000); // overnight
  const win = shiftWindow(shift);
  const inMin = hhmmToMinutes(e.clockIn);
  const lateBy = win && inMin > win.start + (shift?.graceMinutes ?? 0) ? inMin - win.start : 0;
  const worked = clockOutAt ? Math.round((clockOutAt.getTime() - clockInAt.getTime()) / 60_000) : null;
  const scheduled = win?.length ?? DEFAULT_SHIFT_MINUTES;
  const earlyBy = win && clockOutAt ? Math.max(0, Math.round((dayStart + win.end * 60_000 - clockOutAt.getTime()) / 60_000)) : 0;
  return {
    clockInAt,
    clockOutAt,
    workedMinutes: worked,
    lateByMinutes: lateBy,
    earlyByMinutes: earlyBy,
    overtimeMinutes: worked !== null ? Math.max(0, worked - scheduled) : 0,
  };
}

/**
 * Create or update the day's attendance for an employee. If they clocked in
 * themselves that record is corrected (keeping its GPS data); otherwise a
 * MANUAL record is created.
 */
export async function upsertManualAttendance(
  req: Request,
  outlet: { id: string; timezone: string },
  user: { id: string; role: string; name: string; shift: { startTime: string; endTime: string; graceMinutes: number } | null },
  date: string,
  e: ManualEntry,
) {
  if (!canManageAttendanceOf(req.user!, user)) throw forbidden(`You can't mark attendance for ${user.name}`);
  const fields = manualRecordFields(date, outlet.timezone, user.shift, e);
  // BUG-010: only this outlet's record — staff working at several outlets have one per outlet.
  const existing = await prisma.staffAttendance.findFirst({ where: { userId: user.id, outletId: outlet.id, workDate: date }, orderBy: { clockInAt: "asc" } });
  // An omitted note keeps the existing one; an empty / null note clears it.
  const note = e.note === undefined ? (existing?.note ?? null) : e.note || null;
  const common = { ...fields, status: e.status, note, markedById: req.user!.id, editedAt: new Date() } as const;
  const record = existing
    ? await prisma.staffAttendance.update({ where: { id: existing.id }, data: common })
    : await prisma.staffAttendance.create({
        data: { ...common, userId: user.id, outletId: outlet.id, workDate: date, clockInDistance: -1, source: "MANUAL" },
      });
  void alertAttendanceMarked(user.id, date, e.status, req.user!.name, outlet.id);
  await audit(req, existing ? "attendance.manual_edit" : "attendance.manual_add", "StaffAttendance", record.id, {
    userId: user.id,
    date,
    status: e.status,
    clockIn: e.clockIn ?? null,
    clockOut: e.clockOut ?? null,
    ...(existing && { before: { status: existing.status, clockInAt: existing.clockInAt, clockOutAt: existing.clockOutAt } }),
  });
  return record;
}

/**
 * A day's outcome for pay and calendars. A record beats a leave request:
 * PRESENT (1) > HALF_DAY (0.5) > LEAVE record (paid, 1) > ABSENT record (0);
 * without records, approved casual/sick leave is paid and half-day leave is 0.5.
 */
export function dayOutcome(
  recs: { status: string }[],
  leave: { type: string } | undefined,
): { status: "PRESENT" | "HALF_DAY" | "LEAVE" | "ABSENT" | "NONE"; units: number; paidLeave: boolean } {
  if (recs.some((r) => r.status === "PRESENT")) return { status: "PRESENT", units: 1, paidLeave: false };
  if (recs.some((r) => r.status === "HALF_DAY")) return { status: "HALF_DAY", units: 0.5, paidLeave: false };
  if (recs.some((r) => r.status === "LEAVE")) return { status: "LEAVE", units: 1, paidLeave: true };
  if (recs.some((r) => r.status === "ABSENT")) return { status: "ABSENT", units: 0, paidLeave: false };
  if (leave?.type === "HALF_DAY") return { status: "HALF_DAY", units: 0.5, paidLeave: false };
  if (leave && (leave.type === "CASUAL" || leave.type === "SICK")) return { status: "LEAVE", units: 1, paidLeave: true };
  if (leave) return { status: "LEAVE", units: 0, paidLeave: false };
  return { status: "NONE", units: 0, paidLeave: false };
}
