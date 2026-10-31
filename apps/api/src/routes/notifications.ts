import { Router } from "express";
import { deviceTokenSchema } from "@canavo/shared";
import { prisma } from "../db";
import { notFound, param, parse } from "../lib/http";
import { defaultLink } from "../services/notify";
import { emitToUser } from "../realtime";
import { authenticate } from "../middleware/auth";

export const notificationsRouter = Router();
notificationsRouter.use(authenticate);

/**
 * My notifications, newest first. `?unread=1` only unread; `?before=<ISO>` for
 * the next page; `?limit` (max 100). Older rows without a link get the default
 * screen for their kind.
 */
notificationsRouter.get("/", async (req, res) => {
  const unreadOnly = req.query.unread === "1";
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 100);
  const before = typeof req.query.before === "string" ? new Date(req.query.before) : undefined;
  // ?kind=delivery matches "delivery" and "delivery.*" (comma-separated for several families)
  const kinds = typeof req.query.kind === "string" ? req.query.kind.split(",").map((k) => k.trim()).filter(Boolean) : [];
  const where = {
    userId: req.user!.id,
    ...(unreadOnly && { read: false }),
    ...(before && !Number.isNaN(before.getTime()) && { createdAt: { lt: before } }),
    ...(kinds.length && { OR: kinds.map((k) => ({ kind: { startsWith: k } })) }),
  };
  const [items, unread] = await Promise.all([
    prisma.notification.findMany({ where, orderBy: { createdAt: "desc" }, take: limit + 1 }),
    prisma.notification.count({ where: { userId: req.user!.id, read: false } }),
  ]);
  const page = items.slice(0, limit).map((n) => ({ ...n, link: n.link ?? defaultLink(n.kind) }));
  res.json({ items: page, unread, hasMore: items.length > limit, nextBefore: items.length > limit ? page[page.length - 1].createdAt : null });
});

notificationsRouter.post("/read-all", async (req, res) => {
  await prisma.notification.updateMany({ where: { userId: req.user!.id, read: false }, data: { read: true } });
  emitToUser(req.user!.id, "notification:read", { all: true });
  res.status(204).end();
});

/** Mark one notification read (e.g. when it's tapped). */
notificationsRouter.post("/:id/read", async (req, res) => {
  const { count } = await prisma.notification.updateMany({ where: { id: param(req, "id"), userId: req.user!.id }, data: { read: true } });
  if (!count) throw notFound("Notification");
  emitToUser(req.user!.id, "notification:read", { id: param(req, "id") });
  res.json({ unread: await prisma.notification.count({ where: { userId: req.user!.id, read: false } }) });
});

/** Mark one notification unread again. */
notificationsRouter.post("/:id/unread", async (req, res) => {
  const { count } = await prisma.notification.updateMany({ where: { id: param(req, "id"), userId: req.user!.id }, data: { read: false } });
  if (!count) throw notFound("Notification");
  emitToUser(req.user!.id, "notification:read", { id: param(req, "id"), read: false });
  res.json({ unread: await prisma.notification.count({ where: { userId: req.user!.id, read: false } }) });
});

/** Clear notifications already read (synced to the user's other tabs / devices). */
notificationsRouter.delete("/read", async (req, res) => {
  const { count } = await prisma.notification.deleteMany({ where: { userId: req.user!.id, read: true } });
  emitToUser(req.user!.id, "notification:read", { cleared: true });
  res.json({ deleted: count });
});

/** Register (or re-assign to the current user) an Expo push token for this device. */
notificationsRouter.post("/devices", async (req, res) => {
  const { token, platform } = parse(deviceTokenSchema, req.body);
  const device = await prisma.deviceToken.upsert({
    where: { token },
    create: { token, platform, userId: req.user!.id },
    update: { platform, userId: req.user!.id },
  });
  res.status(201).json(device);
});

notificationsRouter.delete("/devices/:token", async (req, res) => {
  await prisma.deviceToken.deleteMany({ where: { token: param(req, "token"), userId: req.user!.id } });
  res.status(204).end();
});
