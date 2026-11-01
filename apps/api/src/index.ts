import "./env";
import http from "node:http";
import { createApp } from "./app";
import { env } from "./env";
import { attachRedisAdapter, initRealtime, socketEmitter } from "./realtime";
import { platformPrisma, prisma } from "./db";
import { startJobs, stopJobs } from "./jobs";
import { registerAllJobs } from "./jobs-all";
import { startOutboxPublisher, stopOutboxPublisher } from "./lib/outbox";

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

server.listen(env.PORT, () => {
  console.info(`CANAVO API listening on http://localhost:${env.PORT} (docs: /docs) · jobs: ${env.JOBS_MODE}`);
});

let stopping = false;
const shutdown = async (signal: string) => {
  if (stopping) return;
  stopping = true;
  console.info(`[api] ${signal}: draining…`);
  // Stop taking new connections, let in-flight requests finish (max 10 s), then stop background work.
  const closed = new Promise<void>((r) => server.close(() => r()));
  const timeout = new Promise<void>((r) => setTimeout(r, 10_000).unref());
  await Promise.race([closed, timeout]);
  stopOutboxPublisher();
  await stopJobs();
  await closeRedis?.();
  await Promise.allSettled([prisma.$disconnect(), platformPrisma.$disconnect()]);
  process.exit(0);
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
