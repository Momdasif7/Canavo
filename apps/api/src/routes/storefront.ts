import { Router } from "express";
import { Prisma } from "@prisma/client";
import { channelRejectSchema, storefrontUpdateSchema } from "@canavo/shared";
import { platformPrisma, prisma } from "../db";
import { audit } from "../lib/audit";
import { conflict, notFound, param, parse } from "../lib/http";
import { authenticate, requireAnyPermission, requireModule, requireOutlet, requirePermission } from "../middleware/auth";
import { moduleEnabled } from "../lib/tenant";
import { razorpayEnabled } from "../services/razorpay";
import { acceptRequest, cancelAcceptedOnline, newPublicToken, readSettings, rejectRequest } from "../services/storefront";
import { emitTables } from "./tables";

/**
 * Phase 6.3 / 6.4 staff side (CHANNELS): online ordering settings, table QR codes, and the
 * queue of QR / online orders waiting for a waiter or cashier to accept them.
 */
export const storefrontRouter = Router();
storefrontRouter.use(authenticate, requireOutlet, requireModule("CHANNELS"));

// ---------- Settings ----------

/**
 * Settings with the new-setup defaults: an outlet that never had an online page (no web address,
 * phone OTP never chosen) starts with "Verify customer phone by OTP" on. Outlets that already had
 * a page keep the stored default (off), so nothing changes for their customers.
 */
function effectiveSettings(outlet: { storefront: Prisma.JsonValue; publicSlug: string | null }) {
  const stored = outlet.storefront && typeof outlet.storefront === "object" && !Array.isArray(outlet.storefront) ? (outlet.storefront as Record<string, unknown>) : {};
  const firstSetup = !outlet.publicSlug && !("verifyPhoneOtp" in stored);
  return { ...readSettings(outlet), ...(firstSetup && { verifyPhoneOtp: true }) };
}

async function settingsView(outletId: string) {
  const outlet = await prisma.outlet.findUniqueOrThrow({ where: { id: outletId } });
  return {
    settings: effectiveSettings(outlet),
    slug: outlet.publicSlug,
    outletName: outlet.name,
    deliveryAvailable: moduleEnabled("DELIVERY") && outlet.deliveryEnabled,
    tablesAvailable: moduleEnabled("TABLES"),
    upiReady: razorpayEnabled() || Boolean(outlet.upiVpa),
  };
}

storefrontRouter.get("/settings", requirePermission("channel:manage"), async (req, res) => {
  res.json(await settingsView(req.outletId!));
});

storefrontRouter.put("/settings", requirePermission("channel:manage"), async (req, res) => {
  const { slug, ...patch } = parse(storefrontUpdateSchema, req.body);
  const outlet = await prisma.outlet.findUniqueOrThrow({ where: { id: req.outletId! } });
  const settings = { ...effectiveSettings(outlet), ...patch };
  if (slug) {
    // Slugs are global (one web address space for every hotel).
    const taken = await platformPrisma.outlet.findFirst({ where: { publicSlug: slug, id: { not: outlet.id } }, select: { id: true } });
    if (taken) throw conflict("That web address is taken — try another");
  }
  if (settings.onlineOrdering && !(slug === undefined ? outlet.publicSlug : slug)) throw conflict("Choose a web address for your online page first");
  try {
    await prisma.outlet.update({
      where: { id: outlet.id },
      data: { storefront: settings as unknown as Prisma.InputJsonValue, ...(slug !== undefined && { publicSlug: slug }) },
    });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") throw conflict("That web address is taken — try another");
    throw e;
  }
  await audit(req, "storefront.settings", "Outlet", outlet.id, { ...settings, slug: slug ?? outlet.publicSlug });
  res.json(await settingsView(outlet.id));
});

// ---------- Table QR codes ----------

/** Active tables with their QR token (tables that never had one get one now). */
storefrontRouter.get("/tables", requireAnyPermission("channel:manage", "table:manage"), async (req, res) => {
  const outletId = req.outletId!;
  const missing = await prisma.diningTable.findMany({ where: { outletId, active: true, qrToken: null }, select: { id: true } });
  for (const t of missing) await prisma.diningTable.update({ where: { id: t.id }, data: { qrToken: newPublicToken() } });
  res.json(
    await prisma.diningTable.findMany({
      where: { outletId, active: true },
      select: { id: true, label: true, qrToken: true, area: { select: { name: true } } },
      orderBy: { label: "asc" },
    }),
  );
});

/** New QR token for a table: printed codes with the old one stop working. */
storefrontRouter.post("/tables/:id/rotate", requireAnyPermission("channel:manage", "table:manage"), async (req, res) => {
  const table = await prisma.diningTable.findFirst({ where: { id: param(req, "id"), outletId: req.outletId } });
  if (!table) throw notFound("Table");
  const updated = await prisma.diningTable.update({ where: { id: table.id }, data: { qrToken: newPublicToken() }, select: { id: true, label: true, qrToken: true } });
  await audit(req, "table.qr.rotate", "DiningTable", table.id, { label: table.label });
  emitTables(req.outletId!, { tableIds: [table.id], action: "qr" });
  res.json(updated);
});

// ---------- Incoming QR / online orders ----------

const canHandle = requireAnyPermission("table:serve", "order:create");

storefrontRouter.get("/requests", canHandle, async (req, res) => {
  const status = typeof req.query.status === "string" && ["PENDING", "ACCEPTED", "REJECTED"].includes(req.query.status) ? req.query.status : "PENDING";
  const rows = await prisma.channelRequest.findMany({
    where: { outletId: req.outletId, status, ...(status !== "PENDING" && { createdAt: { gte: new Date(Date.now() - 24 * 3600_000) } }) },
    orderBy: { createdAt: status === "PENDING" ? "asc" : "desc" },
    take: 100,
  });
  const [tables, orders] = await Promise.all([
    prisma.diningTable.findMany({ where: { id: { in: rows.map((r) => r.tableId).filter((x): x is string => Boolean(x)) } }, select: { id: true, label: true } }),
    prisma.order.findMany({
      where: { id: { in: rows.map((r) => r.orderId).filter((x): x is string => Boolean(x)) } },
      select: { id: true, invoiceNumber: true, orderType: true, grandTotal: true, status: true, notes: true },
    }),
  ]);
  const tableById = new Map(tables.map((t) => [t.id, t.label]));
  const orderById = new Map(orders.map((o) => [o.id, o]));
  res.json(
    rows.map((r) => ({
      id: r.id,
      channel: r.channel,
      status: r.status,
      createdAt: r.createdAt,
      tableId: r.tableId,
      tableLabel: r.tableId ? (tableById.get(r.tableId) ?? null) : null,
      order: r.orderId ? (orderById.get(r.orderId) ?? null) : null,
      items: r.items,
      total: r.total,
      customerName: r.customerName,
      customerPhone: r.customerPhone,
      notes: r.notes,
      payment: r.payment,
      rejectReason: r.rejectReason,
      refund: r.refundStatus ? { status: r.refundStatus, amount: r.refundAmount ?? 0, ref: r.refundRef, error: r.refundError } : null,
    })),
  );
});

async function findRequest(id: string, outletId: string) {
  const r = await prisma.channelRequest.findFirst({ where: { id, outletId } });
  if (!r) throw notFound("Order request");
  return r;
}

storefrontRouter.post("/requests/:id/accept", canHandle, async (req, res) => {
  const request = await findRequest(param(req, "id"), req.outletId!);
  const updated = await acceptRequest(req, request);
  await audit(req, "channel.request.accept", "ChannelRequest", request.id, { channel: request.channel });
  res.json(updated);
});

storefrontRouter.post("/requests/:id/reject", canHandle, async (req, res) => {
  const { reason } = parse(channelRejectSchema, req.body);
  const request = await findRequest(param(req, "id"), req.outletId!);
  const updated = await rejectRequest(req, request, reason);
  await audit(req, "channel.request.reject", "ChannelRequest", request.id, { channel: request.channel, reason });
  res.json(updated);
});

/** Cancel an accepted online order before the kitchen started on it (a UPI payment is refunded). */
storefrontRouter.post("/requests/:id/cancel", requirePermission("order:cancel"), async (req, res) => {
  const { reason } = parse(channelRejectSchema, req.body);
  const request = await findRequest(param(req, "id"), req.outletId!);
  const updated = await cancelAcceptedOnline(req, request, reason);
  await audit(req, "channel.request.cancel", "ChannelRequest", request.id, { channel: request.channel, reason, refund: updated.refundStatus ?? "none" });
  res.json(updated);
});
