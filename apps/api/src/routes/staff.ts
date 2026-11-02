import { Router } from "express";
import bcrypt from "bcryptjs";
import { ROLE_LABELS, staffCreateSchema, staffUpdateSchema, type Role } from "@canavo/shared";
import { prisma } from "../db";
import { audit } from "../lib/audit";
import { badRequest, forbidden, notFound, param, parse } from "../lib/http";
import { forceLogout } from "../lib/tokens";
import { authenticate, requireOutlet, requirePermission } from "../middleware/auth";
import { startOfLocalDay, addDays } from "../lib/time";

export const staffRouter = Router();
staffRouter.use(authenticate, requireOutlet);

const publicFields = {
  id: true,
  name: true,
  phone: true,
  email: true,
  role: true,
  status: true,
  photoUrl: true,
  salaryType: true,
  salaryAmount: true,
  shiftId: true,
  createdAt: true,
  outlets: { select: { outletId: true } },
} as const;

/**
 * Lower rank = more authority. Staff can only create/edit roles strictly below
 * their own: owners add managers and staff, managers add staff (not managers or
 * owners). Owner accounts come only from the platform super admin.
 */
const RANK: Record<Role, number> = {
  SUPER_ADMIN: 0,
  BUSINESS_OWNER: 1,
  OUTLET_MANAGER: 2,
  CASHIER: 3,
  KITCHEN: 3,
  DELIVERY: 3,
  INVENTORY_MANAGER: 3,
};
const isBusinessWide = (r: Role) => r === "SUPER_ADMIN" || r === "BUSINESS_OWNER";

function assertCanAssign(req: Express.Request, role?: Role, outletIds?: string[]) {
  const me = req.user!.role;
  // Platform super admins are created from the platform screens, never inside a business.
  if (role === "SUPER_ADMIN") throw forbidden("Super admins are managed from the platform console");
  if (role) {
    if (role === "BUSINESS_OWNER" && me !== "SUPER_ADMIN") throw forbidden("Owner accounts are created by the CANAVO platform admin");
    if (!(RANK[role] > RANK[me])) throw forbidden(`An ${ROLE_LABELS[me]} can't create or change ${ROLE_LABELS[role]} accounts`);
  }
  if (me !== "SUPER_ADMIN" && outletIds?.some((id) => !req.user!.outletIds.includes(id))) {
    throw forbidden("You can only assign staff to your own outlets");
  }
}

/** Owners and super admins see everyone in the business; managers only staff of the current outlet. */
async function loadStaff(req: Express.Request, id: string) {
  const where = isBusinessWide(req.user!.role) ? { id } : { id, outlets: { some: { outletId: req.outletId! } } };
  const user = await prisma.user.findFirst({ where, select: publicFields });
  if (!user) throw notFound("Staff member");
  return user;
}

staffRouter.get("/", requirePermission("staff:view"), async (req, res) => {
  res.json(
    await prisma.user.findMany({
      // ?scope=business (owners / super admins): every account of the business, incl. owners
      where:
        req.query.scope === "business" && isBusinessWide(req.user!.role)
          ? {}
          : { outlets: { some: { outletId: req.outletId } } },
      select: publicFields,
      orderBy: { name: "asc" },
    }),
  );
});

staffRouter.post("/", requirePermission("staff:manage"), async (req, res) => {
  const data = parse(staffCreateSchema, req.body);
  assertCanAssign(req, data.role, data.outletIds);
  await assertOwnShift(req, data.shiftId);
  const user = await prisma.user.create({
    data: {
      name: data.name,
      phone: data.phone,
      email: data.email?.toLowerCase(),
      role: data.role,
      salaryType: data.salaryType,
      salaryAmount: data.salaryAmount,
      shiftId: data.shiftId,
      passwordHash: data.password ? await bcrypt.hash(data.password, 10) : null,
      pinHash: data.pin ? await bcrypt.hash(data.pin, 10) : null,
      outlets: { create: data.outletIds.map((outletId) => ({ outletId })) },
    },
    select: publicFields,
  });
  await audit(req, "staff.create", "User", user.id, { role: user.role });
  res.status(201).json(user);
});

/** BUG-009: a shift must belong to one of the caller's outlets (Shift is not tenant-scoped). */
async function assertOwnShift(req: Express.Request, shiftId: string | undefined) {
  if (!shiftId) return;
  const shift = await prisma.shift.findFirst({ where: { id: shiftId, outletId: { in: req.user!.outletIds } }, select: { id: true } });
  if (!shift) throw badRequest("Unknown shift");
}

staffRouter.patch("/:id", requirePermission("staff:manage"), async (req, res) => {
  const id = param(req, "id");
  const data = parse(staffUpdateSchema, req.body);
  await assertOwnShift(req, data.shiftId);
  const existing = await loadStaff(req, id);
  // You can only edit people below you (and yourself for name/PIN/password).
  if (id !== req.user!.id) assertCanAssign(req, existing.role);
  assertCanAssign(req, data.role, data.outletIds);
  if (id === req.user!.id && (data.role || data.status || data.outletIds)) throw forbidden("You cannot change your own role, status or outlets");

  const user = await prisma.user.update({
    where: { id },
    data: {
      name: data.name,
      phone: data.phone,
      email: data.email?.toLowerCase(),
      role: data.role,
      status: data.status,
      salaryType: data.salaryType,
      salaryAmount: data.salaryAmount,
      shiftId: data.shiftId,
      ...(data.password && { passwordHash: await bcrypt.hash(data.password, 10) }),
      ...(data.pin && { pinHash: await bcrypt.hash(data.pin, 10) }),
      ...(data.outletIds && {
        // BUG-012: replace only the assignments the editor controls; owners control every outlet.
        outlets: {
          // (assertCanAssign above guarantees every new outletId is one the editor manages)
          deleteMany: req.user!.role === "BUSINESS_OWNER" ? {} : { outletId: { in: req.user!.outletIds } },
          create: data.outletIds.map((outletId) => ({ outletId })),
        },
      }),
    },
    select: publicFields,
  });

  const roleChanged = data.role && data.role !== existing.role;
  const deactivated = data.status && data.status !== "ACTIVE";
  if (roleChanged || deactivated) await forceLogout(id);
  await audit(req, "staff.update", "User", id, { fields: Object.keys(data), forcedLogout: Boolean(roleChanged || deactivated) });
  res.json(user);
});

/** Staff performance: bills raised, sales value, items sold and attendance over the last N days. */
staffRouter.get("/:id/performance", requirePermission("staff:view"), async (req, res) => {
  const id = param(req, "id");
  await loadStaff(req, id);
  const days = Math.min(Number(req.query.days ?? 30), 365);
  const outlet = await prisma.outlet.findUniqueOrThrow({ where: { id: req.outletId } });
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: outlet.timezone }).format(new Date());
  const fromDate = addDays(today, -(days - 1));
  const since = startOfLocalDay(fromDate, outlet.timezone);

  const [bills, items, attendance] = await Promise.all([
    prisma.order.aggregate({
      where: { cashierId: id, outletId: req.outletId, status: "PAID", createdAt: { gte: since } },
      _count: true,
      _sum: { grandTotal: true },
    }),
    prisma.orderItem.aggregate({
      where: { order: { cashierId: id, outletId: req.outletId, status: "PAID", createdAt: { gte: since } } },
      _sum: { quantity: true },
    }),
    prisma.staffAttendance.findMany({
      where: { userId: id, workDate: { gte: fromDate } },
      select: { workDate: true, status: true, workedMinutes: true, overtimeMinutes: true, lateByMinutes: true },
    }),
  ]);
  const presentDays = new Set(attendance.filter((a) => a.status === "PRESENT" || a.status === "HALF_DAY").map((a) => a.workDate)).size;
  res.json({
    days,
    billsRaised: bills._count,
    salesValue: bills._sum.grandTotal ?? 0,
    itemsSold: items._sum.quantity ?? 0,
    presentDays,
    attendancePercent: Math.round((presentDays / days) * 100),
    lateDays: attendance.filter((a) => a.lateByMinutes > 0).length,
    overtimeMinutes: attendance.reduce((s, a) => s + a.overtimeMinutes, 0),
  });
});
