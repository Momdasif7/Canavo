import type { Request } from "express";
import type { Prisma } from "@prisma/client";
import {
  BOARD_CHANNELS,
  formatPackingSlipText,
  formatReceiptText,
  type ChannelBoardOrder,
  type ChannelBoardStage,
  type ChannelPackingSlip,
  type PaperWidth,
} from "@canavo/shared";
import { prisma } from "../../db";
import { conflict, notFound } from "../../lib/http";
import { outboxEmitOutlet } from "../../lib/outbox";
import { addDays, startOfLocalDay, zonedParts } from "../../lib/time";
import { emitToOutlet } from "../../realtime";
import { amountPaid, buildReceipt, getOrder } from "../billing";
import { queueChannelStatus } from "./service";

/**
 * Phase 6 — the Online orders board: aggregator (hub) and own online-page orders arrive billed;
 * staff pack them and hand them to the rider (or to our delivery partner when we deliver).
 *
 * Stage: CANCELLED (bill voided) → HANDED_OVER (handover recorded, or our partner picked it up)
 * → PACKED → PREPARING (the kitchen marked a KOT Preparing / Ready) → NEW. Only packing and
 * handover are stored (OrderHandover); the rest is read from the bill and its KOTs.
 * Packed pushes FOOD_READY to the hub (once — the KOT-ready hook shares the guard), handed over
 * pushes DISPATCHED. Every change emits `channel:board` { orderId, stage } to the outlet.
 */

type Db = Prisma.TransactionClient | typeof prisma;

export const BOARD_EVENT = "channel:board";
const BOARD_CHANNEL_LIST: string[] = [...BOARD_CHANNELS];
export const isBoardChannel = (channel: string | null | undefined) => Boolean(channel && BOARD_CHANNEL_LIST.includes(channel));

/** How far back "not yet handed over" orders are carried onto today's board. */
const CARRY_OVER_DAYS = 7;
export const AUTO_PRINT_KEY = "channels.autoPrint";

const boardInclude = {
  items: { select: { name: true, quantity: true, notes: true, addons: true }, orderBy: { id: "asc" } },
  kots: { select: { status: true } },
  payments: { select: { status: true, amount: true } },
  handover: true,
  delivery: { select: { status: true, pickedAt: true, etaAt: true, agent: { select: { name: true, phone: true } } } },
} satisfies Prisma.OrderInclude;
type BoardRow = Prisma.OrderGetPayload<{ include: typeof boardInclude }>;
type ChannelRow = { orderId: string | null; channelOrderId: string; riderStatus: string | null; rider: Prisma.JsonValue; payload: Prisma.JsonValue };

const KITCHEN_STARTED = new Set(["PREPARING", "READY", "SERVED"]);

function stageOf(o: Pick<BoardRow, "status" | "handover"> & { kots: { status: string }[]; delivery: { pickedAt: Date | null } | null }): ChannelBoardStage {
  if (o.status === "CANCELLED") return "CANCELLED";
  if (o.handover?.handedOverAt || o.delivery?.pickedAt) return "HANDED_OVER";
  if (o.handover?.packedAt) return "PACKED";
  if (o.kots.some((k) => KITCHEN_STARTED.has(k.status))) return "PREPARING";
  return "NEW";
}

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

function present(o: BoardRow, ch: ChannelRow | undefined): ChannelBoardOrder {
  const weDeliver = o.orderType === "DELIVERY";
  const riderJson = (ch?.rider ?? null) as Record<string, unknown> | null;
  let rider: ChannelBoardOrder["rider"] = null;
  if (weDeliver && o.delivery) {
    // Our own delivery partner.
    rider = o.delivery.agent
      ? { name: o.delivery.agent.name, phone: o.delivery.agent.phone, pickupCode: null, eta: o.delivery.etaAt?.toISOString() ?? null, arrived: Boolean(o.delivery.pickedAt) }
      : null;
  } else if (ch && (ch.riderStatus || riderJson)) {
    rider = {
      name: str(riderJson?.name) ?? o.handover?.riderName ?? null,
      phone: str(riderJson?.phone),
      pickupCode: str(riderJson?.pickupCode),
      eta: str(riderJson?.eta),
      arrived: ch.riderStatus === "AT_STORE" || ch.riderStatus === "PICKED_UP" || ch.riderStatus === "DELIVERED",
    };
  } else if (o.handover?.riderName) {
    rider = { name: o.handover.riderName, phone: null, pickupCode: null, eta: null, arrived: true };
  }
  const displayId = str((ch?.payload as Record<string, unknown> | null)?.displayId);
  return {
    orderId: o.id,
    invoiceNumber: o.invoiceNumber,
    channel: o.channel,
    channelOrderId: displayId ?? ch?.channelOrderId ?? (o.channel === "ONLINE" ? null : o.channelOrderId),
    stage: stageOf(o),
    customerName: o.customerName,
    items: o.items.map((i) => {
      const addons = Array.isArray(i.addons) ? (i.addons as { name?: string }[]).map((a) => a?.name).filter(Boolean) : [];
      return { name: addons.length ? `${i.name} + ${addons.join(", ")}` : i.name, quantity: i.quantity, notes: i.notes };
    }),
    total: o.grandTotal,
    paid: o.status === "PAID",
    weDeliver,
    placedAt: o.createdAt.toISOString(),
    packedAt: o.handover?.packedAt?.toISOString() ?? null,
    handedOverAt: (o.handover?.handedOverAt ?? o.delivery?.pickedAt)?.toISOString() ?? null,
    rider,
  };
}

async function channelRows(orderIds: string[], db: Db = prisma): Promise<Map<string, ChannelRow>> {
  if (!orderIds.length) return new Map();
  const rows = await db.channelOrder.findMany({
    where: { orderId: { in: orderIds }, status: { not: "REJECTED" } },
    select: { orderId: true, channelOrderId: true, riderStatus: true, rider: true, payload: true },
  });
  return new Map(rows.map((r) => [r.orderId!, r]));
}

/** Today's (outlet time) channel orders, newest first, plus older ones not yet handed over or cancelled. */
export async function boardOrders(outletId: string): Promise<ChannelBoardOrder[]> {
  const outlet = await prisma.outlet.findUniqueOrThrow({ where: { id: outletId }, select: { timezone: true } });
  const today = zonedParts(new Date(), outlet.timezone).date;
  const dayStart = startOfLocalDay(today, outlet.timezone);
  const carryFrom = startOfLocalDay(addDays(today, -CARRY_OVER_DAYS), outlet.timezone);
  const orders = await prisma.order.findMany({
    where: {
      outletId,
      channel: { in: BOARD_CHANNEL_LIST },
      OR: [
        { createdAt: { gte: dayStart } },
        {
          createdAt: { gte: carryFrom, lt: dayStart },
          status: { not: "CANCELLED" },
          AND: [{ OR: [{ handover: { is: null } }, { handover: { handedOverAt: null } }] }, { OR: [{ delivery: { is: null } }, { delivery: { pickedAt: null, status: { notIn: ["DELIVERED", "CANCELLED"] } } }] }],
        },
      ],
    },
    include: boardInclude,
    orderBy: { createdAt: "desc" },
    take: 300,
  });
  const ch = await channelRows(orders.map((o) => o.id));
  return orders.map((o) => present(o, ch.get(o.id)));
}

async function loadBoardOrder(outletId: string, orderId: string, db: Db = prisma) {
  const o = await db.order.findFirst({ where: { id: orderId, outletId }, include: boardInclude });
  if (!o || !isBoardChannel(o.channel)) throw notFound("Online order");
  return o;
}

export async function boardOrder(outletId: string, orderId: string, db: Db = prisma): Promise<ChannelBoardOrder> {
  const o = await loadBoardOrder(outletId, orderId, db);
  return present(o, (await channelRows([o.id], db)).get(o.id));
}

/**
 * Tell the outlet's board an order changed. Inside a transaction pass `tx`: the event goes
 * through the outbox and is only sent once the transaction commits. No-op for non-board orders.
 */
export async function emitBoardChange(outletId: string, orderId: string, tx?: Prisma.TransactionClient) {
  const db = tx ?? prisma;
  const o = await db.order.findFirst({ where: { id: orderId, outletId }, select: { channel: true, status: true, handover: true, kots: { select: { status: true } }, delivery: { select: { pickedAt: true } } } });
  if (!o || !isBoardChannel(o.channel)) return;
  const payload = { orderId, stage: stageOf(o) };
  if (tx) await outboxEmitOutlet(tx, outletId, BOARD_EVENT, payload);
  else emitToOutlet(outletId, BOARD_EVENT, payload);
}

/** Packed: record it and push FOOD_READY to the hub (skipped if the KOT-ready hook already sent it). */
export async function markPacked(req: Request, orderId: string) {
  const outletId = req.outletId!;
  await prisma.$transaction(async (tx) => {
    const o = await loadBoardOrder(outletId, orderId, tx);
    const stage = stageOf(o);
    if (stage === "CANCELLED") throw conflict("This order was cancelled");
    if (stage === "HANDED_OVER") throw conflict("This order was already handed over");
    if (stage === "PACKED") return;
    await tx.orderHandover.upsert({
      where: { orderId },
      create: { outletId, orderId, packedAt: new Date(), packedById: req.user!.id },
      update: { packedAt: new Date(), packedById: req.user!.id },
    });
    await queueChannelStatus(tx, orderId, "FOOD_READY");
    await emitBoardChange(outletId, orderId, tx);
  });
  return boardOrder(outletId, orderId);
}

/**
 * Handed to the rider: record it (with the rider's name) and push DISPATCHED to the hub.
 * For an order we deliver it means our partner picked it up.
 */
export async function markHandedOver(req: Request, orderId: string, riderName?: string) {
  const outletId = req.outletId!;
  await prisma.$transaction(async (tx) => {
    const o = await loadBoardOrder(outletId, orderId, tx);
    const stage = stageOf(o);
    if (stage === "CANCELLED") throw conflict("This order was cancelled");
    if (stage === "HANDED_OVER") throw conflict("This order was already handed over");
    const now = new Date();
    const name = riderName?.trim() || undefined;
    await tx.orderHandover.upsert({
      where: { orderId },
      create: { outletId, orderId, packedAt: now, packedById: req.user!.id, handedOverAt: now, handedOverById: req.user!.id, riderName: name },
      update: { handedOverAt: now, handedOverById: req.user!.id, ...(name && { riderName: name }), ...(!o.handover?.packedAt && { packedAt: now, packedById: req.user!.id }) },
    });
    // Skipping "Packed" still tells the channel the food is ready before it's dispatched.
    if (stage !== "PACKED") await queueChannelStatus(tx, orderId, "FOOD_READY");
    await queueChannelStatus(tx, orderId, "DISPATCHED", name ? `Handed to ${name}` : undefined);
    await emitBoardChange(outletId, orderId, tx);
  });
  return boardOrder(outletId, orderId);
}

/** The channel's rider picked the order up: record the handover (the channel already knows — no push). */
export async function recordRiderPickup(tx: Prisma.TransactionClient, outletId: string, orderId: string, riderName?: string) {
  const existing = await tx.orderHandover.findUnique({ where: { orderId } });
  if (existing?.handedOverAt) return;
  const now = new Date();
  await tx.orderHandover.upsert({
    where: { orderId },
    create: { outletId, orderId, packedAt: now, handedOverAt: now, riderName },
    update: { handedOverAt: now, ...(riderName && { riderName }), ...(!existing?.packedAt && { packedAt: now }) },
  });
}

/** Packing slip / bag label data. The customer's first name only. */
export async function packingSlip(outletId: string, orderId: string): Promise<ChannelPackingSlip> {
  const o = await loadBoardOrder(outletId, orderId);
  const outlet = await prisma.outlet.findUniqueOrThrow({ where: { id: outletId }, select: { name: true } });
  const view = present(o, (await channelRows([o.id])).get(o.id));
  return {
    ...view,
    customerName: o.customerName?.trim().split(/\s+/)[0] ?? null,
    outletName: outlet.name,
    printedAt: new Date().toISOString(),
    amountDue: o.status === "PAID" || o.status === "CANCELLED" ? 0 : Math.max(0, o.grandTotal - amountPaid(o)),
  };
}

const hhmm = (iso: string, tz: string) => new Date(iso).toLocaleTimeString("en-IN", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false });

/**
 * Everything a counter prints when a channel order arrives (auto-print): the bill, the KOTs
 * and the packing slip, as one plain-text job. Marks the KOTs printed.
 */
export async function arrivalPrintText(outletId: string, orderId: string, paper: PaperWidth) {
  await loadBoardOrder(outletId, orderId);
  const order = await getOrder(orderId, outletId);
  const outlet = await prisma.outlet.findUniqueOrThrow({ where: { id: outletId }, select: { timezone: true } });
  const receipt = formatReceiptText(await buildReceipt(order), paper).join("\n");
  const slip = formatPackingSlipText(await packingSlip(outletId, orderId), { timeZone: outlet.timezone, width: paper === 80 ? 48 : 32 });
  const kots = order.kots.map((k) => {
    const items = (k.items ?? []) as { name: string; quantity: number; addons?: string[]; notes?: string | null; voided?: boolean }[];
    return [
      `KOT #${k.kotNumber}  [${k.station}]`,
      `${order.orderType.replace("_", "-")}  Bill ${order.invoiceNumber}`,
      hhmm(k.createdAt.toISOString(), outlet.timezone),
      "--------------------------------",
      ...items.filter((i) => !i.voided).flatMap((i) => [`${String(i.quantity).padStart(2)} x ${i.name}`, ...(i.addons ?? []).map((a) => `     + ${a}`), ...(i.notes ? [`     ! ${i.notes}`] : [])]),
      ...(order.notes ? ["--------------------------------", `Note: ${order.notes}`] : []),
    ].join("\n");
  });
  if (order.kots.length) await prisma.kotTicket.updateMany({ where: { id: { in: order.kots.map((k) => k.id) }, printedAt: null }, data: { printedAt: new Date() } });
  // A blank line and a cut marker between the parts (thermal printers cut on the page break).
  return [receipt, ...kots, slip].join("\n\n- - - - - - - - - - - - - - - -\n\n");
}

export async function getAutoPrint(outletId: string) {
  const s = await prisma.setting.findUnique({ where: { scope_key: { scope: outletId, key: AUTO_PRINT_KEY } } });
  return s?.value === true;
}

export async function setAutoPrint(outletId: string, autoPrint: boolean) {
  await prisma.setting.upsert({ where: { scope_key: { scope: outletId, key: AUTO_PRINT_KEY } }, create: { scope: outletId, key: AUTO_PRINT_KEY, value: autoPrint }, update: { value: autoPrint } });
  return autoPrint;
}
