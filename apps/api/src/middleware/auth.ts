import type { NextFunction, Request, Response } from "express";
import { withIdempotency } from "../lib/idempotency";
import { normalizeFeatures, can, normalizeModules, permissionEnabled, type ModuleKey, type Permission, type Role } from "@canavo/shared";
import { platformPrisma } from "../db";
import { verifyAccess } from "../lib/tokens";
import { badRequest, forbidden, notFound, unauthorized } from "../lib/http";
import { runWithTenant, tenant, type TenantContext } from "../lib/tenant";

export interface AuthUser {
  id: string;
  name: string;
  role: Role;
  /** null for platform super admins */
  businessId: string | null;
  /** Outlets the user may act in (business owners: every outlet of their business) */
  outletIds: string[];
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
      outletId?: string;
      /** Business of the current request (from the user, the outlet, or X-Business-Id for super admins) */
      businessId?: string;
    }
  }
}

const isPlatformAdmin = (u: AuthUser) => u.role === "SUPER_ADMIN" && !u.businessId;

async function loadBusiness(id: string) {
  const b = await platformPrisma.business.findUnique({ where: { id }, select: { id: true, status: true, modules: true, features: true } });
  if (!b) throw notFound("Business");
  return b;
}

function enterBusiness(req: Request, ctx: TenantContext, b: { id: string; status: string; modules: string[]; features: unknown }) {
  if (b.status !== "ACTIVE") throw forbidden("This business account is suspended. Contact your CANAVO administrator.");
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
    select: { id: true, name: true, role: true, status: true, tokenVersion: true, businessId: true, outlets: true },
  });
  // tokenVersion mismatch → role changed or force-logged-out since token was issued
  if (!user || user.status !== "ACTIVE" || user.tokenVersion !== claims.tv) {
    throw unauthorized("Session no longer valid");
  }
  let outletIds = user.outlets.map((o) => o.outletId);
  if (user.role === "BUSINESS_OWNER" && user.businessId) {
    outletIds = (await platformPrisma.outlet.findMany({ where: { businessId: user.businessId }, select: { id: true } })).map((o) => o.id);
  }
  req.user = { id: user.id, name: user.name, role: user.role, businessId: user.businessId, outletIds };

  const ctx: TenantContext = { platform: isPlatformAdmin(req.user) };
  // Platform super admins never enter a hotel's data (privacy): no business context for them.
  if (user.businessId) enterBusiness(req, ctx, await loadBusiness(user.businessId));
  // Mutations carrying an Idempotency-Key are replay-safe (Phase 1.4).
  await runWithTenant(ctx, () => withIdempotency(req, res, next, user.id));
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
    if (!permissions.some((p) => can(req.user!.role, p) && permissionEnabled(p, modules))) throw forbidden("Insufficient permissions");
    next();
  };
}

/** Role permission AND the business has the module that permission belongs to. */
export function requirePermission(...permissions: Permission[]) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) throw unauthorized();
    if (!permissions.every((p) => can(req.user!.role, p))) throw forbidden("Insufficient permissions");
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

/** Platform-only screens (businesses, modules, whole-database operations). */
export function requirePlatformAdmin(req: Request, _res: Response, next: NextFunction) {
  if (!req.user || !isPlatformAdmin(req.user)) throw forbidden("Platform administrators only");
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
  if (isPlatformAdmin(user)) {
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
