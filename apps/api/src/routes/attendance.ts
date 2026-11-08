import { Router } from "express";
import ExcelJS from "exceljs";
import { z } from "zod";
import { attendanceManualSchema, attendanceRegisterSchema, attendanceUpdateSchema, clockSchema, leaveRequestSchema, ROLE_LABELS } from "@canavo/shared";
import { prisma } from "../db";
import { badRequest, forbidden, notFound, param, parse } from "../lib/http";
import { audit } from "../lib/audit";
import { addDays, isValidYmd as isRealDate } from "../lib/time";
import { authenticate, requireOutlet, requirePermission, requireModule, userCan } from "../middleware/auth";
import { canManageAttendanceOf, clockIn, clockOut, dayOutcome, manualRecordFields, upsertManualAttendance } from "../services/attendance";
import { notify, outletManagers } from "../services/notify";
import { safeCellText } from "../services/report-export";
import { alertAttendanceMarked } from "../services/alerts";

export const attendanceRouter = Router();
attendanceRouter.use(authenticate, requireModule("ATTENDANCE"));

// A real calendar date: "2025-13-01" would crash date maths (500) and "2025-02-30" would be stored as a work date.
const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(isRealDate, "Not a real date");
function assertRealDates(...dates: string[]) {
  if (!dates.every(isRealDate)) throw badRequest("Validation failed", { formErrors: ["Not a real date"] });
}
const monthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);

function monthRange(month: string) {
  const [y, m] = month.split("-").map(Number);
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${month}-01`, to: `${month}-${String(days).padStart(2, "0")}`, days };
}

function eachDay(from: string, to: string) {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

// ---------- Self service ----------
attendanceRouter.post("/clock-in", requirePermission("attendance:self"), async (req, res) => {
  res.status(201).json(await clockIn(req, parse(clockSchema, req.body)));
});

attendanceRouter.post("/clock-out", requirePermission("attendance:self"), async (req, res) => {
  res.json(await clockOut(req, parse(clockSchema, req.body)));
});

attendanceRouter.get("/me/status", async (req, res) => {
  const open = await prisma.staffAttendance.findFirst({
    where: { userId: req.user!.id, clockOutAt: null },
    include: { outlet: { select: { id: true, name: true } } },
  });
  const recent = await prisma.staffAttendance.findMany({
    where: { userId: req.user!.id },
    orderBy: { clockInAt: "desc" },
    take: 10,
  });
  res.json({ clockedIn: Boolean(open), current: open, recent });
});

/** Calendar for one staff member: one entry per day with present/half-day/leave/absent. */
attendanceRouter.get("/calendar", async (req, res) => {
  const month = parse(monthSchema, req.query.month);
  const userId = String(req.query.userId ?? req.user!.id);
  if (userId !== req.user!.id) {
    if (!userCan(req, "attendance:manage")) throw forbidden();
    // Managers see staff of their own outlets only (as everywhere else in attendance); owners the whole business.
    if (req.user!.role !== "BUSINESS_OWNER") {
      const inScope = await prisma.user.findFirst({ where: { id: userId, outlets: { some: { outletId: { in: req.user!.outletIds } } } }, select: { id: true } });
      if (!inScope) throw notFound("Staff member");
    }
  }
  const { from, to } = monthRange(month);
  const [records, leaves] = await Promise.all([
    prisma.staffAttendance.findMany({ where: { userId, workDate: { gte: from, lte: to } }, orderBy: { clockInAt: "asc" } }),
    prisma.leaveRequest.findMany({
      where: { userId, status: "APPROVED", fromDate: { lte: to }, toDate: { gte: from } },
    }),
  ]);
  const todayIso = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());
  const days = eachDay(from, to).map((date) => {
    const recs = records.filter((r) => r.workDate === date);
    const leave = leaves.find((l) => l.fromDate <= date && l.toDate >= date);
    const outcome = dayOutcome(recs, leave);
    const status = outcome.status !== "NONE" ? outcome.status : date > todayIso ? "UPCOMING" : "ABSENT";
    return {
      date,
      status,
      workedMinutes: recs.reduce((s, r) => s + (r.workedMinutes ?? 0), 0),
      lateByMinutes: recs[0]?.lateByMinutes ?? 0,
      overtimeMinutes: recs.reduce((s, r) => s + r.overtimeMinutes, 0),
      records: recs,
    };
  });
  res.json({ month, userId, days });
});

// ---------- Manager views ----------
const rangeQuery = z.object({ from: ymd, to: ymd, userId: z.string().optional() });

async function outletRecords(outletId: string, q: z.infer<typeof rangeQuery>) {
  const records = await prisma.staffAttendance.findMany({
    where: { outletId, workDate: { gte: q.from, lte: q.to }, ...(q.userId && { userId: q.userId }) },
    include: {
      user: {
        select: { id: true, name: true, role: true, phone: true, shift: { select: { name: true, startTime: true, endTime: true, graceMinutes: true } } },
      },
    },
    orderBy: [{ workDate: "desc" }, { clockInAt: "desc" }],
  });
  // Name of the manager / owner who added or edited each record
  const markers = await prisma.user.findMany({
    where: { id: { in: [...new Set(records.map((r) => r.markedById).filter((x): x is string => !!x))] } },
    select: { id: true, name: true },
  });
  return records.map((r) => ({ ...r, markedBy: markers.find((m) => m.id === r.markedById) ?? null }));
}

/** Absent / leave records have no real clock times. */
const hasTimes = (r: { status: string }) => r.status === "PRESENT" || r.status === "HALF_DAY";

attendanceRouter.get("/", requireOutlet, requirePermission("attendance:manage"), async (req, res) => {
  res.json(await outletRecords(req.outletId!, parse(rangeQuery, req.query)));
});

attendanceRouter.get("/export", requireOutlet, requirePermission("attendance:manage"), async (req, res) => {
  const q = parse(rangeQuery, req.query);
  const format = req.query.format === "csv" ? "csv" : "xlsx";
  const records = await outletRecords(req.outletId!, q);
  const fmtTime = (d: Date | null) =>
    d ? d.toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" }) : "";

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Attendance");
  ws.columns = [
    { header: "Date", key: "date", width: 12 },
    { header: "Name", key: "name", width: 22 },
    { header: "Role", key: "role", width: 16 },
    { header: "Clock in", key: "in", width: 10 },
    { header: "Clock out", key: "out", width: 10 },
    { header: "Worked (h)", key: "worked", width: 11 },
    { header: "Late (min)", key: "late", width: 10 },
    { header: "Early (min)", key: "early", width: 11 },
    { header: "Overtime (min)", key: "ot", width: 14 },
    { header: "Status", key: "status", width: 10 },
    { header: "Source", key: "source", width: 10 },
    { header: "Marked by", key: "markedBy", width: 18 },
    { header: "Note", key: "note", width: 28 },
    { header: "Distance (m)", key: "dist", width: 12 },
  ];
  ws.getRow(1).font = { bold: true };
  // Names and notes are typed by staff: formula-safe like every other export (QA Phase 8, sec1-3).
  for (const r of records) {
    ws.addRow({
      date: r.workDate,
      name: safeCellText(r.user.name),
      role: ROLE_LABELS[r.user.role],
      in: hasTimes(r) ? fmtTime(r.clockInAt) : "",
      out: hasTimes(r) ? fmtTime(r.clockOutAt) : "",
      worked: hasTimes(r) && r.workedMinutes != null ? +(r.workedMinutes / 60).toFixed(2) : "",
      late: r.lateByMinutes,
      early: r.earlyByMinutes,
      ot: r.overtimeMinutes,
      status: !hasTimes(r) || r.clockOutAt ? r.status : "OPEN",
      source: r.source === "MANUAL" ? "Manual" : r.markedById ? "Self (edited)" : "Self",
      markedBy: safeCellText(r.markedBy?.name ?? ""),
      note: safeCellText(r.note ?? ""),
      dist: r.clockInDistance >= 0 ? r.clockInDistance : "",
    });
  }
  const filename = `attendance_${q.from}_${q.to}.${format}`;
  res.setHeader("content-disposition", `attachment; filename="${filename}"`);
  if (format === "csv") {
    res.type("text/csv");
    await wb.csv.write(res);
  } else {
    res.type("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    await wb.xlsx.write(res);
  }
  res.end();
});

/**
 * Salary sheet for a month: payable days × daily rate. Approved casual/sick
 * leave is paid; unpaid leave and absence are not; half days count 0.5.
 */
attendanceRouter.get("/salary", requireOutlet, requirePermission("attendance:manage"), async (req, res) => {
  const month = parse(monthSchema, req.query.month);
  const { from, to, days } = monthRange(month);
  const staff = await prisma.user.findMany({
    where: { outlets: { some: { outletId: req.outletId } }, role: { not: "SUPER_ADMIN" } },
    include: {
      attendance: { where: { workDate: { gte: from, lte: to } } },
      leaves: { where: { status: "APPROVED", fromDate: { lte: to }, toDate: { gte: from } } },
    },
    orderBy: { name: "asc" },
  });
  const rows = staff.map((u) => {
    let payable = 0;
    let present = 0;
    let half = 0;
    let paidLeave = 0;
    for (const date of eachDay(from, to)) {
      const recs = u.attendance.filter((a) => a.workDate === date);
      const leave = u.leaves.find((l) => l.fromDate <= date && l.toDate >= date);
      const o = dayOutcome(recs, leave);
      if (o.status === "PRESENT") present++;
      else if (o.status === "HALF_DAY") half++;
      else if (o.paidLeave) paidLeave++;
      payable += o.units;
    }
    const dailyRate = u.salaryType === "DAILY" ? u.salaryAmount : Math.round(u.salaryAmount / days);
    return {
      userId: u.id,
      name: u.name,
      role: u.role,
      salaryType: u.salaryType,
      salaryAmount: u.salaryAmount,
      presentDays: present,
      halfDays: half,
      paidLeaveDays: paidLeave,
      payableDays: payable,
      overtimeMinutes: u.attendance.reduce((s, a) => s + a.overtimeMinutes, 0),
      dailyRate,
      grossPay: Math.round(dailyRate * payable),
    };
  });
  res.json({ month, daysInMonth: days, rows });
});

// ---------- Leave ----------
attendanceRouter.post("/leaves", requirePermission("attendance:self"), async (req, res) => {
  const data = parse(leaveRequestSchema, req.body);
  assertRealDates(data.fromDate, data.toDate);
  const leave = await prisma.leaveRequest.create({ data: { ...data, userId: req.user!.id } });
  const managers = new Set<string>();
  for (const outletId of req.user!.outletIds) (await outletManagers(outletId)).forEach((m) => managers.add(m));
  managers.delete(req.user!.id);
  await notify([...managers], "Leave request", `${req.user!.name} requested ${data.type.toLowerCase()} leave ${data.fromDate} → ${data.toDate}`, "leave.request");
  res.status(201).json(leave);
});

attendanceRouter.get("/leaves", async (req, res) => {
  const manage = userCan(req, "attendance:manage") && req.query.scope === "outlet";
  if (manage) {
    const outletIds = req.user!.role === "SUPER_ADMIN" && req.header("x-outlet-id") ? [req.header("x-outlet-id")!] : req.user!.outletIds;
    return res.json(
      await prisma.leaveRequest.findMany({
        // Owners also see other owners' leave (owners aren't assigned to outlets, so a manager never would).
        where: req.user!.role === "BUSINESS_OWNER" ? { user: { businessId: req.user!.businessId } } : { user: { outlets: { some: { outletId: { in: outletIds } } } } },
        include: { user: { select: { id: true, name: true, role: true } } },
        orderBy: { createdAt: "desc" },
        take: 200,
      }),
    );
  }
  res.json(await prisma.leaveRequest.findMany({ where: { userId: req.user!.id }, orderBy: { createdAt: "desc" } }));
});

attendanceRouter.patch("/leaves/:id", requirePermission("attendance:manage"), async (req, res) => {
  const { status } = parse(z.object({ status: z.enum(["APPROVED", "REJECTED"]) }), req.body);
  // Managers may review leave for staff in any of their outlets (matches the ?scope=outlet listing).
  // Owners review anyone in the business, including another owner; managers only staff of their outlets.
  const scope =
    req.user!.role === "SUPER_ADMIN"
      ? {}
      : req.user!.role === "BUSINESS_OWNER"
        ? { user: { businessId: req.user!.businessId } }
        : { user: { outlets: { some: { outletId: { in: req.user!.outletIds } } } } };
  const leave = await prisma.leaveRequest.findFirst({ where: { id: param(req, "id"), ...scope } });
  if (!leave) throw notFound("Leave request");
  if (leave.userId === req.user!.id) throw forbidden("You cannot approve your own leave");
  if (leave.status !== "PENDING") throw badRequest("Leave request already reviewed");
  const updated = await prisma.leaveRequest.update({
    where: { id: leave.id },
    data: { status, reviewerId: req.user!.id, reviewedAt: new Date() },
  });
  await audit(req, `leave.${status.toLowerCase()}`, "LeaveRequest", leave.id);
  await notify([leave.userId], `Leave ${status.toLowerCase()}`, `Your leave ${leave.fromDate} → ${leave.toDate} was ${status.toLowerCase()}`, "leave.review");
  res.json(updated);
});

// =====================================================================
// Manual attendance — managers / owners mark attendance for their staff
// =====================================================================

const staffSelect = {
  id: true,
  name: true,
  phone: true,
  role: true,
  status: true,
  shift: { select: { name: true, startTime: true, endTime: true, graceMinutes: true } },
} as const;

/**
 * Daily register for the current outlet: every employee assigned to it, their
 * attendance records for the date, approved leave, and whether the current
 * user may mark them.
 */
attendanceRouter.get("/register", requireOutlet, requirePermission("attendance:manage"), async (req, res) => {
  const outlet = await prisma.outlet.findUniqueOrThrow({ where: { id: req.outletId }, select: { id: true, timezone: true } });
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: outlet.timezone }).format(new Date());
  const date = parse(ymd.default(today), req.query.date);
  const staff = await prisma.user.findMany({
    where: { outlets: { some: { outletId: outlet.id } }, role: { not: "SUPER_ADMIN" } },
    select: {
      ...staffSelect,
      attendance: { where: { workDate: date }, orderBy: { clockInAt: "asc" } },
      leaves: { where: { status: "APPROVED", fromDate: { lte: date }, toDate: { gte: date } }, select: { type: true, reason: true } },
    },
    orderBy: [{ role: "asc" }, { name: "asc" }],
  });
  const markers = await prisma.user.findMany({
    where: { id: { in: [...new Set(staff.flatMap((s) => s.attendance.map((a) => a.markedById).filter((x): x is string => !!x)))] } },
    select: { id: true, name: true },
  });
  res.json({
    date,
    timezone: outlet.timezone,
    staff: staff.map((s) => {
      const o = dayOutcome(s.attendance, s.leaves[0]);
      return {
        user: { id: s.id, name: s.name, phone: s.phone, role: s.role, status: s.status, shift: s.shift },
        canMark: canManageAttendanceOf(req.user!, s),
        status: o.status === "NONE" ? null : o.status,
        leave: s.leaves[0] ?? null,
        records: s.attendance.map((a) => ({ ...a, markedBy: markers.find((m) => m.id === a.markedById) ?? null })),
      };
    }),
  });
});

async function loadTarget(req: Express.Request, userId: string) {
  const user = await prisma.user.findFirst({
    where: { id: userId, outlets: { some: { outletId: req.outletId! } } },
    select: { id: true, name: true, role: true, shift: { select: { startTime: true, endTime: true, graceMinutes: true } } },
  });
  if (!user) throw notFound("Employee in this outlet");
  return user;
}

/** Add / correct attendance for one employee on one day. */
attendanceRouter.post("/manual", requireOutlet, requirePermission("attendance:manage"), async (req, res) => {
  const data = parse(attendanceManualSchema, req.body);
  assertRealDates(data.date);
  const outlet = await prisma.outlet.findUniqueOrThrow({ where: { id: req.outletId }, select: { id: true, timezone: true } });
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: outlet.timezone }).format(new Date());
  if (data.date > today) throw badRequest("Attendance can't be marked for a future date");
  const user = await loadTarget(req, data.userId);
  res.status(201).json(await upsertManualAttendance(req, outlet, user, data.date, data));
});

/** Mark the whole register for a date (e.g. "everyone present 9:00–18:00"). */
attendanceRouter.post("/register", requireOutlet, requirePermission("attendance:manage"), async (req, res) => {
  const { date, entries } = parse(attendanceRegisterSchema, req.body);
  assertRealDates(date);
  const outlet = await prisma.outlet.findUniqueOrThrow({ where: { id: req.outletId }, select: { id: true, timezone: true } });
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: outlet.timezone }).format(new Date());
  if (date > today) throw badRequest("Attendance can't be marked for a future date");
  const saved = [];
  const skipped: { userId: string; reason: string }[] = [];
  for (const e of entries) {
    try {
      const user = await loadTarget(req, e.userId);
      saved.push(await upsertManualAttendance(req, outlet, user, date, e));
    } catch (err) {
      skipped.push({ userId: e.userId, reason: err instanceof Error ? err.message : "Failed" });
    }
  }
  res.json({ date, saved: saved.length, skipped });
});

async function loadRecord(req: Express.Request, id: string) {
  const rec = await prisma.staffAttendance.findFirst({
    where: { id, outletId: req.outletId! },
    include: { user: { select: { id: true, name: true, role: true, shift: { select: { startTime: true, endTime: true, graceMinutes: true } } } } },
  });
  if (!rec) throw notFound("Attendance record");
  if (!canManageAttendanceOf(req.user!, rec.user)) throw forbidden(`You can't change attendance for ${rec.user.name}`);
  return rec;
}

/** Edit a record — status, in/out times (HH:MM, outlet time) or note. */
attendanceRouter.patch("/:id", requireOutlet, requirePermission("attendance:manage"), async (req, res) => {
  const data = parse(attendanceUpdateSchema, req.body);
  const rec = await loadRecord(req, param(req, "id"));
  const outlet = await prisma.outlet.findUniqueOrThrow({ where: { id: rec.outletId }, select: { timezone: true } });
  const hhmm = (d: Date | null) => {
    if (!d) return null;
    const p = new Intl.DateTimeFormat("en-GB", { timeZone: outlet.timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d);
    return p;
  };
  const status = data.status ?? rec.status;
  const entry = {
    status,
    clockIn: data.clockIn ?? hhmm(rec.clockInAt) ?? undefined,
    clockOut: data.clockOut === undefined ? hhmm(rec.clockOutAt) : data.clockOut,
  };
  if ((status === "PRESENT" || status === "HALF_DAY") && !entry.clockIn) throw badRequest("Enter the clock-in time");
  // A record that was absent/leave had no real times: require a fresh clock-in when switching to present.
  if ((rec.status === "ABSENT" || rec.status === "LEAVE") && (status === "PRESENT" || status === "HALF_DAY") && !data.clockIn) {
    throw badRequest("Enter the clock-in time");
  }
  const fields = manualRecordFields(rec.workDate, outlet.timezone, rec.user.shift, { ...entry, clockOut: entry.clockOut ?? undefined });
  const updated = await prisma.staffAttendance.update({
    where: { id: rec.id },
    data: { ...fields, status, ...(data.note !== undefined && { note: data.note }), markedById: req.user!.id, editedAt: new Date() },
  });
  void alertAttendanceMarked(rec.userId, rec.workDate, status, req.user!.name, rec.outletId);
  await audit(req, "attendance.manual_edit", "StaffAttendance", rec.id, {
    userId: rec.userId,
    before: { status: rec.status, clockInAt: rec.clockInAt, clockOutAt: rec.clockOutAt },
    after: { status, clockIn: entry.clockIn, clockOut: entry.clockOut },
  });
  res.json(updated);
});

attendanceRouter.delete("/:id", requireOutlet, requirePermission("attendance:manage"), async (req, res) => {
  const rec = await loadRecord(req, param(req, "id"));
  await prisma.staffAttendance.delete({ where: { id: rec.id } });
  await audit(req, "attendance.delete", "StaffAttendance", rec.id, { userId: rec.userId, date: rec.workDate, status: rec.status, source: rec.source });
  res.status(204).end();
});
