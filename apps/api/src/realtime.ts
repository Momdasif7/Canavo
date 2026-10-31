import { allowedOrigin } from "./lib/cors";
import type { Server as HttpServer } from "node:http";
import { Server } from "socket.io";
import { env } from "./env";
import { verifyAccess } from "./lib/tokens";
import { prisma } from "./db";

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
      const user = await prisma.user.findUnique({ where: { id: claims.sub }, include: { outlets: true } });
      if (!user || user.tokenVersion !== claims.tv) return next(new Error("unauthorized"));
      const allowed = user.outlets.some((o) => o.outletId === outletId);
      socket.join(`user:${user.id}`);
      if (outletId && allowed) socket.join(`outlet:${outletId}`);
      next();
    } catch {
      next(new Error("unauthorized"));
    }
  });
}

export function emitToOutlet(outletId: string, event: string, payload: unknown) {
  io?.to(`outlet:${outletId}`).emit(event, payload);
}

export function emitToUser(userId: string, event: string, payload: unknown) {
  io?.to(`user:${userId}`).emit(event, payload);
}
