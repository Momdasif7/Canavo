import { Router, type Request } from "express";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import {
  reservationCancelSchema,
  reservationCreateSchema,
  reservationListQuerySchema,
  reservationSeatSchema,
  reservationUpdateSchema,
  type PreOrderItem,
} from "@canavo/shared";
import { prisma } from "../db";
import { audit } from "../lib/audit";
import { badRequest, conflict, notFound, param, parse } from "../lib/http";
import { startOfLocalDay } from "../lib/time";
import { authenticate, requireOutlet, requirePermission, requireModule } from "../middleware/auth";
import { emitToOutlet } from "../realtime";
import { addItemsToSession, emitTables, findOpenSession, loadMenu, openSession, priceLine } from "./tables";

export const reservationsRouter = Router();
reservationsRouter.use(authenticate, requireOutlet, requireModule("RESERVATIONS"));

const include = { table: { select: { id: true, label: true, capacity: true } } } as const;

function dayRange(date: string, tz: string) {
  const start = startOfLocalDay(date, tz);
  return { gte: start, lt: new Date(start.getTime() + 86_400_000) };
}

async function validateTable(outletId: string, tableId: string | null | undefined, partySize: number) {
  if (!tableId) return null;
  const table = await prisma.diningTable.findFirst({ where: { id: tableId, outletId, active: true } });
  if (!table) throw notFound("Table");
  if (table.capacity < partySize) throw badRequest(`Table ${table.label} seats ${table.capacity}; party of ${partySize} needs a bigger table (or merge tables when seating)`);
  return table;
}

/**
 * No two BOOKED reservations may overlap on the same table. Inside a transaction, lock the table
 * first so two bookings made at the same moment can't both pass the check.
 */
async function assertNoOverlap(outletId: string, tableId: string | null | undefined, start: Date, durationMin: number, excludeId?: string, db: Prisma.TransactionClient | typeof prisma = prisma) {
  if (!tableId) return;
  if (db !== prisma) await db.$queryRaw`SELECT id FROM "DiningTable" WHERE id = ${tableId} FOR UPDATE`;
  const end = start.getTime() + durationMin * 60_000;
  const candidates = await db.reservation.findMany({
    where: {
      outletId,
      tableId,
      status: "BOOKED",
      id: excludeId ? { not: excludeId } : undefined,
      reservedFor: { gte: new Date(start.getTime() - 12 * 3_600_000), lt: new Date(end) },
    },
  });
  const clash = candidates.find((r) => r.reservedFor.getTime() + r.durationMin * 60_000 > start.getTime());
  if (clash) {
    throw conflict(`Table already booked for ${clash.customerName} at ${clash.reservedFor.toISOString()} (${clash.durationMin} min)`);
  }
}

async function validatePreOrder(outletId: string, items: PreOrderItem[], checkAvailable = false) {
  if (!items.length) return;
  const menu = await loadMenu(outletId, items.map((i) => i.menuItemId));
  for (const i of items) priceLine(menu, i, checkAvailable);
}

async function findReservation(id: string, outletId: string) {
  const r = await prisma.reservation.findFirst({ where: { id, outletId }, include });
  if (!r) throw notFound("Reservation");
  return r;
}

/** Free a RESERVED table again when nothing else is due on it soon. */
async function releaseReservedTable(outletId: string, tableId: string | null) {
  if (!tableId) return;
  const table = await prisma.diningTable.findUnique({ where: { id: tableId } });
  if (table?.status !== "RESERVED") return;
  const soon = await prisma.reservation.count({
    where: { tableId, status: "BOOKED", reservedFor: { lte: new Date(Date.now() + 30 * 60_000), gte: new Date(Date.now() - 30 * 60_000) } },
  });
  if (!soon && !(await findOpenSession(outletId, tableId))) {
    await prisma.diningTable.update({ where: { id: tableId }, data: { status: "AVAILABLE" } });
    emitTables(outletId, { tableIds: [tableId], action: "status" });
  }
}

reservationsRouter.get("/", requirePermission("reservation:manage"), async (req, res) => {
  const q = parse(reservationListQuerySchema, req.query);
  const outlet = await prisma.outlet.findUniqueOrThrow({ where: { id: req.outletId } });
  res.json(
    await prisma.reservation.findMany({
      where: {
        outletId: req.outletId,
        ...(q.status && { status: q.status }),
        ...(q.date ? { reservedFor: dayRange(q.date, outlet.timezone) } : !q.status && { reservedFor: { gte: new Date(Date.now() - 3 * 3_600_000) } }),
      },
      include,
      orderBy: { reservedFor: "asc" },
      take: 500,
    }),
  );
});

/** Upcoming takeaway/pickup pre-orders (POST /orders with orderType PRE_ORDER + scheduledFor). */
reservationsRouter.get("/pre-orders", requirePermission("reservation:manage"), async (req, res) => {
  const q = parse(z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }), req.query);
  const outlet = await prisma.outlet.findUniqueOrThrow({ where: { id: req.outletId } });
  const orders = await prisma.order.findMany({
    where: {
      outletId: req.outletId,
      orderType: "PRE_ORDER",
      status: { not: "CANCELLED" },
      scheduledFor: q.date ? dayRange(q.date, outlet.timezone) : { gte: new Date(Date.now() - 3_600_000) },
    },
    include: {
      items: { select: { name: true, quantity: true, notes: true } },
      kots: { select: { id: true, kotNumber: true, station: true, status: true, releaseAt: true } },
      payments: { select: { amount: true, status: true, mode: true } },
    },
    orderBy: { scheduledFor: "asc" },
    take: 500,
  });
  const now = Date.now();
  res.json(
    orders.map((o) => ({
      ...o,
      kitchenReleased: o.kots.every((k) => !k.releaseAt || k.releaseAt.getTime() <= now),
      releaseAt: o.kots.map((k) => k.releaseAt).filter(Boolean).sort()[0] ?? null,
      amountPaid: o.payments.filter((p) => p.status === "SUCCESS").reduce((s, p) => s + p.amount, 0),
    })),
  );
});

reservationsRouter.get("/:id", requirePermission("reservation:manage"), async (req, res) => {
  res.json(await findReservation(param(req, "id"), req.outletId!));
});

reservationsRouter.post("/", requirePermission("reservation:manage"), async (req, res) => {
  const data = parse(reservationCreateSchema, req.body);
  const outletId = req.outletId!;
  const reservedFor = new Date(data.reservedFor);
  if (reservedFor.getTime() < Date.now() - 15 * 60_000) throw badRequest("Reservation time is in the past");
  await validateTable(outletId, data.tableId, data.partySize);
  await validatePreOrder(outletId, data.preOrderItems);
  const r = await prisma.$transaction(async (tx) => {
    await assertNoOverlap(outletId, data.tableId, reservedFor, data.durationMin, undefined, tx);
    return tx.reservation.create({
      data: {
        ...data,
        outletId,
        reservedFor,
        preOrderItems: data.preOrderItems as unknown as Prisma.InputJsonValue,
        createdById: req.user!.id,
      },
      include,
    });
  });
  await audit(req, "reservation.create", "Reservation", r.id, { reservedFor: data.reservedFor, partySize: data.partySize, advancePaid: data.advancePaid });
  emitToOutlet(outletId, "reservation:updated", r);
  res.status(201).json(r);
});

reservationsRouter.patch("/:id", requirePermission("reservation:manage"), async (req, res) => {
  const data = parse(reservationUpdateSchema, req.body);
  const outletId = req.outletId!;
  const existing = await findReservation(param(req, "id"), outletId);
  if (existing.status !== "BOOKED") throw conflict(`Reservation is ${existing.status.toLowerCase()}`);
  const merged = {
    tableId: data.tableId !== undefined ? data.tableId : existing.tableId,
    partySize: data.partySize ?? existing.partySize,
    reservedFor: data.reservedFor ? new Date(data.reservedFor) : existing.reservedFor,
    durationMin: data.durationMin ?? existing.durationMin,
  };
  await validateTable(outletId, merged.tableId, merged.partySize);
  if (data.preOrderItems) await validatePreOrder(outletId, data.preOrderItems);
  const r = await prisma.$transaction(async (tx) => {
    await assertNoOverlap(outletId, merged.tableId, merged.reservedFor, merged.durationMin, existing.id, tx);
    return tx.reservation.update({
      where: { id: existing.id },
      data: {
        ...data,
        reservedFor: merged.reservedFor,
        preOrderItems: data.preOrderItems as unknown as Prisma.InputJsonValue | undefined,
      },
      include,
    });
  });
  await audit(req, "reservation.update", "Reservation", r.id, data as unknown as Prisma.InputJsonValue);
  if (existing.tableId !== r.tableId || existing.reservedFor.getTime() !== r.reservedFor.getTime()) await releaseReservedTable(outletId, existing.tableId);
  emitToOutlet(outletId, "reservation:updated", r);
  res.json(r);
});

async function endReservation(req: Request, status: "CANCELLED" | "NO_SHOW", reason?: string) {
  const outletId = req.outletId!;
  const existing = await findReservation(param(req, "id"), outletId);
  if (existing.status !== "BOOKED") throw conflict(`Reservation is ${existing.status.toLowerCase()}`);
  const r = await prisma.reservation.update({
    where: { id: existing.id },
    data: { status, notes: reason ? [existing.notes, `${status}: ${reason}`].filter(Boolean).join("\n") : undefined },
    include,
  });
  await audit(req, status === "CANCELLED" ? "reservation.cancel" : "reservation.no_show", "Reservation", r.id, { reason: reason ?? null, advancePaid: r.advancePaid });
  await releaseReservedTable(outletId, r.tableId);
  emitToOutlet(outletId, "reservation:updated", r);
  return r;
}

reservationsRouter.post("/:id/cancel", requirePermission("reservation:manage"), async (req, res) => {
  const { reason } = parse(reservationCancelSchema, req.body ?? {});
  res.json(await endReservation(req, "CANCELLED", reason));
});

reservationsRouter.post("/:id/no-show", requirePermission("reservation:manage"), async (req, res) => {
  const { reason } = parse(reservationCancelSchema, req.body ?? {});
  res.json(await endReservation(req, "NO_SHOW", reason));
});

/**
 * Seat the party: opens a running tab on the table and, when the guest
 * pre-selected dishes, adds them to the tab and fires their KOTs right away.
 * The advance (`advancePaid`) is returned with the session — record it as a
 * payment on the bill (reference "ADVANCE"), it is not a discount.
 */
reservationsRouter.post("/:id/seat", requirePermission("reservation:manage", "table:serve"), async (req, res) => {
  const body = parse(reservationSeatSchema, req.body ?? {});
  const outletId = req.outletId!;
  const r = await findReservation(param(req, "id"), outletId);
  if (r.status !== "BOOKED") throw conflict(`Reservation is ${r.status.toLowerCase()}`);
  const tableId = body.tableId ?? r.tableId;
  if (!tableId) throw badRequest("Choose a table to seat this reservation");
  const preOrder = (r.preOrderItems ?? []) as unknown as PreOrderItem[];
  await validatePreOrder(outletId, preOrder, true);

  const session = await openSession(req, tableId, {
    guests: r.partySize,
    waiterId: body.waiterId,
    customerName: r.customerName,
    customerPhone: r.customerPhone,
  });
  await prisma.reservation.update({ where: { id: r.id }, data: { status: "SEATED", sessionId: session.id, tableId } });
  const kots = preOrder.length
    ? await addItemsToSession(req, session, preOrder.map((i) => ({ ...i, addonIds: i.addonIds ?? [] })))
    : [];
  await audit(req, "reservation.seat", "Reservation", r.id, { sessionId: session.id, tableId, preOrderItems: preOrder.length });
  const updated = await findReservation(r.id, outletId);
  emitToOutlet(outletId, "reservation:updated", updated);
  res.status(201).json({ reservation: updated, session: { ...session, advancePaid: r.advancePaid }, kots, advancePaid: r.advancePaid });
});
