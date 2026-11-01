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
    const user = await channelUser(outlet.businessId);
    const req = {
      outletId,
      businessId: outlet.businessId,
      ip: opts.ip,
      user: { id: user.id, name: user.name, role: user.role, businessId: outlet.businessId, outletIds: [outletId] },
    } as unknown as Request;
    const result = await createOrder(req, input, { ...opts, channel });
    return { ...result, duplicate: result.duplicate as boolean };
  });
}

/**
 * A request-shaped actor for system work at an outlet done as "Online orders" (Phase 6.1:
 * a channel cancelling its order). Call inside the outlet's tenant context.
 */
export async function channelRequest(outletId: string, ip?: string): Promise<Request> {
  const outlet = await platformPrisma.outlet.findUniqueOrThrow({ where: { id: outletId }, select: { businessId: true } });
  const user = await channelUser(outlet.businessId);
  return {
    outletId,
    businessId: outlet.businessId,
    ip,
    user: { id: user.id, name: user.name, role: user.role, businessId: outlet.businessId, outletIds: [outletId] },
  } as unknown as Request;
}
