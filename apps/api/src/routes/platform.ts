import { Router } from "express";
import { superAdminIpWhitelist } from "../middleware/ip-whitelist";
import { bcrypt } from "../lib/bcrypt-pool";
import {
  businessArchiveSchema,
  businessCreateSchema,
  FEATURES,
  normalizeFeatures,
  businessUpdateSchema,
  MODULE_INFO,
  normalizeModules,
  platformAdminCreateSchema,
  platformUserCreateSchema,
} from "@canavo/shared";
import { platformPrisma as db } from "../db";
import { audit } from "../lib/audit";
import { badRequest, conflict, notFound, param, parse } from "../lib/http";
import { forceLogout } from "../lib/tokens";
import { authenticate, requirePlatformUser } from "../middleware/auth";
import { createDefaultTaxRates } from "../services/tax-defaults";
import { alertModulesChanged } from "../services/alerts";
import { onFeaturesChanged } from "../services/features";
import { sendPasswordLink } from "../services/password-links";
import { disableTwoFactor } from "../services/two-factor";

/**
 * Platform console (CANAVO operator / super admin): onboard client businesses,
 * choose their modules, suspend them, and create / reset their owner accounts.
 * Privacy: only account information leaves these routes — never a hotel's
 * sales, bills, staff, customers or reports. Owners create their own staff.
 * Uses the unfiltered client and always names the business explicitly.
 * Platform support users (Phase 4.2) may read every route here; writes are super admin only.
 */
export const platformRouter = Router();
platformRouter.use(authenticate, requirePlatformUser, superAdminIpWhitelist);

const userFields = {
  id: true,
  name: true,
  phone: true,
  email: true,
  role: true,
  status: true,
  createdAt: true,
  outlets: { select: { outletId: true } },
} as const;

async function assertLoginFree(phone: string, email?: string) {
  const clash = await db.user.findFirst({ where: { OR: [{ phone }, ...(email ? [{ email }] : [])] }, select: { phone: true } });
  if (clash) throw conflict(clash.phone === phone ? `Phone ${phone} is already registered` : `Email ${email} is already registered`);
}

platformRouter.get("/summary", async (_req, res) => {
  const [businesses, active, outlets, owners] = await Promise.all([
    db.business.count(),
    db.business.count({ where: { status: "ACTIVE" } }),
    db.outlet.count(),
    db.user.count({ where: { role: "BUSINESS_OWNER" } }),
  ]);
  res.json({ businesses, activeBusinesses: active, suspendedBusinesses: businesses - active, outlets, owners });
});

/** Account information only — hotel data (staff, bills, sales…) stays private to the hotel. */
const ownerFields = { id: true, name: true, phone: true, email: true, status: true, createdAt: true, totpEnabledAt: true } as const;

platformRouter.get("/businesses", async (req, res) => {
  const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
  const list = await db.business.findMany({
    where: search ? { OR: [{ name: { contains: search, mode: "insensitive" } }, { phone: { contains: search } }] } : {},
    include: {
      _count: { select: { outlets: true } },
      users: { where: { role: "BUSINESS_OWNER" }, select: { id: true, name: true, phone: true, email: true }, take: 3 },
    },
    orderBy: { createdAt: "desc" },
  });
  res.json(list.map((b) => ({ ...b, modules: normalizeModules(b.modules), owners: b.users, users: undefined })));
});

platformRouter.post("/businesses", async (req, res) => {
  const data = parse(businessCreateSchema, req.body);
  await assertLoginFree(data.owner.phone, data.owner.email);
  const result = await db.$transaction(async (tx) => {
    const business = await tx.business.create({
      data: {
        name: data.name,
        legalName: data.legalName,
        phone: data.phone,
        email: data.email,
        notes: data.notes,
        ownerName: data.owner.name,
        modules: normalizeModules(data.modules),
      },
    });
    await createDefaultTaxRates(tx, business.id);
    const outlet = data.outlet
      ? await tx.outlet.create({
          data: {
            businessId: business.id,
            name: data.outlet.name,
            address: data.outlet.address,
            stateCode: data.outlet.stateCode,
            gstEnabled: data.outlet.gstEnabled,
          },
        })
      : null;
    const owner = await tx.user.create({
      data: {
        businessId: business.id,
        role: "BUSINESS_OWNER",
        name: data.owner.name,
        phone: data.owner.phone,
        email: data.owner.email,
      },
      select: userFields,
    });
    return { business, outlet, owner };
  });
  // The owner sets their own password from a link (the platform never knows it). Phone OTP login works meanwhile.
  const invite = await sendPasswordLink(result.owner, "INVITE", req.user!.id);
  await audit(req, "platform.business.create", "Business", result.business.id, { modules: result.business.modules, invite: invite.channel });
  res.status(201).json({ ...result, invite });
});

platformRouter.get("/businesses/:id", async (req, res) => {
  const business = await db.business.findUnique({
    where: { id: param(req, "id") },
    include: {
      outlets: { select: { id: true, name: true, address: true, createdAt: true }, orderBy: { name: "asc" } },
      users: { where: { role: "BUSINESS_OWNER" }, select: ownerFields, orderBy: { name: "asc" } },
    },
  });
  if (!business) throw notFound("Business");
  const { users, ...rest } = business;
  res.json({ ...rest, modules: normalizeModules(business.modules), features: normalizeFeatures(business.features), featureCatalog: FEATURES, owners: users });
});

platformRouter.patch("/businesses/:id", async (req, res) => {
  const id = param(req, "id");
  const data = parse(businessUpdateSchema, req.body);
  const before = await db.business.findUnique({ where: { id } });
  if (!before) throw notFound("Business");
  if (before.status === "ARCHIVED") throw conflict("This business is archived. Restore it before changing it.");
  const { features: featureChanges, ...rest } = data;
  const features = featureChanges ? { ...normalizeFeatures(before.features), ...featureChanges } : undefined;
  const business = await db.business.update({
    where: { id },
    data: { ...rest, ...(data.modules && { modules: normalizeModules(data.modules) }), ...(features && { features }) },
  });
  if (featureChanges) await onFeaturesChanged(id, normalizeFeatures(before.features), features!);
  if (data.modules) {
    void alertModulesChanged(id, normalizeModules(data.modules).map((m) => MODULE_INFO[m].label));
  }
  // Suspending signs everyone in the business out immediately.
  if (data.status === "SUSPENDED" && before.status !== "SUSPENDED") {
    const users = await db.user.findMany({ where: { businessId: id }, select: { id: true } });
    for (const u of users) await forceLogout(u.id);
  }
  await audit(req, "platform.business.update", "Business", id, { fields: Object.keys(data), modules: business.modules, status: business.status, ...(featureChanges && { features: featureChanges }) });
  res.json({ ...business, modules: normalizeModules(business.modules), features: normalizeFeatures(business.features) });
});

/**
 * QA 16b (gap 8): earliest date an archived business's data may be deleted. The later of
 *  - GST (CGST Act s.36 + Rule 56): 72 months from the due date of the annual return (GSTR-9, 31 Dec after the FY), and
 *  - Income tax (Rule 6F): 6 years from the end of the assessment year (FY + 1),
 * for the financial year the business was archived in: 1 April of (FY-end year + 7), IST.
 */
export function businessRetentionEnd(archivedAt: Date): Date {
  const ist = new Date(archivedAt.getTime() + 5.5 * 3_600_000);
  const fyEndYear = ist.getUTCMonth() >= 3 ? ist.getUTCFullYear() + 1 : ist.getUTCFullYear();
  return new Date(Date.UTC(fyEndYear + 7, 3, 1) - 5.5 * 3_600_000);
}

/** Archive a business: it becomes read-only and everyone in it is signed out (data kept until deleteAfter). */
platformRouter.post("/businesses/:id/archive", async (req, res) => {
  const id = param(req, "id");
  const data = parse(businessArchiveSchema, req.body);
  const before = await db.business.findUnique({ where: { id }, select: { name: true, status: true } });
  if (!before) throw notFound("Business");
  if (before.status === "ARCHIVED") throw conflict("This business is already archived");
  if (data.confirmName.toLowerCase() !== before.name.trim().toLowerCase()) throw badRequest("Type the business name exactly to confirm");
  const archivedAt = new Date();
  const business = await db.business.update({
    where: { id },
    data: { status: "ARCHIVED", archivedAt, archiveReason: data.reason, deleteAfter: businessRetentionEnd(archivedAt) },
    select: { id: true, name: true, status: true, archivedAt: true, archiveReason: true, deleteAfter: true },
  });
  const users = await db.user.findMany({ where: { businessId: id }, select: { id: true } });
  for (const u of users) await forceLogout(u.id);
  await audit(req, "platform.business.archive", "Business", id, { reason: data.reason, previousStatus: before.status, deleteAfter: business.deleteAfter });
  res.json(business);
});

/** Undo an archive (e.g. the business came back): ACTIVE again; owners sign in with their old passwords. */
platformRouter.post("/businesses/:id/restore", async (req, res) => {
  const id = param(req, "id");
  const before = await db.business.findUnique({ where: { id }, select: { status: true, archivedAt: true } });
  if (!before) throw notFound("Business");
  if (before.status !== "ARCHIVED") throw conflict("Only an archived business can be restored");
  const business = await db.business.update({
    where: { id },
    data: { status: "ACTIVE", archivedAt: null, archiveReason: null, deleteAfter: null },
    select: { id: true, name: true, status: true, archivedAt: true, archiveReason: true, deleteAfter: true },
  });
  await audit(req, "platform.business.restore", "Business", id, { archivedAt: before.archivedAt });
  res.json(business);
});

/** Add an owner account to a business (owners then create their managers and staff). */
platformRouter.post("/businesses/:id/users", async (req, res) => {
  const businessId = param(req, "id");
  const data = parse(platformUserCreateSchema, req.body);
  if (!(await db.business.findUnique({ where: { id: businessId }, select: { id: true } }))) throw notFound("Business");
  await assertLoginFree(data.phone, data.email);
  const user = await db.user.create({
    data: {
      businessId,
      role: "BUSINESS_OWNER",
      name: data.name,
      phone: data.phone,
      email: data.email,
    },
    select: ownerFields,
  });
  const invite = await sendPasswordLink(user, "INVITE", req.user!.id);
  await audit(req, "platform.owner.create", "User", user.id, { businessId, invite: invite.channel });
  res.status(201).json({ ...user, invite });
});

/**
 * Owner locked out: send them a reset link (Phase 2.2). The platform never sets or sees
 * the password; the owner's sessions end when they set the new one.
 */
platformRouter.post("/businesses/:id/owners/:userId/reset-link", async (req, res) => {
  const businessId = param(req, "id");
  const owner = await db.user.findFirst({
    where: { id: param(req, "userId"), businessId, role: "BUSINESS_OWNER" },
    select: { id: true, name: true, email: true, phone: true, status: true },
  });
  if (!owner) throw notFound("Owner");
  if (owner.status !== "ACTIVE") throw badRequest("This owner account is not active");
  const delivery = await sendPasswordLink(owner, "RESET", req.user!.id);
  await audit(req, "platform.owner.reset_link", "User", owner.id, { businessId, channel: delivery.channel });
  res.json(delivery);
});

/** Owner lost their phone and recovery codes: turn off two-step login and sign them out. */
platformRouter.post("/businesses/:id/owners/:userId/reset-2fa", async (req, res) => {
  const businessId = param(req, "id");
  const owner = await db.user.findFirst({ where: { id: param(req, "userId"), businessId, role: "BUSINESS_OWNER" }, select: { id: true } });
  if (!owner) throw notFound("Owner");
  await disableTwoFactor(owner.id);
  await forceLogout(owner.id);
  await audit(req, "platform.owner.reset_2fa", "User", owner.id, { businessId });
  res.json({ ok: true });
});

/** Hotels whose owners currently allow support access (read-only, time-limited). */
platformRouter.get("/support-grants", async (_req, res) => {
  const grants = await db.supportGrant.findMany({
    where: { revokedAt: null, expiresAt: { gt: new Date() } },
    include: { business: { select: { id: true, name: true, status: true } } },
    orderBy: { expiresAt: "asc" },
  });
  const owners = await db.user.findMany({ where: { id: { in: grants.map((g) => g.grantedById) } }, select: { id: true, name: true } });
  const ownerName = new Map(owners.map((o) => [o.id, o.name]));
  res.json(grants.map((g) => ({ id: g.id, business: g.business, reason: g.reason, expiresAt: g.expiresAt, createdAt: g.createdAt, grantedBy: ownerName.get(g.grantedById) ?? null })));
});

/** Platform accounts: super admins and platform support users. */
platformRouter.get("/admins", async (_req, res) => {
  res.json(await db.user.findMany({ where: { role: { in: ["SUPER_ADMIN", "PLATFORM_SUPPORT"] }, businessId: null }, select: userFields, orderBy: { name: "asc" } }));
});

platformRouter.post("/admins", async (req, res) => {
  const data = parse(platformAdminCreateSchema, req.body);
  await assertLoginFree(data.phone, data.email);
  const user = await db.user.create({
    data: { role: data.role, name: data.name, phone: data.phone, email: data.email, passwordHash: await bcrypt.hash(data.password, 10) },
    select: userFields,
  });
  await audit(req, "platform.admin.create", "User", user.id, { role: data.role });
  res.status(201).json(user);
});
