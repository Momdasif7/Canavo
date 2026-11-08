import { Router } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { customRoleSchema, customRoleUpdateSchema, PERMISSION_LABELS, ROLE_LABELS, ROLE_PERMISSIONS, staffCreateSchema, staffUpdateSchema, type Permission, type Role } from "@canavo/shared";
import { prisma } from "../db";
import { audit } from "../lib/audit";
import { badRequest, conflict, forbidden, notFound, param, parse } from "../lib/http";
import { forceLogout } from "../lib/tokens";
import { disableTwoFactor } from "../services/two-factor";
import { sendPasswordLink } from "../services/password-links";
import { authenticate, requireAnyPermission, requireOutlet, requirePermission } from "../middleware/auth";
import { startOfLocalDay, addDays } from "../lib/time";
import { revalidateSockets } from "../realtime";

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
  totpEnabledAt: true,
  customRoleId: true,
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
  WAITER: 3,
  // Business-wide outsiders (CA, auditor): the owner adds them, not managers.
  ACCOUNTANT: 2,
  AUDITOR: 2,
  PLATFORM_SUPPORT: 0,
};
const isBusinessWide = (r: Role) => r === "SUPER_ADMIN" || r === "BUSINESS_OWNER";

function assertCanAssign(req: Express.Request, role?: Role, outletIds?: string[]) {
  const me = req.user!.role;
  // Platform super admins are created from the platform screens, never inside a business.
  if (role === "SUPER_ADMIN" || role === "PLATFORM_SUPPORT") throw forbidden("Platform accounts are managed from the platform console");
  if (role) {
    if (role === "BUSINESS_OWNER" && me !== "SUPER_ADMIN") throw forbidden("Owner accounts are created by the CANAVO platform admin");
    if (!(RANK[role] > RANK[me])) throw forbidden(`An ${ROLE_LABELS[me]} can't create or change ${ROLE_LABELS[role]} accounts`);
  }
  if (me !== "SUPER_ADMIN" && outletIds?.some((id) => !req.user!.outletIds.includes(id))) {
    throw forbidden("You can only assign staff to your own outlets");
  }
}

/** A shift given to a staff member must be one of their outlets' shifts (the FK alone would accept any hotel's). */
async function assertShift(shiftId: string | undefined, outletIds: string[]) {
  if (!shiftId) return;
  const shift = await prisma.shift.findUnique({ where: { id: shiftId }, select: { outletId: true } });
  if (!shift || (outletIds.length && !outletIds.includes(shift.outletId))) throw badRequest("Shift not found in this staff member's outlets");
}

/** A custom role given to a staff member must be this business's and based on their role. */
async function assertCustomRole(customRoleId: string | null | undefined, role: Role) {
  if (!customRoleId) return;
  const cr = await prisma.customRole.findUnique({ where: { id: customRoleId }, select: { baseRole: true } });
  if (!cr) throw badRequest("Custom role not found");
  if (cr.baseRole !== role) throw badRequest(`That custom role is based on ${ROLE_LABELS[cr.baseRole]}, not ${ROLE_LABELS[role]}`);
}

/** A custom role can only remove permissions from its base role, never add them. */
function assertSubset(baseRole: Role, permissions: Permission[]) {
  const extra = permissions.filter((p) => !ROLE_PERMISSIONS[baseRole].includes(p));
  if (extra.length) {
    throw badRequest(`A custom role can only remove permissions from ${ROLE_LABELS[baseRole]}. Not part of it: ${extra.map((p) => PERMISSION_LABELS[p]).join(", ")}`);
  }
}

// =====================================================================
// Custom roles (Phase 4.2): owners name a subset of a built-in role
// =====================================================================

/** Managers see the list too, so they can pick a custom role when adding staff. */
staffRouter.get("/roles", requireAnyPermission("staff:manage", "outlet:manage"), async (_req, res) => {
  const roles = await prisma.customRole.findMany({ orderBy: { name: "asc" }, include: { _count: { select: { users: true } } } });
  res.json(roles.map(({ _count, ...r }) => ({ ...r, staffCount: _count.users })));
});

staffRouter.post("/roles", requirePermission("outlet:manage"), async (req, res) => {
  const data = parse(customRoleSchema, req.body);
  assertSubset(data.baseRole, data.permissions);
  const role = await prisma.customRole.create({ data: { ...data, permissions: [...new Set(data.permissions)], businessId: req.businessId! } });
  await audit(req, "staff.role.create", "CustomRole", role.id, { name: role.name, baseRole: role.baseRole, permissions: role.permissions });
  res.status(201).json(role);
});

staffRouter.patch("/roles/:id", requirePermission("outlet:manage"), async (req, res) => {
  const id = param(req, "id");
  const data = parse(customRoleUpdateSchema, req.body);
  const existing = await prisma.customRole.findUnique({ where: { id }, include: { _count: { select: { users: true } } } });
  if (!existing) throw notFound("Custom role");
  const baseRole = data.baseRole ?? existing.baseRole;
  if (baseRole !== existing.baseRole && existing._count.users) throw conflict("Staff use this role. Move them to another role before changing its base role.");
  const permissions = data.permissions ? [...new Set(data.permissions)] : data.baseRole ? existing.permissions.filter((p) => ROLE_PERMISSIONS[baseRole].includes(p as Permission)) : undefined;
  if (data.permissions) assertSubset(baseRole, data.permissions);
  const role = await prisma.customRole.update({ where: { id }, data: { name: data.name, baseRole: data.baseRole, permissions } });
  await audit(req, "staff.role.update", "CustomRole", id, { fields: Object.keys(data), permissions: role.permissions });
  res.json(role);
});

/** Deleting a role in use would quietly give its staff the full base role: refuse instead. */
staffRouter.delete("/roles/:id", requirePermission("outlet:manage"), async (req, res) => {
  const id = param(req, "id");
  const existing = await prisma.customRole.findUnique({ where: { id }, include: { _count: { select: { users: true } } } });
  if (!existing) throw notFound("Custom role");
  if (existing._count.users) throw conflict(`${existing._count.users} staff member(s) use this role. Move them to another role first.`);
  await prisma.customRole.delete({ where: { id } });
  await audit(req, "staff.role.delete", "CustomRole", id, { name: existing.name });
  res.status(204).end();
});

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
  await assertCustomRole(data.customRoleId, data.role);
  await assertShift(data.shiftId, data.outletIds);
  const user = await prisma.user.create({
    data: {
      customRoleId: data.customRoleId ?? null,
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

staffRouter.patch("/:id", requirePermission("staff:manage"), async (req, res) => {
  const id = param(req, "id");
  const data = parse(staffUpdateSchema, req.body);
  const existing = await loadStaff(req, id);
  // You can only edit people below you (and yourself for name/PIN/password).
  if (id !== req.user!.id) assertCanAssign(req, existing.role);
  assertCanAssign(req, data.role, data.outletIds);
  if (id === req.user!.id && (data.role || data.status || data.outletIds || data.customRoleId !== undefined)) throw forbidden("You cannot change your own role, status or outlets");
  // Your own password needs the current one (POST /auth/password/change): a stolen session must not
  // be able to lock the owner of the account out (QA Phase 8, sec1-5).
  if (id === req.user!.id && data.password) throw badRequest("Change your own password under Account → Security (it asks for the current one)");
  // A role change drops a custom role based on the old role unless a matching one is given.
  const nextRole = data.role ?? existing.role;
  let customRoleId = data.customRoleId;
  if (customRoleId === undefined && data.role && data.role !== existing.role && existing.customRoleId) customRoleId = null;
  await assertCustomRole(customRoleId, nextRole);
  // A manager's outlet list only covers their own outlets: assignments elsewhere (outlets they don't run) stay.
  const outletIds = data.outletIds && [
    ...new Set([...data.outletIds, ...(isBusinessWide(req.user!.role) ? [] : existing.outlets.map((o) => o.outletId).filter((o) => !req.user!.outletIds.includes(o)))]),
  ];
  await assertShift(data.shiftId, outletIds ?? existing.outlets.map((o) => o.outletId));

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
      customRoleId,
      ...(data.password && { passwordHash: await bcrypt.hash(data.password, 10) }),
      ...(data.pin && { pinHash: await bcrypt.hash(data.pin, 10) }),
      ...(outletIds && {
        outlets: { deleteMany: {}, create: outletIds.map((outletId) => ({ outletId })) },
      }),
    },
    select: publicFields,
  });

  const roleChanged = data.role && data.role !== existing.role;
  const deactivated = data.status && data.status !== "ACTIVE";
  // A new password set by a manager (lost / leaked password) ends every session that used the old one.
  const passwordReset = Boolean(data.password);
  const forcedLogout = Boolean(roleChanged || deactivated || passwordReset);
  if (forcedLogout) await forceLogout(id);
  // Moved to other outlets: live sockets leave the outlet rooms they lost (rt-3).
  else if (outletIds) await revalidateSockets(id);
  await audit(req, "staff.update", "User", id, { fields: Object.keys(data), forcedLogout });
  res.json(user);
});

/** Someone below you lost their phone: turn off their two-step login and sign them out (Phase 2.1). */
staffRouter.post("/:id/reset-2fa", requirePermission("staff:manage"), async (req, res) => {
  const id = param(req, "id");
  if (id === req.user!.id) throw forbidden("Turn off your own two-step login under Account → Security");
  const existing = await loadStaff(req, id);
  assertCanAssign(req, existing.role);
  await disableTwoFactor(id);
  await forceLogout(id);
  await audit(req, "staff.reset_2fa", "User", id);
  res.json({ ok: true });
});

/** Send someone below you a one-time link to set a new password (you never see it). */
staffRouter.post("/:id/reset-link", requirePermission("staff:manage"), async (req, res) => {
  const id = param(req, "id");
  const existing = await loadStaff(req, id);
  if (id !== req.user!.id) assertCanAssign(req, existing.role);
  if (existing.status !== "ACTIVE") throw forbidden("This account is not active");
  const delivery = await sendPasswordLink({ id, name: existing.name, email: existing.email, phone: existing.phone }, "RESET", req.user!.id);
  await audit(req, "staff.reset_link", "User", id, { channel: delivery.channel });
  res.json(delivery);
});

/** Staff performance: bills raised, sales value, items sold and attendance over the last N days. */
staffRouter.get("/:id/performance", requirePermission("staff:view"), async (req, res) => {
  const id = param(req, "id");
  await loadStaff(req, id);
  const { days } = parse(z.object({ days: z.coerce.number().int().min(1).max(365).default(30) }), req.query);
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
