import http from "node:http";
import type { AddressInfo } from "node:net";
import { Server } from "socket.io";
import { io as connect } from "socket.io-client";
import { afterEach, describe, expect, it } from "vitest";
import { createShutdown, isDraining, resetDraining } from "./shutdown";

/** SIGTERM drain (QA Phase 16): in-flight requests finish, new connections are refused, sockets drop, cleanup runs in order. */
describe("graceful shutdown", () => {
  afterEach(() => resetDraining());

  const start = (handler: http.RequestListener) =>
    new Promise<{ server: http.Server; url: string }>((r) => {
      const server = http.createServer(handler);
      server.listen(0, "127.0.0.1", () => r({ server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` }));
    });

  it("lets the in-flight request finish, refuses new ones, disconnects sockets, then runs cleanup in order and exits 0", async () => {
    const { server, url } = await start((req, res) => {
      if (req.url === "/slow") setTimeout(() => res.end("done"), 300);
      else res.end("ok");
    });
    const io = new Server(server);
    const client = connect(url, { transports: ["websocket"], reconnection: false });
    await new Promise<void>((r) => client.on("connect", () => r()));
    const disconnected = new Promise<string>((r) => client.on("disconnect", (reason) => r(reason)));

    const order: string[] = [];
    const exits: number[] = [];
    const shutdown = createShutdown({
      server,
      closeSockets: () => io.local.disconnectSockets(true),
      steps: [
        ["outbox", () => void order.push("outbox")],
        ["pg-boss", async () => void order.push("pg-boss")],
        ["redis", () => { throw new Error("redis gone"); }],
        ["prisma", () => void order.push("prisma")],
      ],
      drainMs: 5_000,
      exit: (c) => exits.push(c),
      log: () => {},
    });

    const inflight = fetch(`${url}/slow`).then((r) => r.text());
    await new Promise((r) => setTimeout(r, 50));
    const done = shutdown("SIGTERM");
    expect(isDraining()).toBe(true);
    expect(order).toEqual([]); // cleanup waits for the drain

    await expect(fetch(`${url}/`)).rejects.toThrow(); // no new connections
    expect(await inflight).toBe("done");
    expect(await disconnected).toBe("io server disconnect");
    await done;
    expect(order).toEqual(["outbox", "pg-boss", "prisma"]); // a failing step does not skip the rest
    expect(exits).toEqual([0]);
    expect(server.listening).toBe(false);
    await shutdown("SIGINT"); // idempotent
    expect(exits).toEqual([0]);
    client.close();
  });

  it("cuts connections that outlive the drain timeout", async () => {
    const { server, url } = await start(() => {}); // never answers
    const exits: number[] = [];
    const hung = fetch(url).catch(() => "cut");
    await new Promise((r) => setTimeout(r, 50));
    const t0 = Date.now();
    await createShutdown({ server, steps: [], drainMs: 200, exit: (c) => exits.push(c), log: () => {} })("SIGTERM");
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(await hung).toBe("cut");
    expect(exits).toEqual([0]);
  });
});
