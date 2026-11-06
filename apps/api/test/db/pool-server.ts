/**
 * A child API instance for test/db/pool.test.ts: the real Express app on a random port, with its
 * own Prisma pool (DATABASE_URL carries connection_limit / pool_timeout). Prints {"port":n} once
 * listening; exits when stdin closes so a crashed test never leaves it running.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";

async function main() {
  const { createApp } = await import("../../src/app");
  const server = http.createServer(createApp());
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  process.stdout.write(`${JSON.stringify({ port: (server.address() as AddressInfo).port })}\n`);
  process.stdin.resume();
  process.stdin.on("end", () => process.exit(0));
  process.stdin.on("close", () => process.exit(0));
}

void main();
