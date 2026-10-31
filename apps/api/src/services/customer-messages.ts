import { sendWhatsApp, type WaPurpose, type WaSendResult } from "./whatsapp";

export { waLink } from "./whatsapp";

/** "sent" via the business's WhatsApp provider; "link" = open the wa.me link on a device. */
export type CustomerMessageResult = WaSendResult;

/** Template purpose per CRM message (template names are set per business in Settings → WhatsApp). */
export const CRM_TEMPLATES = {
  khataReminder: "khata_reminder",
  birthday: "birthday",
  anniversary: "anniversary",
} as const satisfies Record<string, WaPurpose>;

/**
 * Send a WhatsApp message to a customer through the business's provider (Meta
 * Cloud API or WATI) using its approved template; otherwise (or on failure) a
 * wa.me click-to-chat link with the same text is returned for staff to open.
 */
export async function sendCustomerMessage(opts: {
  phone: string;
  text: string;
  template: WaPurpose;
  broadcast: string;
  parameters: { name: string; value: string }[];
}): Promise<CustomerMessageResult> {
  return sendWhatsApp({ to: opts.phone, text: opts.text, purpose: opts.template, tag: opts.broadcast, params: opts.parameters });
}
