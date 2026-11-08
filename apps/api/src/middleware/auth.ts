import type { NextFunction, Request, Response } from "express";
import { withIdempotency } from "../lib/idempotency";
import { featureEnabled, normalizeFeatures, canWith, isPlatformRole, normalizeModules, permissionEnabled, type ModuleKey, type Permission, type Role } from "@canavo/shared";
import { platformPrisma } from "../db";
import { sessionActive, verifyAccess } from "../lib/tokens";
import { badRequest, forbidden, HttpError, notFound, unauthorized } from "../lib/http";
import { runWithTenant, tenant, type TenantContext } from "../lib/tenant";
import { assertPlatformIpAllowed } from "./ip-whitelist";

export interface AuthUser {
  id: string;
  name: string;
  role: Role;
  /** null for platform super admins */
  businessId: string | null;
  /** Outlets the user may act in (business owners: every outlet of their business) */
  outletIds: string[];
  /** Custom role (Phase 4.2): its permissions narrow the base role; null = the full base role */
  customRoleId?: string | null;
  customPermissions?: string[] | null;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
      /** Session (refresh-token family) of this access token, when known */
      sessionId?: string;
      /** Platform admin working inside a hotel under the owner's support grant (read-only) */
      support?: { grantId: string; adminId: string; businessId: string; expiresAt: Date };
      outletId?: string;
      /** Business of the current request (from the user, the outlet, or X-Business-Id for super admins) */
      businessId?: string;
    }
  }
}

/** CANAVO operator accounts (super admin, platform support): no business of their own. */
const isPlatformUser = (u: AuthUser) => isPlatformRole(u.role) && !u.businessId;

/**
 * Does the signed-in user have this permission (base role ∩ custom role)? Use this instead of
 * `can(req.user.role, …)` so custom roles are honoured everywhere. Modules are checked by the guards.
 */
export const userCan = (req: { user?: AuthUser }, permission: Permission) =>
  Boolean(req.user && canWith(req.user.role, permission, req.user.customPermissions));

/** Roles a hotel can require two-step login for (feature REQUIRE_2FA). */
export const TWO_FACTOR_REQUIRED_ROLES: Role[] = ["BUSINESS_OWNER", "OUTLET_MANAGER"];
export const mustSetUpTwoFactor = (user: { role: Role; totpEnabledAt: Date | null }, ctx: TenantContext) =>
  !user.totpEnabledAt && TWO_FACTOR_REQUIRED_ROLES.includes(user.role) && featureEnabled(ctx.features, "REQUIRE_2FA", ctx.modules);

/** Why a non-ACTIVE business can't be used (QA 16b: archived businesses say so instead of "suspended"). */
export const businessClosedMessage = (status: string | undefined) =>
  status === "ARCHIVED"
    ? "This business account has been closed (archived). Contact your CANAVO administrator."
    : "This business account is suspended. Contact your CANAVO administrator.";

async function loadBusiness(id: string) {
  const b = await platformPrisma.business.findUnique({ where: { id }, select: { id: true, status: true, modules: true, features: true } });
  if (!b) throw notFound("Business");
  return b;
}

function enterBusiness(req: Request, ctx: TenantContext, b: { id: string; status: string; modules: string[]; features: unknown }) {
  if (b.status !== "ACTIVE") throw forbidden(businessClosedMessage(b.status));
  ctx.businessId = b.id;
  ctx.modules = normalizeModules(b.modules);
  ctx.features = normalizeFeatures(b.features);
  req.businessId = b.id;
}

/**
 * Verify the access token, load the user and open the tenant context for the
 * rest of the request. Platform super admins work across businesses: they get
 * a business context from X-Business-Id or, later, from the outlet they act in.
 */
export async function authenticate(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) throw unauthorized();
  const claims = verifyAccess(header.slice(7));
  const user = await platformPrisma.user.findUnique({
    where: { id: claims.sub },
    select: {
      id: true,
      name: true,
      role: true,
      status: true,
      tokenVersion: true,
      businessId: true,
      outlets: true,
      totpEnabledAt: true,
      customRole: { select: { id: true, permissions: true } },
    },
  });
  // tokenVersion mismatch → role changed or force-logged-out since token was issued
  if (!user || user.status !== "ACTIVE" || user.tokenVersion !== claims.tv) {
    throw unauthorized("Session no longer valid");
  }
  // Signed out on that device ("Signed-in devices" → Sign out): the access token dies with it.
  if (claims.sid && !(await sessionActive(claims.sid))) throw unauthorized("Session ended");
  req.sessionId = claims.sid;
  let outletIds = user.outlets.map((o) => o.outletId);
  if (user.role === "BUSINESS_OWNER" && user.businessId) {
    outletIds = (await platformPrisma.outlet.findMany({ where: { businessId: user.businessId }, select: { id: true } })).map((o) => o.id);
  }
  req.user = {
    id: user.id,
    name: user.name,
    role: user.role,
    businessId: user.businessId,
    outletIds,
    customRoleId: user.customRole?.id ?? null,
    customPermissions: user.customRole?.permissions ?? null,
  };

  const supportBusinessId = req.header("x-support-business");
  if (supportBusinessId && isPlatformUser(req.user)) {
    const ctx: TenantContext = { platform: false };
    await enterSupport(req, ctx, supportBusinessId, user);
    return runWithTenant(ctx, () => withIdempotency(req, res, next, user.id));
  }

  const ctx: TenantContext = { platform: isPlatformUser(req.user) };
  // Platform super admins never enter a hotel's data (privacy): no business context for them.
  if (user.businessId) enterBusiness(req, ctx, await loadBusiness(user.businessId));
  // REQUIRE_2FA (Phase 2.1): owners/managers without two-step login may only reach /auth/* (to set it up).
  if (mustSetUpTwoFactor(user, ctx) && !req.originalUrl.startsWith("/auth/")) {
    throw new HttpError(403, "Your hotel requires two-step login. Turn it on under Account → Security first.", { code: "TWO_FACTOR_SETUP_REQUIRED" });
  }
  // Auditors are read-only whatever their permissions say (Phase 4.2 safety net, like support views).
  if (user.role === "AUDITOR" && req.method !== "GET" && req.method !== "HEAD" && !req.originalUrl.startsWith("/auth/")) {
    throw forbidden("Auditor accounts are read-only.");
  }
  // Mutations carrying an Idempotency-Key are replay-safe (Phase 1.4).
  await runWithTenant(ctx, () => withIdempotency(req, res, next, user.id));
}

/**
 * Support view (Phase 2.4): a platform admin (or platform support, Phase 4.2) opens a hotel only while its owner's grant is
 * active, only with their own two-step login on, and only to read. They act as an outlet
 * manager of every outlet (no owner-only screens, no data export); every request is
 * written to the hotel's audit log so the owner sees what was viewed.
 */
async function enterSupport(req: Request, ctx: TenantContext, businessId: string, user: { id: string; totpEnabledAt: Date | null }) {
  const grant = await platformPrisma.supportGrant.findFirst({
    where: { businessId, revokedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { expiresAt: "desc" },
    select: { id: true, expiresAt: true },
  });
  if (!grant) throw forbidden("This hotel's owner hasn't granted support access, or it has ended.");
  if (!user.totpEnabledAt) throw forbidden("Turn on two-step login (Account → Security) before using support access.");
  // A support view is platform access: the platform IP whitelist applies (QA Phase 8, sec1-4).
  await assertPlatformIpAllowed(req);
  enterBusiness(req, ctx, await loadBusiness(businessId));
  const outletIds = (await platformPrisma.outlet.findMany({ where: { businessId }, select: { id: true } })).map((o) => o.id);
  req.user = { ...req.user!, role: "OUTLET_MANAGER", businessId, outletIds, customRoleId: null, customPermissions: null };
  req.support = { grantId: grant.id, adminId: user.id, businessId, expiresAt: grant.expiresAt };
  const path = req.originalUrl.split("?")[0]!;
  if (req.method !== "GET" && req.method !== "HEAD" && !path.startsWith("/auth/")) throw forbidden("Support access is read-only.");
  if (!path.startsWith("/auth/") && !path.startsWith("/notifications")) {
    void platformPrisma.auditLog
      .create({
        data: {
          userId: user.id,
          businessId,
          outletId: req.header("x-outlet-id") ?? null,
          action: "support.view",
          entity: "SupportGrant",
          entityId: grant.id,
          meta: { method: req.method, path },
          ip: req.ip,
        },
      })
      .catch((e) => console.error("[support] audit failed", e));
  }
}

/**
 * At least one of the permissions (role ∩ modules). For routes shared by managers and
 * the person doing the work (e.g. delivery:manage OR delivery:own); handlers still
 * check row ownership (e.g. "your delivery").
 */
export function requireAnyPermission(...permissions: Permission[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) throw unauthorized();
    const modules = tenant()?.modules ?? null;
    if (!permissions.some((p) => userCan(req, p) && permissionEnabled(p, modules))) throw forbidden("Insufficient permissions");
    next();
  };
}

/** Role permission AND the business has the module that permission belongs to. */
export function requirePermission(...permissions: Permission[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) throw unauthorized();
    if (!permissions.every((p) => userCan(req, p))) throw forbidden("Insufficient permissions");
    const modules = tenant()?.modules ?? null;
    const off = permissions.find((p) => !permissionEnabled(p, modules));
    if (off) throw forbidden("This feature is not enabled for your business");
    next();
  };
}

/** Reject the request unless the current business has the module. */
export function requireModule(module: ModuleKey) {
  return (_req: Request, _res: Response, next: NextFunction) => {
    const modules = tenant()?.modules;
    if (modules && !modules.includes(module)) throw forbidden("This feature is not enabled for your business");
    next();
  };
}

/** Reject unless at least one of the modules is enabled (e.g. the menu serves billing and inventory). */
export function requireAnyModule(...modules: ModuleKey[]) {
  return (_req: Request, _res: Response, next: NextFunction) => {
    const enabled = tenant()?.modules;
    if (enabled && !modules.some((m) => enabled.includes(m))) throw forbidden("This feature is not enabled for your business");
    next();
  };
}

/**
 * Platform console: platform accounts only. Reads need platform:view (super admin and
 * platform support); anything that changes data needs platform:manage (super admin).
 */
export function requirePlatformUser(req: Request, _res: Response, next: NextFunction) {
  if (!req.user || !isPlatformUser(req.user)) throw forbidden("Platform administrators only");
  const read = req.method === "GET" || req.method === "HEAD";
  if (!userCan(req, read ? "platform:view" : "platform:manage")) throw forbidden("Only a super admin can change this");
  next();
}

/**
 * Resolve the active outlet from the X-Outlet-Id header and check the user may
 * act in it. Platform super admins can't act inside any outlet (privacy).
 */
export async function requireOutlet(req: Request, _res: Response, next: NextFunction) {
  const outletId = req.header("x-outlet-id") ?? (req.user?.outletIds.length === 1 ? req.user.outletIds[0] : undefined);
  if (!outletId) throw badRequest("X-Outlet-Id header is required");
  const user = req.user!;
  if (isPlatformUser(user)) {
    throw forbidden("The platform admin can't open a hotel's data. The hotel's owner or manager can.");
  } else if (!user.outletIds.includes(outletId)) {
    throw forbidden("You are not assigned to this outlet");
  }
  req.outletId = outletId;
  next();
}

/** Business-level routes that don't need an outlet (business users only). */
export function requireBusiness(req: Request, _res: Response, next: NextFunction) {
  if (!tenant()?.businessId) throw forbidden("Only the hotel's own accounts can do this");
  next();
}
