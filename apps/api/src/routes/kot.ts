import { Router } from "express";
import { z } from "zod";
import type { Prisma } from "@prisma/client";
import { kotStatusSchema } from "@canavo/shared";
import { prisma } from "../db";
import { audit } from "../lib/audit";
import { retryTransaction } from "../lib/tx-retry";
import { notFound, param, parse } from "../lib/http";
import { authenticate, requireOutlet, requirePermission, requireModule } from "../middleware/auth";
import { emitToOutlet } from "../realtime";
import { alertOrderReady } from "../services/alerts";
import { onKotReady } from "../services/channels/service";
import { emitBoardChange, isBoardChannel } from "../services/channels/board";
import { THEATRE_EVENT } from "../services/theatre-kot";

export const kotRouter = Router();
kotRouter.use(authenticate, requireOutlet, requireModule("KOT"));

const kotInclude = {
  order: {
    select: { id: true, invoiceNumber: true, orderType: true, tableLabel: true, notes: true, status: true, scheduledFor: true, customerName: true, channel: true },
  },
  session: { select: { id: true, tableId: true, mergedTableIds: true, table: { select: { label: true } } } },
} satisfies Prisma.KotTicketInclude;
type KotRow = Prisma.KotTicketGetPayload<{ include: typeof kotInclude }>;

/** Shape KOTs for clients: `session: { id, tableLabel, table: { label } }` incl. merged table labels. */
async function present(kots: KotRow[]) {
  const mergedIds = [...new Set(kots.flatMap((k) => k.session?.mergedTableIds ?? []))];
  const labels = mergedIds.length
    ? new Map((await prisma.diningTable.findMany({ where: { id: { in: mergedIds } }, select: { id: true, label: true } })).map((t) => [t.id, t.label]))
    : new Map<string, string>();
  return kots.map(({ session, ...k }) => {
    if (!session) return { ...k, session: null };
    const label = [session.table.label, ...session.mergedTableIds.map((id) => labels.get(id) ?? "?")].join("+");
    return { ...k, session: { id: session.id, tableLabel: label, table: { label } } };
  });
}

/** Tell kitchen displays about KOTs changed elsewhere (THEATRE runner board), same payload as PATCH /kot/:id. */
export async function emitKotsUpdated(outletId: string, ids: string[]) {
  if (!ids.length) return;
  const rows = await prisma.kotTicket.findMany({ where: { id: { in: ids }, outletId }, include: kotInclude });
  for (const k of await present(rows)) emitToOutlet(outletId, "kot:updated", k);
}

/**
 * Active KOTs for the kitchen display (anything not yet served, last 24h).
 * Pre-order KOTs stay hidden until their release time; `?all=1` shows
 * everything (served, held pre-orders) for history views.
 */
kotRouter.get("/", requirePermission("kot:view"), async (req, res) => {
  const { station, all } = parse(z.object({ station: z.string().optional(), all: z.string().optional() }), req.query);
  const now = new Date();
  const kots = await prisma.kotTicket.findMany({
    where: {
      outletId: req.outletId,
      ...(station && { station }),
      AND: [
        // Pre-orders may have been placed days ago; include them once released.
        all
          ? { OR: [{ createdAt: { gte: new Date(now.getTime() - 86_400_000) } }, { releaseAt: { gte: new Date(now.getTime() - 86_400_000) } }] }
          : {
              OR: [
                { releaseAt: null, createdAt: { gte: new Date(now.getTime() - 86_400_000) } },
                { releaseAt: { lte: now, gte: new Date(now.getTime() - 86_400_000) } },
              ],
            },
        ...(all ? [] : [{ status: { not: "SERVED" as const } }]),
        // Running-tab KOTs have no order until billed.
        { OR: [{ orderId: null }, { order: { status: { not: "CANCELLED" as const } } }] },
      ],
    },
    include: kotInclude,
    orderBy: [{ createdAt: "asc" }],
  });
  res.json(await present(kots));
});

const STAGES = ["RECEIVED", "PREPARING", "READY", "SERVED"] as const;
const STAGE_AT = { PREPARING: "preparingAt", READY: "readyAt", SERVED: "servedAt" } as const;

/**
 * Stage timestamps for a status change: stamp every stage up to the new one that isn't
 * stamped yet (skipping Preparing stamps it too), clear the later ones when moving back.
 */
function kotStageTimes(found: { preparingAt: Date | null; readyAt: Date | null; servedAt: Date | null }, status: (typeof STAGES)[number]) {
  const at = STAGES.indexOf(status);
  const now = new Date();
  const out: Partial<Record<(typeof STAGE_AT)[keyof typeof STAGE_AT], Date | null>> = {};
  for (const [stage, field] of Object.entries(STAGE_AT) as [keyof typeof STAGE_AT, (typeof STAGE_AT)[keyof typeof STAGE_AT]][]) {
    if (STAGES.indexOf(stage) <= at) {
      if (!found[field]) out[field] = now;
    } else if (found[field]) out[field] = null;
  }
  return out;
}

kotRouter.patch("/:id", requirePermission("kot:update"), async (req, res) => {
  const { status } = parse(kotStatusSchema, req.body);
  const id = param(req, "id");
  if (!(await prisma.kotTicket.findFirst({ where: { id, outletId: req.outletId }, select: { id: true } }))) throw notFound("KOT");
  // Two kitchen screens tapping at once: lock the ticket and read it fresh, so stage times and the
  // "was it already ready?" check see the other tap's result — one "ready" alert, sane timestamps (QA Phase 9).
  const { kot, found } = await retryTransaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "KotTicket" WHERE id = ${id} FOR NO KEY UPDATE`;
    const found = await tx.kotTicket.findUniqueOrThrow({ where: { id } });
    const k = await tx.kotTicket.update({ where: { id }, data: { status, ...kotStageTimes(found, status) }, include: kotInclude });
    // Phase 6.1: an aggregator order whose food is all ready → tell the channel (outbox, retried).
    if (status === "READY" && found.status !== "READY" && k.orderId) await onKotReady(tx, k.orderId);
    return { kot: k, found };
  });
  const [shaped] = await present([kot]);
  emitToOutlet(req.outletId!, "kot:updated", shaped);
  // Phase 6: kitchen progress moves an online-channel order NEW → PREPARING on the packing board.
  if (kot.orderId && status !== found.status && isBoardChannel(kot.order?.channel)) {
    void emitBoardChange(req.outletId!, kot.orderId).catch((e) => console.error("[channels] board emit failed", e));
  }
  if (status === "READY" && found.status !== "READY") void alertOrderReady(req.outletId!, kot.id);
  // THEATRE: a seat order's kitchen progress moves it on the runner board.
  if (found.header && status !== found.status) emitToOutlet(req.outletId!, THEATRE_EVENT, { action: "kitchen", kotId: found.id });
  if (kot.sessionId) emitToOutlet(req.outletId!, "table:updated", { tableIds: [kot.session!.tableId, ...kot.session!.mergedTableIds], sessionId: kot.sessionId, action: "kot" });
  res.json(shaped);
});

const hhmm = (d: Date, tz: string) => d.toLocaleTimeString("en-IN", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false });

/** Record a (re)print and return the KOT as plain text for a thermal printer. */
kotRouter.post("/:id/print", requirePermission("kot:view"), async (req, res) => {
  const row = await prisma.kotTicket.findFirst({ where: { id: param(req, "id"), outletId: req.outletId }, include: kotInclude });
  if (!row) throw notFound("KOT");
  const [found] = await present([row]);
  const outlet = await prisma.outlet.findUniqueOrThrow({ where: { id: req.outletId }, select: { timezone: true } });
  const tz = outlet.timezone;
  const reprint = Boolean(found.printedAt);
  await prisma.kotTicket.update({ where: { id: found.id }, data: { printedAt: new Date() } });
  await audit(req, reprint ? "kot.reprint" : "kot.print", "KotTicket", found.id);
  const items = found.items as { name: string; quantity: number; addons?: string[]; notes?: string | null; voided?: boolean }[];
  const order = found.order;
  const header = found.header
    ? found.header
    : found.session
    ? `DINE-IN  Table ${found.session.tableLabel}`
    : `${order?.orderType.replace("_", "-") ?? ""}${order?.tableLabel ? `  Table ${order.tableLabel}` : ""}`;
  const lines = [
    `${reprint ? "** REPRINT ** " : ""}KOT #${found.kotNumber}  [${found.station}]`,
    ...(order?.scheduledFor && !found.header ? [] : [header]),
    ...(order?.scheduledFor ? [`PRE-ORDER for ${hhmm(order.scheduledFor, tz)}${order.customerName ? ` (${order.customerName})` : ""}`] : []),
    ...(order ? [`Bill ${order.invoiceNumber}`] : ["Running tab"]),
    hhmm(new Date(found.createdAt), tz),
    "--------------------------------",
    ...items.flatMap((i) => [
      `${String(i.quantity).padStart(2)} x ${i.name}${i.voided ? "  ** VOID **" : ""}`,
      ...(i.addons ?? []).map((a) => `     + ${a}`),
      ...(i.notes ? [`     ! ${i.notes}`] : []),
    ]),
    ...(order?.notes ? ["--------------------------------", `Note: ${order.notes}`] : []),
  ];
  res.json({ lines, text: lines.join("\n") });
});
