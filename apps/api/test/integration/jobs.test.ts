/**
 * Phase 1.2 — scheduled jobs on pg-boss: three runners (2 API instances + 1 worker)
 * all ticking the same job never execute it twice in a window, and never concurrently.
 */
import { afterAll, describe, expect, it } from "vitest";
import { startJobRunner, type JobDef, type JobRunner } from "../../src/jobs";

const runners: JobRunner[] = [];
afterAll(async () => {
  await Promise.all(runners.map((r) => r.stop()));
});

describe("pg-boss jobs", () => {
  it("2 API instances + 1 worker: each window runs once, never overlapping", async () => {
    const runs: number[] = [];
    let active = 0;
    let maxActive = 0;
    const name = `test.double-run.${Date.now()}`;
    const jobs = new Map<string, JobDef>([
      [
        name,
        {
          everyMs: 1000,
          fn: async () => {
            active++;
            maxActive = Math.max(maxActive, active);
            runs.push(Date.now());
            await new Promise((r) => setTimeout(r, 150));
            active--;
          },
        },
      ],
    ]);
    // Start sequentially (queue creation), then all three tick + work concurrently.
    runners.push(await startJobRunner(jobs, { tick: true, work: true }));
    runners.push(await startJobRunner(jobs, { tick: true, work: true }));
    runners.push(await startJobRunner(jobs, { tick: true, work: true }));
    await new Promise((r) => setTimeout(r, 6500));
    // ~6 windows with 3 tickers each = up to 18 enqueue attempts; singleton windows keep one per second.
    expect(runs.length).toBeGreaterThanOrEqual(3);
    expect(runs.length).toBeLessThanOrEqual(7);
    expect(maxActive).toBe(1);
    const windows = runs.map((t) => Math.floor(t / 1000));
    // never two runs started within the same 1 s window
    const gaps = runs.slice(1).map((t, i) => t - runs[i]!);
    expect(Math.min(...gaps)).toBeGreaterThan(500);
    expect(new Set(windows).size).toBe(windows.length);
  }, 30_000);
});
