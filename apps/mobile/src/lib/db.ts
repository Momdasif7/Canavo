import * as SQLite from "expo-sqlite";
import type { OrderCreateInput } from "@canavo/shared";
import type { Menu, Outlet } from "./types";

/**
 * Local SQLite store (expo-sqlite "next" API, SDK 51):
 *  - kv: cached menu/outlet per outlet + app preferences
 *  - pending_orders: bills raised offline, flushed via POST /orders/sync
 */
let dbPromise: Promise<SQLite.SQLiteDatabase> | null = null;

function db(): Promise<SQLite.SQLiteDatabase> {
  if (!dbPromise) {
    dbPromise = (async () => {
      const d = await SQLite.openDatabaseAsync("canavo.db");
      await d.execAsync(`
        PRAGMA journal_mode = WAL;
        CREATE TABLE IF NOT EXISTS kv (
          key TEXT PRIMARY KEY NOT NULL,
          value TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS pending_orders (
          client_order_id TEXT PRIMARY KEY NOT NULL,
          outlet_id TEXT NOT NULL,
          payload TEXT NOT NULL,
          payment_mode TEXT NOT NULL,
          grand_total INTEGER NOT NULL,
          state TEXT NOT NULL DEFAULT 'pending',
          order_id TEXT,
          invoice_number TEXT,
          attempts INTEGER NOT NULL DEFAULT 0,
          last_error TEXT,
          created_at TEXT NOT NULL
        );
      `);
      return d;
    })();
  }
  return dbPromise;
}

// ---------- Key/value ----------
export async function kvGet<T>(key: string): Promise<{ value: T; updatedAt: number } | null> {
  const row = await (await db()).getFirstAsync<{ value: string; updated_at: number }>(
    "SELECT value, updated_at FROM kv WHERE key = ?",
    key,
  );
  if (!row) return null;
  try {
    return { value: JSON.parse(row.value) as T, updatedAt: row.updated_at };
  } catch {
    return null;
  }
}

export async function kvSet(key: string, value: unknown): Promise<void> {
  await (await db()).runAsync(
    "INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
    key,
    JSON.stringify(value),
    Date.now(),
  );
}

export async function kvDel(key: string): Promise<void> {
  await (await db()).runAsync("DELETE FROM kv WHERE key = ?", key);
}

export const cacheKeys = {
  menu: (outletId: string) => `menu:${outletId}`,
  outlet: (outletId: string) => `outlet:${outletId}`,
  printer: "prefs:printer",
};

export const cacheMenu = (outletId: string, menu: Menu) => kvSet(cacheKeys.menu(outletId), menu);
export const cacheOutlet = (outlet: Outlet) => kvSet(cacheKeys.outlet(outlet.id), outlet);
export const cachedMenu = (outletId: string) => kvGet<Menu>(cacheKeys.menu(outletId));
export const cachedOutlet = (outletId: string) => kvGet<Outlet>(cacheKeys.outlet(outletId));

// ---------- Offline order queue ----------
/**
 * pending  → not yet on the server
 * unpaid   → created on the server, payment not yet recorded
 * done     → created and paid (kept briefly for the "recently synced" list)
 * failed   → server rejected it permanently (shown to the user)
 */
export type PendingState = "pending" | "unpaid" | "done" | "failed";
export type OfflinePaymentMode = "CASH" | "CARD";

export interface PendingOrder {
  clientOrderId: string;
  outletId: string;
  payload: OrderCreateInput;
  paymentMode: OfflinePaymentMode;
  grandTotal: number;
  state: PendingState;
  orderId: string | null;
  invoiceNumber: string | null;
  attempts: number;
  lastError: string | null;
  createdAt: string;
}

interface PendingRow {
  client_order_id: string;
  outlet_id: string;
  payload: string;
  payment_mode: OfflinePaymentMode;
  grand_total: number;
  state: PendingState;
  order_id: string | null;
  invoice_number: string | null;
  attempts: number;
  last_error: string | null;
  created_at: string;
}

const fromRow = (r: PendingRow): PendingOrder => ({
  clientOrderId: r.client_order_id,
  outletId: r.outlet_id,
  payload: JSON.parse(r.payload) as OrderCreateInput,
  paymentMode: r.payment_mode,
  grandTotal: r.grand_total,
  state: r.state,
  orderId: r.order_id,
  invoiceNumber: r.invoice_number,
  attempts: r.attempts,
  lastError: r.last_error,
  createdAt: r.created_at,
});

export async function enqueueOrder(o: {
  clientOrderId: string;
  outletId: string;
  payload: OrderCreateInput;
  paymentMode: OfflinePaymentMode;
  grandTotal: number;
  createdAt: string;
}): Promise<void> {
  await (await db()).runAsync(
    "INSERT OR IGNORE INTO pending_orders (client_order_id, outlet_id, payload, payment_mode, grand_total, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    o.clientOrderId,
    o.outletId,
    JSON.stringify(o.payload),
    o.paymentMode,
    o.grandTotal,
    o.createdAt,
  );
}

export async function listQueue(states: PendingState[]): Promise<PendingOrder[]> {
  if (!states.length) return [];
  const rows = await (await db()).getAllAsync<PendingRow>(
    `SELECT * FROM pending_orders WHERE state IN (${states.map(() => "?").join(",")}) ORDER BY created_at ASC`,
    ...states,
  );
  return rows.map(fromRow);
}

export async function countUnsynced(): Promise<number> {
  const row = await (await db()).getFirstAsync<{ n: number }>(
    "SELECT COUNT(*) AS n FROM pending_orders WHERE state IN ('pending', 'unpaid')",
  );
  return row?.n ?? 0;
}

export async function markCreated(clientOrderId: string, orderId: string, invoiceNumber: string | null, grandTotal: number) {
  await (await db()).runAsync(
    "UPDATE pending_orders SET state = 'unpaid', order_id = ?, invoice_number = ?, grand_total = ?, last_error = NULL WHERE client_order_id = ?",
    orderId,
    invoiceNumber,
    grandTotal,
    clientOrderId,
  );
}

export async function markState(clientOrderId: string, state: PendingState, error: string | null = null) {
  await (await db()).runAsync(
    "UPDATE pending_orders SET state = ?, last_error = ?, attempts = attempts + 1 WHERE client_order_id = ?",
    state,
    error,
    clientOrderId,
  );
}

/** "Retry" on bills set aside as failed: back to the step they failed at, with a fresh attempt count. */
export async function requeueFailed(): Promise<void> {
  await (await db()).runAsync(
    "UPDATE pending_orders SET state = CASE WHEN order_id IS NULL THEN 'pending' ELSE 'unpaid' END, attempts = 0, last_error = NULL WHERE state = 'failed'",
  );
}

/** Drop fully-synced rows older than a day. */
export async function pruneQueue() {
  const cutoff = new Date(Date.now() - 86_400_000).toISOString();
  await (await db()).runAsync("DELETE FROM pending_orders WHERE state = 'done' AND created_at < ?", cutoff);
}
