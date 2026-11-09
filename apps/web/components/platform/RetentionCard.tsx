"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { EnvelopeSimple, Trash } from "@phosphor-icons/react";
import { errorMessage } from "@/lib/api";
import { formatDate } from "@/lib/format";
import { platformApi } from "@/lib/platform";
import { useApiQuery } from "@/hooks/useApiQuery";
import { useToast } from "@/components/providers/ToastProvider";
import { Card, CardHeader } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Input } from "@/components/ui/Input";
import { Alert, LoadingState } from "@/components/ui/States";

interface PurgePreview {
  deleteAfter: string | null;
  finalExportAt: string | null;
  purgeFrom: string | null;
  canPurge: boolean;
  blockers: string[];
  tables: Record<string, number>;
  totalRows: number;
}

/**
 * P2 gap 8b: an archived business's retention — the owner's final export (emailed to the owners only)
 * and, once the retention date and the 30-day notice have passed, permanent deletion with typed confirmation.
 */
export function RetentionCard({ businessId, name, readOnly }: { businessId: string; name: string; readOnly: boolean }) {
  const toast = useToast();
  const router = useRouter();
  const preview = useApiQuery<PurgePreview>(`purge-preview:${businessId}`, () => platformApi.get<PurgePreview>(`/platform/businesses/${businessId}/purge-preview`));
  const [sending, setSending] = useState(false);
  const [open, setOpen] = useState(false);
  const [typedName, setTypedName] = useState("");
  const [typedDelete, setTypedDelete] = useState("");
  const p = preview.data;

  const sendExport = async () => {
    setSending(true);
    try {
      const r = await platformApi.post<{ sentTo: number }>(`/platform/businesses/${businessId}/final-export`, {});
      toast(r.sentTo ? `Final export link emailed to ${r.sentTo} owner${r.sentTo === 1 ? "" : "s"}` : "Export prepared, but no owner has an email address", r.sentTo ? "success" : "error");
      void preview.reload();
    } catch (e) {
      toast(errorMessage(e), "error");
    } finally {
      setSending(false);
    }
  };

  return (
    <Card>
      <CardHeader title="Retention and deletion" subtitle="Records are kept for GST and income-tax retention, then deleted permanently" />
      <div className="space-y-3 px-5 pb-5 text-sm">
        {!p ? (
          <LoadingState />
        ) : (
          <>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
              <dt className="text-muted">Keep until</dt>
              <dd>{p.deleteAfter ? formatDate(p.deleteAfter) : "—"}</dd>
              <dt className="text-muted">Final export</dt>
              <dd>{p.finalExportAt ? `Emailed to the owners ${formatDate(p.finalExportAt)}` : "Not offered yet (sent automatically 30 days before)"}</dd>
              <dt className="text-muted">Can be deleted from</dt>
              <dd>{p.purgeFrom ? formatDate(p.purgeFrom) : "—"}</dd>
              <dt className="text-muted">Rows</dt>
              <dd>{p.totalRows.toLocaleString("en-IN")}</dd>
            </dl>
            {!p.canPurge && (
              <ul className="list-disc space-y-0.5 pl-5 text-muted">
                {p.blockers.map((x) => (
                  <li key={x}>{x}</li>
                ))}
              </ul>
            )}
            {!readOnly && (
              <div className="flex flex-wrap gap-2 pt-1">
                <Button variant="secondary" icon={<EnvelopeSimple size={20} />} loading={sending} onClick={sendExport}>
                  {p.finalExportAt ? "Resend final export link" : "Email final export to owners"}
                </Button>
                <Button
                  variant="danger"
                  icon={<Trash size={20} />}
                  disabled={!p.canPurge}
                  onClick={() => {
                    setTypedName("");
                    setTypedDelete("");
                    setOpen(true);
                  }}
                >
                  Delete permanently
                </Button>
              </div>
            )}
          </>
        )}
      </div>
      {p && (
        <ConfirmDialog
          open={open}
          onClose={() => setOpen(false)}
          title={`Permanently delete ${name}?`}
          description={
            <span className="block space-y-3">
              <Alert tone="warning">
                This can&apos;t be undone. Every bill, menu item, customer, staff account and uploaded image of this business is deleted. Only a record that
                it existed (name hash, dates, row counts) is kept.
              </Alert>
              <span className="block max-h-40 overflow-auto rounded-xl border border-line p-2 text-xs">
                {Object.entries(p.tables)
                  .sort((a, b) => b[1] - a[1])
                  .map(([t, n]) => (
                    <span key={t} className="flex justify-between gap-4">
                      <span>{t}</span>
                      <span className="tabular-nums">{n.toLocaleString("en-IN")}</span>
                    </span>
                  ))}
              </span>
              <Input label="Type the business name" value={typedName} onChange={(e) => setTypedName(e.target.value)} placeholder={name} />
              <Input label="Type DELETE" value={typedDelete} onChange={(e) => setTypedDelete(e.target.value)} placeholder="DELETE" />
            </span>
          }
          confirmLabel="Delete permanently"
          tone="danger"
          onConfirm={async () => {
            try {
              await platformApi.post(`/platform/businesses/${businessId}/purge`, { confirmName: typedName, confirmText: typedDelete });
              toast(`${name} was deleted permanently`, "success");
              router.push("/platform/businesses");
            } catch (e) {
              throw new Error(errorMessage(e));
            }
          }}
        />
      )}
    </Card>
  );
}
