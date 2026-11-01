/**
 * Background worker (Phase 1.2): runs the scheduled jobs on pg-boss in its own
 * process. Use with JOBS_MODE=worker on the API so the API serves requests only.
 *   npm run worker -w @canavo/api        (Render: a "Background Worker" service)
 * Events the jobs emit (socket updates, notifications) go through the outbox and
 * are delivered by the API, which owns the sockets.
 */
import "./env";
import { installProcessHandlers } from "./lib/observability";
installProcessHandlers();
import "./outbox-tasks";
import { platformPrisma, prisma } from "./db";
import { registeredJobs, startJobs, stopJobs } from "./jobs";
import { registerAllJobs } from "./jobs-all";

registerAllJobs();
startJobs({ tick: true, work: true })
  .then(() => console.info(`[worker] running ${registeredJobs().length} jobs: ${registeredJobs().join(", ")}`))
  .catch((e) => {
    console.error("[worker] failed to start", e);
    process.exit(1);
  });

const shutdown = async (signal: string) => {
  console.info(`[worker] ${signal}: finishing current jobs…`);
  await stopJobs();
  await Promise.allSettled([prisma.$disconnect(), platformPrisma.$disconnect()]);
  process.exit(0);
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
