import type { Prisma } from "@prisma/client";
import { theatreSettingsSchema, type SeatTiming, type TheatreSettings } from "@canavo/shared";
import { prisma } from "../db";
import { kickOutbox, outboxEmitOutlet, outboxTask } from "../lib/outbox";
import { moduleEnabled } from "../lib/tenant";
import { lastKotNumberToday } from "./kot-number";

/**
 * Cinema seat ordering (THEATRE), the kitchen side. Kept free of billing imports: billing's
 * settleIfPaid calls onSeatOrderPaid, so a paid seat order's KOTs go out in the payment's own
 * transaction (webhook, cashier confirm or dev simulate — every path ends in settleIfPaid).
 */

type Tx = Prisma.TransactionClient;

/** Theatre settings live in Outlet.storefront under `theatre` (defaults when missing / invalid). */
export function readTheatreSettings(outlet: { storefront: Prisma.JsonValue }): TheatreSettings {
  const sf = outlet.storefront && typeof outlet.storefront === "object" && !Array.isArray(outlet.storefront) ? (outlet.storefront as Record<string, unknown>) : {};
  const parsed = theatreSettingsSchema.safeParse(sf.theatre ?? {});
  return parsed.success ? parsed.data : theatreSettingsSchema.parse({});
}

/** "SCREEN S2 · F12 · INTERVAL", counter pickups add the token: "SCREEN S2 · F12 · COUNTER #7". */
export function seatHeader(screenCode: string, row: string | null, seatNumber: number | null, timing: string, pickupToken: number | null) {
  const seat = row && seatNumber ? `${row}${seatNumber}` : "?";
  return `SCREEN ${screenCode} · ${seat} · ${timing}${timing === "COUNTER" && pickupToken ? ` #${pickupToken}` : ""}`;
}

/** Interval orders reach the kitchen this long before the interval; null = at once (no interval, or already inside the lead time). */
export function intervalReleaseAt(timing: SeatTiming | string | null, intervalAt: Date | null | undefined, leadMin: number, now = new Date()): Date | null {
  if (timing !== "INTERVAL" || !intervalAt) return null;
  const at = new Date(intervalAt.getTime() - leadMin * 60_000);
  return at.getTime() > now.getTime() ? at : null;
}

/** Board / guest pages follow seat orders through this socket event (outlet room). */
export const THEATRE_EVENT = "theatre:updated";
export const emitTheatre = (tx: Tx, outletId: string, payload: { requestId?: string; action: string }) => outboxEmitOutlet(tx, outletId, THEATRE_EVENT, payload);

/**
 * Send a seat order to the kitchen once it is both accepted and paid: one KOT per station with the
 * seat header, interval orders held (releaseAt) until shortly before the interval. Idempotent: the
 * request row is locked and a request that already has KOTs is left alone, so a payment confirmed
 * at the same moment as a staff "accept" fires once. Returns the KOT ids.
 */
export async function fireSeatKots(tx: Tx, requestId: string): Promise<string[]> {
  await tx.$queryRaw`SELECT id FROM "ChannelRequest" WHERE id = ${requestId} FOR UPDATE`;
  const request = await tx.channelRequest.findUnique({ where: { id: requestId } });
  if (!request?.seatTiming || !request.orderId || request.status !== "ACCEPTED" || request.kotIds.length) return request?.kotIds ?? [];
  const order = await tx.order.findUniqueOrThrow({ where: { id: request.orderId }, include: { items: true } });
  if (order.status !== "PAID") return [];
  const outletId = request.outletId;
  if (!moduleEnabled("KOT")) {
    await emitTheatre(tx, outletId, { requestId, action: "paid" });
    return [];
  }
  if (await tx.kotTicket.count({ where: { orderId: order.id } })) return (await tx.kotTicket.findMany({ where: { orderId: order.id }, select: { id: true } })).map((k) => k.id);

  const outlet = await tx.outlet.findUniqueOrThrow({ where: { id: outletId }, select: { timezone: true, storefront: true } });
  const seat = request.tableId ? await tx.diningTable.findUnique({ where: { id: request.tableId }, include: { area: { select: { code: true } } } }) : null;
  const show = request.showTimeId ? await tx.showTime.findUnique({ where: { id: request.showTimeId }, select: { intervalAt: true } }) : null;
  const releaseAt = intervalReleaseAt(request.seatTiming, show?.intervalAt, readTheatreSettings(outlet).intervalLeadMin);
  const header = seatHeader(seat?.area?.code ?? "?", seat?.seatRow ?? null, seat?.seatNumber ?? null, request.seatTiming, request.pickupToken);

  const stations = new Map(
    (await tx.menuItem.findMany({ where: { id: { in: order.items.map((i) => i.menuItemId) } }, select: { id: true, kitchenStation: true } })).map((m) => [m.id, m.kitchenStation]),
  );
  const byStation = new Map<string, typeof order.items>();
  for (const i of order.items) {
    const st = stations.get(i.menuItemId) ?? "MAIN";
    byStation.set(st, [...(byStation.get(st) ?? []), i]);
  }
  let kotNumber = await lastKotNumberToday(tx, outletId, outlet.timezone);
  const created = [];
  for (const [station, items] of byStation) {
    created.push(
      await tx.kotTicket.create({
        data: {
          orderId: order.id,
          outletId,
          station,
          kotNumber: ++kotNumber,
          header,
          releaseAt,
          items: items.map((i) => ({ name: i.name, quantity: i.quantity, addons: ((i.addons as { name: string }[] | null) ?? []).map((a) => a.name), notes: i.notes ?? null })),
        },
      }),
    );
  }
  await tx.channelRequest.update({ where: { id: requestId }, data: { kotIds: created.map((k) => k.id) } });
  if (!releaseAt) {
    // Held interval KOTs are announced by the service-kot-release job when releaseAt passes.
    const summary = { id: order.id, invoiceNumber: order.invoiceNumber, orderType: order.orderType, tableLabel: order.tableLabel, notes: order.notes, status: order.status, channel: order.channel };
    await outboxEmitOutlet(tx, outletId, "kot:new", created.map((k) => ({ ...k, order: summary, session: null })));
    await outboxTask(tx, "kitchen.alert", { outletId, kotIds: created.map((k) => k.id), label: header });
  }
  await emitTheatre(tx, outletId, { requestId, action: "kitchen" });
  return created.map((k) => k.id);
}

/** settleIfPaid hook: a seat order just became PAID → its KOTs (if it is already accepted). */
export async function onSeatOrderPaid(db: Tx | typeof prisma, orderId: string): Promise<void> {
  const request = await db.channelRequest.findUnique({ where: { orderId }, select: { id: true, seatTiming: true, outletId: true } });
  if (!request?.seatTiming) return;
  const run = async (tx: Tx) => {
    await fireSeatKots(tx, request.id);
    await emitTheatre(tx, request.outletId, { requestId: request.id, action: "paid" });
  };
  if ("$transaction" in db && typeof db.$transaction === "function") {
    await (db as typeof prisma).$transaction(run);
    kickOutbox();
  } else await run(db as Tx);
}
