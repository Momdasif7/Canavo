"use client";

import { useEffect, useState } from "react";
import { Plus } from "@phosphor-icons/react";
import { formatINR } from "@canavo/shared";
import { api } from "@/lib/api";
import type { PurchaseListRow, PurchaseStatus, VendorWithSummary } from "@/lib/types-inventory";
import { useApiQuery } from "@/hooks/useApiQuery";
import { useSession } from "@/components/providers/SessionProvider";
import { useSocketEvent } from "@/components/providers/SocketProvider";
import { PageContainer, PageHeader } from "@/components/layout/PageHeader";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input, Select, Toggle } from "@/components/ui/Input";
import { Badge } from "@/components/ui/Badge";
import { Segmented } from "@/components/ui/Segmented";
import { Table, THead, Th, Td, Tr } from "@/components/ui/Table";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/States";
import { InventoryTabs } from "@/components/inventory/InventoryTabs";
import { PurchaseFormDialog, type PurchaseFormTarget } from "@/components/inventory/PurchaseFormDialog";
import { PurchaseDetailSheet } from "@/components/inventory/PurchaseDetailSheet";
import { PurchaseStatusBadge } from "@/components/inventory/common";
import { formatDate, formatYmd } from "@/components/inventory/units";

type StatusFilter = PurchaseStatus | "ALL";

export default function PurchasesPage() {
  const { outletId, can } = useSession();
  const manage = can("inventory:manage");
  const [status, setStatus] = useState<StatusFilter>("ALL");
  const [vendorId, setVendorId] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [unpaid, setUnpaid] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [detailVersion, setDetailVersion] = useState(0);
  const [formTarget, setFormTarget] = useState<PurchaseFormTarget>(null);

  // Deep links from the vendor screen: ?vendor=<id> and ?open=<purchaseId>
  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    const v = sp.get("vendor");
    const open = sp.get("open");
    if (v) setVendorId(v);
    if (open) setDetailId(open);
  }, []);

  const rangeValid = !(from && to && from > to);
  const key = outletId && rangeValid ? `inv-purchases:${outletId}:${status}:${vendorId}:${from}:${to}:${unpaid}` : null;
  const list = useApiQuery<PurchaseListRow[]>(key, () =>
    api.get<PurchaseListRow[]>("/inventory/purchases", {
      query: { status: status === "ALL" ? undefined : status, vendorId: vendorId || undefined, from: from || undefined, to: to || undefined, unpaid: unpaid ? "1" : undefined },
    }),
  );
  const vendors = useApiQuery<VendorWithSummary[]>(outletId ? `inv-vendors-all:${outletId}` : null, () =>
    api.get<VendorWithSummary[]>("/inventory/vendors", { query: { includeInactive: "1" } }),
  );

  useSocketEvent("inventory:changed", () => void list.reload());

  const rows = list.data ?? [];
  const received = rows.filter((p) => p.status === "RECEIVED");
  const sum = received.reduce((s, p) => ({ total: s.total + p.total, paid: s.paid + p.paidAmount, balance: s.balance + p.balance }), { total: 0, paid: 0, balance: 0 });
  const filtered = status !== "ALL" || vendorId || from || to || unpaid;

  return (
    <PageContainer>
      <PageHeader
        title="Purchases"
        subtitle={list.data ? `${rows.length} purchases · ${formatINR(sum.balance)} outstanding` : "Stock bought from vendors"}
        actions={
          manage && (
            <Button icon={<Plus size={20} />} onClick={() => setFormTarget({ mode: "create", vendorId: vendorId || undefined })}>
              New purchase
            </Button>
          )
        }
      />
      <InventoryTabs />
      <Card>
        <div className="flex flex-wrap items-end gap-3 border-b border-line p-4">
          <Segmented
            value={status}
            onChange={setStatus}
            options={[
              { value: "ALL", label: "All" },
              { value: "DRAFT", label: "Drafts" },
              { value: "RECEIVED", label: "Received" },
              { value: "CANCELLED", label: "Cancelled" },
            ]}
          />
          <Select aria-label="Vendor filter" value={vendorId} onChange={(e) => setVendorId(e.target.value)} wrapperClassName="w-full sm:w-52">
            <option value="">All vendors</option>
            {(vendors.data ?? []).map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
                {!v.active ? " (inactive)" : ""}
              </option>
            ))}
          </Select>
          <Input aria-label="From date" type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} wrapperClassName="w-[46%] sm:w-40" />
          <Input aria-label="To date" type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} wrapperClassName="w-[46%] sm:w-40" />
          <Toggle checked={unpaid} onChange={setUnpaid} label="Unpaid only" />
          {filtered && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setStatus("ALL");
                setVendorId("");
                setFrom("");
                setTo("");
                setUnpaid(false);
              }}
            >
              Clear filters
            </Button>
          )}
        </div>
        {!rangeValid ? (
          <EmptyState title="Invalid date range" description="The start date must be on or before the end date." />
        ) : list.loading && !list.data ? (
          <LoadingState />
        ) : list.error && !list.data ? (
          <ErrorState message={list.error} onRetry={list.reload} />
        ) : rows.length === 0 ? (
          <EmptyState
            title={filtered ? "No purchases match these filters" : "No purchases yet"}
            description={filtered ? undefined : manage ? "Use New purchase above to record vendor deliveries, add stock and track what you owe." : "Vendor deliveries recorded here add stock and track what you owe."}
          />
        ) : (
          <Table>
            <THead>
              <tr>
                <Th>Date</Th>
                <Th>Vendor</Th>
                <Th>Invoice</Th>
                <Th>Status</Th>
                <Th className="text-right">Items</Th>
                <Th className="text-right">Total</Th>
                <Th className="text-right">Paid</Th>
                <Th className="text-right">Outstanding</Th>
              </tr>
            </THead>
            <tbody>
              {rows.map((p) => (
                <Tr key={p.id} onClick={() => setDetailId(p.id)} data-testid="purchase-row">
                  <Td className="whitespace-nowrap">{formatDate(p.receivedAt ?? p.createdAt)}</Td>
                  <Td className="font-semibold">{p.vendor.name}</Td>
                  <Td>
                    {p.invoiceNo ?? <span className="text-muted">—</span>}
                    {p.invoiceDate && <span className="block text-xs text-muted">{formatYmd(p.invoiceDate)}</span>}
                  </Td>
                  <Td>
                    <PurchaseStatusBadge status={p.status} />
                  </Td>
                  <Td className="tabular text-right">{p._count.items}</Td>
                  <Td className="tabular whitespace-nowrap text-right font-semibold">{formatINR(p.total)}</Td>
                  <Td className="tabular whitespace-nowrap text-right">{p.status === "RECEIVED" ? formatINR(p.paidAmount) : "—"}</Td>
                  <Td className="whitespace-nowrap text-right">
                    {p.status === "RECEIVED" && p.balance > 0 ? <Badge tone="warning">{formatINR(p.balance)}</Badge> : p.status === "RECEIVED" ? <Badge tone="success">Paid</Badge> : <span className="text-muted">—</span>}
                  </Td>
                </Tr>
              ))}
            </tbody>
            {received.length > 0 && (
              <tfoot>
                <tr className="bg-surface-2 font-semibold">
                  <Td colSpan={5}>Received ({received.length})</Td>
                  <Td className="tabular text-right">{formatINR(sum.total)}</Td>
                  <Td className="tabular text-right">{formatINR(sum.paid)}</Td>
                  <Td className="tabular text-right">{formatINR(sum.balance)}</Td>
                </tr>
              </tfoot>
            )}
          </Table>
        )}
      </Card>

      <PurchaseDetailSheet
        purchaseId={detailId}
        version={detailVersion}
        onClose={() => setDetailId(null)}
        onEdit={(p) => setFormTarget({ mode: "edit", purchase: p })}
        onChanged={() => void list.reload()}
      />
      <PurchaseFormDialog
        target={formTarget}
        onClose={() => setFormTarget(null)}
        onSaved={(p) => {
          void list.reload();
          setDetailVersion((v) => v + 1);
          setDetailId(p.id);
        }}
      />
    </PageContainer>
  );
}
