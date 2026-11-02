import { defineConfig } from "vitest/config";

/** Black-box smoke suite against a running API — see test/smoke/smoke.test.ts. */
export default defineConfig({
  test: {
    include: ["test/smoke/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    fileParallelism: false,
    reporters: ["verbose"],
  },
});
