import "./env";
import http from "node:http";
import { createApp } from "./app";
import { env } from "./env";
import { initRealtime } from "./realtime";
import { prisma } from "./db";
import { stopJobs } from "./jobs";
import { registerJobs as registerServiceJobs } from "./jobs-service";
import { registerJobs as registerCrmJobs } from "./jobs-crm";
import { registerJobs as registerPlatformJobs } from "./jobs-platform";
import { registerJobs as registerInventoryJobs } from "./jobs-inventory";
import { registerJobs as registerAlertJobs } from "./jobs-notifications";

const server = http.createServer(createApp());
initRealtime(server);

if (env.NODE_ENV !== "test") {
  registerServiceJobs();
  registerCrmJobs();
  registerPlatformJobs();
  registerInventoryJobs();
  registerAlertJobs();
}

server.listen(env.PORT, () => {
  console.info(`CANAVO API listening on http://localhost:${env.PORT} (docs: /docs)`);
});

const shutdown = async () => {
  stopJobs();
  server.close();
  await prisma.$disconnect();
  process.exit(0);
};
// Backstop (BUG-014): a stray rejected promise must be logged, not take the whole API down.
process.on("unhandledRejection", (reason) => console.error("[process] unhandled rejection", reason));
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
