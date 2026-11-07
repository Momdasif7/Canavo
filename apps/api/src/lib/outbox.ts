import { Prisma } from "@prisma/client";
import { platformPrisma } from "../db";
import { currentBusinessId, runForBusiness } from "./tenant";

/**
 * Transactional outbox (Phase 1.3).
 *
 * Anything that must happen *because* a transaction committed — a socket event
 * (new KOT, order created), a push notification, a follow-up task — is written to
 * OutboxEvent with the SAME transaction client. So:
 *  - a rolled-back transaction leaves no event, and nothing is emitted;
 *  - a crash right after commit loses nothing: the publisher delivers it on restart.
 * The publisher (API process, which owns the sockets) claims rows with
 * FOR UPDATE SKIP LOCKED, so several API instances never deliver the same row
 * at the same time. Delivery is at-least-once; consumers treat events as hints
 * (screens refetch / dedupe by id). Failures retry with backoff; after
 * MAX_ATTEMPTS the row is kept as dead-lettered (failedAt) for inspection.
 */

type Db = Prisma.TransactionClient | typeof platformPrisma;
type Payload = Prisma.InputJsonValue;

export type OutboxKind = "socket.outlet" | "socket.user" | "task";
export interface OutboxRow {
  seq: bigint;
  businessId: string | null;
  kind: OutboxKind;
  target: string | null;
  name: string;
  payload: unknown;
  attempts: number;
}

const MAX_ATTEMPTS = 8;
const LEASE_SECONDS = 30;
const BATCH = 100;
const POLL_MS = 1000;

// ---------------------------------------------------------------------------
// Enqueue (call with the transaction client of the change)
// ---------------------------------------------------------------------------

async function enqueue(db: Db, kind: OutboxKind, name: string, payload: unknown, target?: string) {
  await db.outboxEvent.create({
    data: { kind, name, target: target ?? null, payload: (payload ?? {}) as Payload, businessId: currentBusinessId() ?? null },
  });
  scheduleKick();
}

/** Emit `event` to everyone in the outlet's room once the transaction commits. */
export const outboxEmitOutlet = (db: Db, outletId: string, event: string, payload: unknown) => enqueue(db, "socket.outlet", event, payload, outletId);
/** Emit `event` to one user's room once the transaction commits. */
export const outboxEmitUser = (db: Db, userId: string, event: string, payload: unknown) => enqueue(db, "socket.user", event, payload, userId);
/** Run a registered task (registerOutboxTask) once the transaction commits. */
export const outboxTask = (db: Db, name: string, payload: unknown) => enqueue(db, "task", name, payload);

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

const tasks = new Map<string, (payload: never) => Promise<void>>();

/** Register the handler for a task name (idempotent handlers: delivery is at-least-once). */
export function registerOutboxTask<P>(name: string, handler: (payload: P) => Promise<void>) {
  tasks.set(name, handler as (payload: never) => Promise<void>);
}

// ---------------------------------------------------------------------------
// Publisher
// ---------------------------------------------------------------------------

export interface SocketEmitter {
  toOutlet(outletId: string, event: string, payload: unknown): void;
  toUser(userId: string, event: string, payload: unknown): void;
}

let emitter: SocketEmitter | null = null;
let timer: NodeJS.Timeout | null = null;
let draining = false;
let again = false;
let kickTimer: NodeJS.Timeout | null = null;

/** Claim up to BATCH due rows for this publisher (lease LEASE_SECONDS). */
export async function claimBatch(limit = BATCH): Promise<OutboxRow[]> {
  return platformPrisma.$queryRaw<OutboxRow[]>`
    UPDATE "OutboxEvent" SET "attempts" = "attempts" + 1, "availableAt" = now() + make_interval(secs => ${LEASE_SECONDS})
    WHERE "seq" IN (
      SELECT "seq" FROM "OutboxEvent"
      WHERE "deliveredAt" IS NULL AND "failedAt" IS NULL AND "availableAt" <= now()
      ORDER BY "seq" LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING "seq", "businessId", "kind", "target", "name", "payload", "attempts"`;
}

async function deliver(row: OutboxRow) {
  if (row.kind === "socket.outlet" || row.kind === "socket.user") {
    if (!emitter) throw new Error("no socket emitter in this process");
    if (row.kind === "socket.outlet") emitter.toOutlet(row.target!, row.name, row.payload);
    else emitter.toUser(row.target!, row.name, row.payload);
    return;
  }
  const handler = tasks.get(row.name);
  if (!handler) throw new Error(`no outbox task "${row.name}"`);
  const run = () => handler(row.payload as never);
  await (row.businessId ? runForBusiness(row.businessId, run) : run());
}

/** Deliver everything that is due now. Returns how many rows were delivered. */
export async function drainOutbox(): Promise<number> {
  if (draining) {
    again = true;
    return 0;
  }
  draining = true;
  let delivered = 0;
  try {
    for (;;) {
      const rows = await claimBatch();
      for (const row of rows) {
        try {
          await deliver(row);
          await platformPrisma.outboxEvent.update({ where: { seq: row.seq }, data: { deliveredAt: new Date(), lastError: null } });
          delivered++;
        } catch (e) {
          const msg = (e instanceof Error ? e.message : String(e)).slice(0, 500);
          const dead = row.attempts >= MAX_ATTEMPTS;
          await platformPrisma.outboxEvent.update({
            where: { seq: row.seq },
            data: dead
              ? { failedAt: new Date(), lastError: msg }
              : { lastError: msg, availableAt: new Date(Date.now() + Math.min(300, 2 ** row.attempts) * 1000) },
          });
          console.error(`[outbox] ${row.kind} ${row.name} #${row.seq} ${dead ? "dead-lettered" : "will retry"}: ${msg}`);
        }
      }
      if (rows.length < BATCH) break;
    }
  } finally {
    draining = false;
  }
  if (again) {
    again = false;
    delivered += await drainOutbox();
  }
  return delivered;
}

/** Ask the publisher to run soon (after the caller's transaction has had a moment to commit). */
export function scheduleKick() {
  if (!timer || kickTimer) return;
  kickTimer = setTimeout(() => {
    kickTimer = null;
    void drainOutbox().catch((e) => console.error("[outbox] drain failed", e));
  }, 20);
  kickTimer.unref?.();
}

/** Run the publisher right now (call after a transaction commits for the lowest latency). */
export function kickOutbox() {
  if (!timer) return;
  void drainOutbox().catch((e) => console.error("[outbox] drain failed", e));
}

/** Start delivering in this process (API: has the sockets). Polls every second plus kicks. */
export function startOutboxPublisher(socketEmitter: SocketEmitter | null) {
  emitter = socketEmitter;
  if (timer) return;
  timer = setInterval(() => void drainOutbox().catch((e) => console.error("[outbox] drain failed", e)), POLL_MS);
  timer.unref?.();
  kickOutbox();
}

export function stopOutboxPublisher() {
  if (timer) clearInterval(timer);
  timer = null;
}

/** Delete delivered rows older than `days` (scheduled job). Dead-lettered rows are kept. */
export async function purgeDeliveredOutbox(days = 3): Promise<number> {
  const { count } = await platformPrisma.outboxEvent.deleteMany({ where: { deliveredAt: { lt: new Date(Date.now() - days * 86_400_000) } } });
  return count;
}
