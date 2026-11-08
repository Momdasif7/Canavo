import "./env";
import { installProcessHandlers } from "./lib/observability";
installProcessHandlers();
import http from "node:http";
import { createApp } from "./app";
import { env } from "./env";
import { attachRedisAdapter, closeRealtime, initRealtime, socketEmitter } from "./realtime";
import { createShutdown } from "./lib/shutdown";
import { platformPrisma, prisma } from "./db";
import { startJobs, stopJobs } from "./jobs";
import { registerAllJobs } from "./jobs-all";
import { startOutboxPublisher, stopOutboxPublisher } from "./lib/outbox";
import { assertNoDemoLogins } from "./lib/demo-guard";

const server = http.createServer(createApp());
initRealtime(server);
let closeRedis: (() => Promise<void>) | null = null;
attachRedisAdapter()
  .then((c) => (closeRedis = c))
  .catch((e) => {
    // Without Redis, several API instances would miss each other's events: refuse to run half-broken.
    console.error("[realtime] REDIS_URL is set but Redis is unreachable", e);
    process.exit(1);
  });
// This process owns the sockets, so it delivers outbox events (several API instances are safe).
startOutboxPublisher(socketEmitter());

if (env.NODE_ENV !== "test" && env.JOBS_MODE === "embedded") {
  registerAllJobs();
  startJobs({ tick: true, work: true }).catch((e) => console.error("[jobs] failed to start", e));
}

assertNoDemoLogins(platformPrisma, { NODE_ENV: env.NODE_ENV, ALLOW_DEMO_SEED: process.env.ALLOW_DEMO_SEED })
  .then(() =>
    server.listen(env.PORT, () => {
      console.info(`CANAVO API listening on http://localhost:${env.PORT} (docs: /docs) · jobs: ${env.JOBS_MODE}`);
    }),
  )
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });

// Graceful shutdown: /ready → 503, stop accepting, drain HTTP + sockets (max 10 s), then background work and DB.
const shutdown = createShutdown({
  server,
  closeSockets: closeRealtime,
  steps: [
    ["outbox", stopOutboxPublisher],
    ["pg-boss", stopJobs],
    ["redis", () => closeRedis?.()],
    ["prisma", () => Promise.allSettled([prisma.$disconnect(), platformPrisma.$disconnect()])],
  ],
});
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
