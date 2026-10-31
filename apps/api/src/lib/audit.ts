import type { Request } from "express";
import { Prisma } from "@prisma/client";
import { prisma } from "../db";

type Tx = Prisma.TransactionClient | typeof prisma;

export async function audit(
  req: Request,
  action: string,
  entity: string,
  entityId?: string,
  meta?: Prisma.InputJsonValue,
  tx: Tx = prisma,
) {
  await tx.auditLog.create({
    data: {
      userId: req.user?.id,
      outletId: req.outletId,
      action,
      entity,
      entityId,
      meta,
      ip: req.ip,
    },
  });
}
