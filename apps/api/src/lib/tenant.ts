import { AsyncLocalStorage } from "node:async_hooks";
import { featureEnabled, type FeatureFlags, type FeatureKey, type ModuleKey } from "@canavo/shared";
import { forbidden } from "./http";

/**
 * Per-request business (tenant) context. Every query on a business-owned model
 * is automatically filtered to `businessId` (see db.ts). No context = platform
 * scope (super admin platform screens, background jobs, seeds).
 */
export interface TenantContext {
  businessId?: string;
  /** Enabled modules of the business; undefined in platform scope */
  modules?: ModuleKey[];
  /** Per-hotel feature flags of the business */
  features?: FeatureFlags;
  /** Platform admin request (no hotel): database row-level security shows platform rows only */
  platform?: boolean;
}

const store = new AsyncLocalStorage<TenantContext>();

/**
 * Run `fn` in the tenant context. If it returns a promise-like, it is awaited INSIDE
 * the context: Prisma query promises are lazy (they run when awaited), so returning
 * one un-awaited would execute it outside the context — without the tenant filter or
 * the row-level-security setting (found by the RLS tests, Phase 1.1).
 */
export function runWithTenant<T>(ctx: TenantContext, fn: () => T): T {
  return store.run(ctx, () => {
    const result = fn();
    if (result && typeof (result as { then?: unknown }).then === "function") {
      return (async () => await (result as unknown as PromiseLike<unknown>))() as T;
    }
    return result;
  });
}

export const tenant = (): TenantContext | undefined => store.getStore();
export const currentBusinessId = (): string | undefined => store.getStore()?.businessId;

/** The current business id; throws when called outside a business context. */
export function requireBusinessId(): string {
  const id = currentBusinessId();
  if (!id) throw forbidden("Select a business (outlet) first");
  return id;
}

/** True when the module is enabled for the current business (always true in platform scope). */
export function moduleEnabled(m: ModuleKey): boolean {
  const ctx = store.getStore();
  return !ctx?.businessId || !ctx.modules || ctx.modules.includes(m);
}

/** True when the feature flag is on for the current business (and its required modules are enabled). Off in platform scope. */
export function featureOn(key: FeatureKey): boolean {
  const ctx = store.getStore();
  return Boolean(ctx?.businessId) && featureEnabled(ctx!.features, key, ctx!.modules);
}

/**
 * Run `fn` inside a business context outside of an HTTP request (webhooks,
 * background jobs). Loads the business's modules so module checks apply.
 */
export async function runForBusiness<T>(businessId: string, fn: () => Promise<T>): Promise<T> {
  const { platformPrisma } = await import("../db");
  const { normalizeFeatures, normalizeModules } = await import("@canavo/shared");
  const b = await platformPrisma.business.findUniqueOrThrow({ where: { id: businessId }, select: { modules: true, features: true } });
  return runWithTenant({ businessId, modules: normalizeModules(b.modules), features: normalizeFeatures(b.features) }, fn);
}

/** Same as runForBusiness, starting from an outlet id. */
export async function runForOutlet<T>(outletId: string, fn: () => Promise<T>): Promise<T> {
  const { platformPrisma } = await import("../db");
  const o = await platformPrisma.outlet.findUniqueOrThrow({ where: { id: outletId }, select: { businessId: true } });
  return runForBusiness(o.businessId, fn);
}
