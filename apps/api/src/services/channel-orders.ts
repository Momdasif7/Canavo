import type { Request } from "express";
import type { OrderChannel, OrderCreateInput } from "@canavo/shared";
import { platformPrisma } from "../db";
import { runForOutlet } from "../lib/tenant";
import { createOrder, type CreateOrderOptions } from "./billing";

/**
 * Orders that no staff member placed (Phase 6): QR table orders, the online ordering page,
 * aggregators via a hub. They go through the normal billing path (server-side prices, GST,
 * invoice numbers, KOTs) under a per-business system account "Online orders", so reports
 * and audit show them separately from cashiers.
 */
export async function channelUser(businessId: string) {
  const email = `online-orders+${businessId}@system.canavo`;
  const existing = await platformPrisma.user.findUnique({ where: { email } });
  if (existing) return existing;
  return platformPrisma.user.create({
    data: {
      businessId,
      email,
      // Not a real number: the system account can't sign in (no password, no PIN).
      phone: `sys-${businessId}`,
      name: "Online orders",
      role: "CASHIER",
      status: "ACTIVE",
    },
  });
}

/** A request-shaped actor for the "Online orders" account (billing, audit and KOT helpers take a Request). */
export async function systemRequest(outletId: string, businessId: string, ip?: string) {
  const user = await channelUser(businessId);
  return {
    outletId,
    businessId,
    ip,
    user: { id: user.id, name: user.name, role: user.role, businessId, outletIds: [outletId] },
  } as unknown as Request;
}

/**
 * Create an order for a channel at an outlet, inside that outlet's tenant context.
 * Idempotent per (outlet, channel, channelOrderId) when a channel order id is given.
 */
export async function createChannelOrder(
  outletId: string,
  channel: OrderChannel,
  input: OrderCreateInput,
  opts: Omit<CreateOrderOptions, "channel"> & { ip?: string } = {},
) {
  return runForOutlet(outletId, async () => {
    const outlet = await platformPrisma.outlet.findUniqueOrThrow({ where: { id: outletId }, select: { businessId: true } });
    if (opts.channelOrderId) {
      const dup = await platformPrisma.order.findFirst({ where: { outletId, channel, channelOrderId: opts.channelOrderId } });
      if (dup) return { order: dup, duplicate: true, effects: (): void => undefined };
    }
    const req = await systemRequest(outletId, outlet.businessId, opts.ip);
    const result = await createOrder(req, input, { ...opts, channel });
    return { ...result, duplicate: result.duplicate as boolean };
  });
}
