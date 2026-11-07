"use client";

import { useState } from "react";
import { ArrowCounterClockwise, Database, LockSimple, Plus, WarningOctagon } from "@phosphor-icons/react";
import { api, errorMessage } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import { useApiQuery } from "@/hooks/useApiQuery";
import { useToast } from "@/components/providers/ToastProvider";
import { PageHeader } from "@/components/layout/PageHeader";
import type { BackupFile, BackupResult } from "@/components/admin/types";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card, CardHeader } from "@/components/ui/Card";
import { Dialog } from "@/components/ui/Dialog";
import { Input } from "@/components/ui/Input";
import { Alert, EmptyState, ErrorState, LoadingState } from "@/components/ui/States";
import { Table, THead, Th, Td } from "@/components/ui/Table";

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export default function BackupsPage() {
  const toast = useToast();
  const backups = useApiQuery<BackupFile[]>("backups", () => api.get<BackupFile[]>("/admin/backups", { outletId: null }));
  const counts = useApiQuery<Record<string, number>>("table-counts", () => api.get<Record<string, number>>("/admin/table-counts", { outletId: null }));
  const [creating, setCreating] = useState(false);
  const [restoring, setRestoring] = useState<BackupFile | null>(null);

  const create = async () => {
    setCreating(true);
    try {
      const r = await api.post<BackupResult>("/admin/backups", undefined, { outletId: null });
      toast(`Backup created · ${r.rows.toLocaleString("en-IN")} rows · ${formatBytes(r.size)}`, "success");
      await Promise.all([backups.reload(), counts.reload()]);
    } catch (e) {
      toast(errorMessage(e), "error");
    } finally {
      setCreating(false);
    }
  };

  return (
    <>
      <PageHeader title="Backups" subtitle="Full-database snapshots (gzipped NDJSON). Automatic backups run nightly." />
      <p className="mb-5 flex items-start gap-2 rounded-xl border border-line bg-surface-2 px-4 py-3 text-sm text-muted">
        <LockSimple size={18} className="mt-0.5 shrink-0 text-primary" />
        Backups are kept on the server for disaster recovery. They can&apos;t be downloaded from here, to keep hotel data private.
      </p>
      <div className="grid gap-5 xl:grid-cols-[1fr_380px]">
        <div className="space-y-5">
          <Card>
            <CardHeader
              title="Backups"
              subtitle="Stored on the server for disaster recovery."
              action={
                <Button icon={<Plus size={20} />} loading={creating} onClick={create}>
                  Back up now
                </Button>
              }
            />
            {backups.loading && !backups.data ? (
              <LoadingState />
            ) : backups.error ? (
              <ErrorState message={backups.error} onRetry={backups.reload} />
            ) : !backups.data?.length ? (
              <EmptyState title="No backups yet" description="Create the first backup now." />
            ) : (
              <Table>
                <THead>
                  <tr>
                    <Th>Created</Th>
                    <Th>Type</Th>
                    <Th className="text-right">Size</Th>
                    <Th className="hidden lg:table-cell">File</Th>
                    <Th className="text-right">Actions</Th>
                  </tr>
                </THead>
                <tbody>
                  {backups.data.map((b) => (
                    <tr key={b.file}>
                      <Td className="whitespace-nowrap font-semibold">{formatDateTime(b.createdAt)}</Td>
                      <Td>
                        <div className="flex flex-wrap gap-1">
                          <Badge tone={b.kind === "auto" ? "info" : "neutral"}>{b.kind === "auto" ? "Automatic" : "Manual"}</Badge>
                          {b.location === "offsite" && <Badge tone="neutral">Off-site only</Badge>}
                        </div>
                      </Td>
                      <Td className="tabular text-right">{formatBytes(b.size)}</Td>
                      <Td className="hidden max-w-[280px] truncate font-mono text-xs text-muted lg:table-cell" title={b.file}>
                        {b.file}
                      </Td>
                      <Td>
                        <div className="flex justify-end gap-2">
                          <Button variant="ghost" size="sm" className="text-red-600 dark:text-red-300" icon={<ArrowCounterClockwise size={18} />} onClick={() => setRestoring(b)}>
                            Restore
                          </Button>
                        </div>
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>

        </div>

        <Card className="self-start">
          <CardHeader title="Table counts" subtitle="Compare before/after a restore" action={<Database size={22} className="text-muted" />} />
          {counts.loading && !counts.data ? (
            <LoadingState />
          ) : counts.error ? (
            <ErrorState message={counts.error} onRetry={counts.reload} />
          ) : counts.data ? (
            <div className="max-h-[560px] overflow-y-auto">
              <Table>
                <tbody>
                  {Object.entries(counts.data)
                    .sort((a, b) => b[1] - a[1])
                    .map(([table, n]) => (
                      <tr key={table}>
                        <Td className="py-2 font-mono text-xs">{table}</Td>
                        <Td className="tabular py-2 text-right font-semibold">{n.toLocaleString("en-IN")}</Td>
                      </tr>
                    ))}
                  <tr className="bg-surface-2/60 font-bold">
                    <Td className="py-2">Total rows</Td>
                    <Td className="tabular py-2 text-right">{Object.values(counts.data).reduce((s, n) => s + n, 0).toLocaleString("en-IN")}</Td>
                  </tr>
                </tbody>
              </Table>
            </div>
          ) : null}
        </Card>
      </div>

      <RestoreDialog
        backup={restoring}
        onClose={() => setRestoring(null)}
        onDone={async () => {
          await Promise.all([backups.reload(), counts.reload()]);
        }}
      />
    </>
  );
}

function RestoreDialog({ backup, onClose, onDone }: { backup: BackupFile | null; onClose: () => void; onDone: () => Promise<void> }) {
  const toast = useToast();
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ok = typed === "RESTORE";

  const close = () => {
    if (busy) return;
    setTyped("");
    setError(null);
    onClose();
  };

  const restore = async () => {
    if (!backup || !ok) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<{ rows: number }>(`/admin/backups/${encodeURIComponent(backup.file)}/restore`, { confirm: "RESTORE" }, { outletId: null });
      toast(`Restored ${r.rows.toLocaleString("en-IN")} rows from backup`, "success");
      setTyped("");
      onClose();
      await onDone();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={!!backup}
      onClose={close}
      dismissible={!busy}
      size="md"
      title={
        <span className="flex items-center gap-2 text-red-600 dark:text-red-300">
          <WarningOctagon size={24} weight="fill" /> Restore backup
        </span>
      }
      footer={
        <>
          <Button variant="ghost" onClick={close} disabled={busy}>
            Cancel
          </Button>
          <Button variant="danger" onClick={restore} loading={busy} disabled={!ok}>
            Erase & restore
          </Button>
        </>
      }
    >
      {backup && (
        <div className="space-y-4">
          <Alert>
            This <b>permanently erases every table</b> — orders, bills, payments, staff, menu, inventory — and replaces them with the snapshot from{" "}
            <b>{formatDateTime(backup.createdAt)}</b>. Anything recorded after that moment is lost. All users at every outlet are affected, and the POS will
            show the old data immediately.
          </Alert>
          <ul className="list-disc space-y-1 pl-5 text-sm text-muted">
            <li>Take a fresh backup first (“Back up now”) so you can undo this.</li>
            <li>Ask cashiers to stop billing until the restore finishes.</li>
            <li>The restore refuses to run if the backup was taken on a different database version.</li>
          </ul>
          <p className="break-all rounded-lg bg-surface-2 px-3 py-2 font-mono text-xs">{backup.file}</p>
          {error && <Alert>{error}</Alert>}
          <Input
            label={
              <>
                Type <span className="font-mono font-bold">RESTORE</span> to confirm
              </>
            }
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            autoComplete="off"
            spellCheck={false}
            data-autofocus
          />
        </div>
      )}
    </Dialog>
  );
}
