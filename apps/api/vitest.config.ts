import { defineConfig } from "vitest/config";

/**
 * Unit tests must be hermetic: a clean clone with no apps/api/.env has to pass.
 * Importing anything that touches src/env.ts calls process.exit(1) when the
 * required variables are missing (BUG-001), so supply test-only dummies for
 * any that are not already set. Real values (e.g. CI's DATABASE_URL) win.
 */
const TEST_ENV_DEFAULTS: Record<string, string> = {
  NODE_ENV: "test",
  DATABASE_URL: "postgresql://unit:unit@localhost:1/unit_tests_do_not_connect",
  JWT_ACCESS_SECRET: "unit-test-access-secret-0123456789abcdef0123",
  JWT_REFRESH_SECRET: "unit-test-refresh-secret-0123456789abcdef012",
  RECEIPT_LINK_SECRET: "unit-test-receipt-secret-0123456789abcdef012",
};

const env = Object.fromEntries(
  Object.entries(TEST_ENV_DEFAULTS).filter(([k]) => !process.env[k]),
);

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    env,
  },
});
