"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ClipboardText, Play } from "@phosphor-icons/react";
import { ApiError, api, errorMessage } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import type { AuditDetail, AuditListRow, ItemCategory } from "@/lib/types-inventory";
import type { StockAuditStartInput } from "@canavo/shared";
import { useApiQuery } from "@/hooks/useApiQuery";
import { useSession } from "@/components/providers/SessionProvider";
import { useToast } from "@/components/providers/ToastProvider";
import { PageContainer, PageHeader } from "@/components/layout/PageHeader";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Select, Textarea } from "@/components/ui/Input";
import { Dialog } from "@/components/ui/Dialog";
import { Table, THead, Th, Td, Tr } from "@/components/ui/Table";
import { Alert, EmptyState, ErrorState, LoadingState } from "@/components/ui/States";
import { InventoryTabs } from "@/components/inventory/InventoryTabs";
import { AuditStatusBadge } from "@/components/inventory/common";

export default function AuditsPage() {
  const { outletId, can } = useSession();
  const router = useRouter();
  const manage = can("inventory:manage");
  const audits = useApiQuery<AuditListRow[]>(outletId ? `inv-audits:${outletId}` : null, () => api.get<AuditListRow[]>("/inventory/audits"));
  const [starting, setStarting] = useState(false);
  const list = audits.data ?? [];
  const inProgress = list.find((a) => a.status === "IN_PROGRESS");

  return (
    <PageContainer>
      <PageHeader
        title="Stock audits"
        subtitle="Physical counts that correct system stock"
        actions={
          manage &&
          (inProgress ? (
            <Link
              href={`/inventory/audits/${inProgress.id}`}
              className="inline-flex min-h-tap items-center gap-2 rounded-xl bg-primary px-4 font-semibold text-white shadow-sm hover:bg-primary-600"
            >
              <ClipboardText size={20} /> Continue counting
            </Link>
          ) : (
            <Button icon={<Play size={20} />} onClick={() => setStarting(true)}>
              Start audit
            </Button>
          ))
        }
      />
      <InventoryTabs />
      {inProgress && (
        <div className="mb-4">
          <Alert tone="info">
            An audit started {formatDateTime(inProgress.createdAt)} is in progress ({inProgress._count.lines} items).{" "}
            <Link href={`/inventory/audits/${inProgress.id}`} className="font-semibold underline">
              Open count sheet
            </Link>
          </Alert>
        </div>
      )}
      <Card>
        {audits.loading && !audits.data ? (
          <LoadingState />
        ) : audits.error && !audits.data ? (
          <ErrorState message={audits.error} onRetry={audits.reload} />
        ) : list.length === 0 ? (
          <EmptyState
            title="No audits yet"
            description="Start an audit to count stock on the shelf and post the differences."
            action={
              manage ? (
                <Button icon={<Play size={18} />} onClick={() => setStarting(true)}>
                  Start audit
                </Button>
              ) : undefined
            }
          />
        ) : (
          <Table>
            <THead>
              <tr>
                <Th>Started</Th>
                <Th>Status</Th>
                <Th className="text-right">Items</Th>
                <Th>Completed</Th>
                <Th>Notes</Th>
              </tr>
            </THead>
            <tbody>
              {list.map((a) => (
                <Tr key={a.id} onClick={() => router.push(`/inventory/audits/${a.id}`)} data-testid="audit-row">
                  <Td className="whitespace-nowrap">{formatDateTime(a.createdAt)}</Td>
                  <Td>
                    <AuditStatusBadge status={a.status} />
                  </Td>
                  <Td className="tabular text-right">{a._count.lines}</Td>
                  <Td className="whitespace-nowrap text-muted">{a.completedAt ? formatDateTime(a.completedAt) : "—"}</Td>
                  <Td className="max-w-xs truncate whitespace-pre-line text-muted">{a.notes ?? "—"}</Td>
                </Tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
      <StartAuditDialog
        open={starting}
        onClose={() => setStarting(false)}
        onStarted={(id) => router.push(`/inventory/audits/${id}`)}
        onConflict={async () => {
          await audits.reload();
        }}
      />
    </PageContainer>
  );
}

function StartAuditDialog({
  open,
  onClose,
  onStarted,
  onConflict,
}: {
  open: boolean;
  onClose: () => void;
  onStarted: (id: string) => void;
  onConflict: () => Promise<void>;
}) {
  const { outletId } = useSession();
  const toast = useToast();
  const categories = useApiQuery<ItemCategory[]>(open && outletId ? `inv-cats:${outletId}` : null, () => api.get<ItemCategory[]>("/inventory/items/categories"));
  const [category, setCategory] = useState("");
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setCategory("");
    setNotes("");
    setError(null);
  }, [open]);

  const start = async () => {
    setSaving(true);
    setError(null);
    try {
      const body: StockAuditStartInput = { category: category || undefined, notes: notes.trim() || null };
      const a = await api.post<AuditDetail>("/inventory/audits", body);
      toast(`Audit started · ${a.summary.items} items to count`, "success");
      onClose();
      onStarted(a.id);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        setError("An audit is already in progress for this outlet. Finish or cancel it first.");
        await onConflict();
      } else setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const total = (categories.data ?? []).reduce((s, c) => s + c.count, 0);
  return (
    <Dialog
      open={open}
      onClose={onClose}
      dismissible={!saving}
      title="Start stock audit"
      description="System quantities are snapshotted now. Sales made while you count are accounted for when you complete."
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button icon={<Play size={18} />} onClick={start} loading={saving}>
            Start counting
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {error && <Alert>{error}</Alert>}
        <Select label="Category" aria-label="Audit category" value={category} onChange={(e) => setCategory(e.target.value)}>
          <option value="">All categories ({total} items)</option>
          {(categories.data ?? []).map((c) => (
            <option key={c.category} value={c.category}>
              {c.category} ({c.count})
            </option>
          ))}
        </Select>
        <Textarea label="Notes" aria-label="Audit notes" maxLength={500} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. Month-end count" />
      </div>
    </Dialog>
  );
}
