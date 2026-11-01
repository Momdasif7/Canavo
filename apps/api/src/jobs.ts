import PgBoss from "pg-boss";
import { env } from "./env";

/**
 * Scheduled background jobs on pg-boss (Phase 1.2): no new infrastructure, the
 * queue lives in Postgres (schema "pgboss").
 *
 * Modules declare jobs with registerJob(name, everyMs, fn) in their jobs-*.ts files.
 * startJobs() then:
 *  - creates one queue per job (policy "stately": at most one queued + one active
 *    job at a time) with retries + backoff and a dead-letter queue `<name>.dead`;
 *  - ticks: every `everyMs` it sends a job with singletonKey + singletonSeconds, so
 *    however many processes tick (2 API instances + a worker), one job is created
 *    per time window — no double execution;
 *  - works: consumes jobs one at a time.
 * Where jobs run is set by JOBS_MODE: "embedded" (default: the API process ticks and
 * works — fine for one small server) or "worker" (the API runs none; `npm run worker`
 * runs them in a separate process). Several processes of either kind are safe.
 */

export interface JobDef {
  everyMs: number;
  fn: () => Promise<void>;
}
const defs = new Map<string, JobDef>();

/** pg-boss queue names: letters, digits, - _ . / only. */
export const queueName = (name: string) => name.replace(/[^\w.\-/]/g, ".");

export function registerJob(name: string, everyMs: number, fn: () => Promise<void>) {
  defs.set(queueName(name), { everyMs, fn });
}

export const registeredJobs = () => [...defs.keys()];

/** Connection string without Prisma-only parameters (pg ignores ?schema but be explicit). */
export function pgConnectionString(url = env.DATABASE_URL) {
  const u = new URL(url);
  u.searchParams.delete("schema");
  return u.toString();
}

export interface JobRunner {
  boss: PgBoss;
  stop: () => Promise<void>;
}

/** Start one runner (one "process") for the given jobs. Several runners on one database never double-run a window. */
export async function startJobRunner(
  jobs: Map<string, JobDef>,
  opts: { tick: boolean; work: boolean; connectionString?: string },
): Promise<JobRunner> {
  const b = new PgBoss({ connectionString: opts.connectionString ?? pgConnectionString(), schema: "pgboss", application_name: "canavo-jobs" });
  b.on("error", (e) => console.error("[jobs] pg-boss error", e));
  await b.start();
  const own: NodeJS.Timeout[] = [];
  for (const [name, def] of jobs) {
    const windowSeconds = Math.max(1, Math.floor(def.everyMs / 1000));
    const dead = `${name}.dead`;
    await b.createQueue(dead, { name: dead, policy: "standard", retentionDays: 14 });
    await b.createQueue(name, {
      name,
      policy: "stately",
      retryLimit: 2,
      retryDelay: 10,
      retryBackoff: true,
      expireInSeconds: Math.max(120, windowSeconds * 4),
      retentionDays: 2,
      deadLetter: dead,
    });
    if (opts.work) {
      await b.work(name, { batchSize: 1, pollingIntervalSeconds: Math.min(2, windowSeconds) }, async (batch) => {
        for (const _job of batch) await def.fn();
      });
    }
    if (opts.tick) {
      const tick = () =>
        b.send(name, {}, { singletonKey: name, singletonSeconds: windowSeconds }).catch((e) => console.error(`[jobs] could not enqueue ${name}`, e));
      own.push(setInterval(tick, def.everyMs));
    }
  }
  return {
    boss: b,
    stop: async () => {
      own.splice(0).forEach(clearInterval);
      await b.stop({ graceful: true, wait: true, timeout: 15_000 }).catch((e) => console.error("[jobs] stop failed", e));
    },
  };
}

let runner: JobRunner | null = null;

/** Start this process's runner for every registered job. */
export async function startJobs(opts: { tick: boolean; work: boolean; connectionString?: string } = { tick: true, work: true }) {
  if (!runner) runner = await startJobRunner(defs, opts);
  return runner.boss;
}

export async function stopJobs() {
  const r = runner;
  runner = null;
  await r?.stop();
}
