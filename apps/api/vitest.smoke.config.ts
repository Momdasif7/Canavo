import { defineConfig } from "vitest/config";

/**
 * Smoke suite: runs against a LIVE stack (default http://localhost:4000).
 *   SMOKE_API_URL=https://staging.example.com/api npm run test:smoke -w @canavo/api
 * Writes are self-cleaning (the bill it creates is cancelled at the end).
 */
export default defineConfig({
  test: {
    include: ["test/smoke/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    fileParallelism: false,
    sequence: { concurrent: false },
  },
});
