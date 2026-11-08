"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { MagnifyingGlass, PencilSimple, Plus, Prohibit } from "@phosphor-icons/react";
import { formatINR } from "@canavo/shared";
import { api, errorMessage } from "@/lib/api";
import type { Vendor, VendorDetail, VendorWithSummary } from "@/lib/types-inventory";
import { useApiQuery } from "@/hooks/useApiQuery";
import { useDebouncedValue } from "@/hooks/useDebounced";
import { useSession } from "@/components/providers/SessionProvider";
import { useToast } from "@/components/providers/ToastProvider";
import { PageContainer, PageHeader } from "@/components/layout/PageHeader";
import { Card } from "@/components/ui/Card";
import { Button, IconButton } from "@/components/ui/Button";
import { Input, Toggle } from "@/components/ui/Input";
import { Badge } from "@/components/ui/Badge";
import { Sheet } from "@/components/ui/Dialog";
import { Table, THead, Th, Td, Tr } from "@/components/ui/Table";
import { EmptyState, ErrorState, LoadingState } from "@/components/ui/States";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { InventoryTabs } from "@/components/inventory/InventoryTabs";
import { VendorFormDialog } from "@/components/inventory/VendorFormDialog";
import { PurchaseStatusBadge, Stat } from "@/components/inventory/common";
import { formatDate, formatYmd } from "@/components/inventory/units";

export default function VendorsPage() {
  const { outletId, can } = useSession();
  const toast = useToast();
  const manage = can("inventory:manage");
  const [search, setSearch] = useState("");
  const [showInactive, setShowInactive] = useState(false);
  const q = useDebouncedValue(search.trim(), 300);
  const vendors = useApiQuery<VendorWithSummary[]>(outletId ? `inv-vendors:${outletId}:${q}:${showInactive}` : null, () =>
    api.get<VendorWithSummary[]>("/inventory/vendors", { query: { search: q || undefined, includeInactive: showInactive ? "1" : undefined } }),
  );
  const [editing, setEditing] = useState<Vendor | null | undefined>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [detailVersion, setDetailVersion] = useState(0);
  const [deactivating, setDeactivating] = useState<Vendor | null>(null);

  const list = vendors.data ?? [];
  const totals = list.reduce((s, v) => ({ spend: s.spend + v.summary.totalSpend, outstanding: s.outstanding + v.summary.outstanding }), { spend: 0, outstanding: 0 });

  const reactivate = async (v: Vendor) => {
    try {
      await api.patch(`/inventory/vendors/${v.id}`, { active: true });
      toast(`${v.name} reactivated`, "success");
      void vendors.reload();
      setDetailVersion((x) => x + 1);
    } catch (e) {
      toast(errorMessage(e), "error");
    }
  };

  return (
    <PageContainer>
      <PageHeader
        title="Vendors"
        subtitle={vendors.data ? `${list.length} vendors · outstanding ${formatINR(totals.outstanding)}` : "Suppliers you purchase from"}
        actions={
          manage && (
            <Button icon={<Plus size={20} />} onClick={() => setEditing(undefined)}>
              Add vendor
            </Button>
          )
        }
      />
      <InventoryTabs />
      <Card>
        <div className="flex flex-wrap items-center gap-3 border-b border-line p-4">
          <Input
            type="search"
            aria-label="Search vendors"
            placeholder="Search name or phone"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            prefix={<MagnifyingGlass size={18} />}
            wrapperClassName="w-full sm:w-72"
          />
          <Toggle checked={showInactive} onChange={setShowInactive} label="Show inactive" />
        </div>
        {vendors.loading && !vendors.data ? (
          <LoadingState />
        ) : vendors.error && !vendors.data ? (
          <ErrorState message={vendors.error} onRetry={vendors.reload} />
        ) : list.length === 0 ? (
          <EmptyState
            title={q ? "No vendors match" : "No vendors yet"}
            description={!q && manage ? "Use Add vendor above to add a supplier." : undefined}
          />
        ) : (
          <Table>
            <THead>
              <tr>
                <Th>Vendor</Th>
                <Th>Contact</Th>
                <Th className="text-right">Purchases</Th>
                <Th className="text-right">Total spend</Th>
                <Th className="text-right">Paid</Th>
                <Th className="text-right">Outstanding</Th>
                <Th>Last purchase</Th>
                {manage && <Th />}
              </tr>
            </THead>
            <tbody>
              {list.map((v) => (
                <Tr key={v.id} onClick={() => setDetailId(v.id)} className={v.active ? undefined : "opacity-60"}>
                  <Td>
                    <p className="font-semibold">
                      {v.name} {!v.active && <Badge>Inactive</Badge>}
                    </p>
                    {v.gstin && <p className="font-mono text-xs text-muted">{v.gstin}</p>}
                  </Td>
                  <Td className="text-sm">
                    <p>{v.contactPerson ?? "—"}</p>
                    {v.phone && <p className="text-xs text-muted">{v.phone}</p>}
                  </Td>
                  <Td className="tabular text-right">{v.summary.purchases}</Td>
                  <Td className="tabular whitespace-nowrap text-right font-semibold">{formatINR(v.summary.totalSpend)}</Td>
                  <Td className="tabular whitespace-nowrap text-right">{formatINR(v.summary.paid)}</Td>
                  <Td className="whitespace-nowrap text-right">
                    {v.summary.outstanding > 0 ? <Badge tone="warning">{formatINR(v.summary.outstanding)}</Badge> : <span className="text-muted">—</span>}
                  </Td>
                  <Td className="whitespace-nowrap text-muted">{v.summary.lastPurchaseAt ? formatDate(v.summary.lastPurchaseAt) : "—"}</Td>
                  {manage && (
                    <Td className="text-right" onClick={(e) => e.stopPropagation()}>
                      <IconButton label={`Edit ${v.name}`} onClick={() => setEditing(v)}>
                        <PencilSimple size={20} />
                      </IconButton>
                    </Td>
                  )}
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      <VendorDetailSheet
        vendorId={detailId}
        version={detailVersion}
        onClose={() => setDetailId(null)}
        onEdit={(v) => setEditing(v)}
        onDeactivate={(v) => setDeactivating(v)}
        onReactivate={reactivate}
      />
      <VendorFormDialog
        vendor={editing}
        onClose={() => setEditing(null)}
        onSaved={() => {
          void vendors.reload();
          setDetailVersion((x) => x + 1);
        }}
      />
      <ConfirmDialog
        open={!!deactivating}
        title={`Deactivate ${deactivating?.name ?? "vendor"}?`}
        description="Inactive vendors can't be used on new purchases. Purchase history is kept."
        confirmLabel="Deactivate"
        onConfirm={async () => {
          try {
            await api.del(`/inventory/vendors/${deactivating!.id}`);
          } catch (e) {
            throw new Error(errorMessage(e));
          }
          toast("Vendor deactivated", "success");
          void vendors.reload();
          setDetailVersion((x) => x + 1);
        }}
        onClose={() => setDeactivating(null)}
      />
    </PageContainer>
  );
}

function VendorDetailSheet({
  vendorId,
  version,
  onClose,
  onEdit,
  onDeactivate,
  onReactivate,
}: {
  vendorId: string | null;
  version: number;
  onClose: () => void;
  onEdit: (v: Vendor) => void;
  onDeactivate: (v: Vendor) => void;
  onReactivate: (v: Vendor) => void;
}) {
  const { outletId, can } = useSession();
  const router = useRouter();
  const manage = can("inventory:manage");
  const q = useApiQuery<VendorDetail>(vendorId ? `inv-vendor:${outletId}:${vendorId}:${version}` : null, () => api.get<VendorDetail>(`/inventory/vendors/${vendorId}`));
  const v = q.data && q.data.id === vendorId ? q.data : undefined;
  return (
    <Sheet
      open={!!vendorId}
      onClose={onClose}
      width="max-w-2xl"
      title={v?.name ?? "Vendor"}
      footer={
        v &&
        manage && (
          <>
            {v.active ? (
              <Button variant="ghost" icon={<Prohibit size={18} />} className="mr-auto text-red-600 dark:text-red-400" onClick={() => onDeactivate(v)}>
                Deactivate
              </Button>
            ) : (
              <Button variant="outline" className="mr-auto" onClick={() => onReactivate(v)}>
                Reactivate
              </Button>
            )}
            <Button variant="outline" icon={<PencilSimple size={18} />} onClick={() => onEdit(v)}>
              Edit vendor
            </Button>
          </>
        )
      }
    >
      {q.loading && !v ? (
        <LoadingState />
      ) : q.error ? (
        <ErrorState message={q.error} onRetry={q.reload} />
      ) : v ? (
        <div className="space-y-6">
          <dl className="grid gap-3 text-sm sm:grid-cols-2">
            <Info label="Contact person" value={v.contactPerson} />
            <Info label="Phone" value={v.phone} />
            <Info label="Email" value={v.email} />
            <Info label="GSTIN" value={v.gstin} mono />
            <Info label="Address" value={v.address} />
            <Info label="Notes" value={v.notes} />
          </dl>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat label="Purchases" value={v.summary.purchases} />
            <Stat label="Total spend" value={formatINR(v.summary.totalSpend)} />
            <Stat label="Paid" value={formatINR(v.summary.paid)} />
            <Stat label="Outstanding" value={formatINR(v.summary.outstanding)} tone={v.summary.outstanding > 0 ? "warning" : undefined} />
          </div>
          <section>
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-sm font-bold">Recent purchases (this outlet)</h3>
              <Link href={`/inventory/purchases?vendor=${v.id}`} className="text-sm font-semibold text-primary-700 hover:underline dark:text-primary-200">
                View all
              </Link>
            </div>
            {v.purchases.length === 0 ? (
              <EmptyState title="No purchases yet" />
            ) : (
              <div className="rounded-xl border border-line">
                <Table>
                  <THead>
                    <tr>
                      <Th>Date</Th>
                      <Th>Invoice</Th>
                      <Th>Status</Th>
                      <Th className="text-right">Total</Th>
                      <Th className="text-right">Due</Th>
                    </tr>
                  </THead>
                  <tbody>
                    {v.purchases.map((p) => (
                      <Tr key={p.id} onClick={() => router.push(`/inventory/purchases?open=${p.id}`)}>
                        <Td className="whitespace-nowrap">{formatDate(p.receivedAt ?? p.createdAt)}</Td>
                        <Td>
                          {p.invoiceNo ?? "—"}
                          {p.invoiceDate && <span className="block text-xs text-muted">{formatYmd(p.invoiceDate)}</span>}
                        </Td>
                        <Td>
                          <PurchaseStatusBadge status={p.status} />
                        </Td>
                        <Td className="tabular text-right">{formatINR(p.total)}</Td>
                        <Td className="tabular text-right">{p.status === "RECEIVED" && p.total > p.paidAmount ? formatINR(p.total - p.paidAmount) : "—"}</Td>
                      </Tr>
                    ))}
                  </tbody>
                </Table>
              </div>
            )}
          </section>
        </div>
      ) : null}
    </Sheet>
  );
}

function Info({ label, value, mono }: { label: string; value: string | null; mono?: boolean }) {
  return (
    <div>
      <dt className="text-xs font-semibold uppercase tracking-wide text-muted">{label}</dt>
      <dd className={`mt-0.5 whitespace-pre-line ${mono ? "font-mono" : ""}`}>{value || "—"}</dd>
    </div>
  );
}
