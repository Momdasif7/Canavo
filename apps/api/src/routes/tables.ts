import { Router, type Request } from "express";
import { Prisma } from "@prisma/client";
import {
  computeBill,
  effectiveGstRate,
  type LineTax,
  diningAreaSchema,
  diningTableSchema,
  diningTableUpdateSchema,
  itemVoidSchema,
  OrderCreateInput,
  sessionBillSchema,
  sessionItemsSchema,
  sessionMergeSchema,
  sessionOpenSchema,
  sessionTransferSchema,
  sessionUpdateSchema,
  tableLayoutSchema,
  tableStatusSchema,
  tableWaiterSchema,
  type SessionItemInput,
} from "@canavo/shared";
import { prisma } from "../db";
import { audit } from "../lib/audit";
import { badRequest, conflict, notFound, param, parse } from "../lib/http";
import { startOfLocalDay, zonedParts } from "../lib/time";
import { authenticate, requireOutlet, requirePermission, requireModule } from "../middleware/auth";
import { emitToOutlet } from "../realtime";
import { createOrder } from "../services/billing";
import { equalSplit, groupBillItems, runWithSessionBill } from "../services/service-context";
import { resolveItemTax, taxConfigForOutlet } from "../services/tax";
import { alertKitchenNewKots, alertTableAttention } from "../services/alerts";

export const tablesRouter = Router();
tablesRouter.use(authenticate, requireOutlet, requireModule("TABLES"));

type Tx = Prisma.TransactionClient;
type Db = Tx | typeof prisma;

// =====================================================================
// Shared helpers (also used by reservations)
// =====================================================================

export function emitTables(outletId: string, payload: { tableIds: string[]; sessionId?: string; action: string }) {
  emitToOutlet(outletId, "table:updated", payload);
}

const menuInclude = (outletId: string) =>
  ({ variants: true, addons: true, overrides: { where: { outletId } } }) satisfies Prisma.MenuItemInclude;
type MenuRow = Prisma.MenuItemGetPayload<{ include: ReturnType<typeof menuInclude> }> & { tax: LineTax };

/** Menu rows with their resolved tax composition (item rate → business default → legacy). */
export async function loadMenu(outletId: string, ids: string[], db: Db = prisma) {
  const rows = await db.menuItem.findMany({ where: { id: { in: [...new Set(ids)] } }, include: menuInclude(outletId) });
  const taxes = await resolveItemTax(rows, undefined, db);
  return new Map(rows.map((m) => [m.id, { ...m, tax: taxes.get(m.id)! }]));
}

export interface PricedLine {
  name: string;
  unitPrice: number;
  /** Effective GST % (cgst + sgst), for display */
  gstRate: number;
  tax: LineTax;
  station: string;
  addons: string[];
}

/** Same price resolution as billing.ts: variant price, else outlet override, else base; plus add-ons. */
export function priceLine(
  menu: Map<string, MenuRow>,
  line: { menuItemId: string; variantId?: string | null; addonIds: string[] },
  checkAvailable = false,
): PricedLine {
  const item = menu.get(line.menuItemId);
  if (!item) throw badRequest(`Unknown menu item ${line.menuItemId}`);
  const override = item.overrides[0];
  if (checkAvailable && (override?.status ?? item.status) !== "AVAILABLE") throw badRequest(`${item.name} is not available`);
  const variant = line.variantId ? item.variants.find((v) => v.id === line.variantId) : undefined;
  if (line.variantId && !variant) throw badRequest(`Invalid size for ${item.name}`);
  const addons = line.addonIds.map((aid) => {
    const a = item.addons.find((x) => x.id === aid);
    if (!a) throw badRequest(`Invalid add-on for ${item.name}`);
    return a;
  });
  const base = variant?.price ?? override?.price ?? item.price;
  return {
    name: [item.name, variant && `(${variant.name})`].filter(Boolean).join(" "),
    unitPrice: base + addons.reduce((s, a) => s + a.price, 0),
    gstRate: effectiveGstRate(item.tax),
    tax: item.tax,
    station: item.kitchenStation,
    addons: addons.map((a) => a.name),
  };
}

/** Running-total estimate (DINE_IN tax config, no promotions). */
export function estimateTotal(
  outlet: Parameters<typeof taxConfigForOutlet>[0],
  lines: { unitPrice: number; tax: LineTax; quantity: number }[],
) {
  if (!lines.length) return { subtotal: 0, tax: 0, serviceCharge: 0, grandTotal: 0 };
  const bill = computeBill(
    lines.map((l) => ({ unitPrice: l.unitPrice, quantity: l.quantity, tax: l.tax })),
    taxConfigForOutlet(outlet, { orderType: "DINE_IN" }),
  );
  return { subtotal: bill.subtotal, tax: bill.totalTax, serviceCharge: bill.serviceCharge, grandTotal: bill.grandTotal };
}

/** Open session that covers this table (as primary or merged table). */
export function findOpenSession(outletId: string, tableId: string, db: Db = prisma) {
  return db.tableSession.findFirst({
    where: { outletId, status: "OPEN", OR: [{ tableId }, { mergedTableIds: { has: tableId } }] },
  });
}

export async function sessionLabel(session: { tableId: string; mergedTableIds: string[] }, db: Db = prisma) {
  const ids = [session.tableId, ...session.mergedTableIds];
  const tables = await db.diningTable.findMany({ where: { id: { in: ids } }, select: { id: true, label: true } });
  const byId = new Map(tables.map((t) => [t.id, t.label]));
  return ids.map((id) => byId.get(id) ?? "?").join("+");
}

async function loadOpenSession(id: string, outletId: string) {
  const s = await prisma.tableSession.findFirst({ where: { id, outletId } });
  if (!s) throw notFound("Table session");
  if (s.status !== "OPEN") throw conflict("Table session is closed");
  return s;
}

async function assertStaff(outletId: string, userId: string | null | undefined) {
  if (!userId) return;
  const u = await prisma.user.findFirst({ where: { id: userId, status: "ACTIVE", outlets: { some: { outletId } } } });
  if (!u) throw badRequest("Staff member not found in this outlet");
}

export async function openSession(
  req: Request,
  tableId: string,
  body: { guests: number; waiterId?: string; customerName?: string; customerPhone?: string },
) {
  const outletId = req.outletId!;
  const table = await prisma.diningTable.findFirst({ where: { id: tableId, outletId, active: true } });
  if (!table) throw notFound("Table");
  await assertStaff(outletId, body.waiterId);
  const session = await prisma.$transaction(async (tx) => {
    if (await findOpenSession(outletId, table.id, tx)) throw conflict(`Table ${table.label} already has an open tab`);
    const s = await tx.tableSession.create({
      data: {
        outletId,
        tableId: table.id,
        guests: body.guests,
        waiterId: body.waiterId ?? table.waiterId,
        customerName: body.customerName,
        customerPhone: body.customerPhone,
      },
    });
    await tx.diningTable.update({ where: { id: table.id }, data: { status: "OCCUPIED" } });
    await audit(req, "table.session.open", "TableSession", s.id, { table: table.label, guests: body.guests }, tx);
    return s;
  });
  emitTables(outletId, { tableIds: [table.id], sessionId: session.id, action: "open" });
  return session;
}

/**
 * Save a round of items on a running tab and fire one KOT per kitchen station
 * immediately (orderId null until billed). Emits `kot:new`.
 */
export async function addItemsToSession(
  req: Request,
  session: { id: string; outletId: string; tableId: string; mergedTableIds: string[] },
  items: SessionItemInput[],
) {
  const outletId = session.outletId;
  const outlet = await prisma.outlet.findUniqueOrThrow({ where: { id: outletId } });
  const menu = await loadMenu(outletId, items.map((i) => i.menuItemId));
  const priced = items.map((i) => ({ input: i, line: priceLine(menu, i, true) }));
  const label = await sessionLabel(session);

  const kots = await prisma.$transaction(async (tx) => {
    const today = zonedParts(new Date(), outlet.timezone).date;
    let kotNumber = await tx.kotTicket.count({ where: { outletId, createdAt: { gte: startOfLocalDay(today, outlet.timezone) } } });
    const byStation = new Map<string, typeof priced>();
    for (const p of priced) byStation.set(p.line.station, [...(byStation.get(p.line.station) ?? []), p]);
    const created = [];
    for (const [station, group] of byStation) {
      const rows: { id: string }[] = [];
      for (const p of group) {
        rows.push(
          await tx.tableSessionItem.create({
            data: {
              sessionId: session.id,
              menuItemId: p.input.menuItemId,
              variantId: p.input.variantId,
              addonIds: p.input.addonIds,
              quantity: p.input.quantity,
              notes: p.input.notes,
              seat: p.input.seat,
            },
          }),
        );
      }
      const kot = await tx.kotTicket.create({
        data: {
          outletId,
          sessionId: session.id,
          station,
          kotNumber: ++kotNumber,
          items: group.map((p, i) => ({
            name: p.line.name,
            quantity: p.input.quantity,
            addons: p.line.addons,
            notes: [p.input.seat ? `Seat ${p.input.seat}` : null, p.input.notes].filter(Boolean).join(" · ") || null,
            sessionItemId: rows[i].id,
          })),
        },
      });
      await tx.tableSessionItem.updateMany({ where: { id: { in: rows.map((r) => r.id) } }, data: { kotId: kot.id } });
      created.push(kot);
    }
    await audit(req, "table.session.items", "TableSession", session.id, { count: items.length, kots: created.map((k) => k.kotNumber) }, tx);
    return created;
  });

  const sessionInfo = { id: session.id, tableLabel: label, table: { label } };
  emitToOutlet(outletId, "kot:new", kots.map((k) => ({ ...k, order: null, session: sessionInfo })));
  void alertKitchenNewKots(outletId, kots, `Table ${sessionInfo.tableLabel}`);
  emitTables(outletId, { tableIds: [session.tableId, ...session.mergedTableIds], sessionId: session.id, action: "items" });
  return kots;
}

/** Full session view: items with names/prices, KOTs, orders, running estimate. */
async function sessionDetail(id: string, outletId: string) {
  const session = await prisma.tableSession.findFirst({
    where: { id, outletId },
    include: {
      items: { orderBy: { createdAt: "asc" } },
      kots: { orderBy: { createdAt: "asc" } },
      orders: { select: { id: true, invoiceNumber: true, status: true, grandTotal: true, createdAt: true, payments: { select: { amount: true, status: true, mode: true } } } },
      table: { select: { id: true, label: true, capacity: true } },
      waiter: { select: { id: true, name: true } },
    },
  });
  if (!session) throw notFound("Table session");
  const outlet = await prisma.outlet.findUniqueOrThrow({ where: { id: outletId } });
  const menu = await loadMenu(outletId, session.items.map((i) => i.menuItemId));
  const kotById = new Map(session.kots.map((k) => [k.id, k]));
  const items = session.items.map((i) => {
    const p = priceLine(menu, i);
    return {
      ...i,
      name: p.name,
      addons: p.addons,
      unitPrice: p.unitPrice,
      gstRate: p.gstRate,
      tax: p.tax,
      amount: p.unitPrice * i.quantity,
      kotNumber: i.kotId ? kotById.get(i.kotId)?.kotNumber : undefined,
      kotStatus: i.kotId ? kotById.get(i.kotId)?.status : undefined,
    };
  });
  const unbilled = items.filter((i) => !i.billedOrderId);
  const reservation = await prisma.reservation.findFirst({ where: { sessionId: session.id }, select: { id: true, advancePaid: true, customerName: true } });
  const label = await sessionLabel(session);
  return {
    ...session,
    label,
    items,
    openedMinutes: Math.floor((Date.now() - session.openedAt.getTime()) / 60_000),
    estimate: estimateTotal(outlet, items),
    unbilledEstimate: estimateTotal(outlet, unbilled),
    unbilledCount: unbilled.length,
    readyToClose:
      session.status === "OPEN" && unbilled.length === 0 && session.orders.every((o) => o.status !== "OPEN"),
    /** Advance taken at reservation time — record it as a payment (reference "ADVANCE") on the bill, not as a discount */
    advancePaid: reservation?.advancePaid ?? 0,
    reservationId: reservation?.id ?? null,
  };
}

// =====================================================================
// Floor view
// =====================================================================

tablesRouter.get("/floor", requirePermission("table:serve"), async (req, res) => {
  const outletId = req.outletId!;
  const now = new Date();
  const [outlet, areas, tables, sessions, reservations] = await Promise.all([
    prisma.outlet.findUniqueOrThrow({ where: { id: outletId } }),
    prisma.diningArea.findMany({ where: { outletId }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }] }),
    prisma.diningTable.findMany({
      where: { outletId, active: true },
      include: { waiter: { select: { id: true, name: true } } },
      orderBy: { label: "asc" },
    }),
    prisma.tableSession.findMany({
      where: { outletId, status: "OPEN" },
      include: {
        items: true,
        kots: { select: { id: true, kotNumber: true, status: true, station: true } },
        orders: { select: { id: true, status: true, grandTotal: true } },
        waiter: { select: { id: true, name: true } },
      },
    }),
    prisma.reservation.findMany({
      where: { outletId, status: "BOOKED", reservedFor: { gte: new Date(now.getTime() - 30 * 60_000), lte: new Date(now.getTime() + 60 * 60_000) } },
      orderBy: { reservedFor: "asc" },
    }),
  ]);
  const menu = await loadMenu(outletId, sessions.flatMap((s) => s.items.map((i) => i.menuItemId)));
  const labelById = new Map(tables.map((t) => [t.id, t.label]));
  const summaries = new Map<string, unknown>();
  for (const s of sessions) {
    const lines = s.items.map((i) => ({ ...priceLine(menu, i), quantity: i.quantity, billed: Boolean(i.billedOrderId) }));
    const unbilled = lines.filter((l) => !l.billed);
    const kotStatus: Record<string, number> = {};
    for (const k of s.kots) kotStatus[k.status] = (kotStatus[k.status] ?? 0) + 1;
    const summary = {
      id: s.id,
      primaryTableId: s.tableId,
      label: [s.tableId, ...s.mergedTableIds].map((id) => labelById.get(id) ?? "?").join("+"),
      guests: s.guests,
      waiter: s.waiter,
      customerName: s.customerName,
      openedAt: s.openedAt,
      openedMinutes: Math.floor((now.getTime() - s.openedAt.getTime()) / 60_000),
      itemsCount: s.items.reduce((n, i) => n + i.quantity, 0),
      unbilledCount: unbilled.length,
      runningTotal: estimateTotal(outlet, lines).grandTotal,
      unbilledTotal: estimateTotal(outlet, unbilled).grandTotal,
      kotStatus,
      kots: s.kots,
      orders: s.orders,
      readyToClose: s.items.length > 0 && unbilled.length === 0 && s.orders.every((o) => o.status !== "OPEN"),
    };
    for (const tid of [s.tableId, ...s.mergedTableIds]) summaries.set(tid, summary);
  }
  const tableRows = tables.map((t) => {
    const r = reservations.find((x) => x.tableId === t.id);
    return {
      ...t,
      session: summaries.get(t.id) ?? null,
      upcomingReservation: r
        ? { id: r.id, customerName: r.customerName, partySize: r.partySize, reservedFor: r.reservedFor, minutesAway: Math.round((r.reservedFor.getTime() - now.getTime()) / 60_000) }
        : null,
    };
  });
  res.json({
    areas: [
      ...areas.map((a) => ({ ...a, tables: tableRows.filter((t) => t.areaId === a.id) })),
      ...(tableRows.some((t) => !t.areaId) ? [{ id: null, name: "Unassigned", sortOrder: 9999, tables: tableRows.filter((t) => !t.areaId) }] : []),
    ],
    stats: {
      tables: tables.length,
      occupied: tableRows.filter((t) => t.session).length,
      available: tableRows.filter((t) => !t.session && t.status === "AVAILABLE").length,
      openSessions: sessions.length,
    },
    unassignedReservations: reservations.filter((r) => !r.tableId),
  });
});

/** Recent / open sessions (history). */
tablesRouter.get("/sessions", requirePermission("table:serve"), async (req, res) => {
  const status = req.query.status === "CLOSED" ? "CLOSED" : req.query.status === "ALL" ? undefined : "OPEN";
  res.json(
    await prisma.tableSession.findMany({
      where: { outletId: req.outletId, ...(status && { status }) },
      include: { table: { select: { id: true, label: true } }, orders: { select: { id: true, invoiceNumber: true, status: true, grandTotal: true } } },
      orderBy: { openedAt: "desc" },
      take: 100,
    }),
  );
});

// =====================================================================
// Areas
// =====================================================================

tablesRouter.get("/areas", requirePermission("table:serve"), async (req, res) => {
  res.json(await prisma.diningArea.findMany({ where: { outletId: req.outletId }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }] }));
});

tablesRouter.post("/areas", requirePermission("table:manage"), async (req, res) => {
  const data = parse(diningAreaSchema, req.body);
  const area = await prisma.diningArea.create({ data: { ...data, outletId: req.outletId! } });
  await audit(req, "table.area.create", "DiningArea", area.id, { name: area.name });
  emitTables(req.outletId!, { tableIds: [], action: "area" });
  res.status(201).json(area);
});

async function findArea(id: string, outletId: string) {
  const a = await prisma.diningArea.findFirst({ where: { id, outletId } });
  if (!a) throw notFound("Area");
  return a;
}

tablesRouter.patch("/areas/:id", requirePermission("table:manage"), async (req, res) => {
  const area = await findArea(param(req, "id"), req.outletId!);
  const data = parse(diningAreaSchema.partial(), req.body);
  const updated = await prisma.diningArea.update({ where: { id: area.id }, data });
  emitTables(req.outletId!, { tableIds: [], action: "area" });
  res.json(updated);
});

tablesRouter.delete("/areas/:id", requirePermission("table:manage"), async (req, res) => {
  const area = await findArea(param(req, "id"), req.outletId!);
  await prisma.diningArea.delete({ where: { id: area.id } }); // tables keep existing, areaId → null
  await audit(req, "table.area.delete", "DiningArea", area.id, { name: area.name });
  emitTables(req.outletId!, { tableIds: [], action: "area" });
  res.status(204).end();
});

// =====================================================================
// Tables
// =====================================================================

tablesRouter.get("/", requirePermission("table:serve"), async (req, res) => {
  res.json(
    await prisma.diningTable.findMany({
      where: { outletId: req.outletId, ...(req.query.all ? {} : { active: true }) },
      include: { area: { select: { id: true, name: true } }, waiter: { select: { id: true, name: true } } },
      orderBy: { label: "asc" },
    }),
  );
});

tablesRouter.post("/", requirePermission("table:manage"), async (req, res) => {
  const data = parse(diningTableSchema, req.body);
  if (data.areaId) await findArea(data.areaId, req.outletId!);
  await assertStaff(req.outletId!, data.waiterId);
  const table = await prisma.diningTable.create({ data: { ...data, outletId: req.outletId! } });
  await audit(req, "table.create", "DiningTable", table.id, { label: table.label });
  emitTables(req.outletId!, { tableIds: [table.id], action: "create" });
  res.status(201).json(table);
});

/** Drag-and-drop floor editor: save all positions in one go. */
tablesRouter.put("/layout", requirePermission("table:manage"), async (req, res) => {
  const { tables } = parse(tableLayoutSchema, req.body);
  const outletId = req.outletId!;
  const owned = await prisma.diningTable.findMany({ where: { outletId, id: { in: tables.map((t) => t.id) } }, select: { id: true } });
  if (owned.length !== new Set(tables.map((t) => t.id)).size) throw badRequest("Unknown table in layout");
  const areaIds = [...new Set(tables.map((t) => t.areaId).filter((a): a is string => Boolean(a)))];
  if (areaIds.length && (await prisma.diningArea.count({ where: { outletId, id: { in: areaIds } } })) !== areaIds.length) {
    throw badRequest("Unknown area in layout");
  }
  await prisma.$transaction(
    tables.map(({ id, ...pos }) => prisma.diningTable.update({ where: { id }, data: pos })),
  );
  await audit(req, "table.layout.save", "DiningTable", undefined, { count: tables.length });
  emitTables(outletId, { tableIds: tables.map((t) => t.id), action: "layout" });
  res.json(await prisma.diningTable.findMany({ where: { outletId, active: true }, orderBy: { label: "asc" } }));
});

async function findTable(id: string, outletId: string) {
  const t = await prisma.diningTable.findFirst({ where: { id, outletId } });
  if (!t) throw notFound("Table");
  return t;
}

tablesRouter.get("/:id", requirePermission("table:serve"), async (req, res) => {
  const table = await findTable(param(req, "id"), req.outletId!);
  const session = await findOpenSession(req.outletId!, table.id);
  res.json({ ...table, session: session ? await sessionDetail(session.id, req.outletId!) : null });
});

tablesRouter.patch("/:id", requirePermission("table:manage"), async (req, res) => {
  const table = await findTable(param(req, "id"), req.outletId!);
  const data = parse(diningTableUpdateSchema, req.body);
  if (data.areaId) await findArea(data.areaId, req.outletId!);
  await assertStaff(req.outletId!, data.waiterId);
  if (data.active === false && (await findOpenSession(req.outletId!, table.id))) throw conflict("Table has an open tab");
  const updated = await prisma.diningTable.update({ where: { id: table.id }, data });
  await audit(req, "table.update", "DiningTable", table.id, data as Prisma.InputJsonValue);
  emitTables(req.outletId!, { tableIds: [table.id], action: "update" });
  res.json(updated);
});

tablesRouter.delete("/:id", requirePermission("table:manage"), async (req, res) => {
  const table = await findTable(param(req, "id"), req.outletId!);
  if (await findOpenSession(req.outletId!, table.id)) throw conflict("Table has an open tab");
  const used = (await prisma.tableSession.count({ where: { tableId: table.id } })) + (await prisma.reservation.count({ where: { tableId: table.id } }));
  // Keep history intact: tables with past sessions are deactivated rather than deleted.
  if (used) await prisma.diningTable.update({ where: { id: table.id }, data: { active: false } });
  else await prisma.diningTable.delete({ where: { id: table.id } });
  await audit(req, used ? "table.deactivate" : "table.delete", "DiningTable", table.id, { label: table.label });
  emitTables(req.outletId!, { tableIds: [table.id], action: "delete" });
  res.status(204).end();
});

tablesRouter.patch("/:id/status", requirePermission("table:serve"), async (req, res) => {
  const { status } = parse(tableStatusSchema, req.body);
  const table = await findTable(param(req, "id"), req.outletId!);
  const open = await findOpenSession(req.outletId!, table.id);
  if (open && (status === "AVAILABLE" || status === "RESERVED")) throw conflict("Table has an open tab — close it first");
  if (!open && status === "OCCUPIED") throw badRequest("Open a tab to occupy the table");
  const updated = await prisma.diningTable.update({ where: { id: table.id }, data: { status } });
  await audit(req, "table.status", "DiningTable", table.id, { from: table.status, to: status });
  emitTables(req.outletId!, { tableIds: [table.id], action: "status" });
  if (status === "NEEDS_ATTENTION" && table.status !== "NEEDS_ATTENTION") void alertTableAttention(req.outletId!, table.id, req.user!.id);
  res.json(updated);
});

tablesRouter.patch("/:id/waiter", requirePermission("table:serve"), async (req, res) => {
  const { waiterId } = parse(tableWaiterSchema, req.body);
  const table = await findTable(param(req, "id"), req.outletId!);
  await assertStaff(req.outletId!, waiterId);
  const updated = await prisma.diningTable.update({ where: { id: table.id }, data: { waiterId } });
  const open = await findOpenSession(req.outletId!, table.id);
  if (open) await prisma.tableSession.update({ where: { id: open.id }, data: { waiterId } });
  emitTables(req.outletId!, { tableIds: [table.id], sessionId: open?.id, action: "waiter" });
  res.json(updated);
});

// =====================================================================
// Running tabs
// =====================================================================

tablesRouter.post("/:id/open", requirePermission("table:serve"), async (req, res) => {
  const body = parse(sessionOpenSchema, req.body ?? {});
  const session = await openSession(req, param(req, "id"), body);
  res.status(201).json(await sessionDetail(session.id, req.outletId!));
});

tablesRouter.get("/sessions/:id", requirePermission("table:serve"), async (req, res) => {
  res.json(await sessionDetail(param(req, "id"), req.outletId!));
});

tablesRouter.patch("/sessions/:id", requirePermission("table:serve"), async (req, res) => {
  const session = await loadOpenSession(param(req, "id"), req.outletId!);
  const data = parse(sessionUpdateSchema, req.body);
  await assertStaff(req.outletId!, data.waiterId);
  await prisma.tableSession.update({ where: { id: session.id }, data });
  emitTables(req.outletId!, { tableIds: [session.tableId, ...session.mergedTableIds], sessionId: session.id, action: "update" });
  res.json(await sessionDetail(session.id, req.outletId!));
});

tablesRouter.post("/sessions/:id/items", requirePermission("table:serve"), async (req, res) => {
  const { items } = parse(sessionItemsSchema, req.body);
  const session = await loadOpenSession(param(req, "id"), req.outletId!);
  const kots = await addItemsToSession(req, session, items);
  res.status(201).json({ kots, session: await sessionDetail(session.id, req.outletId!) });
});

tablesRouter.delete("/sessions/:id/items/:itemId", requirePermission("order:cancel"), async (req, res) => {
  const reason = parse(itemVoidSchema.partial(), req.body ?? {}).reason ?? (typeof req.query.reason === "string" ? req.query.reason : undefined);
  const session = await loadOpenSession(param(req, "id"), req.outletId!);
  const item = await prisma.tableSessionItem.findFirst({ where: { id: param(req, "itemId"), sessionId: session.id } });
  if (!item) throw notFound("Item");
  if (item.billedOrderId) throw conflict("Item is already billed — cancel the bill first");

  const kot = await prisma.$transaction(async (tx) => {
    await tx.tableSessionItem.delete({ where: { id: item.id } });
    let updatedKot = null;
    if (item.kotId) {
      const k = await tx.kotTicket.findUnique({ where: { id: item.kotId } });
      if (k) {
        const entries = (k.items as Record<string, unknown>[]).map((e) => (e.sessionItemId === item.id ? { ...e, voided: true } : e));
        updatedKot = await tx.kotTicket.update({ where: { id: k.id }, data: { items: entries as Prisma.InputJsonValue } });
      }
    }
    await audit(req, "table.item.void", "TableSessionItem", item.id, { sessionId: session.id, menuItemId: item.menuItemId, quantity: item.quantity, reason: reason ?? null }, tx);
    return updatedKot;
  });
  const label = await sessionLabel(session);
  emitToOutlet(req.outletId!, "kot:void", { sessionItemId: item.id, kotId: item.kotId, kot: kot && { ...kot, order: null, session: { id: session.id, tableLabel: label, table: { label } } } });
  emitTables(req.outletId!, { tableIds: [session.tableId, ...session.mergedTableIds], sessionId: session.id, action: "void" });
  res.json(await sessionDetail(session.id, req.outletId!));
});

tablesRouter.post("/sessions/:id/transfer", requirePermission("table:serve"), async (req, res) => {
  const { toTableId } = parse(sessionTransferSchema, req.body);
  const outletId = req.outletId!;
  const session = await loadOpenSession(param(req, "id"), outletId);
  const target = await prisma.diningTable.findFirst({ where: { id: toTableId, outletId, active: true } });
  if (!target) throw notFound("Target table");
  if (target.id === session.tableId) throw badRequest("Session is already on that table");
  await prisma.$transaction(async (tx) => {
    if (await findOpenSession(outletId, target.id, tx)) throw conflict(`Table ${target.label} is occupied`);
    await tx.tableSession.update({ where: { id: session.id }, data: { tableId: target.id } });
    await tx.diningTable.update({ where: { id: session.tableId }, data: { status: "AVAILABLE" } });
    await tx.diningTable.update({ where: { id: target.id }, data: { status: "OCCUPIED" } });
    await audit(req, "table.session.transfer", "TableSession", session.id, { from: session.tableId, to: target.id }, tx);
  });
  emitTables(outletId, { tableIds: [session.tableId, target.id], sessionId: session.id, action: "transfer" });
  res.json(await sessionDetail(session.id, outletId));
});

tablesRouter.post("/sessions/:id/merge", requirePermission("table:serve"), async (req, res) => {
  const { tableIds } = parse(sessionMergeSchema, req.body);
  const outletId = req.outletId!;
  const session = await loadOpenSession(param(req, "id"), outletId);
  const own = new Set([session.tableId, ...session.mergedTableIds]);
  const tables = await prisma.diningTable.findMany({ where: { outletId, active: true, id: { in: tableIds } } });
  if (tables.length !== new Set(tableIds).size) throw notFound("Table");
  const touched: string[] = [];
  const mergedSessions: string[] = [];
  await prisma.$transaction(async (tx) => {
    const merged = new Set(session.mergedTableIds);
    let guests = session.guests;
    for (const t of tables) {
      if (own.has(t.id)) continue;
      const other = await findOpenSession(outletId, t.id, tx);
      if (other) {
        await tx.tableSessionItem.updateMany({ where: { sessionId: other.id }, data: { sessionId: session.id } });
        await tx.kotTicket.updateMany({ where: { sessionId: other.id }, data: { sessionId: session.id } });
        await tx.order.updateMany({ where: { tableSessionId: other.id }, data: { tableSessionId: session.id } });
        await tx.reservation.updateMany({ where: { sessionId: other.id }, data: { sessionId: session.id } });
        await tx.tableSession.update({ where: { id: other.id }, data: { status: "CLOSED", closedAt: new Date() } });
        guests += other.guests;
        for (const id of [other.tableId, ...other.mergedTableIds]) merged.add(id);
        mergedSessions.push(other.id);
      } else {
        merged.add(t.id);
      }
    }
    merged.delete(session.tableId);
    await tx.tableSession.update({ where: { id: session.id }, data: { mergedTableIds: [...merged], guests } });
    await tx.diningTable.updateMany({ where: { id: { in: [...merged] } }, data: { status: "OCCUPIED" } });
    touched.push(...merged);
    await audit(req, "table.session.merge", "TableSession", session.id, { tableIds: [...merged], mergedSessions }, tx);
  });
  emitTables(outletId, { tableIds: [session.tableId, ...touched], sessionId: session.id, action: "merge" });
  res.json(await sessionDetail(session.id, outletId));
});

/**
 * Raise bill(s) from the unbilled items of a tab. KOTs were already fired per
 * round, so billing skips KOT creation and links the existing KOTs instead.
 * - FULL: one bill. BY_SEAT / BY_ITEMS: one bill per group.
 * - EQUAL: one bill with everything + `equalSplit` amounts (summing exactly to
 *   the grand total) for the client to record as split payments on that bill.
 */
tablesRouter.post("/sessions/:id/bill", requirePermission("table:serve", "order:create"), async (req, res) => {
  const body = parse(sessionBillSchema, req.body ?? {});
  const outletId = req.outletId!;
  const session = await loadOpenSession(param(req, "id"), outletId);
  const items = await prisma.tableSessionItem.findMany({ where: { sessionId: session.id }, orderBy: { createdAt: "asc" } });
  const groups = groupBillItems(items, body.mode, { itemIds: body.itemIds, groups: body.groups, seats: body.seats });
  if (groups.length > 1 && (body.discount?.type === "FLAT" || body.couponCode || body.redeemPoints)) {
    throw badRequest("Flat discounts, coupons and points apply to a single bill — bill the groups one at a time");
  }
  const label = (await sessionLabel(session)).slice(0, 20);
  const byId = new Map(items.map((i) => [i.id, i]));
  const orders = [];
  for (const g of groups) {
    const groupItems = g.itemIds.map((id) => byId.get(id)!);
    const input: OrderCreateInput = {
      orderType: "DINE_IN",
      tableLabel: label,
      customerName: body.customerName ?? session.customerName ?? undefined,
      customerPhone: body.customerPhone ?? session.customerPhone ?? undefined,
      interState: body.interState,
      items: groupItems.map((i) => ({
        menuItemId: i.menuItemId,
        variantId: i.variantId ?? undefined,
        addonIds: i.addonIds,
        quantity: i.quantity,
        notes: [i.seat ? `Seat ${i.seat}` : null, i.notes].filter(Boolean).join(" · ") || undefined,
      })),
      discount: body.discount,
      couponCode: body.couponCode,
      redeemPoints: body.redeemPoints,
      notes: [body.notes, groups.length > 1 ? g.label : null].filter(Boolean).join(" · ") || undefined,
    };
    const { order } = await runWithSessionBill({ sessionId: session.id, itemIds: g.itemIds }, () =>
      createOrder(req, input, { skipKot: true, tableSessionId: session.id, skipAvailability: true }),
    );
    // Link the already-fired KOTs to this bill (a KOT shared across split bills links to the first).
    const kotIds = [...new Set(groupItems.map((i) => i.kotId).filter((k): k is string => Boolean(k)))];
    if (kotIds.length) await prisma.kotTicket.updateMany({ where: { id: { in: kotIds }, orderId: null }, data: { orderId: order.id } });
    orders.push({ group: g.label, seat: g.seat, itemIds: g.itemIds, order });
  }
  const detail = await sessionDetail(session.id, outletId);
  emitTables(outletId, { tableIds: [session.tableId, ...session.mergedTableIds], sessionId: session.id, action: "bill" });
  res.status(201).json({
    orders,
    equalSplit: body.mode === "EQUAL" ? equalSplit(orders[0].order.grandTotal, body.parts!) : undefined,
    advancePaid: detail.advancePaid,
    session: detail,
  });
});

tablesRouter.post("/sessions/:id/close", requirePermission("table:serve"), async (req, res) => {
  const outletId = req.outletId!;
  const session = await loadOpenSession(param(req, "id"), outletId);
  const [unbilled, openOrders] = await Promise.all([
    prisma.tableSessionItem.count({ where: { sessionId: session.id, billedOrderId: null } }),
    prisma.order.count({ where: { tableSessionId: session.id, status: "OPEN" } }),
  ]);
  if (unbilled) throw conflict(`${unbilled} item(s) not billed yet`);
  if (openOrders) throw conflict(`${openOrders} bill(s) not paid yet`);
  const tableIds = [session.tableId, ...session.mergedTableIds];
  await prisma.$transaction(async (tx) => {
    await tx.tableSession.update({ where: { id: session.id }, data: { status: "CLOSED", closedAt: new Date() } });
    await tx.diningTable.updateMany({ where: { id: { in: tableIds } }, data: { status: "AVAILABLE" } });
    await tx.reservation.updateMany({ where: { sessionId: session.id, status: "SEATED" }, data: { status: "COMPLETED" } });
    await tx.kotTicket.updateMany({ where: { sessionId: session.id, status: { not: "SERVED" } }, data: { status: "SERVED" } });
    await audit(req, "table.session.close", "TableSession", session.id, { tableIds }, tx);
  });
  emitTables(outletId, { tableIds, sessionId: session.id, action: "close" });
  res.json(await sessionDetail(session.id, outletId));
});
