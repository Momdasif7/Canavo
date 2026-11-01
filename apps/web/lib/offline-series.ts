/**
 * Offline invoice series of this browser (Phase 3.4, hotel flag OFFLINE_INVOICE_SERIES).
 * While online the POS fetches its series (e.g. "INVA1") for the outlet; a bill raised offline
 * is then numbered here, so the cashier sees the final invoice number instead of waiting for sync.
 * Numbering is shared with the mobile app (nextSeriesNumber in @canavo/shared).
 */
import { mergeSeriesState, nextSeriesNumber, type OfflineSeriesState } from "@canavo/shared";
import { api } from "./api";

const DEVICE_KEY = "canavo:deviceId";
const key = (outletId: string) => `canavo:offlineSeries:${outletId}`;

function read(outletId: string): OfflineSeriesState | null {
  try {
    const raw = localStorage.getItem(key(outletId));
    return raw ? (JSON.parse(raw) as OfflineSeriesState) : null;
  } catch {
    return null;
  }
}

function write(outletId: string, s: OfflineSeriesState | null): boolean {
  try {
    if (s) localStorage.setItem(key(outletId), JSON.stringify(s));
    else localStorage.removeItem(key(outletId));
    return true;
  } catch {
    return false;
  }
}

/**
 * Stable id of this browser. Null when storage is unavailable: a fresh id per page load would
 * claim a new device series on every refresh, so such a browser just stays provisional.
 */
export function getDeviceId(): string | null {
  try {
    let id = localStorage.getItem(DEVICE_KEY);
    if (!id) {
      id = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `web-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
      localStorage.setItem(DEVICE_KEY, id);
    }
    return id;
  } catch {
    return null;
  }
}

/** Fetch (or refresh) the series while online. Keeps the higher count if this browser is ahead. */
export async function refreshOfflineSeries(outletId: string): Promise<void> {
  const deviceId = getDeviceId();
  if (!deviceId) return;
  try {
    const r = await api.post<{ enabled: boolean; prefix?: string; lastSeqByFy?: Record<string, number> }>("/orders/offline-series", { deviceId }, { outletId });
    if (!r.enabled || !r.prefix) return void write(outletId, null);
    write(outletId, mergeSeriesState({ prefix: r.prefix, lastSeqByFy: r.lastSeqByFy ?? {} }, read(outletId)));
  } catch {
    // Offline or older API: keep whatever we had.
  }
}

/** Forget the series (flag switched off): offline bills go back to provisional numbering. */
export const clearOfflineSeries = (outletId: string) => void write(outletId, null);

/**
 * The next invoice number for an offline bill, or null (no series: the number is assigned at sync).
 * The advanced count is saved first, so a number is never handed out twice.
 */
export function nextOfflineInvoiceNumber(outletId: string, createdAt: string, timezone: string): string | null {
  const s = read(outletId);
  if (!s) return null;
  try {
    const { number, state } = nextSeriesNumber(s, createdAt, timezone);
    return write(outletId, state) ? number : null;
  } catch {
    return null; // e.g. prefix too long for the 16-character limit: fall back to provisional
  }
}
