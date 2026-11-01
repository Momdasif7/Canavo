import { financialYearStart, formatInvoiceNumber } from "@canavo/shared";
import { api } from "../lib/api";
import { kvGet, kvSet } from "../lib/db";
import { getDeviceId } from "../lib/secure";

/**
 * Offline invoice series of this phone (Phase 3.4, hotel flag OFFLINE_INVOICE_SERIES). While
 * online the app fetches its series (e.g. "INVA1"); offline bills are then numbered here, so
 * the printed receipt carries the final invoice number instead of a provisional "OFF-…" one.
 */
interface Series {
  prefix: string;
  lastSeqByFy: Record<string, number>;
}
const key = (outletId: string) => `offlineSeries:${outletId}`;

/** Fetch (or refresh) the series while online. Keeps the higher count if this phone is ahead. */
export async function refreshOfflineSeries(outletId: string): Promise<void> {
  try {
    const r = await api.post<{ enabled: boolean; prefix?: string; lastSeqByFy?: Record<string, number> }>("/orders/offline-series", { deviceId: await getDeviceId() });
    if (!r.enabled || !r.prefix) return void (await kvSet(key(outletId), null));
    const local = (await kvGet<Series | null>(key(outletId)))?.value;
    const merged: Record<string, number> = { ...(r.lastSeqByFy ?? {}) };
    for (const [fy, n] of Object.entries(local?.prefix === r.prefix ? local.lastSeqByFy : {})) merged[fy] = Math.max(merged[fy] ?? 0, n);
    await kvSet(key(outletId), { prefix: r.prefix, lastSeqByFy: merged } satisfies Series);
  } catch {
    // Offline or older API: keep whatever we had.
  }
}

/** The next invoice number for an offline bill, or null (no series: the receipt stays provisional). */
export async function nextOfflineInvoiceNumber(outletId: string, createdAt: string, timezone: string): Promise<string | null> {
  const s = (await kvGet<Series | null>(key(outletId)))?.value;
  if (!s) return null;
  const fy = financialYearStart(new Date(createdAt), timezone);
  const seq = (s.lastSeqByFy[String(fy)] ?? 0) + 1;
  await kvSet(key(outletId), { ...s, lastSeqByFy: { ...s.lastSeqByFy, [String(fy)]: seq } });
  return formatInvoiceNumber(s.prefix, fy, seq);
}
