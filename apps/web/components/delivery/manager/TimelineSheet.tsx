"use client";

import clsx from "clsx";
import { CheckCircle, HandCoins, Handshake, Moped, Package, SignIn, SignOut, UserPlus, WarningOctagon, type Icon } from "@phosphor-icons/react";
import { formatINR } from "@canavo/shared";
import { api } from "@/lib/api";
import { formatTime } from "@/lib/format";
import type { PartnerTimeline, TimelineEventType } from "@/lib/types-delivery";
import { useApiQuery } from "@/hooks/useApiQuery";
import { useSession } from "@/components/providers/SessionProvider";
import { Sheet } from "@/components/ui/Dialog";
import { ErrorState, LoadingState } from "@/components/ui/States";

const EVENT: Record<TimelineEventType, { icon: Icon; cls: string }> = {
  CLOCK_IN: { icon: SignIn, cls: "bg-green-100 text-green-700 dark:bg-green-500/20 dark:text-green-300" },
  CLOCK_OUT: { icon: SignOut, cls: "bg-surface-2 text-muted" },
  ASSIGNED: { icon: UserPlus, cls: "bg-sky-100 text-sky-700 dark:bg-sky-500/20 dark:text-sky-300" },
  ACCEPTED: { icon: Moped, cls: "bg-indigo-100 text-indigo-700 dark:bg-indigo-500/20 dark:text-indigo-300" },
  PICKED: { icon: Package, cls: "bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-200" },
  DELIVERED: { icon: CheckCircle, cls: "bg-secondary-50 text-secondary dark:bg-secondary/25 dark:text-green-300" },
  COLLECTED: { icon: HandCoins, cls: "bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-200" },
  HANDOVER: { icon: Handshake, cls: "bg-primary-50 text-primary-700 dark:bg-primary/20 dark:text-primary-200" },
  ISSUE: { icon: WarningOctagon, cls: "bg-red-100 text-red-700 dark:bg-red-500/20 dark:text-red-300" },
};

const dayLabel = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

/** One partner's day: duty, each delivery step, cash collected and handed over, problems. */
export function TimelineSheet({ target, onClose }: { target: { agentId: string; name: string; date: string } | null; onClose: () => void }) {
  const { outletId } = useSession();
  const q = useApiQuery<PartnerTimeline>(target && outletId ? `partner-timeline:${outletId}:${target.agentId}:${target.date}` : null, () =>
    api.get<PartnerTimeline>(`/delivery/partners/${target!.agentId}/timeline`, { query: { date: target!.date } }),
  );
  const t = q.data && target && q.data.agent.id === target.agentId && q.data.date === target.date ? q.data : null;

  return (
    <Sheet open={!!target} onClose={onClose} title={target ? `${target.name} · ${dayLabel(target.date)}` : ""} width="max-w-lg">
      {!t ? (
        q.error ? (
          <ErrorState message={q.error} onRetry={q.reload} />
        ) : (
          <LoadingState label="Loading the day…" />
        )
      ) : (
        <div className="space-y-4" data-testid="timeline">
          <div className="grid grid-cols-2 gap-2">
            <div className="rounded-xl bg-surface-2 px-3 py-2">
              <p className="text-xs font-semibold text-muted">Opening cash with partner</p>
              <p className="tabular text-lg font-extrabold">{formatINR(t.openingBalance)}</p>
            </div>
            <div className="rounded-xl bg-surface-2 px-3 py-2">
              <p className="text-xs font-semibold text-muted">Closing · to receive</p>
              <p className={clsx("tabular text-lg font-extrabold", t.closingBalance > 0 && "text-primary-700 dark:text-primary-200")}>{formatINR(t.closingBalance)}</p>
            </div>
          </div>
          {t.events.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted">No activity on this day.</p>
          ) : (
            <ol className="relative space-y-3 before:absolute before:bottom-2 before:left-[19px] before:top-2 before:w-px before:bg-line">
              {t.events.map((e, i) => {
                const meta = EVENT[e.type] ?? EVENT.ASSIGNED;
                const I = meta.icon;
                return (
                  <li key={i} className="relative flex items-start gap-3" data-testid="timeline-event" data-type={e.type}>
                    <span className={clsx("relative z-10 flex h-10 w-10 shrink-0 items-center justify-center rounded-full ring-4 ring-surface", meta.cls)}>
                      <I size={20} weight="bold" />
                    </span>
                    <div className="min-w-0 flex-1 pt-0.5">
                      <p className="flex flex-wrap items-baseline gap-x-2">
                        <span className="font-bold">{e.title}</span>
                        <span className="tabular text-xs text-muted">{formatTime(e.at)}</span>
                      </p>
                      {e.detail && <p className="break-words text-sm text-muted">{e.detail}</p>}
                    </div>
                    {e.amount != null && (
                      <span className={clsx("tabular shrink-0 pt-0.5 font-extrabold", e.type === "HANDOVER" ? "text-secondary dark:text-green-300" : "text-amber-700 dark:text-amber-300")}>
                        {e.type === "HANDOVER" ? "−" : "+"}
                        {formatINR(e.amount)}
                      </span>
                    )}
                  </li>
                );
              })}
            </ol>
          )}
        </div>
      )}
    </Sheet>
  );
}
