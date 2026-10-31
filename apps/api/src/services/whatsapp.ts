import { env } from "../env";

export interface ShareResult {
  /** "sent" when delivered via WhatsApp Business API; "link" when the client must open wa.me */
  method: "sent" | "link";
  waLink: string;
}

/**
 * Share a receipt on WhatsApp. With WATI configured the template message is
 * sent server-side; otherwise we return a wa.me click-to-chat link the
 * cashier's device opens (works with any WhatsApp install, no API account).
 */
export async function shareReceipt(opts: {
  phone: string;
  outletName: string;
  invoiceNumber: string;
  amountText: string;
  receiptUrl: string;
}): Promise<ShareResult> {
  const text =
    `Thank you for visiting ${opts.outletName}!\n` +
    `Bill ${opts.invoiceNumber} — ${opts.amountText}\n` +
    `Download your receipt: ${opts.receiptUrl}`;
  const waLink = `https://wa.me/91${opts.phone}?text=${encodeURIComponent(text)}`;

  if (env.WATI_API_URL && env.WATI_API_TOKEN) {
    const res = await fetch(
      `${env.WATI_API_URL}/api/v1/sendTemplateMessage?whatsappNumber=91${opts.phone}`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${env.WATI_API_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({
          template_name: env.WATI_RECEIPT_TEMPLATE,
          broadcast_name: `receipt_${opts.invoiceNumber}`,
          parameters: [
            { name: "outlet", value: opts.outletName },
            { name: "invoice", value: opts.invoiceNumber },
            { name: "amount", value: opts.amountText },
            { name: "link", value: opts.receiptUrl },
          ],
        }),
      },
    );
    if (res.ok) return { method: "sent", waLink };
    console.warn(`[whatsapp] WATI send failed (${res.status}); falling back to wa.me link`);
  }
  return { method: "link", waLink };
}
