import { PrismaClient } from "@prisma/client";
import { currentBusinessId } from "./lib/tenant";

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

const base = new PrismaClient();

/**
 * Tenant isolation: inside a business context every read/write on a scoped
 * model gets `businessId` added to its filter and to created rows, so one
 * business can never see or change another's data. Outside a context (platform
 * screens, jobs, seeds) queries are unfiltered.
 *
 * Typed as a plain PrismaClient so transaction clients stay assignable to
 * Prisma.TransactionClient; the query extension doesn't change result types.
 */
export const prisma = base.$extends({
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
}) as unknown as PrismaClient;

/** Unfiltered client for platform-level work that must cross businesses explicitly. */
export const platformPrisma = base;
