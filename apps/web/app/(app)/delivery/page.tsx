"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { DeliveryAgent } from "@/lib/types-service";
import { useSession } from "@/components/providers/SessionProvider";
import { useSocketEvent } from "@/components/providers/SocketProvider";
import { PageContainer, PageHeader } from "@/components/layout/PageHeader";
import { Segmented } from "@/components/ui/Segmented";
import { DeliveryBoard } from "@/components/delivery/DeliveryBoard";
import { AgentsPanel } from "@/components/delivery/AgentsPanel";
import { DeliveryAreaTab } from "@/components/delivery/DeliveryAreaTab";
import { MyDeliveries } from "@/components/delivery/MyDeliveries";
import { CashPanel } from "@/components/delivery/CashPanel";
import { formatINR } from "@/lib/format";

type Tab = "board" | "agents" | "cash" | "zones";

export default function DeliveryPage() {
  const { can, outletId } = useSession();
  const manager = can("delivery:manage");
  const [tab, setTab] = useState<Tab>("board");
  const [agents, setAgents] = useState<DeliveryAgent[]>([]);
  const [cashTotal, setCashTotal] = useState<number | null>(null);

  const loadAgents = useCallback(async () => {
    if (!manager || !outletId) return;
    try {
      setAgents(await api.get<DeliveryAgent[]>("/delivery/agents"));
    } catch {
      /* agents panel shows empty */
    }
  }, [manager, outletId]);
  useEffect(() => {
    void loadAgents();
  }, [loadAgents]);
  // Assignments, pick-ups, deliveries and "back at the outlet" all change who can take orders.
  useSocketEvent("delivery:updated", () => void loadAgents());
  useSocketEvent<{ agentId: string; lat: number; lng: number; at: string; deliveryId: string }>("delivery:location", (l) =>
    setAgents((list) => list.map((a) => (a.id === l.agentId ? { ...a, location: { lat: l.lat, lng: l.lng, at: l.at, deliveryId: l.deliveryId } } : a))),
  );

  if (!manager) {
    return (
      <PageContainer>
        <PageHeader title="My deliveries" subtitle="Upcoming and active runs, nearest ETA first" />
        <MyDeliveries />
      </PageContainer>
    );
  }

  return (
    <PageContainer>
      <PageHeader
        title="Delivery"
        subtitle={(() => {
          const onDuty = agents.filter((a) => a.clockedIn).length;
          return `${onDuty} ${onDuty === 1 ? "partner" : "partners"} on duty · ${agents.filter((a) => a.available).length} available`;
        })()}
        actions={
          <Segmented
            className="max-w-full overflow-x-auto"
            value={tab}
            onChange={setTab}
            options={[
              { value: "board", label: "Board" },
              { value: "agents", label: `Agents (${agents.length})` },
              { value: "cash", label: cashTotal ? `Cash with partners · ${formatINR(cashTotal)}` : "Cash with partners" },
              { value: "zones", label: "Delivery area" },
            ]}
          />
        }
      />
      {tab === "board" && <DeliveryBoard agents={agents} onAgentsChanged={() => void loadAgents()} />}
      {tab === "agents" && <AgentsPanel agents={agents} onAgentsChanged={() => void loadAgents()} />}
      {tab === "cash" && <CashPanel onTotal={setCashTotal} />}
      {tab === "zones" && <DeliveryAreaTab />}
    </PageContainer>
  );
}
