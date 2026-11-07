import type { Prisma } from "@prisma/client";
import { offlineSeriesPrefix, parseInvoiceNumber } from "@canavo/shared";
import { prisma } from "../db";
import { conflict } from "../lib/http";

/**
 * Offline invoice series per billing device (Phase 3.4, OFFLINE_INVOICE_SERIES). While online,
 * a device asks for its series (code "A1"…"Z9" at this outlet); offline it numbers bills
 * itself as <prefix(3)><code>-<FY>-<seq>, so the printed receipt carries the final number.
 * At sync the number is accepted only if it belongs to that device's series and FY.
 */
type Tx = Prisma.TransactionClient;
const CODES = Array.from({ length: 26 * 9 }, (_, i) => `${String.fromCharCode(65 + Math.floor(i / 9))}${(i % 9) + 1}`);

export async function seriesForDevice(outletId: string, deviceId: string, invoicePrefix: string) {
  let series = await prisma.offlineSeries.findUnique({ where: { outletId_deviceId: { outletId, deviceId } } });
  if (!series) {
    const taken = new Set((await prisma.offlineSeries.findMany({ where: { outletId }, select: { code: true } })).map((s) => s.code));
    const code = CODES.find((c) => !taken.has(c));
    if (!code) throw conflict("This outlet already has the maximum number of offline billing devices");
    series = await prisma.offlineSeries.create({ data: { outletId, deviceId, code } });
  }
  return { code: series.code, prefix: offlineSeriesPrefix(invoicePrefix, series.code), lastSeqByFy: series.lastSeqByFy as Record<string, number> };
}

/**
 * Validate an offline bill's own number. Returns it when it may be used, or null to fall back
 * to the outlet's normal counter (unknown series, wrong FY, or the number is already taken —
 * e.g. the app was reinstalled and restarted its count).
 */
export async function acceptOfflineNumber(tx: Tx, outletId: string, invoicePrefix: string, number: string, fyStart: number): Promise<string | null> {
  const p = parseInvoiceNumber(number);
  if (!p || p.fyStart !== fyStart || p.seq < 1) return null;
  const code = p.prefix.slice(Math.min(3, invoicePrefix.length));
  if (offlineSeriesPrefix(invoicePrefix, code) !== p.prefix) return null;
  const series = await tx.offlineSeries.findUnique({ where: { outletId_code: { outletId, code } } });
  if (!series) return null;
  if (await tx.order.findFirst({ where: { outletId, invoiceNumber: number }, select: { id: true } })) return null;
  const last = (series.lastSeqByFy as Record<string, number>)[String(fyStart)] ?? 0;
  if (p.seq > last) await tx.offlineSeries.update({ where: { id: series.id }, data: { lastSeqByFy: { ...(series.lastSeqByFy as object), [String(fyStart)]: p.seq } } });
  return number;
}
