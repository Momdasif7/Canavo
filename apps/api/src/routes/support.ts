import { Router } from "express";
import { z } from "zod";
import { prisma } from "../db";
import { audit } from "../lib/audit";
import { badRequest, forbidden, notFound, param, parse } from "../lib/http";
import { authenticate, requireBusiness, requirePermission } from "../middleware/auth";

/**
 * Owner side of support access (Phase 2.4). The owner decides if and how long the CANAVO
 * team may look inside the hotel (read-only), can end it any time, and sees every screen
 * the support person opened.
 */
export const supportRouter = Router();
supportRouter.use(authenticate, requireBusiness, requirePermission("outlet:manage"));
supportRouter.use((req, _res, next) => {
  if (req.support) throw forbidden("Support access can't be changed from a support view");
  next();
});

const grantSchema = z.object({
  hours: z.number().int().min(1).max(72),
  reason: z.string().trim().max(300).optional(),
});

supportRouter.get("/", async (_req, res) => {
  const grants = await prisma.supportGrant.findMany({ orderBy: { createdAt: "desc" }, take: 20 });
  const views = await prisma.auditLog.groupBy({
    by: ["entityId"],
    where: { action: "support.view", entityId: { in: grants.map((g) => g.id) } },
    _count: { _all: true },
    _max: { createdAt: true },
  });
  const byGrant = new Map(views.map((v) => [v.entityId, v]));
  const now = new Date();
  res.json(
    grants.map((g) => ({
      ...g,
      active: !g.revokedAt && g.expiresAt > now,
      views: byGrant.get(g.id)?._count._all ?? 0,
      lastViewedAt: byGrant.get(g.id)?._max.createdAt ?? null,
    })),
  );
});

/** Grant (or replace) access for 1–72 hours. Only one grant is active at a time. */
supportRouter.post("/", async (req, res) => {
  const { hours, reason } = parse(grantSchema, req.body);
  const now = new Date();
  const grant = await prisma.$transaction(async (tx) => {
    await tx.supportGrant.updateMany({ where: { revokedAt: null, expiresAt: { gt: now } }, data: { revokedAt: now, revokedById: req.user!.id } });
    return tx.supportGrant.create({
      data: { businessId: req.businessId!, grantedById: req.user!.id, reason, expiresAt: new Date(now.getTime() + hours * 3_600_000) },
    });
  });
  await audit(req, "support.granted", "SupportGrant", grant.id, { hours, reason: reason ?? null });
  res.status(201).json(grant);
});

supportRouter.post("/:id/revoke", async (req, res) => {
  const id = param(req, "id");
  const grant = await prisma.supportGrant.findFirst({ where: { id } });
  if (!grant) throw notFound("Support access");
  if (grant.revokedAt || grant.expiresAt <= new Date()) throw badRequest("This access has already ended");
  await prisma.supportGrant.update({ where: { id }, data: { revokedAt: new Date(), revokedById: req.user!.id } });
  await audit(req, "support.revoked", "SupportGrant", id);
  res.json({ ok: true });
});

/** What the support person opened under one grant (newest first). */
supportRouter.get("/:id/activity", async (req, res) => {
  const id = param(req, "id");
  if (!(await prisma.supportGrant.findFirst({ where: { id }, select: { id: true } }))) throw notFound("Support access");
  const rows = await prisma.auditLog.findMany({
    where: { action: "support.view", entityId: id },
    orderBy: { createdAt: "desc" },
    take: 500,
    select: { id: true, createdAt: true, meta: true, ip: true, user: { select: { name: true } } },
  });
  res.json(rows.map((r) => ({ id: r.id, at: r.createdAt, ...(r.meta as { method: string; path: string }), ip: r.ip, by: r.user?.name ?? null })));
});
