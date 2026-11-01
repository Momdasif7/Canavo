import { defineConfig } from "vitest/config";

/**
 * Integration tests against a REAL PostgreSQL database (canavo_it), recreated and
 * migrated before the run. Needs the docker Postgres (npm run db:up) or a CI service.
 *   npm run test:integration -w @canavo/api
 */
// Migrations run as the database owner; the app and tests connect as a NON-superuser role
// (canavo_app_it) so PostgreSQL row-level security is really enforced (superusers bypass it).
const DB = process.env.IT_DATABASE_URL ?? "postgresql://canavo:canavo@localhost:5433/canavo_it?schema=public";
const APP_DB = process.env.IT_APP_DATABASE_URL ?? "postgresql://canavo_app_it:canavo_app_it@localhost:5433/canavo_it?schema=public";

export default defineConfig({
  test: {
    include: ["test/integration/**/*.test.ts"],
    globalSetup: ["test/integration/global-setup.ts"],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 120_000,
    env: {
      NODE_ENV: "test",
      DATABASE_URL: APP_DB,
      IT_DATABASE_URL: DB,
      IT_APP_DATABASE_URL: APP_DB,
      JWT_ACCESS_SECRET: "it-access-secret-0123456789abcdef0123456789",
      JWT_REFRESH_SECRET: "it-refresh-secret-0123456789abcdef012345678",
      RECEIPT_LINK_SECRET: "it-receipt-secret-0123456789abcdef01234567",
      DATA_ENCRYPTION_KEY: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
      CORS_ORIGINS: "http://localhost:3000",
    },
  },
});
