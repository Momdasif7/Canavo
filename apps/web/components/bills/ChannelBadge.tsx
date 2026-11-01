import { ORDER_CHANNEL_LABELS, type OrderChannel } from "@canavo/shared";
import { Badge } from "@/components/ui/Badge";

const tones: Partial<Record<OrderChannel, "danger" | "warning" | "info" | "primary">> = { ZOMATO: "danger", SWIGGY: "warning", QR: "info", ONLINE: "primary" };

/** Where an order came from (Phase 6) — nothing for counter (POS) orders. */
export function ChannelBadge({ channel, className }: { channel?: string | null; className?: string }) {
  if (!channel || channel === "POS") return null;
  return (
    <Badge tone={tones[channel as OrderChannel] ?? "neutral"} className={className}>
      {ORDER_CHANNEL_LABELS[channel as OrderChannel] ?? channel}
    </Badge>
  );
}
