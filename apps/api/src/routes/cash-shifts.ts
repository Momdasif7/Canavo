import { Router } from "express";
import { z } from "zod";
import { cashMovementSchema, shiftCloseSchema, shiftOpenSchema } from "@canavo/shared";
import { prisma } from "../db";
import { param, parse } from "../lib/http";
import { authenticate, requireModule, requireOutlet, requirePermission } from "../middleware/auth";
import { addMovement, closeShift, getShift, openShift, shiftSummary, startShift } from "../services/cash-shifts";

/** Cash drawer shifts, pay-ins / pay-outs and X / Z reports (Phase 3.2). */
export const cashShiftsRouter = Router();
cashShiftsRouter.use(authenticate, requireOutlet, requireModule("BILLING"));

/** The open shift with live (X-report) figures, or null. */
cashShiftsRouter.get("/current", requirePermission("payment:collect"), async (req, res) => {
  const shift = await openShift(req.outletId!);
  res.json(shift ? { ...shift, summary: await shiftSummary(shift) } : null);
});

cashShiftsRouter.post("/open", requirePermission("payment:collect"), async (req, res) => {
  res.status(201).json(await startShift(req, parse(shiftOpenSchema, req.body).openingFloat));
});

cashShiftsRouter.post("/current/movements", requirePermission("payment:collect"), async (req, res) => {
  res.status(201).json(await addMovement(req, parse(cashMovementSchema, req.body)));
});

cashShiftsRouter.post("/current/close", requirePermission("payment:collect"), async (req, res) => {
  res.json(await closeShift(req, parse(shiftCloseSchema, req.body)));
});

/** Past shifts (owner / manager). */
cashShiftsRouter.get("/", requirePermission("report:view"), async (req, res) => {
  const { limit } = parse(z.object({ limit: z.coerce.number().int().min(1).max(200).default(30) }), req.query);
  res.json(
    await prisma.cashShift.findMany({
      where: { outletId: req.outletId! },
      orderBy: { openedAt: "desc" },
      take: limit,
      select: { id: true, status: true, openedAt: true, closedAt: true, openingFloat: true, expectedCash: true, countedCash: true, variance: true, openedById: true, closedById: true, note: true },
    }),
  );
});

/** Z-report of one shift. */
cashShiftsRouter.get("/:id", requirePermission("report:view"), async (req, res) => {
  res.json(await getShift(req.outletId!, param(req, "id")));
});
