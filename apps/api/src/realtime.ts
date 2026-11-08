import { allowedOrigin } from "./lib/cors";
import type { Server as HttpServer } from "node:http";
import { Server } from "socket.io";
import { sessionActive, verifyAccess } from "./lib/tokens";
import { platformPrisma } from "./db";
import { outboxEmitOutlet, outboxEmitUser, type SocketEmitter } from "./lib/outbox";
import { env } from "./env";

let io: Server | undefined;
let sweepTimer: NodeJS.Timeout | undefined;

/** How often live sockets are re-checked against the database (deactivation, outlet removal, suspension). */
export const SOCKET_REVALIDATE_MS = 60_000;

interface SocketIdentity {
  userId: string;
  tv: number;
  sid?: string;
  outletId: string;
}

/**
 * Is the identity still allowed on a socket, and may it receive the outlet's events?
 * Same rules as `authenticate`: active user, current token version, live session,
 * active business (platform users have none); outlet = assignment, or any outlet of
 * the owner's business.
 */
async function checkIdentity(id: SocketIdentity): Promise<{ ok: false } | { ok: true; outletAllowed: boolean }> {
  const user = await platformPrisma.user.findUnique({
    where: { id: id.userId },
    include: { outlets: true, business: { select: { status: true } } },
  });
  if (!user || user.tokenVersion !== id.tv || user.status !== "ACTIVE") return { ok: false };
  if (user.business && user.business.status !== "ACTIVE") return { ok: false };
  if (id.sid && !(await sessionActive(id.sid))) return { ok: false };
  let outletAllowed = Boolean(id.outletId) && user.outlets.some((o) => o.outletId === id.outletId);
  // Owners work business-wide without outlet assignments (BUG-006: they never got live updates).
  if (!outletAllowed && id.outletId && user.role === "BUSINESS_OWNER" && user.businessId) {
    outletAllowed = Boolean(await platformPrisma.outlet.findFirst({ where: { id: id.outletId, businessId: user.businessId }, select: { id: true } }));
  }
  return { ok: true, outletAllowed };
}

/**
 * Socket.io rooms: `outlet:<id>` for POS/KDS sync, `user:<id>` for personal
 * notifications, `session:<sid>` to end one device's sockets. Clients authenticate
 * with the access token and pass the outlet they are working in. Sockets are
 * disconnected when their session ends (logout, device sign-out, forceLogout) and
 * re-checked every minute (rt-1/rt-2).
 */
export function initRealtime(server: HttpServer) {
  io = new Server(server, { cors: { origin: allowedOrigin() } });
  io.use(async (socket, next) => {
    try {
      const claims = verifyAccess(String(socket.handshake.auth.token ?? ""));
      const id: SocketIdentity = { userId: claims.sub, tv: claims.tv, sid: claims.sid, outletId: String(socket.handshake.auth.outletId ?? "") };
      const check = await checkIdentity(id);
      if (!check.ok) return next(new Error("unauthorized"));
      socket.data = id;
      socket.join(`user:${id.userId}`);
      if (id.sid) socket.join(`session:${id.sid}`);
      if (check.outletAllowed) socket.join(`outlet:${id.outletId}`);
      next();
    } catch {
      next(new Error("unauthorized"));
    }
  });
  clearInterval(sweepTimer);
  sweepTimer = setInterval(() => void revalidateSockets().catch((e) => console.error("[realtime] revalidate failed", e)), SOCKET_REVALIDATE_MS);
  sweepTimer.unref();
  return io;
}

/**
 * Re-check live sockets (all on this instance, or one user's on every instance):
 * invalid ones are disconnected, sockets that lost their outlet leave its room.
 * One database check per distinct identity (200 kitchen screens on one login = 1 check).
 */
export async function revalidateSockets(userId?: string) {
  if (!io) return;
  const sockets = userId ? await io.in(`user:${userId}`).fetchSockets() : await io.local.fetchSockets();
  const groups = new Map<string, typeof sockets>();
  for (const s of sockets) {
    const d = s.data as SocketIdentity | undefined;
    if (!d?.userId) continue;
    const key = `${d.userId}|${d.tv}|${d.sid ?? ""}|${d.outletId}`;
    groups.set(key, [...(groups.get(key) ?? []), s]);
  }
  for (const group of groups.values()) {
    const d = group[0].data as SocketIdentity;
    const check = await checkIdentity(d);
    for (const s of group) {
      if (!check.ok) s.disconnect(true);
      else if (!check.outletAllowed && d.outletId) s.leave(`outlet:${d.outletId}`);
    }
  }
}

/** End live sockets of a user (every device) or of one session (one device). Works across instances. */
export function disconnectSockets(target: { userId: string } | { sid: string }) {
  if (!io) return;
  io.in("userId" in target ? `user:${target.userId}` : `session:${target.sid}`).disconnectSockets(true);
}

/** Shutdown: stop the revalidation sweep and disconnect this instance's sockets (clients reconnect elsewhere). */
export function closeRealtime() {
  clearInterval(sweepTimer);
  io?.local.disconnectSockets(true);
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
