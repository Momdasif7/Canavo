import { allowedOrigin } from "./lib/cors";
import type { Server as HttpServer } from "node:http";
import { Server } from "socket.io";
import { verifyAccess } from "./lib/tokens";
import { platformPrisma } from "./db";
import { outboxEmitOutlet, outboxEmitUser, type SocketEmitter } from "./lib/outbox";
import { env } from "./env";

let io: Server | undefined;

/**
 * Socket.io rooms: `outlet:<id>` for POS/KDS sync, `user:<id>` for personal
 * notifications. Clients authenticate with the access token and pass the
 * outlet they are working in.
 */
export function initRealtime(server: HttpServer) {
  io = new Server(server, { cors: { origin: allowedOrigin() } });
  io.use(async (socket, next) => {
    try {
      const claims = verifyAccess(String(socket.handshake.auth.token ?? ""));
      const outletId = String(socket.handshake.auth.outletId ?? "");
      const user = await platformPrisma.user.findUnique({ where: { id: claims.sub }, include: { outlets: true } });
      if (!user || user.tokenVersion !== claims.tv || user.status !== "ACTIVE") return next(new Error("unauthorized"));
      let allowed = user.outlets.some((o) => o.outletId === outletId);
      // Owners work business-wide without outlet assignments (BUG-006: they never got live updates).
      if (!allowed && outletId && user.role === "BUSINESS_OWNER" && user.businessId) {
        allowed = Boolean(await platformPrisma.outlet.findFirst({ where: { id: outletId, businessId: user.businessId }, select: { id: true } }));
      }
      socket.join(`user:${user.id}`);
      if (outletId && allowed) socket.join(`outlet:${outletId}`);
      next();
    } catch {
      next(new Error("unauthorized"));
    }
  });
  return io;
}

/**
 * Share rooms across API instances through Redis (Phase 1.5). With REDIS_URL unset the
 * server stays single-instance (in-memory adapter). Returns a closer for shutdown.
 */
export async function attachRedisAdapter(url = env.REDIS_URL, server: Server | undefined = io): Promise<(() => Promise<void>) | null> {
  if (!server || !url) return null;
  const [{ createAdapter }, { createClient }] = await Promise.all([import("@socket.io/redis-adapter"), import("redis")]);
  const pub = createClient({ url });
  const sub = pub.duplicate();
  pub.on("error", (e) => console.error("[realtime] redis pub error", e));
  sub.on("error", (e) => console.error("[realtime] redis sub error", e));
  await Promise.all([pub.connect(), sub.connect()]);
  server.adapter(createAdapter(pub, sub));
  console.info("[realtime] Socket.io rooms shared through Redis");
  return async () => {
    await Promise.allSettled([pub.quit(), sub.quit()]);
  };
}

/** The live emitter for the outbox publisher (null where there are no sockets, e.g. the worker). */
export const socketEmitter = (): SocketEmitter | null =>
  io
    ? {
        toOutlet: (outletId, event, payload) => io!.to(`outlet:${outletId}`).emit(event, payload),
        toUser: (userId, event, payload) => io!.to(`user:${userId}`).emit(event, payload),
      }
    : null;

/**
 * Emit now (API process). In a process without sockets (the background worker)
 * the event goes through the outbox and the API delivers it.
 * Inside a transaction, use outboxEmitOutlet(tx, …) instead so nothing is sent
 * for a change that rolls back.
 */
export function emitToOutlet(outletId: string, event: string, payload: unknown) {
  if (io) io.to(`outlet:${outletId}`).emit(event, payload);
  else void outboxEmitOutlet(platformPrisma, outletId, event, payload).catch((e) => console.error("[realtime] outbox enqueue failed", e));
}

export function emitToUser(userId: string, event: string, payload: unknown) {
  if (io) io.to(`user:${userId}`).emit(event, payload);
  else void outboxEmitUser(platformPrisma, userId, event, payload).catch((e) => console.error("[realtime] outbox enqueue failed", e));
}
