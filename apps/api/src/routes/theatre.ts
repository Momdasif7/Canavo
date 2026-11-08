import { Router } from "express";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { screenSchema, screenUpdateSchema, seatBulkSchema, showTimeSchema, showTimeUpdateSchema, theatreSettingsSchema } from "@canavo/shared";
import { prisma } from "../db";
import { audit } from "../lib/audit";
import { conflict, notFound, param, parse } from "../lib/http";
import { isValidYmd, zonedParts } from "../lib/time";
import { authenticate, requireModule, requireOutlet, requirePermission } from "../middleware/auth";
import { newPublicToken } from "../services/storefront";
import { readTheatreSettings } from "../services/theatre-kot";
import {
  addSeats,
  checkShowTimes,
  deleteScreen,
  deleteSeat,
  findScreen,
  findSeatRequest,
  findShow,
  moveStage,
  nextScreenCode,
  runnerBoard,
  saveShow,
  screenView,
  screenViews,
  showsOnDay,
  showView,
} from "../services/theatre";
import { emitKotsUpdated } from "./kot";
import { emitTables } from "./tables";

/**
 * Cinema seat ordering (THEATRE), staff side: screens and seats, showtimes, theatre settings and the
 * runner board. Contract: docs/build/theatre-contract.md.
 */
export const theatreRouter = Router();
theatreRouter.use(authenticate, requireOutlet, requireModule("THEATRE"));

const serve = requirePermission("table:serve");
const manage = requirePermission("table:manage");

// ---------- Screens and seats ----------

theatreRouter.get("/screens", serve, async (req, res) => {
  res.json(await screenViews(req.outletId!));
});

theatreRouter.post("/screens", manage, async (req, res) => {
  const data = parse(screenSchema, req.body);
  const outletId = req.outletId!;
  const area = await prisma.$transaction(async (tx) => {
    // Screen codes are handed out under a lock so two screens created at once don't both get "S3".
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`screen:${outletId}`}))`;
    const code = await nextScreenCode(outletId, tx);
    const sortOrder = data.sortOrder ?? (await tx.diningArea.count({ where: { outletId, kind: "SCREEN" } })) + 1;
    return tx.diningArea.create({ data: { outletId, name: data.name, sortOrder, kind: "SCREEN", code, qrToken: newPublicToken() } });
  });
  await audit(req, "theatre.screen.create", "DiningArea", area.id, { name: area.name, code: area.code });
  res.status(201).json(await screenView(outletId, area.id));
});

theatreRouter.patch("/screens/:id", manage, async (req, res) => {
  const screen = await findScreen(param(req, "id"), req.outletId!);
  const data = parse(screenUpdateSchema, req.body);
  await prisma.diningArea.update({ where: { id: screen.id }, data });
  await audit(req, "theatre.screen.update", "DiningArea", screen.id, data);
  res.json(await screenView(req.outletId!, screen.id));
});

theatreRouter.delete("/screens/:id", manage, async (req, res) => {
  const screen = await findScreen(param(req, "id"), req.outletId!);
  await deleteScreen(screen);
  await audit(req, "theatre.screen.delete", "DiningArea", screen.id, { name: screen.name, code: screen.code });
  res.status(204).end();
});

theatreRouter.post("/screens/:id/seats", manage, async (req, res) => {
  const screen = await findScreen(param(req, "id"), req.outletId!);
  const input = parse(seatBulkSchema, req.body);
  const result = await addSeats(screen, input);
  await audit(req, "theatre.seats.add", "DiningArea", screen.id, { rows: input.rows, from: input.from, to: input.to, skip: input.skip.length, ...result });
  res.json(result);
});

theatreRouter.post("/screens/:id/qr/rotate", manage, async (req, res) => {
  const screen = await findScreen(param(req, "id"), req.outletId!);
  await prisma.diningArea.update({ where: { id: screen.id }, data: { qrToken: newPublicToken() } });
  await audit(req, "theatre.screen.qr_rotate", "DiningArea", screen.id, { name: screen.name });
  res.json(await screenView(req.outletId!, screen.id));
});

theatreRouter.delete("/seats/:id", manage, async (req, res) => {
  const seat = await prisma.diningTable.findFirst({ where: { id: param(req, "id"), outletId: req.outletId, seatRow: { not: null } } });
  if (!seat) throw notFound("Seat");
  const outcome = await deleteSeat(seat);
  await audit(req, outcome === "deleted" ? "theatre.seat.delete" : "theatre.seat.deactivate", "DiningTable", seat.id, { label: seat.label });
  emitTables(req.outletId!, { tableIds: [seat.id], action: "delete" });
  res.status(204).end();
});

// ---------- Showtimes ----------

const showQuery = z.object({
  date: z.string().refine(isValidYmd, "Use a real date (YYYY-MM-DD)").optional(),
  screenId: z.string().min(1).max(40).optional(),
});

theatreRouter.get("/showtimes", serve, async (req, res) => {
  const q = parse(showQuery, req.query);
  const outlet = await prisma.outlet.findUniqueOrThrow({ where: { id: req.outletId }, select: { id: true, timezone: true } });
  if (q.screenId) await findScreen(q.screenId, outlet.id);
  res.json(await showsOnDay(outlet, q.date ?? zonedParts(new Date(), outlet.timezone).date, q.screenId));
});

theatreRouter.post("/showtimes", manage, async (req, res) => {
  const d = parse(showTimeSchema, req.body);
  const screen = await findScreen(d.screenId, req.outletId!);
  const show = await saveShow(req.outletId!, screen.id, {
    title: d.title,
    startsAt: new Date(d.startsAt),
    intervalAt: d.intervalAt ? new Date(d.intervalAt) : null,
    endsAt: new Date(d.endsAt),
    orderCutoffMin: d.orderCutoffMin,
  });
  await audit(req, "theatre.show.create", "ShowTime", show.id, { title: show.title, screen: screen.name, startsAt: show.startsAt.toISOString() });
  res.status(201).json(showView(show));
});

theatreRouter.patch("/showtimes/:id", manage, async (req, res) => {
  const found = await findShow(param(req, "id"), req.outletId!);
  const d = parse(showTimeUpdateSchema, req.body);
  const times = {
    startsAt: d.startsAt ? new Date(d.startsAt) : found.startsAt,
    intervalAt: d.intervalAt === undefined ? found.intervalAt : d.intervalAt ? new Date(d.intervalAt) : null,
    endsAt: d.endsAt ? new Date(d.endsAt) : found.endsAt,
  };
  checkShowTimes(times);
  const show = await saveShow(req.outletId!, found.areaId, { title: d.title ?? found.title, orderCutoffMin: d.orderCutoffMin ?? found.orderCutoffMin, ...times }, found.id);
  await audit(req, "theatre.show.update", "ShowTime", show.id, d);
  res.json(showView(show));
});

theatreRouter.delete("/showtimes/:id", manage, async (req, res) => {
  const show = await findShow(param(req, "id"), req.outletId!);
  // Its orders keep pointing at it (reports group sales by show).
  if (await prisma.channelRequest.count({ where: { showTimeId: show.id } })) throw conflict("This show has orders — it stays for the reports (edit it instead)");
  await prisma.showTime.delete({ where: { id: show.id } });
  await audit(req, "theatre.show.delete", "ShowTime", show.id, { title: show.title });
  res.status(204).end();
});

// ---------- Settings ----------

theatreRouter.get("/settings", serve, async (req, res) => {
  const outlet = await prisma.outlet.findUniqueOrThrow({ where: { id: req.outletId }, select: { storefront: true } });
  res.json(readTheatreSettings(outlet));
});

theatreRouter.patch("/settings", manage, async (req, res) => {
  const patch = parse(theatreSettingsSchema.partial().strict(), req.body);
  const settings = await prisma.$transaction(async (tx) => {
    // Lock the outlet row: a concurrent storefront settings save must not drop the theatre key (or vice versa).
    await tx.$queryRaw`SELECT id FROM "Outlet" WHERE id = ${req.outletId} FOR UPDATE`;
    const outlet = await tx.outlet.findUniqueOrThrow({ where: { id: req.outletId }, select: { storefront: true } });
    const stored = outlet.storefront && typeof outlet.storefront === "object" && !Array.isArray(outlet.storefront) ? (outlet.storefront as Record<string, unknown>) : {};
    const next = { ...readTheatreSettings(outlet), ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) };
    await tx.outlet.update({ where: { id: req.outletId }, data: { storefront: { ...stored, theatre: next } as Prisma.InputJsonValue } });
    return next;
  });
  await audit(req, "theatre.settings", "Outlet", req.outletId!, settings);
  res.json(settings);
});

// ---------- Runner board ----------

theatreRouter.get("/board", serve, async (req, res) => {
  const { screenId } = parse(z.object({ screenId: z.string().min(1).max(40).optional() }), req.query);
  if (screenId) await findScreen(screenId, req.outletId!);
  const outlet = await prisma.outlet.findUniqueOrThrow({ where: { id: req.outletId } });
  res.json(await runnerBoard(outlet, screenId));
});

for (const [path, stage] of [
  ["ready", "READY"],
  ["delivered", "DELIVERED"],
] as const) {
  theatreRouter.post(`/orders/:requestId/${path}`, serve, async (req, res) => {
    const request = await findSeatRequest(param(req, "requestId"), req.outletId!);
    const outlet = await prisma.outlet.findUniqueOrThrow({ where: { id: req.outletId } });
    const { order, kotIds } = await moveStage(req, outlet, request, stage);
    void emitKotsUpdated(req.outletId!, kotIds).catch((e) => console.error("[theatre] kot emit failed", e));
    res.json(order);
  });
}
