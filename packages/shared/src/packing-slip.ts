import { formatINR } from "./money";
import { ORDER_CHANNEL_LABELS, type ChannelPackingSlip, type OrderChannel } from "./schemas";

const hhmm = (iso: string, timeZone?: string) => new Date(iso).toLocaleTimeString("en-IN", { timeZone, hour: "2-digit", minute: "2-digit", hour12: false });

/**
 * Phase 6: packing slip / bag label for an online-channel order as plain text for a thermal
 * printer (32 columns on 58 mm, 48 on 80 mm). Shared by the API's arrival print job and the web board.
 */
export function formatPackingSlipText(s: ChannelPackingSlip, opts: { timeZone?: string; width?: number } = {}): string {
  const width = opts.width ?? 32;
  const rule = "-".repeat(width);
  const center = (t: string) => " ".repeat(Math.max(0, Math.floor((width - t.length) / 2))) + t;
  const label = ORDER_CHANNEL_LABELS[s.channel as OrderChannel] ?? s.channel;
  return [
    center(`** ${label.toUpperCase()} **`),
    center(s.outletName.slice(0, width)),
    rule,
    ...(s.channelOrderId ? [`${label} order: ${s.channelOrderId}`] : []),
    `Bill: ${s.invoiceNumber}`,
    ...(s.customerName ? [`For: ${s.customerName}`] : []),
    rule,
    ...s.items.flatMap((i) => [`${String(i.quantity).padStart(2)} x ${i.name}`, ...(i.notes ? [`     ! ${i.notes}`] : [])]),
    rule,
    center(s.amountDue > 0 ? `COLLECT ${formatINR(s.amountDue)}` : "PAID ONLINE"),
    ...(s.rider?.pickupCode ? [center(`Pickup code: ${s.rider.pickupCode}`)] : []),
    ...(s.weDeliver ? [center("We deliver")] : []),
    ...(s.packedAt ? [`Packed ${hhmm(s.packedAt, opts.timeZone)}`] : []),
    `Printed ${hhmm(s.printedAt, opts.timeZone)}`,
  ].join("\n");
}
