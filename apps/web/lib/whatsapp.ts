import type { WhatsAppSendResult } from "./types";

type Toast = (message: string, tone?: "success" | "error" | "info") => void;

/**
 * Act on a WhatsApp send result. "sent": the provider delivered it — close the
 * pre-opened tab and confirm. "link": open the click-to-chat link in the
 * pre-opened tab (popup blockers allow it), and explain when the API send failed.
 */
export function handleWhatsAppResult(
  res: WhatsAppSendResult,
  tab: { go: (url: string) => boolean; cancel: () => void },
  toast: Toast,
  messages: { sent?: string; opened?: string } = {},
) {
  if (res.method === "sent") {
    tab.cancel();
    toast(messages.sent ?? "Sent on WhatsApp", "success");
    return;
  }
  if (!res.waLink) {
    tab.cancel();
    toast(res.error ? `WhatsApp API failed: ${res.error}` : "Could not open WhatsApp", "error");
    return;
  }
  if (!tab.go(res.waLink)) {
    toast("Allow pop-ups to open WhatsApp", "error");
    return;
  }
  if (res.error) toast(`WhatsApp API failed: ${res.error} — opened chat instead`, "info");
  else if (messages.opened) toast(messages.opened, "info");
}
