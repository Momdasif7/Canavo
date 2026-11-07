"use client";

import { useEffect, useState } from "react";
import clsx from "clsx";
import { formatTime } from "@/lib/format";
import type { Kot, KotStatus } from "@/lib/types";
import { Badge } from "@/components/ui/Badge";

const STATUS: Record<KotStatus, { label: string; tone: "info" | "primary" | "success" | "neutral" }> = {
  RECEIVED: { label: "Received", tone: "info" },
  PREPARING: { label: "Preparing", tone: "primary" },
  READY: { label: "Ready", tone: "success" },
  SERVED: { label: "Served", tone: "neutral" },
};
const STEPS: KotStatus[] = ["RECEIVED", "PREPARING", "READY", "SERVED"];

const minutesSince = (iso: string, now: number) => Math.max(0, Math.floor((now - new Date(iso).getTime()) / 60_000));

/** When the ticket reached each stage, as "Received 12:04 · Preparing 12:06 · Ready 12:15". */
function stageTimes(k: Kot) {
  const at: [KotStatus, string | null | undefined][] = [
    ["RECEIVED", k.createdAt],
    ["PREPARING", k.preparingAt],
    ["READY", k.readyAt],
    ["SERVED", k.servedAt],
  ];
  return at.filter(([, t]) => t).map(([s, t]) => `${STATUS[s].label} ${formatTime(t!)}`).join(" · ");
}

/**
 * Bill detail: the food's progress, item by item. The kitchen moves whole tickets (one per
 * station), so each item shows its ticket's status. Updates live (the drawer reloads on kot:updated).
 */
export function KitchenStatus({ kots, cancelled }: { kots: Kot[]; cancelled: boolean }) {
  const [now, setNow] = useState(() => Date.now());
  const waiting = kots.some((k) => k.status !== "SERVED" && k.status !== "READY");
  useEffect(() => {
    if (!waiting || cancelled) return;
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, [waiting, cancelled]);

  if (kots.length === 0) return <p className="text-sm text-muted">No kitchen tickets for this bill.</p>;
  const sorted = [...kots].sort((a, b) => a.kotNumber - b.kotNumber);

  return (
    <ul className="space-y-3" data-testid="kitchen-status">
      {sorted.map((k) => {
        const scheduled = k.releaseAt && new Date(k.releaseAt).getTime() > now;
        const s = STATUS[k.status];
        const step = STEPS.indexOf(k.status);
        const late = !cancelled && !scheduled && (k.status === "RECEIVED" || k.status === "PREPARING") ? minutesSince(k.createdAt, now) : null;
        return (
          <li key={k.id} className="rounded-xl border border-line p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-sm font-semibold">
                KOT #{k.kotNumber} <span className="font-normal text-muted">· {k.station}</span>
              </span>
              <span className="flex items-center gap-2">
                {late !== null && <span className={clsx("tabular text-xs", late >= 20 ? "font-semibold text-red-600 dark:text-red-300" : "text-muted")}>{late} min</span>}
                {cancelled ? <Badge tone="danger">Cancelled</Badge> : scheduled ? <Badge tone="warning">Scheduled {formatTime(k.releaseAt!)}</Badge> : <Badge tone={s.tone}>{s.label}</Badge>}
              </span>
            </div>
            {!cancelled && !scheduled && (
              <div className="mt-2 flex gap-1" aria-hidden>
                {STEPS.map((st, i) => (
                  <span key={st} className={clsx("h-1.5 flex-1 rounded-full", i <= step ? (k.status === "SERVED" ? "bg-muted/50" : "bg-secondary") : "bg-surface-2")} />
                ))}
              </div>
            )}
            <ul className="mt-2 space-y-1 text-sm">
              {k.items.map((i, idx) => (
                <li key={idx} className={clsx("flex items-start justify-between gap-2", i.voided && "text-muted line-through")}>
                  <span>
                    <span className="tabular font-semibold">{i.quantity}×</span> {i.name}
                    {i.addons && i.addons.length > 0 && <span className="block text-xs text-muted">+ {i.addons.join(", ")}</span>}
                    {i.notes && <span className="block text-xs italic text-muted">“{i.notes}”</span>}
                  </span>
                  {i.voided ? <span className="text-xs no-underline">Voided</span> : !cancelled && !scheduled && <span className="whitespace-nowrap text-xs text-muted">{s.label}</span>}
                </li>
              ))}
            </ul>
            <p className="mt-2 text-xs text-muted">{stageTimes(k)}</p>
          </li>
        );
      })}
    </ul>
  );
}
