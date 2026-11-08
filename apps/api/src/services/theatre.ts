import type { Request } from "express";
import type { ChannelRequest, DiningArea, DiningTable, Outlet, Prisma, ShowTime } from "@prisma/client";
import { seatCode, type SeatOrderInput, type SeatTiming, type TheatreSettings } from "@canavo/shared";
import { platformPrisma, prisma } from "../db";
import { badRequest, conflict, notFound } from "../lib/http";
import { kickOutbox } from "../lib/outbox";
import { startOfLocalDay, zonedParts, addDays } from "../lib/time";
import { moduleEnabled, runForOutlet } from "../lib/tenant";
import { createChannelOrder, systemRequest } from "./channel-orders";
import { notify, outletStaff } from "./notify";
import { checkCart, issueUpi, newPublicToken, publicMenu, tableByToken } from "./storefront";
import { emitTheatre, intervalReleaseAt, readTheatreSettings, seatHeader } from "./theatre-kot";
import { cancelOrderInTx } from "./order-cancel";
import { getOrder } from "./billing";

/**
 * Cinema seat ordering (THEATRE). A screen is a DiningArea of kind SCREEN, every seat a DiningTable
 * in it (label "S2-F12", own QR). Guests order from the seat QR during a show and always prepay by
 * UPI; the order is a QR ChannelRequest with a bill, so payments, KOTs, reports and refunds reuse the
 * table-QR and online-order machinery. Contract: docs/build/theatre-contract.md.
 */

/** Seat ordering opens this long before a show starts. */
export const OPEN_BEFORE_MIN = 30;
/** How long a show's status reads INTERVAL after the interval starts. */
export const INTERVAL_MIN = 15;
/** Unpaid seat orders are cancelled after this long (the Razorpay QR itself closes after 15 minutes). */
export const UNPAID_EXPIRY_MIN = 30;
/** Seats per screen. */
export const MAX_SEATS_PER_SCREEN = 3000;

const MIN = 60_000;
type Tx = Prisma.TransactionClient;

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export type ShowRow = ShowTime & { area: { name: string } };
export type ShowStatus = "UPCOMING" | "RUNNING" | "INTERVAL" | "ENDED";

export const closesAt = (s: Pick<ShowTime, "endsAt" | "orderCutoffMin">) => new Date(s.endsAt.getTime() - s.orderCutoffMin * MIN);

export function showStatus(s: Pick<ShowTime, "startsAt" | "endsAt" | "intervalAt">, now = new Date()): ShowStatus {
  const t = now.getTime();
  if (t < s.startsAt.getTime()) return "UPCOMING";
  if (t >= s.endsAt.getTime()) return "ENDED";
  if (s.intervalAt && t >= s.intervalAt.getTime() && t < s.intervalAt.getTime() + INTERVAL_MIN * MIN) return "INTERVAL";
  return "RUNNING";
}

export function showView(s: ShowRow, now = new Date()) {
  return {
    id: s.id,
    screenId: s.areaId,
    screenName: s.area.name,
    title: s.title,
    startsAt: s.startsAt.toISOString(),
    intervalAt: s.intervalAt?.toISOString() ?? null,
    endsAt: s.endsAt.toISOString(),
    orderCutoffMin: s.orderCutoffMin,
    closesAt: closesAt(s).toISOString(),
    status: showStatus(s, now),
  };
}
export type ShowView = ReturnType<typeof showView>;

/** Rows A…Z, then AA…ZZ. */
export const rowOrder = (a: string, b: string) => a.length - b.length || a.localeCompare(b);

const hhmm = (d: Date, tz: string) => {
  const m = zonedParts(d, tz).minutes;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
};

// ---------------------------------------------------------------------------
// Screens and seats (staff)
// ---------------------------------------------------------------------------

export async function findScreen(id: string, outletId: string) {
  const a = await prisma.diningArea.findFirst({ where: { id, outletId, kind: "SCREEN" } });
  if (!a) throw notFound("Screen");
  return a;
}

/** Current (running now) and next show per screen. */
async function currentAndNext(outletId: string, screenIds: string[], now = new Date()) {
  const shows = screenIds.length
    ? await prisma.showTime.findMany({ where: { outletId, areaId: { in: screenIds }, endsAt: { gt: now } }, include: { area: { select: { name: true } } }, orderBy: { startsAt: "asc" } })
    : [];
  const out = new Map<string, { currentShow: ShowView | null; nextShow: ShowView | null }>();
  for (const id of screenIds) {
    const mine = shows.filter((s) => s.areaId === id);
    const cur = mine.find((s) => s.startsAt <= now);
    const next = mine.find((s) => s.startsAt > now);
    out.set(id, { currentShow: cur ? showView(cur, now) : null, nextShow: next ? showView(next, now) : null });
  }
  return out;
}

type SeatRow = Pick<DiningTable, "id" | "label" | "seatRow" | "seatNumber" | "qrToken" | "active">;
function groupSeats(seats: SeatRow[]) {
  const rows = new Map<string, SeatRow[]>();
  for (const s of seats) if (s.seatRow) rows.set(s.seatRow, [...(rows.get(s.seatRow) ?? []), s]);
  return [...rows.keys()].sort(rowOrder).map((row) => ({
    row,
    seats: rows
      .get(row)!
      .sort((a, b) => (a.seatNumber ?? 0) - (b.seatNumber ?? 0))
      .map((s) => ({ id: s.id, label: s.label, seatNumber: s.seatNumber ?? 0, qrToken: s.qrToken ?? "", active: s.active })),
  }));
}

/** The Screen shape of the contract, for one or all screens of the outlet. */
export async function screenViews(outletId: string, onlyId?: string) {
  const screens = await prisma.diningArea.findMany({ where: { outletId, kind: "SCREEN", ...(onlyId && { id: onlyId }) }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }] });
  const ids = screens.map((s) => s.id);
  const [seats, shows] = await Promise.all([
    ids.length ? prisma.diningTable.findMany({ where: { outletId, areaId: { in: ids }, seatRow: { not: null } }, select: { id: true, label: true, seatRow: true, seatNumber: true, qrToken: true, active: true, areaId: true } }) : [],
    currentAndNext(outletId, ids),
  ]);
  return screens.map((a) => {
    const mine = seats.filter((s) => s.areaId === a.id);
    return {
      id: a.id,
      name: a.name,
      code: a.code ?? "S",
      sortOrder: a.sortOrder,
      qrToken: a.qrToken ?? "",
      seatCount: mine.filter((s) => s.active).length,
      rows: groupSeats(mine),
      ...shows.get(a.id)!,
    };
  });
}

export async function screenView(outletId: string, id: string) {
  const [v] = await screenViews(outletId, id);
  if (!v) throw notFound("Screen");
  return v;
}

/** S1, S2 …: the smallest number not used by another screen of the outlet. Fixed for the screen's life (seat labels carry it). */
export async function nextScreenCode(outletId: string, db: Tx | typeof prisma = prisma) {
  const used = new Set((await db.diningArea.findMany({ where: { outletId, kind: "SCREEN" }, select: { code: true } })).map((a) => a.code));
  for (let n = 1; ; n++) if (!used.has(`S${n}`)) return `S${n}`;
}

/**
 * Bulk seats: every row × from…to except the skip list. Existing seats are kept (inactive ones in
 * the range come back); a label already taken by another table of the outlet is skipped.
 */
export async function addSeats(screen: DiningArea, input: { rows: string[]; from: number; to: number; skip: string[] }) {
  const skip = new Set(input.skip);
  const wanted: { row: string; n: number; label: string }[] = [];
  for (const row of [...new Set(input.rows)]) {
    for (let n = input.from; n <= input.to; n++) {
      const code = seatCode(row, n);
      if (!skip.has(code)) wanted.push({ row, n, label: `${screen.code}-${code}` });
    }
  }
  const requested = [...new Set(input.rows)].length * (input.to - input.from + 1);
  const existing = await prisma.diningTable.findMany({ where: { outletId: screen.outletId, label: { in: wanted.map((w) => w.label) } }, select: { id: true, label: true, areaId: true, active: true, seatRow: true } });
  const byLabel = new Map(existing.map((e) => [e.label, e]));
  const revive = existing.filter((e) => e.areaId === screen.id && e.seatRow && !e.active).map((e) => e.id);
  const fresh = wanted.filter((w) => !byLabel.has(w.label));
  const current = await prisma.diningTable.count({ where: { areaId: screen.id, active: true } });
  if (current + fresh.length + revive.length > MAX_SEATS_PER_SCREEN) throw badRequest(`A screen can have at most ${MAX_SEATS_PER_SCREEN.toLocaleString("en-IN")} seats`);
  let created = 0;
  if (fresh.length) {
    const r = await prisma.diningTable.createMany({
      data: fresh.map((w) => ({
        outletId: screen.outletId,
        areaId: screen.id,
        label: w.label,
        seatRow: w.row,
        seatNumber: w.n,
        capacity: 1,
        shape: "SQUARE" as const,
        width: 1,
        height: 1,
        posX: Math.min(w.n, 500),
        posY: 0,
        qrToken: newPublicToken(),
      })),
      // Two managers adding the same rows at once: the second simply skips them.
      skipDuplicates: true,
    });
    created += r.count;
  }
  if (revive.length) created += (await prisma.diningTable.updateMany({ where: { id: { in: revive } }, data: { active: true } })).count;
  const total = await prisma.diningTable.count({ where: { areaId: screen.id, active: true } });
  return { created, skipped: requested - created, total };
}

/** Seat order history of a seat (or of any seat in a list): sessions, reservations or QR requests. */
async function seatHistory(ids: string[]) {
  if (!ids.length) return new Set<string>();
  const [s, r, c] = await Promise.all([
    prisma.tableSession.findMany({ where: { tableId: { in: ids } }, select: { tableId: true }, distinct: ["tableId"] }),
    prisma.reservation.findMany({ where: { tableId: { in: ids } }, select: { tableId: true }, distinct: ["tableId"] }),
    prisma.channelRequest.findMany({ where: { tableId: { in: ids } }, select: { tableId: true }, distinct: ["tableId"] }),
  ]);
  return new Set([...s, ...r, ...c].map((x) => x.tableId).filter((x): x is string => Boolean(x)));
}

export async function assertSeatsIdle(ids: string[]) {
  if (!ids.length) return;
  if (await prisma.tableSession.count({ where: { status: "OPEN", tableId: { in: ids } } })) throw conflict("A seat on this screen has an open tab — close it first");
  if (await prisma.channelRequest.count({ where: { status: "PENDING", tableId: { in: ids } } })) throw conflict("A seat on this screen has an order waiting — accept or reject it first");
}

/**
 * Delete a screen: refused while a seat is busy, and for a screen with seat orders in its history
 * (reports group sales by screen and show). Seats without history are deleted with it.
 */
export async function deleteScreen(screen: DiningArea) {
  const seats = (await prisma.diningTable.findMany({ where: { areaId: screen.id }, select: { id: true } })).map((s) => s.id);
  await assertSeatsIdle(seats);
  const history = await seatHistory(seats);
  if (history.size) throw conflict("This screen has orders in its history — rename it instead of deleting it");
  await prisma.$transaction(async (tx) => {
    await tx.diningTable.deleteMany({ where: { id: { in: seats } } });
    await tx.diningArea.delete({ where: { id: screen.id } });
  });
}

/** Delete a seat; one with history is deactivated (its QR stops taking orders). */
export async function deleteSeat(seat: DiningTable) {
  await assertSeatsIdle([seat.id]);
  const used = (await seatHistory([seat.id])).size > 0;
  if (used) await prisma.diningTable.update({ where: { id: seat.id }, data: { active: false } });
  else await prisma.diningTable.delete({ where: { id: seat.id } });
  return used ? "deactivated" : "deleted";
}

// ---------------------------------------------------------------------------
// Showtimes
// ---------------------------------------------------------------------------

/** Shows of the outlet overlapping a local day (optionally one screen). */
export async function showsOnDay(outlet: Pick<Outlet, "id" | "timezone">, date: string, screenId?: string) {
  const start = startOfLocalDay(date, outlet.timezone);
  const end = startOfLocalDay(addDays(date, 1), outlet.timezone);
  const rows = await prisma.showTime.findMany({
    where: { outletId: outlet.id, startsAt: { lt: end }, endsAt: { gt: start }, ...(screenId && { areaId: screenId }) },
    include: { area: { select: { name: true } } },
    orderBy: [{ startsAt: "asc" }],
  });
  const now = new Date();
  return rows.map((s) => showView(s, now));
}

export interface ShowTimes {
  startsAt: Date;
  intervalAt: Date | null;
  endsAt: Date;
}

/** Same rules as showTimeSchema, for a PATCH merged onto the stored show. */
export function checkShowTimes(t: ShowTimes) {
  if (t.endsAt <= t.startsAt) throw badRequest("The show must end after it starts");
  if (t.intervalAt && (t.intervalAt <= t.startsAt || t.intervalAt >= t.endsAt)) throw badRequest("The interval must be during the show");
  if (t.endsAt.getTime() - t.startsAt.getTime() > 8 * 3600_000) throw badRequest("A show can be at most 8 hours");
}

/**
 * Save a show (create or update) unless it overlaps another show on the same screen. A per-screen
 * advisory lock makes two managers adding shows at once take turns, so overlaps can't slip in.
 */
export async function saveShow(outletId: string, screenId: string, data: Omit<Prisma.ShowTimeUncheckedCreateInput, "outletId" | "areaId">, id?: string) {
  const row = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`showtime:${screenId}`}))`;
    const clash = await tx.showTime.findFirst({
      where: { outletId, areaId: screenId, startsAt: { lt: data.endsAt as Date }, endsAt: { gt: data.startsAt as Date }, ...(id && { id: { not: id } }) },
      orderBy: { startsAt: "asc" },
    });
    if (clash) throw conflict(`Overlaps "${clash.title}" on this screen (${clash.startsAt.toISOString()} – ${clash.endsAt.toISOString()})`);
    return id ? tx.showTime.update({ where: { id }, data }) : tx.showTime.create({ data: { ...data, outletId, areaId: screenId } });
  });
  return prisma.showTime.findUniqueOrThrow({ where: { id: row.id }, include: { area: { select: { name: true } } } });
}

export async function findShow(id: string, outletId: string) {
  const s = await prisma.showTime.findFirst({ where: { id, outletId }, include: { area: { select: { name: true } } } });
  if (!s) throw notFound("Show");
  return s;
}

// ---------------------------------------------------------------------------
// The seat's ordering window (public)
// ---------------------------------------------------------------------------

export interface SeatWindow {
  show: ShowRow;
  orderingOpen: boolean;
  reason?: string;
}

/**
 * Which show a seat orders for right now. Open from startsAt − 30 min until closesAt (endsAt −
 * cut-off). A show still running but past its cut-off reads "closed"; else the next show later
 * today reads "not yet" with the time ordering opens; no show today → null.
 */
export async function seatWindow(areaId: string, timezone: string, now = new Date()): Promise<SeatWindow | null> {
  const shows = await prisma.showTime.findMany({
    where: { areaId, endsAt: { gt: now }, startsAt: { lt: new Date(now.getTime() + 24 * 3600_000) } },
    include: { area: { select: { name: true } } },
    orderBy: { startsAt: "asc" },
    take: 10,
  });
  const inWindow = shows.filter((s) => s.startsAt.getTime() - OPEN_BEFORE_MIN * MIN <= now.getTime());
  const open = inWindow.find((s) => now < closesAt(s));
  if (open) return { show: open, orderingOpen: true };
  if (inWindow.length) return { show: inWindow[inWindow.length - 1], orderingOpen: false, reason: "Ordering has closed for this show" };
  const today = zonedParts(now, timezone).date;
  const next = shows.find((s) => s.startsAt > now && zonedParts(s.startsAt, timezone).date === today);
  if (next) return { show: next, orderingOpen: false, reason: `Ordering opens at ${hhmm(new Date(next.startsAt.getTime() - OPEN_BEFORE_MIN * MIN), timezone)}` };
  return null;
}

/** Which timings the guest may pick now. */
export function seatOptions(win: SeatWindow | null, s: TheatreSettings, now = new Date()) {
  const open = Boolean(win?.orderingOpen && s.seatOrdering);
  return {
    now: open && s.deliverDuringShow,
    interval: open && Boolean(intervalReleaseAt("INTERVAL", win!.show.intervalAt, s.intervalLeadMin, now)),
    counter: open && s.counterPickup,
  };
}

type SeatWithArea = DiningTable & { area: DiningArea | null };

async function loadSeat(tableId: string): Promise<SeatWithArea> {
  const seat = await prisma.diningTable.findUniqueOrThrow({ where: { id: tableId }, include: { area: true } });
  return seat;
}

/** The `theatre` block of GET /public/t/:token for a seat (inside the outlet's tenant context). */
export async function seatPage(table: DiningTable, outlet: Outlet) {
  const seat = await loadSeat(table.id);
  const settings = readTheatreSettings(outlet);
  const now = new Date();
  const win = seat.area?.kind === "SCREEN" ? await seatWindow(seat.area.id, outlet.timezone, now) : null;
  let reason = win?.reason;
  if (win && win.orderingOpen && !settings.seatOrdering) reason = "Seat ordering is off right now";
  if (win && win.orderingOpen && !table.active) reason = "This seat isn't taking orders — please ask a staff member";
  const orderingOpen = Boolean(win?.orderingOpen && settings.seatOrdering && table.active);
  return {
    ordering: orderingOpen,
    notice: !win ? "No show on this screen now" : orderingOpen ? null : (reason ?? null),
    theatre: {
      seat: { label: seat.label, screenName: seat.area?.name ?? "", screenCode: seat.area?.code ?? "", row: seat.seatRow ?? "", seatNumber: seat.seatNumber ?? 0 },
      show: win ? { ...showView(win.show, now), orderingOpen, ...(!orderingOpen && reason && { reason }) } : null,
      options: orderingOpen ? seatOptions(win, settings, now) : { now: false, interval: false, counter: false },
      settings: { intervalLeadMin: settings.intervalLeadMin },
    },
  };
}

/** GET /public/s/:screenToken — the screen poster QR: pick a row and seat. */
export async function screenByToken(token: string) {
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(token)) throw notFound("Screen");
  const area = await platformPrisma.diningArea.findUnique({ where: { qrToken: token } });
  if (!area || area.kind !== "SCREEN") throw notFound("Screen");
  const seats = await platformPrisma.diningTable.findMany({ where: { areaId: area.id, active: true, seatRow: { not: null }, qrToken: { not: null } }, select: { qrToken: true }, take: 1 });
  // Same gate as the seat page itself (business active, CHANNELS + THEATRE, seat ordering or menu view on).
  if (seats[0]) await tableByToken(seats[0].qrToken!);
  else {
    const outlet = await platformPrisma.outlet.findUniqueOrThrow({ where: { id: area.outletId }, select: { businessId: true } });
    const b = await platformPrisma.business.findUnique({ where: { id: outlet.businessId }, select: { status: true, modules: true } });
    if (!b || b.status !== "ACTIVE" || !b.modules.includes("THEATRE")) throw notFound("Screen");
  }
  const outlet = await platformPrisma.outlet.findUniqueOrThrow({ where: { id: area.outletId } });
  return runForOutlet(outlet.id, async () => {
    const all = await prisma.diningTable.findMany({ where: { areaId: area.id, active: true, seatRow: { not: null } }, select: { id: true, label: true, seatRow: true, seatNumber: true, qrToken: true, active: true } });
    const win = await seatWindow(area.id, outlet.timezone);
    return {
      outletName: outlet.name,
      screen: { name: area.name, code: area.code ?? "" },
      show: win ? showView(win.show) : null,
      rows: groupSeats(all).map((r) => ({ row: r.row, seats: r.seats.filter((s) => s.qrToken).map((s) => ({ label: s.label, seatNumber: s.seatNumber, token: s.qrToken })) })),
    };
  });
}

// ---------------------------------------------------------------------------
// Placing a seat order (public)
// ---------------------------------------------------------------------------

/** Highest pickup token today at the outlet; a per-outlet advisory lock (held to commit) makes parallel orders take turns. */
async function nextPickupToken(tx: Tx, outletId: string, timezone: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`pickup:${outletId}`}))`;
  const since = startOfLocalDay(zonedParts(new Date(), timezone).date, timezone);
  const r = await tx.channelRequest.aggregate({ where: { outletId, createdAt: { gte: since }, pickupToken: { not: null } }, _max: { pickupToken: true } });
  return (r._max.pickupToken ?? 0) + 1;
}

const TIMING_REFUSAL: Record<SeatTiming, string> = {
  NOW: "Delivery to your seat during the show is off — choose the interval or counter pickup",
  INTERVAL: "There is no interval ahead in this show — choose another time",
  COUNTER: "Counter pickup is off — choose delivery to your seat",
};

/**
 * POST /public/t/:token/orders for a seat. Checks the show window and the timing, creates the bill
 * (no KOT yet) and a QR request with the timing / show / pickup token, and returns a UPI QR. The KOT
 * goes out when the payment is confirmed (and the request accepted, if the outlet confirms QR orders).
 */
export async function placeSeatOrder(token: string, input: SeatOrderInput, ip?: string) {
  const { table, outlet, settings: sf } = await tableByToken(token);
  return runForOutlet(outlet.id, async () => {
    if (!moduleEnabled("THEATRE")) throw notFound("Table");
    const settings = readTheatreSettings(outlet);
    if (!settings.seatOrdering) throw conflict("Seat ordering is switched off right now — please ask a staff member");
    if (!table.active) throw conflict("This seat isn't taking orders — please ask a staff member");
    const seat = await loadSeat(table.id);
    if (seat.area?.kind !== "SCREEN") throw conflict("This seat isn't taking orders — please ask a staff member");
    const now = new Date();
    const win = await seatWindow(seat.area.id, outlet.timezone, now);
    if (!win) throw conflict("No show on this screen now");
    if (!win.orderingOpen) throw conflict(win.reason ?? "Ordering has closed for this show");
    const options = seatOptions(win, settings, now);
    if (!options[input.timing === "NOW" ? "now" : input.timing === "INTERVAL" ? "interval" : "counter"]) throw conflict(TIMING_REFUSAL[input.timing]);

    const lines = checkCart(await publicMenu(outlet.id, outlet.timezone), input.items);
    if (input.notes) lines[0] = { ...lines[0], notes: [lines[0].notes, `Note: ${input.notes}`].filter(Boolean).join(" · ").slice(0, 200) };
    const publicToken = newPublicToken();
    const pending = sf.qrNeedsConfirmation;

    // The request first: its pickup token is numbered under the lock and printed on the bill / KOT.
    const request = await prisma.$transaction(async (tx) => {
      const pickupToken = input.timing === "COUNTER" ? await nextPickupToken(tx, outlet.id, outlet.timezone) : null;
      return tx.channelRequest.create({
        data: {
          outletId: outlet.id,
          channel: "QR",
          status: pending ? "PENDING" : "ACCEPTED",
          decidedAt: pending ? undefined : now,
          tableId: seat.id,
          items: lines as unknown as Prisma.InputJsonValue,
          customerName: input.customerName || undefined,
          customerPhone: input.customerPhone,
          notes: input.notes,
          total: lines.reduce((s, l) => s + l.unitPrice * l.quantity, 0),
          publicToken,
          payment: "UPI",
          seatTiming: input.timing,
          showTimeId: win.show.id,
          pickupToken,
          ip,
        },
      });
    });
    const header = seatHeader(seat.area.code ?? "?", seat.seatRow, seat.seatNumber, input.timing, request.pickupToken);
    try {
      const { order } = await createChannelOrder(
        outlet.id,
        "QR",
        {
          orderType: "DINE_IN",
          tableLabel: seat.label.slice(0, 20),
          customerName: input.customerName || undefined,
          customerPhone: input.customerPhone,
          interState: false,
          items: lines.map((l) => ({ menuItemId: l.menuItemId, variantId: l.variantId, addonIds: l.addonIds, quantity: l.quantity, notes: l.notes })),
          notes: [header, "UPI prepaid", input.notes].filter(Boolean).join(" · ").slice(0, 300),
        },
        { ip, channelOrderId: publicToken, skipKot: true },
      );
      const updated = await prisma.$transaction(async (tx) => {
        const r = await tx.channelRequest.update({ where: { id: request.id }, data: { orderId: order.id, total: order.grandTotal } });
        await emitTheatre(tx, outlet.id, { requestId: r.id, action: "new" });
        return r;
      });
      kickOutbox();
      const { payment, qr } = await issueUpi(outlet, order.id);
      if (pending) {
        const { emitToOutlet } = await import("../realtime");
        emitToOutlet(outlet.id, "channel:request", { id: request.id, action: "new" });
        void alertSeatOrder(outlet.id, updated, seat.label);
      }
      return {
        id: updated.id,
        token: publicToken,
        status: updated.status,
        timing: input.timing,
        pickupToken: updated.pickupToken,
        total: order.grandTotal,
        upi: { qrPayload: qr.qrPayload, imageUrl: qr.imageUrl ?? null, amount: payment.amount, mock: qr.mock },
      };
    } catch (e) {
      // No bill → no stray request (its pickup token is free again: tokens are the day's highest + 1).
      const r = await prisma.channelRequest.findUnique({ where: { id: request.id } });
      if (r && !r.orderId) await prisma.channelRequest.delete({ where: { id: r.id } }).catch(() => undefined);
      throw e;
    }
  });
}

async function alertSeatOrder(outletId: string, request: ChannelRequest, label: string) {
  try {
    const to = await outletStaff(outletId, ["CASHIER", "WAITER"]);
    await notify(to, `New seat order · ${label}`, `${request.seatTiming} — accept or reject it on the Tables screen`, "channel.order", { outletId, link: "/theatre/board" });
  } catch (e) {
    console.warn("[theatre] new-order alert failed (ignored):", (e as Error).message);
  }
}

/** A fresh UPI QR for an unpaid seat order (the first one expired). */
export async function seatUpi(token: string, requestToken: string) {
  const { table, outlet } = await tableByToken(token);
  return runForOutlet(outlet.id, async () => {
    const r = await prisma.channelRequest.findUnique({ where: { publicToken: requestToken } });
    if (!r || r.tableId !== table.id || !r.seatTiming || !r.orderId) throw notFound("Order");
    if (r.status === "REJECTED") throw conflict("This order was cancelled");
    const { payment, qr } = await issueUpi(outlet, r.orderId);
    return { qrPayload: qr.qrPayload, imageUrl: qr.imageUrl ?? null, amount: payment.amount, mock: qr.mock };
  });
}

// ---------------------------------------------------------------------------
// Runner board
// ---------------------------------------------------------------------------

export type BoardStage = "WAITING" | "PREPARING" | "READY" | "DELIVERED";

type KotLite = { id: string; status: string; releaseAt: Date | null };

export function seatStage(r: Pick<ChannelRequest, "status" | "readyAt" | "deliveredAt">, paid: boolean, kots: KotLite[], releaseAt: Date | null, now = new Date()): BoardStage {
  if (r.deliveredAt) return "DELIVERED";
  if (!paid || r.status !== "ACCEPTED") return "WAITING";
  if (releaseAt && releaseAt > now) return "WAITING";
  if (r.readyAt) return "READY";
  if (kots.length && kots.every((k) => k.status === "READY" || k.status === "SERVED")) return "READY";
  return "PREPARING";
}

export interface BoardOrder {
  requestId: string;
  orderId: string | null;
  publicToken: string;
  screenId: string;
  screenName: string;
  seatLabel: string;
  row: string | null;
  seatNumber: number | null;
  timing: SeatTiming;
  pickupToken: number | null;
  stage: BoardStage;
  releaseAt: string | null;
  items: { name: string; quantity: number; notes?: string }[];
  total: number;
  paid: boolean;
  createdAt: string;
  customerName: string | null;
}

/** BoardOrder rows for seat requests (inside the tenant context). */
export async function boardOrders(outlet: Pick<Outlet, "id" | "storefront">, requests: ChannelRequest[], now = new Date()) {
  const settings = readTheatreSettings(outlet);
  const orderIds = requests.map((r) => r.orderId).filter((x): x is string => Boolean(x));
  const tableIds = [...new Set(requests.map((r) => r.tableId).filter((x): x is string => Boolean(x)))];
  const showIds = [...new Set(requests.map((r) => r.showTimeId).filter((x): x is string => Boolean(x)))];
  const [orders, kots, seats, shows] = await Promise.all([
    orderIds.length ? prisma.order.findMany({ where: { id: { in: orderIds } }, select: { id: true, status: true, grandTotal: true } }) : [],
    orderIds.length ? prisma.kotTicket.findMany({ where: { orderId: { in: orderIds } }, select: { id: true, orderId: true, status: true, releaseAt: true } }) : [],
    tableIds.length ? prisma.diningTable.findMany({ where: { id: { in: tableIds } }, select: { id: true, label: true, seatRow: true, seatNumber: true, areaId: true, area: { select: { name: true } } } }) : [],
    showIds.length ? prisma.showTime.findMany({ where: { id: { in: showIds } }, select: { id: true, intervalAt: true } }) : [],
  ]);
  const orderById = new Map(orders.map((o) => [o.id, o]));
  const seatById = new Map(seats.map((s) => [s.id, s]));
  const showById = new Map(shows.map((s) => [s.id, s]));
  return requests.map((r): BoardOrder => {
    const order = r.orderId ? orderById.get(r.orderId) : undefined;
    const mine = kots.filter((k) => k.orderId === r.orderId);
    const seat = r.tableId ? seatById.get(r.tableId) : undefined;
    const held = mine.map((k) => k.releaseAt).filter((d): d is Date => Boolean(d));
    const releaseAt = held.length
      ? new Date(Math.max(...held.map((d) => d.getTime())))
      : r.seatTiming === "INTERVAL" && !mine.length
        ? (() => {
            const iv = r.showTimeId ? showById.get(r.showTimeId)?.intervalAt : null;
            return iv ? new Date(iv.getTime() - settings.intervalLeadMin * MIN) : null;
          })()
        : null;
    const paid = order?.status === "PAID";
    return {
      requestId: r.id,
      orderId: r.orderId,
      publicToken: r.publicToken,
      screenId: seat?.areaId ?? "",
      screenName: seat?.area?.name ?? "",
      seatLabel: seat?.label ?? "",
      row: seat?.seatRow ?? null,
      seatNumber: seat?.seatNumber ?? null,
      timing: r.seatTiming as SeatTiming,
      pickupToken: r.pickupToken,
      stage: seatStage(r, paid, mine, releaseAt, now),
      releaseAt: releaseAt?.toISOString() ?? null,
      items: (r.items as unknown as { name: string; quantity: number; notes?: string }[]).map((l) => ({ name: l.name, quantity: l.quantity, ...(l.notes && { notes: l.notes }) })),
      total: order?.grandTotal ?? r.total,
      paid,
      createdAt: r.createdAt.toISOString(),
      customerName: r.customerName,
    };
  });
}

/**
 * The runner board: seat orders of the last 12 hours that still need someone (unpaid ones placed in
 * the last 30 minutes so a cashier can confirm a UPI payment by hand; delivered ones for 15 minutes).
 */
export async function runnerBoard(outlet: Outlet, screenId?: string) {
  const now = new Date();
  const screens = await prisma.diningArea.findMany({ where: { outletId: outlet.id, kind: "SCREEN", ...(screenId && { id: screenId }) }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }] });
  const requests = await prisma.channelRequest.findMany({
    where: {
      outletId: outlet.id,
      seatTiming: { not: null },
      status: { not: "REJECTED" },
      createdAt: { gte: new Date(now.getTime() - 12 * 3600_000) },
      OR: [{ deliveredAt: null }, { deliveredAt: { gte: new Date(now.getTime() - 15 * MIN) } }],
    },
    orderBy: { createdAt: "asc" },
    take: 1000,
  });
  const all = (await boardOrders(outlet, requests, now)).filter((o) => o.paid || Date.parse(o.createdAt) >= now.getTime() - UNPAID_EXPIRY_MIN * MIN);
  const ids = new Set(screens.map((s) => s.id));
  const mine = all.filter((o) => ids.has(o.screenId));
  const shows = await currentAndNext(outlet.id, screens.map((s) => s.id), now);
  return {
    screens: screens.map((s) => {
      const orders = mine.filter((o) => o.screenId === s.id && o.timing !== "COUNTER");
      const rows = [...new Set(orders.map((o) => o.row ?? "?"))].sort(rowOrder);
      return { id: s.id, name: s.name, code: s.code ?? "", currentShow: shows.get(s.id)?.currentShow ?? null, rows: rows.map((row) => ({ row, orders: orders.filter((o) => (o.row ?? "?") === row) })) };
    }),
    counter: mine.filter((o) => o.timing === "COUNTER").sort((a, b) => (a.pickupToken ?? 0) - (b.pickupToken ?? 0)),
  };
}

export async function findSeatRequest(id: string, outletId: string) {
  const r = await prisma.channelRequest.findFirst({ where: { id, outletId, seatTiming: { not: null } } });
  if (!r) throw notFound("Seat order");
  return r;
}

/**
 * Runner board stage change. READY: the food is ready for a runner / the counter (its KOTs move to
 * Ready on the kitchen display too). DELIVERED: handed over (KOTs Served, off the kitchen display).
 */
export async function moveStage(req: Request, outlet: Outlet, request: ChannelRequest, to: "READY" | "DELIVERED") {
  const [before] = await boardOrders(outlet, [request]);
  if (request.status === "REJECTED") throw conflict("This order was cancelled");
  if (request.status !== "ACCEPTED") throw conflict("Accept the order first");
  if (!before.paid) throw conflict("This order isn't paid yet");
  if (before.stage === "DELIVERED") throw conflict("Already delivered");
  if (before.stage === "WAITING" && before.releaseAt) throw conflict(`Held for the interval — it goes to the kitchen at ${hhmm(new Date(before.releaseAt), outlet.timezone)}`);
  if (to === "READY" && before.stage === "READY") return { order: before, kotIds: [] as string[] };
  const now = new Date();
  const kotIds = await prisma.$transaction(async (tx) => {
    const claimed = await tx.channelRequest.updateMany({
      where: { id: request.id, deliveredAt: null },
      data: to === "READY" ? { readyAt: now } : { deliveredAt: now, ...(request.readyAt ? {} : { readyAt: now }) },
    });
    if (!claimed.count) throw conflict("Already delivered");
    const kotStatus = to === "READY" ? "READY" : "SERVED";
    const kots = await tx.kotTicket.findMany({ where: { orderId: request.orderId!, status: { notIn: to === "READY" ? ["READY", "SERVED"] : ["SERVED"] } } });
    for (const k of kots) {
      await tx.kotTicket.update({
        where: { id: k.id },
        data: { status: kotStatus, preparingAt: k.preparingAt ?? now, readyAt: k.readyAt ?? now, ...(to === "DELIVERED" && { servedAt: k.servedAt ?? now }) },
      });
    }
    await emitTheatre(tx, outlet.id, { requestId: request.id, action: to === "READY" ? "ready" : "delivered" });
    return kots.map((k) => k.id);
  });
  kickOutbox();
  const { audit } = await import("../lib/audit");
  await audit(req, to === "READY" ? "theatre.order.ready" : "theatre.order.delivered", "ChannelRequest", request.id);
  const [after] = await boardOrders(outlet, [await prisma.channelRequest.findUniqueOrThrow({ where: { id: request.id } })]);
  return { order: after, kotIds };
}

// ---------------------------------------------------------------------------
// Guest tracking (public)
// ---------------------------------------------------------------------------

/** GET /public/t/:token/orders for a seat: this show's orders on the seat (not the previous guest's). */
export async function seatOrders(table: DiningTable, outlet: Outlet) {
  return runForOutlet(outlet.id, async () => {
    const seat = await loadSeat(table.id);
    const win = seat.area ? await seatWindow(seat.area.id, outlet.timezone) : null;
    const since = win && win.show.startsAt.getTime() - OPEN_BEFORE_MIN * MIN < Date.now() ? new Date(win.show.startsAt.getTime() - OPEN_BEFORE_MIN * MIN) : new Date(Date.now() - 4 * 3600_000);
    const requests = await prisma.channelRequest.findMany({ where: { tableId: table.id, seatTiming: { not: null }, createdAt: { gte: since } }, orderBy: { createdAt: "desc" }, take: 20 });
    const views = await boardOrders(outlet, requests);
    const orderIds = requests.map((r) => r.orderId).filter((x): x is string => Boolean(x));
    const pendingUpi = orderIds.length ? await prisma.payment.findMany({ where: { orderId: { in: orderIds }, mode: "UPI", status: "PENDING" }, orderBy: { createdAt: "desc" } }) : [];
    return requests.map((r, i) => {
      const v = views[i];
      const upi = !v.paid && r.status !== "REJECTED" ? pendingUpi.find((p) => p.orderId === r.orderId) : undefined;
      return {
        id: r.id,
        token: r.publicToken,
        createdAt: r.createdAt,
        status: r.status,
        stage: r.status === "REJECTED" ? ("CANCELLED" as const) : v.stage,
        timing: v.timing,
        pickupToken: v.pickupToken,
        releaseAt: v.releaseAt,
        paid: v.paid,
        rejectReason: r.rejectReason,
        total: v.total,
        items: v.items.map((l) => ({ name: l.name, quantity: l.quantity })),
        upi: upi ? { amount: upi.amount, qrPayload: upi.qrPayload } : null,
      };
    });
  });
}

// ---------------------------------------------------------------------------
// Unpaid seat orders expire (job)
// ---------------------------------------------------------------------------

/** Cancel seat orders still unpaid after UNPAID_EXPIRY_MIN (their bills would clutter Open bills forever). */
export async function expireUnpaidSeatOrders(now = new Date()) {
  const candidates = await prisma.channelRequest.findMany({
    where: {
      seatTiming: { not: null },
      status: { not: "REJECTED" },
      orderId: { not: null },
      kotIds: { isEmpty: true },
      readyAt: null,
      deliveredAt: null,
      createdAt: { lt: new Date(now.getTime() - UNPAID_EXPIRY_MIN * MIN), gte: new Date(now.getTime() - 12 * 3600_000) },
    },
    select: { id: true, outletId: true, orderId: true },
    take: 2000,
  });
  const open = new Set(
    candidates.length ? (await prisma.order.findMany({ where: { id: { in: candidates.map((c) => c.orderId!) }, status: "OPEN" }, select: { id: true } })).map((o) => o.id) : [],
  );
  const stale = candidates.filter((c) => open.has(c.orderId!));
  let n = 0;
  for (const s of stale) {
    await runForOutlet(s.outletId, async () => {
      const order = await getOrder(s.orderId!, s.outletId);
      if (order.status !== "OPEN" || order.payments.some((p) => p.status === "SUCCESS")) return;
      const outlet = await prisma.outlet.findUniqueOrThrow({ where: { id: s.outletId }, select: { businessId: true } });
      const req = await systemRequest(s.outletId, outlet.businessId);
      await prisma.$transaction(async (tx) => {
        const claimed = await tx.channelRequest.updateMany({ where: { id: s.id, status: { not: "REJECTED" } }, data: { status: "REJECTED", rejectReason: "Not paid in time", decidedAt: now } });
        if (!claimed.count) return;
        await tx.payment.updateMany({ where: { orderId: order.id, status: "PENDING" }, data: { status: "FAILED" } });
        await cancelOrderInTx(tx, req, order, "Seat order not paid in time");
        await emitTheatre(tx, s.outletId, { requestId: s.id, action: "expired" });
      });
      n++;
    });
  }
  if (n) kickOutbox();
  return n;
}
