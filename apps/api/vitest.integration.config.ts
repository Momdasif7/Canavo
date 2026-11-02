import { defineConfig } from "vitest/config";

/**
 * API + database integration tests (Supertest against the in-process app, real
 * PostgreSQL). The database is reset and seeded once per run — see
 * test/integration/global-setup.ts.
 *
 *   IT_DATABASE_URL  default postgresql://canavo:canavo@localhost:5433/canavo_it
 */
const DATABASE_URL = process.env.IT_DATABASE_URL ?? "postgresql://canavo:canavo@localhost:5433/canavo_it?schema=public";
process.env.DATABASE_URL = DATABASE_URL; // for globalSetup (runs in this process)

export default defineConfig({
  test: {
    include: ["test/integration/**/*.test.ts"],
    globalSetup: ["test/integration/global-setup.ts"],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 120_000,
    env: {
      NODE_ENV: "test",
      DATABASE_URL,
      JWT_ACCESS_SECRET: "it-access-secret-0123456789abcdef0123456789",
      JWT_REFRESH_SECRET: "it-refresh-secret-0123456789abcdef012345678",
      RECEIPT_LINK_SECRET: "it-receipt-secret-0123456789abcdef01234567",
      CORS_ORIGINS: "http://localhost:3000",
    },
  },
});
