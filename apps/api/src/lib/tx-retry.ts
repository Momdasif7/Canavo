import type { Prisma } from "@prisma/client";
import { prisma } from "../db";
import { isTransactionConflict } from "./http";

/**
 * Automatic retry of PostgreSQL deadlocks (40P01) and serialization failures (40001 / P2034)
 * (QA Phase 7). PostgreSQL rolled the whole transaction back, so running the whole callback again is
 * safe — as long as the callback has no effect outside the database: sockets, notifications and
 * channel pushes go through the outbox (rows in the same transaction) or run after commit, and a
 * callback must not push into variables declared outside it (or must reset them first).
 * Only whole transactions are retried, never a statement inside one. After the last retry the
 * conflict goes through to the error handler (409 TRY_AGAIN, "nothing was saved").
 */
export const TX_CONFLICT_RETRIES = 3;

type TxOptions = Parameters<typeof prisma.$transaction>[1];

/** Jittered exponential backoff: ~10–30 ms, 20–60 ms, 40–120 ms, so the two losers don't collide again. */
const backoff = (attempt: number) => 2 ** attempt * 10 * (1 + 2 * Math.random());

export async function withConflictRetry<T>(run: () => Promise<T>, retries = TX_CONFLICT_RETRIES): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await run();
    } catch (e) {
      if (attempt >= retries || !isTransactionConflict(e)) throw e;
      await new Promise((r) => setTimeout(r, backoff(attempt)));
    }
  }
}

/** `prisma.$transaction(fn, opts)` (tenant client, RLS settings) retried as a whole on a deadlock / serialization failure. */
export function retryTransaction<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>, opts?: TxOptions): Promise<T> {
  return withConflictRetry(() => prisma.$transaction(fn, opts as never) as Promise<T>);
}
