import type { Prisma } from "@prisma/client";

/**
 * Highest KOT number used at the outlet since `since` (its local day start); the caller numbers
 * new KOTs from it. Serialised per outlet with a transaction-scoped advisory lock (held to commit),
 * and based on the highest number rather than a count, so rounds fired at the same moment and
 * deleted KOTs (rejected QR requests, cancelled pre-orders) never repeat a number (dba-2).
 */
export async function lastKotNumber(tx: Prisma.TransactionClient, outletId: string, since: Date): Promise<number> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`kot:${outletId}`}))`;
  const r = await tx.kotTicket.aggregate({ where: { outletId, createdAt: { gte: since } }, _max: { kotNumber: true } });
  return r._max.kotNumber ?? 0;
}
