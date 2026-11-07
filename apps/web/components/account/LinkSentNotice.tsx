import type { LinkDelivery } from "@/lib/types-platform";
import { Alert } from "@/components/ui/States";

/** Where a password link went (development: the link itself, since no email/SMS is set up). */
export function LinkSentNotice({ delivery, who }: { delivery: LinkDelivery; who: string }) {
  const until = new Date(delivery.expiresAt).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" });
  if (delivery.channel === "email") return <Alert tone="info">A link was emailed to {who}. It works once, until {until}.</Alert>;
  if (delivery.channel === "sms") return <Alert tone="info">A link was sent by SMS to {who}. It works once, until {until}.</Alert>;
  return (
    <Alert tone="warning">
      Email and SMS aren&apos;t set up on this server, so nothing was sent.
      {delivery.devLink && (
        <>
          {" "}
          Development link (valid until {until}):{" "}
          <a className="break-all font-mono text-xs underline" href={delivery.devLink}>
            {delivery.devLink}
          </a>
        </>
      )}
    </Alert>
  );
}

