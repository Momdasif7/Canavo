import type { Server as HttpServer } from "node:http";

/**
 * Graceful shutdown (QA Phase 16): on SIGTERM the host (Render / Kubernetes / docker stop) gives the
 * process a grace period. In that window we
 *   1. flag "draining" so GET /ready answers 503 and the load balancer stops routing here,
 *   2. stop accepting connections (idle keep-alive connections are closed, in-flight requests finish),
 *   3. disconnect this instance's Socket.io clients (they reconnect to another instance; an open
 *      WebSocket would otherwise hold server.close() until the drain timeout),
 *   4. after the requests drained (or drainMs passed: remaining connections are cut), run the cleanup
 *      steps in order — outbox publisher, pg-boss, Redis, Prisma — each isolated so one failure does
 *      not skip the rest, and exit 0.
 */
let draining = false;
export const isDraining = () => draining;
/** Test hook. */
export const resetDraining = () => void (draining = false);

export interface ShutdownOptions {
  server: HttpServer;
  /** Disconnect live sockets (Socket.io) so the HTTP server can close. */
  closeSockets?: () => unknown;
  /** Cleanup after HTTP drained, run in order. */
  steps: Array<[name: string, run: () => unknown]>;
  drainMs?: number;
  exit?: (code: number) => void;
  log?: (msg: string) => void;
}

export function createShutdown(o: ShutdownOptions) {
  const log = o.log ?? ((m: string) => console.info(m));
  const exit = o.exit ?? ((c: number) => process.exit(c));
  let running: Promise<void> | null = null;
  return (signal: string): Promise<void> =>
    (running ??= (async () => {
      draining = true;
      log(`[api] ${signal}: draining…`);
      const closed = new Promise<void>((r) => (o.server.listening ? o.server.close(() => r()) : r()));
      // Keep-alive connections become idle when their request ends: close them as they do.
      o.server.closeIdleConnections?.();
      const idleSweep = setInterval(() => o.server.closeIdleConnections?.(), 50);
      try {
        await o.closeSockets?.();
      } catch (e) {
        log(`[api] closing sockets failed: ${String(e)}`);
      }
      let timer: NodeJS.Timeout | undefined;
      const timedOut = await Promise.race([
        closed.then(() => false),
        new Promise<boolean>((r) => (timer = setTimeout(() => r(true), o.drainMs ?? 10_000))),
      ]);
      clearTimeout(timer);
      clearInterval(idleSweep);
      if (timedOut) {
        log("[api] drain timeout: closing remaining connections");
        o.server.closeAllConnections?.();
      }
      for (const [name, run] of o.steps) {
        try {
          await run();
        } catch (e) {
          log(`[api] shutdown step ${name} failed: ${String(e)}`);
        }
      }
      log("[api] stopped");
      exit(0);
    })());
}
