/**
 * Phase 1.5 — Socket.io across several API instances through Redis. Skipped when no
 * Redis is reachable (set IT_REDIS_URL; CI provides a redis service).
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { Server } from "socket.io";
import { io as connect } from "socket.io-client";
import { afterAll, describe, expect, it } from "vitest";
import { attachRedisAdapter } from "../../src/realtime";

const REDIS = process.env.IT_REDIS_URL ?? "redis://localhost:6390";
const closers: (() => Promise<void> | void)[] = [];
afterAll(async () => {
  for (const c of closers.reverse()) await c();
});

async function instance() {
  const httpServer = http.createServer();
  const io = new Server(httpServer);
  io.on("connection", (s) => s.join("outlet:demo"));
  const close = await attachRedisAdapter(REDIS, io);
  await new Promise<void>((r) => httpServer.listen(0, "127.0.0.1", r));
  closers.push(async () => {
    await io.close();
    await close?.();
  });
  return { io, url: `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}` };
}

const redisUp = await (async () => {
  try {
    const { createClient } = await import("redis");
    const c = createClient({ url: REDIS, socket: { connectTimeout: 1000, reconnectStrategy: false } });
    await c.connect();
    await c.quit();
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!redisUp)("Socket.io Redis adapter", () => {
  it("an event emitted on instance 1 reaches a client connected to instance 2", async () => {
    const one = await instance();
    const two = await instance();
    const client = connect(two.url, { transports: ["websocket"] });
    closers.push(() => client.disconnect());
    await new Promise<void>((r) => client.once("connect", () => r()));
    await new Promise((r) => setTimeout(r, 200)); // room join propagated
    const got = new Promise<unknown>((resolve) => client.once("kot:new", resolve));
    one.io.to("outlet:demo").emit("kot:new", { id: "k1" });
    expect(await Promise.race([got, new Promise((r) => setTimeout(() => r("timeout"), 3000))])).toEqual({ id: "k1" });
  });
});
