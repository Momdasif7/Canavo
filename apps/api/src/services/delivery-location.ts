import type { Prisma } from "@prisma/client";
import {
  checkDeliveryArea,
  DELIVERY_LOCATION_SETTING,
  normalizeDeliveryLocation,
  type DeliveryLocationSettings,
  type DeliveryLocationUpdate,
  type TypedAddress,
} from "@canavo/shared";
import { prisma } from "../db";

type Db = Pick<Prisma.TransactionClient, "setting">;

/** The outlet's delivery location mode (MAP when never set). Call inside the tenant context. */
export async function deliveryLocation(outletId: string, db: Db = prisma): Promise<DeliveryLocationSettings> {
  const s = await db.setting.findUnique({ where: { scope_key: { scope: outletId, key: DELIVERY_LOCATION_SETTING } } });
  return normalizeDeliveryLocation(s?.value);
}

export async function saveDeliveryLocation(outletId: string, patch: DeliveryLocationUpdate): Promise<DeliveryLocationSettings> {
  const next = normalizeDeliveryLocation({ ...(await deliveryLocation(outletId)), ...patch });
  const value = next as unknown as Prisma.InputJsonValue;
  await prisma.setting.upsert({
    where: { scope_key: { scope: outletId, key: DELIVERY_LOCATION_SETTING } },
    create: { scope: outletId, key: DELIVERY_LOCATION_SETTING, value },
    update: { value },
  });
  return next;
}

/** Fee / ETA / allowed-area answer for a typed address (ADDRESS mode). */
export function addressQuote(s: DeliveryLocationSettings, a?: Partial<TypedAddress>) {
  const check = a && (a.address || a.pincode || a.area) ? checkDeliveryArea(s, { address: a.address ?? "", landmark: a.landmark, area: a.area, pincode: a.pincode }) : null;
  return {
    mode: "ADDRESS" as const,
    fee: s.flatFee,
    minOrder: s.minOrder,
    etaMinutes: s.etaMinutes,
    areas: s.areas,
    pincodes: s.pincodes,
    /** null = nothing to check yet */
    deliverable: check ? check.ok : null,
    message: check && !check.ok ? check.message : null,
  };
}
