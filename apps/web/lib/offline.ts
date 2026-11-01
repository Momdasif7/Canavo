/**
 * Offline support for the POS.
 *
 * - `cache` store: last good copy of the menu and outlet settings per outlet,
 *   so the POS can open and price bills without the API.
 * - `queue` store: bills raised while offline. Each carries a client UUID
 *   (`clientOrderId`) and the original `createdAt`, which makes
 *   POST /orders/sync idempotent — retrying a flush never double-bills.
 */
import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import { allocate, type OrderCreateInput } from "@canavo/shared";
import { api, errorMessage, isNetworkError } from "./api";
import type { Menu, Order, Outlet, PaymentMode, SyncResult } from "./types";

export interface QueuedPayment {
  mode: PaymentMode;
  amount: number;
  /** Phase 3.8 (online only): tip, card details, gift card code */
  tip?: number;
  cardLast4?: string;
  authCode?: string;
  giftCardCode?: string;
}

export interface QueuedOrder {
  clientOrderId: string;
  outletId: string;
  order: OrderCreateInput;
  payments: QueuedPayment[];
  tendered?: number;
  /** Client-side bill preview total at the time of sale */
  previewTotal: number;
  createdAt: string;
  /** Set once the bill exists on the server but payments are still to be recorded */
  serverOrderId?: string;
  invoiceNumber?: string;
  attempts: number;
  lastError?: string;
}

interface CanavoDB extends DBSchema {
  cache: { key: string; value: unknown };
  queue: { key: string; value: QueuedOrder; indexes: { byOutlet: string } };
}

let dbPromise: Promise<IDBPDatabase<CanavoDB>> | null = null;

function db() {
  dbPromise ??= openDB<CanavoDB>("canavo", 1, {
    upgrade(database) {
      database.createObjectStore("cache");
      const q = database.createObjectStore("queue", { keyPath: "clientOrderId" });
      q.createIndex("byOutlet", "outletId");
    },
  });
  return dbPromise;
}

// ---------- Cache ----------
export async function cachePut(key: string, value: unknown) {
  try {
    await (await db()).put("cache", value, key);
  } catch {
    /* IndexedDB unavailable — offline mode simply won't have a cache */
  }
}

export async function cacheGet<T>(key: string): Promise<T | undefined> {
  try {
    return (await (await db()).get("cache", key)) as T | undefined;
  } catch {
    return undefined;
  }
}

export const menuKey = (outletId: string) => `menu:${outletId}`;
export const outletKey = (outletId: string) => `outlet:${outletId}`;

/** Fetch from the API and refresh the cache; fall back to the cache when offline. */
export async function fetchWithCache<T>(key: string, fetcher: () => Promise<T>): Promise<{ data: T; fromCache: boolean }> {
  try {
    const data = await fetcher();
    void cachePut(key, data);
    return { data, fromCache: false };
  } catch (e) {
    if (isNetworkError(e)) {
      const cached = await cacheGet<T>(key);
      if (cached !== undefined) return { data: cached, fromCache: true };
    }
    throw e;
  }
}

export const loadMenu = (outletId: string) => fetchWithCache<Menu>(menuKey(outletId), () => api.get<Menu>("/menu"));
export const loadOutlet = (outletId: string) =>
  fetchWithCache<Outlet>(outletKey(outletId), () => api.get<Outlet>("/outlets/current"));

// ---------- Queue ----------
const queueListeners = new Set<() => void>();
const notifyQueue = () => queueListeners.forEach((fn) => fn());

export function subscribeQueue(fn: () => void): () => void {
  queueListeners.add(fn);
  return () => queueListeners.delete(fn);
}

export async function enqueueOrder(entry: Omit<QueuedOrder, "attempts">) {
  await (await db()).put("queue", { ...entry, attempts: 0 });
  notifyQueue();
}

export async function listQueue(): Promise<QueuedOrder[]> {
  try {
    return await (await db()).getAll("queue");
  } catch {
    return [];
  }
}

async function updateQueued(entry: QueuedOrder) {
  await (await db()).put("queue", entry);
}

async function removeQueued(id: string) {
  await (await db()).delete("queue", id);
}

/** Record the queued payments against the server bill's outstanding balance. */
async function settle(entry: QueuedOrder, orderId: string) {
  const order = await api.get<Order>(`/orders/${orderId}`, { outletId: entry.outletId });
  const balance = order.balance ?? 0;
  if (order.status !== "OPEN" || balance <= 0) return;
  // The server recomputes totals; spread its balance over the modes the cashier chose.
  const amounts = allocate(balance, entry.payments.map((p) => p.amount));
  const payments = entry.payments.map((p, i) => ({ mode: p.mode, amount: amounts[i] })).filter((p) => p.amount > 0);
  if (!payments.length) return;
  const cashPart = payments.filter((p) => p.mode === "CASH").reduce((s, p) => s + p.amount, 0);
  const tendered = entry.tendered !== undefined ? Math.max(entry.tendered, cashPart) : undefined;
  await api.post(`/orders/${orderId}/payments`, { payments, tendered }, { outletId: entry.outletId });
}

export interface FlushSummary {
  synced: number;
  failed: number;
}

let flushing: Promise<FlushSummary> | null = null;

/** Push queued bills to the server. Safe to call repeatedly; runs one flush at a time. */
export function flushQueue(): Promise<FlushSummary> {
  flushing ??= runFlush().finally(() => {
    flushing = null;
    notifyQueue();
  });
  return flushing;
}

async function runFlush(): Promise<FlushSummary> {
  const queue = await listQueue();
  const summary: FlushSummary = { synced: 0, failed: 0 };
  if (!queue.length) return summary;

  const byOutlet = new Map<string, QueuedOrder[]>();
  for (const q of queue) byOutlet.set(q.outletId, [...(byOutlet.get(q.outletId) ?? []), q]);

  for (const [outletId, entries] of byOutlet) {
    const pending = entries.filter((e) => !e.serverOrderId);
    for (let i = 0; i < pending.length; i += 200) {
      const chunk = pending.slice(i, i + 200);
      const { results } = await api.post<{ results: SyncResult[] }>(
        "/orders/sync",
        { orders: chunk.map((e) => e.order) },
        { outletId },
      );
      for (const r of results) {
        const entry = chunk.find((e) => e.clientOrderId === r.clientOrderId);
        if (!entry) continue;
        if (r.ok && r.orderId) {
          entry.serverOrderId = r.orderId;
          entry.invoiceNumber = r.invoiceNumber;
          entry.lastError = undefined;
        } else {
          entry.attempts++;
          entry.lastError = r.error ?? "Sync failed";
        }
        await updateQueued(entry);
      }
    }

    for (const entry of entries.filter((e) => e.serverOrderId)) {
      try {
        await settle(entry, entry.serverOrderId!);
        await removeQueued(entry.clientOrderId);
        summary.synced++;
      } catch (e) {
        if (isNetworkError(e)) throw e;
        entry.attempts++;
        entry.lastError = `Payment: ${errorMessage(e)}`;
        await updateQueued(entry);
      }
    }
  }
  summary.failed = (await listQueue()).filter((q) => q.lastError).length;
  return summary;
}
