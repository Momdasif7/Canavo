"use client";

import { useState } from "react";
import { ArrowRight, Plus } from "@phosphor-icons/react";
import { api } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import type { TransferListRow } from "@/lib/types-inventory";
import { useApiQuery } from "@/hooks/useApiQuery";
import { useSession } from "@/components/providers/SessionProvider";
import { useSocketEvent } from "@/components/providers/SocketProvider";
import { PageContainer, PageHeader } from "@/components/layout/PageHeader";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Segmented } from "@/components/ui/Segmented";
import { Table, THead, Th, Td, Tr } from "@/components/ui/Table";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/States";
import { InventoryTabs } from "@/components/inventory/InventoryTabs";
import { TransferFormDialog } from "@/components/inventory/TransferFormDialog";
import { TransferDetailSheet } from "@/components/inventory/TransferDetailSheet";
import { TransferStatusBadge } from "@/components/inventory/common";

type Direction = "incoming" | "outgoing";

export default function TransfersPage() {
  const { outletId, me, can } = useSession();
  const manage = can("inventory:manage");
  const [direction, setDirection] = useState<Direction>("incoming");
  const [creating, setCreating] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [detailVersion, setDetailVersion] = useState(0);
  const list = useApiQuery<TransferListRow[]>(outletId ? `inv-transfers:${outletId}:${direction}` : null, () =>
    api.get<TransferListRow[]>("/inventory/transfers", { query: { direction } }),
  );
  const singleOutlet = (me?.outlets.length ?? 0) <= 1;

  useSocketEvent<{ id: string }>("inventory:transfer", (p) => {
    void list.reload();
    if (p?.id && p.id === detailId) setDetailVersion((v) => v + 1);
  });

  const rows = list.data ?? [];
  const pendingAction = rows.filter((t) =>
    direction === "incoming" ? t.status === "DISPATCHED" : t.status === "REQUESTED" || t.status === "APPROVED",
  ).length;

  return (
    <PageContainer>
      <PageHeader
        title="Transfers"
        subtitle="Move stock between outlets"
        actions={
          manage &&
          !singleOutlet && (
            <Button icon={<Plus size={20} />} onClick={() => setCreating(true)}>
              New transfer
            </Button>
          )
        }
      />
      <InventoryTabs />
      {singleOutlet ? (
        <Card>
          <EmptyState title="Transfers need more than one outlet" description="You have access to a single outlet. Transfers appear here once you're assigned to another outlet." />
        </Card>
      ) : (
        <Card>
          <div className="flex flex-wrap items-center gap-3 border-b border-line p-4">
            <Segmented
              value={direction}
              onChange={setDirection}
              options={[
                { value: "incoming", label: "Incoming" },
                { value: "outgoing", label: "Outgoing" },
              ]}
            />
            {pendingAction > 0 && (
              <span className="text-sm text-muted">
                {pendingAction} {direction === "incoming" ? "awaiting receipt" : "awaiting approval or dispatch"}
              </span>
            )}
          </div>
          {list.loading && !list.data ? (
            <LoadingState />
          ) : list.error && !list.data ? (
            <ErrorState message={list.error} onRetry={list.reload} />
          ) : rows.length === 0 ? (
            <EmptyState title={direction === "incoming" ? "No incoming transfers" : "No outgoing transfers"} />
          ) : (
            <Table>
              <THead>
                <tr>
                  <Th>Created</Th>
                  <Th>Route</Th>
                  <Th className="text-right">Items</Th>
                  <Th>Status</Th>
                  <Th>Notes</Th>
                </tr>
              </THead>
              <tbody>
                {rows.map((t) => (
                  <Tr key={t.id} onClick={() => setDetailId(t.id)} data-testid="transfer-row">
                    <Td className="whitespace-nowrap">{formatDateTime(t.createdAt)}</Td>
                    <Td>
                      <span className="inline-flex items-center gap-2 font-medium">
                        {t.fromOutletName ?? "—"} <ArrowRight size={14} className="text-muted" /> {t.toOutletName ?? "—"}
                      </span>
                    </Td>
                    <Td className="tabular text-right">{t._count.items}</Td>
                    <Td>
                      <TransferStatusBadge status={t.status} />
                    </Td>
                    <Td className="max-w-xs truncate text-muted">{t.notes ?? "—"}</Td>
                  </Tr>
                ))}
              </tbody>
            </Table>
          )}
        </Card>
      )}
      <TransferDetailSheet transferId={detailId} version={detailVersion} onClose={() => setDetailId(null)} onChanged={() => void list.reload()} />
      <TransferFormDialog
        open={creating}
        onClose={() => setCreating(false)}
        onSaved={(t) => {
          setDirection(t.fromOutletId === outletId ? "outgoing" : "incoming");
          void list.reload();
          setDetailId(t.id);
        }}
      />
    </PageContainer>
  );
}
