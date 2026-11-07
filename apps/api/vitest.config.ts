import { defineConfig } from "vitest/config";

/**
 * Unit tests must not depend on a developer's apps/api/.env (BUG-001): modules
 * that import src/env.ts validate the environment at import time. These values
 * are test-only placeholders; no test opens a real database connection.
 */
export default defineConfig({
  test: {
    // Unit tests only; live-stack suites (test/smoke, …) have their own configs.
    include: ["src/**/*.test.ts"],
    env: {
      NODE_ENV: "test",
      DATABASE_URL: process.env.DATABASE_URL ?? "postgresql://canavo:canavo@localhost:5433/canavo_test?schema=public",
      JWT_ACCESS_SECRET: process.env.JWT_ACCESS_SECRET ?? "test-access-secret-0123456789abcdef0123456789",
      JWT_REFRESH_SECRET: process.env.JWT_REFRESH_SECRET ?? "test-refresh-secret-0123456789abcdef012345678",
      RECEIPT_LINK_SECRET: process.env.RECEIPT_LINK_SECRET ?? "test-receipt-secret-0123456789abcdef01234567",
    },
  },
});
