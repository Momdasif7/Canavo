import { Prisma, PrismaClient } from "@prisma/client";
import { currentBusinessId, tenant } from "./lib/tenant";

/** Models owned by a business. Queries on them are filtered to the current business. */
export const BUSINESS_SCOPED_MODELS = new Set([
  "Outlet",
  "User",
  "MenuCategory",
  "MenuItem",
  "Customer",
  "InventoryItem",
  "Vendor",
  "Offer",
  "Coupon",
  "TaxRate",
  "AuditLog",
  "CustomRole",
  "CorporateAccount",
  "CorporateStatement",
  "BusinessIntegration",
]);

const FILTERED_OPS = new Set([
  "findUnique",
  "findUniqueOrThrow",
  "findFirst",
  "findFirstOrThrow",
  "findMany",
  "count",
  "aggregate",
  "groupBy",
  "update",
  "updateMany",
  "delete",
  "deleteMany",
  "upsert",
]);

// PRISMA_QUERY_LOG=1: emit every statement as a "query" event (N+1 hunting, perf/n1-scan.ts). Off by default.
// Interactive transactions queue behind per-outlet locks (KOT numbers, bills) in a lunch rush: Prisma's
// 5 s default made 30 bills at once fail (QA Phase 13, R5). Allow 10 s to start and 15 s to finish.
const base = new PrismaClient({
  transactionOptions: { maxWait: 10_000, timeout: 15_000 },
  ...(process.env.PRISMA_QUERY_LOG === "1" && { log: [{ emit: "event" as const, level: "query" as const }] }),
});

// ---------------------------------------------------------------------------
// Layer 1 — application tenant filter (unchanged): inside a business context
// every read/write on a scoped model gets `businessId` added.
// ---------------------------------------------------------------------------
const filtered = base.$extends({
  query: {
    $allModels: {
      async $allOperations({ model, operation, args, query }) {
        const businessId = currentBusinessId();
        if (!businessId || !BUSINESS_SCOPED_MODELS.has(model)) return query(args);
        const a = (args ?? {}) as Record<string, unknown>;
        if (FILTERED_OPS.has(operation)) a.where = { ...((a.where as object) ?? {}), businessId };
        if (operation === "create") a.data = { businessId, ...(a.data as object) };
        if (operation === "upsert") a.create = { businessId, ...(a.create as object) };
        if (operation === "createMany" || operation === "createManyAndReturn") {
          const data = a.data as object | object[];
          a.data = Array.isArray(data) ? data.map((d) => ({ businessId, ...d })) : { businessId, ...data };
        }
        return query(a);
      },
    },
  },
});

// ---------------------------------------------------------------------------
// Layer 2 — database Row-Level Security (Phase 1.1). Every statement runs with
// transaction-local settings (pool-safe: set_config(…, true) dies with the
// transaction). The database refuses rows of other hotels even if a query
// forgets its filter. See migrations/*_row_level_security.
// ---------------------------------------------------------------------------
interface RlsSettings {
  business: string;
  platform: "on" | "off";
  bypass: "on" | "off";
}

/** Tenant client: the current hotel; platform-admin requests see platform rows only (fail closed); no request = infrastructure. */
function tenantSettings(): RlsSettings {
  const ctx = tenant();
  if (ctx?.businessId) return { business: ctx.businessId, platform: "off", bypass: "off" };
  if (ctx?.platform) return { business: "", platform: "on", bypass: "off" };
  if (ctx) return { business: "", platform: "off", bypass: "off" };
  return { business: "", platform: "off", bypass: "on" }; // jobs outside a hotel, scripts, unauthenticated routes
}
const platformSettings = (): RlsSettings => ({ business: "", platform: "off", bypass: "on" });

type AnyClient = { $executeRaw: PrismaClient["$executeRaw"]; $transaction: PrismaClient["$transaction"] };
const setConfig = (c: AnyClient, s: RlsSettings) =>
  c.$executeRaw`SELECT set_config('app.business_id', ${s.business}, true), set_config('app.platform', ${s.platform}, true), set_config('app.bypass_rls', ${s.bypass}, true)`;

const READ_OPS = new Set(["findUnique", "findUniqueOrThrow", "findFirst", "findFirstOrThrow", "findMany", "count", "aggregate", "groupBy"]);
/** Bounded: each dead pooled connection fails at once (nothing was sent), so a pool's worth of retries is cheap. */
const STALE_CONNECTION_RETRIES = 10;
/**
 * P1017: the pooled connection was already closed by the server (failover, restart, idle kill). The
 * pool replaces it, but every stale connection would fail one request (QA Phase 7) — reads are
 * retried on the next connection; writes are not (the client gets a 503 and retries itself).
 */
const isStaleConnection = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P1017";

/**
 * Build a client whose single queries run as `[set_config, query]` batches, whose
 * interactive transactions set the config first, and whose raw queries carry it too.
 */
function withRls<C extends object>(inner: C & AnyClient, settings: () => RlsSettings): PrismaClient {
  const rls = (inner as unknown as PrismaClient).$extends({
    query: {
      $allModels: {
        async $allOperations({ operation, args, query }) {
          for (let attempt = 1; ; attempt++) {
            try {
              const [, result] = await inner.$transaction([setConfig(inner, settings()), query(args)] as Prisma.PrismaPromise<unknown>[]);
              return result;
            } catch (e) {
              if (!READ_OPS.has(operation) || !isStaleConnection(e) || attempt >= STALE_CONNECTION_RETRIES) throw e;
            }
          }
        },
      },
    },
  });
  const RAW = new Set(["$queryRaw", "$executeRaw", "$queryRawUnsafe", "$executeRawUnsafe"]);
  return new Proxy(rls, {
    get(target, prop, receiver) {
      if (prop === "$transaction") {
        return (arg: unknown, opts?: Parameters<PrismaClient["$transaction"]>[1]) => {
          if (typeof arg === "function") {
            const s = settings();
            return inner.$transaction(async (tx: Prisma.TransactionClient) => {
              await setConfig(tx as unknown as AnyClient, s);
              return (arg as (tx: Prisma.TransactionClient) => Promise<unknown>)(tx);
            }, opts as never);
          }
          throw new Error("Batch $transaction([...]) is not supported with row-level security; use the callback form");
        };
      }
      if (typeof prop === "string" && RAW.has(prop)) {
        return (...args: unknown[]) =>
          (inner.$transaction([setConfig(inner, settings()), (inner as unknown as Record<string, (...a: unknown[]) => Prisma.PrismaPromise<unknown>>)[prop]!(...args)]) as Promise<unknown[]>).then((r) => r[1]);
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as unknown as PrismaClient;
}

/**
 * Tenant-aware client for all hotel work. Typed as a plain PrismaClient so
 * transaction clients stay assignable to Prisma.TransactionClient.
 */
export const prisma = withRls(filtered as unknown as AnyClient & object, tenantSettings);

/** Unfiltered client for platform-level work that must cross businesses explicitly (bypasses RLS). */
export const platformPrisma = withRls(base as unknown as AnyClient & object, platformSettings);

/** Raw client without RLS settings (tests / migrations only). */
export const rawPrisma = base;
