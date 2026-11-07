import { defineConfig } from "@playwright/test";

/**
 * Playwright config for the UI sweeps in ./e2e (run against an already running app).
 *
 *   SWEEP_BASE_URL   web app to test (default http://localhost:3302)
 *   SWEEP_ROLES      comma-separated subset of roles (default: all, see e2e/sweep-config.ts)
 *   SWEEP_PASSWORD   seed password (default Canavo@123)
 *
 * `npm run test:e2e:sweep -w @canavo/web` runs the duplicate-button sweep.
 */
export default defineConfig({
  testDir: "./e2e",
  outputDir: "./e2e/.sweep/test-results",
  fullyParallel: true,
  workers: Number(process.env.SWEEP_WORKERS ?? 4),
  retries: 0,
  // One test per role walks every route at two viewports.
  timeout: 45 * 60 * 1000,
  reporter: [["list"]],
  globalTeardown: "./e2e/sweep-report.ts",
  use: {
    baseURL: process.env.SWEEP_BASE_URL ?? "http://localhost:3302",
    browserName: "chromium",
    headless: true,
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },
});
