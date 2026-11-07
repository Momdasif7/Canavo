import type { Prisma } from "@prisma/client";
import { startOfLocalDay, zonedParts } from "../lib/time";

/**
 * Highest KOT number used today at the outlet (numbers restart daily); the caller numbers its
 * tickets from it inside the same transaction. A per-outlet advisory lock, held until commit, makes
 * concurrent bills, tab rounds and online orders take turns, and the highest number (not a count)
 * means deleted KOTs (rejected QR requests, cancelled pre-orders) never cause a repeat (QA Phase 7).
 * The day is the ticket's own (now), not the bill's: an offline bill synced later gets today's next number.
 */
export async function lastKotNumberToday(tx: Prisma.TransactionClient, outletId: string, timezone: string): Promise<number> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`kot:${outletId}`}))`;
  const since = startOfLocalDay(zonedParts(new Date(), timezone).date, timezone);
  const r = await tx.kotTicket.aggregate({ where: { outletId, createdAt: { gte: since } }, _max: { kotNumber: true } });
  return r._max.kotNumber ?? 0;
}
