import { env } from "../env";

export interface CustomerMessageResult {
  /** "sent" via WhatsApp Business API (WATI); "link" = open the wa.me link on a device */
  method: "sent" | "link";
  waLink: string;
}

/** WATI template names used by the CRM module (create/approve them in WATI). */
export const CRM_TEMPLATES = {
  khataReminder: "khata_reminder",
  birthday: "birthday_wish",
  anniversary: "anniversary_wish",
} as const;

export const waLink = (phone: string, text: string) => `https://wa.me/91${phone}?text=${encodeURIComponent(text)}`;

/**
 * Send a WhatsApp message to a customer. With WATI configured the approved
 * template is sent server-side; otherwise (or on failure) a wa.me
 * click-to-chat link with the same text is returned for staff to open.
 */
export async function sendCustomerMessage(opts: {
  phone: string;
  text: string;
  template: string;
  broadcast: string;
  parameters: { name: string; value: string }[];
}): Promise<CustomerMessageResult> {
  const link = waLink(opts.phone, opts.text);
  if (env.WATI_API_URL && env.WATI_API_TOKEN) {
    try {
      const res = await fetch(`${env.WATI_API_URL}/api/v1/sendTemplateMessage?whatsappNumber=91${opts.phone}`, {
        method: "POST",
        headers: { authorization: `Bearer ${env.WATI_API_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({
          template_name: opts.template,
          broadcast_name: opts.broadcast,
          parameters: opts.parameters,
        }),
      });
      if (res.ok) return { method: "sent", waLink: link };
      console.warn(`[crm] WATI send failed (${res.status}); falling back to wa.me link`);
    } catch (e) {
      console.warn("[crm] WATI send error; falling back to wa.me link", e);
    }
  }
  return { method: "link", waLink: link };
}
