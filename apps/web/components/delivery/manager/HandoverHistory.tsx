"use client";

import { PencilSimple, Receipt, Trash } from "@phosphor-icons/react";
import { useState } from "react";
import { formatINR } from "@canavo/shared";
import { api } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import type { CashHandover } from "@/lib/types-delivery";
import { useToast } from "@/components/providers/ToastProvider";
import { IconButton } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { ErrorState, LoadingState } from "@/components/ui/States";
import type { QueryState } from "@/hooks/useApiQuery";

/** Handover entries with edit / delete for corrections. */
export function HandoverHistory({
  q,
  onEdit,
  onChanged,
}: {
  q: QueryState<CashHandover[]>;
  onEdit: (h: CashHandover) => void;
  onChanged: () => void;
}) {
  const toast = useToast();
  const [deleting, setDeleting] = useState<CashHandover | null>(null);

  if (q.loading && !q.data) return <LoadingState label="Loading handovers…" />;
  if (q.error && !q.data) return <ErrorState message={q.error} onRetry={q.reload} />;
  const list = q.data ?? [];

  return (
    <>
      {list.length === 0 ? (
        <p className="px-5 py-8 text-center text-sm text-muted">No cash recorded in this period.</p>
      ) : (
        <ul className="divide-y divide-line" data-testid="manager-handovers">
          {list.map((h) => (
            <li key={h.id} className="flex items-center gap-3 px-4 py-2.5" data-testid="manager-handover">
              <span className="hidden h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-secondary-50 text-secondary dark:bg-secondary/25 dark:text-green-300 sm:flex">
                <Receipt size={22} />
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate font-semibold">
                  {h.agent?.name ?? "Partner"} <span className="font-normal text-muted">→ {h.receivedBy?.name ?? "outlet"}</span>
                </p>
                <p className="truncate text-xs text-muted">
                  {formatDateTime(h.receivedAt)}
                  {h.note ? ` · ${h.note}` : ""}
                </p>
              </div>
              <span className="tabular font-extrabold">{formatINR(h.amount)}</span>
              <IconButton label={`Edit handover of ${formatINR(h.amount)}`} onClick={() => onEdit(h)}>
                <PencilSimple size={20} />
              </IconButton>
              <IconButton label={`Delete handover of ${formatINR(h.amount)}`} className="text-red-600 dark:text-red-300" onClick={() => setDeleting(h)}>
                <Trash size={20} />
              </IconButton>
            </li>
          ))}
        </ul>
      )}
      <ConfirmDialog
        open={!!deleting}
        title={deleting ? `Delete ${formatINR(deleting.amount)} handover from ${deleting.agent?.name ?? "partner"}?` : ""}
        description="Use this only to undo a mistake. The amount goes back to the partner's cash to hand over."
        confirmLabel="Delete entry"
        onClose={() => setDeleting(null)}
        onConfirm={async () => {
          if (!deleting) return;
          const res = await api.del<{ balance: number }>(`/delivery/cash/handovers/${deleting.id}`);
          toast(`Entry deleted · ${deleting.agent?.name ?? "Partner"} now holds ${formatINR(Math.max(0, res.balance))}`, "success");
          onChanged();
        }}
      />
    </>
  );
}
