import type { DeliveryStatus } from "@prisma/client";

const MESSAGES: Record<DeliveryStatus, (o: { outlet: string; invoice: string; eta?: string; agent?: string }) => string> = {
  PENDING: (o) => `Hi! ${o.outlet} has received your order ${o.invoice}.`,
  ACCEPTED: (o) => `Your order ${o.invoice} from ${o.outlet} is confirmed${o.eta ? ` — expected by ${o.eta}` : ""}.`,
  PREPARING: (o) => `Your order ${o.invoice} is being prepared at ${o.outlet}.`,
  OUT_FOR_DELIVERY: (o) =>
    `Your order ${o.invoice} is out for delivery${o.agent ? ` with ${o.agent}` : ""}${o.eta ? `, arriving by ${o.eta}` : ""}.`,
  DELIVERED: (o) => `Your order ${o.invoice} has been delivered. Thank you for ordering from ${o.outlet}!`,
  CANCELLED: (o) => `Sorry, your order ${o.invoice} from ${o.outlet} has been cancelled.`,
};

/**
 * Customer status update as a wa.me click-to-chat link (no WhatsApp API
 * account needed); the staff device opens it to send the message.
 */
export function deliveryStatusLink(opts: {
  phone: string;
  status: DeliveryStatus;
  outletName: string;
  invoiceNumber: string;
  etaAt?: Date | null;
  agentName?: string | null;
  timezone?: string;
}): { waLink: string; text: string } {
  const eta = opts.etaAt
    ? opts.etaAt.toLocaleTimeString("en-IN", { timeZone: opts.timezone ?? "Asia/Kolkata", hour: "2-digit", minute: "2-digit" })
    : undefined;
  const text = MESSAGES[opts.status]({ outlet: opts.outletName, invoice: opts.invoiceNumber, eta, agent: opts.agentName ?? undefined });
  return { text, waLink: `https://wa.me/91${opts.phone}?text=${encodeURIComponent(text)}` };
}
