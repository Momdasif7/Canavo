"use client";

import { useState } from "react";
import { MapPin, Phone, Storefront } from "@phosphor-icons/react";
import { api, errorMessage } from "@/lib/api";
import { formatTime } from "@/lib/format";
import type { DeliveryAgent } from "@/lib/types-service";
import { useToast } from "@/components/providers/ToastProvider";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { EmptyState } from "@/components/ui/States";
import { mapsLink, partnerStatus } from "./common";

/** On duty, away from the outlet, nothing out for delivery: a manager can release them for new orders. */
export const canMarkBack = (a: DeliveryAgent) => a.onDuty && !a.atOutlet && a.outForDelivery === 0;

export function PartnerStatusBadge({ agent }: { agent: DeliveryAgent }) {
  const s = partnerStatus(agent);
  return (
    <Badge tone={s.tone} className="tabular">
      {s.label}
    </Badge>
  );
}

/** "Mark back at outlet" — POST /delivery/agents/:id/back (for partners whose phone isn't sharing GPS). */
export function MarkBackButton({ agent, onDone, className }: { agent: DeliveryAgent; onDone: () => void; className?: string }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  if (!canMarkBack(agent)) return null;
  return (
    <Button
      size="sm"
      variant="outline"
      className={className}
      loading={busy}
      icon={<Storefront size={16} />}
      onClick={async () => {
        setBusy(true);
        try {
          await api.post(`/delivery/agents/${agent.id}/back`);
          toast(`${agent.name} is back at the outlet — can take new orders`, "success");
          onDone();
        } catch (e) {
          toast(errorMessage(e), "error");
        } finally {
          setBusy(false);
        }
      }}
    >
      Mark back at outlet
    </Button>
  );
}

export function AgentsPanel({ agents, onAgentsChanged }: { agents: DeliveryAgent[]; onAgentsChanged: () => void }) {
  const onDuty = agents.filter((a) => a.clockedIn).length;
  const available = agents.filter((a) => a.available).length;
  const max = agents[0]?.max;
  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3">
        <h2 className="font-bold">Delivery agents</h2>
        <span className="text-sm text-muted">
          {onDuty} on duty · {available} available · {agents.reduce((s, a) => s + a.activeDeliveries, 0)} active runs
          {max ? ` · up to ${max} orders each` : ""}
        </span>
      </div>
      {agents.length === 0 ? (
        <EmptyState title="No delivery agents" description="Add staff with the Delivery role on the Staff page." />
      ) : (
        <ul className="divide-y divide-line">
          {agents.map((a) => (
            <li key={a.id} className="flex flex-wrap items-center gap-3 px-4 py-3" data-testid="agent-row">
              <span className={`h-2.5 w-2.5 rounded-full ${a.clockedIn ? "bg-green-500" : "bg-line"}`} aria-hidden />
              <div className="min-w-0 flex-1">
                <p className="font-semibold">{a.name}</p>
                <a href={`tel:${a.phone}`} className="flex items-center gap-1 text-xs text-muted hover:text-primary">
                  <Phone size={12} /> {a.phone}
                </a>
              </div>
              <PartnerStatusBadge agent={a} />
              {a.clockedIn && a.clockedInAt && <span className="text-xs text-muted">Clocked in {formatTime(a.clockedInAt)}</span>}
              <Badge tone={a.active >= a.max ? "warning" : "neutral"} className="tabular">
                {a.active} of {a.max} orders
              </Badge>
              {a.location ? (
                <a href={mapsLink(a.location.lat, a.location.lng)} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-xs font-semibold text-sky-700 hover:underline dark:text-sky-300">
                  <MapPin size={14} weight="fill" /> Seen {formatTime(a.location.at)}
                </a>
              ) : (
                <span className="text-xs text-muted">No live location</span>
              )}
              <MarkBackButton agent={a} onDone={onAgentsChanged} />
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
