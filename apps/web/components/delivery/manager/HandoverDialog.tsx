"use client";

import { useEffect, useState } from "react";
import { formatINR } from "@canavo/shared";
import { api, errorMessage } from "@/lib/api";
import { parseRupees, rupeesInput } from "@/lib/format";
import type { CashHandover, HandoverResult } from "@/lib/types-delivery";
import { useToast } from "@/components/providers/ToastProvider";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Input, Select, Textarea } from "@/components/ui/Input";
import { Alert } from "@/components/ui/States";

export interface PartnerOption {
  id: string;
  name: string;
  /** Cash the partner holds now (paise) — prefills the amount */
  balance: number;
}

const pad = (n: number) => String(n).padStart(2, "0");
/** ISO → value for <input type="datetime-local"> (device local time). */
export function toLocalInput(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Record cash received from a partner (any amount — partial is fine), or
 * correct an existing entry (`editing`). Shows API warnings (e.g. more than held).
 */
export function HandoverDialog({
  open,
  partners,
  agentId,
  editing,
  onClose,
  onSaved,
}: {
  open: boolean;
  partners: PartnerOption[];
  /** Preselected partner for a new entry */
  agentId?: string | null;
  editing?: CashHandover | null;
  onClose: () => void;
  onSaved: (res: { balance: number; agentId: string }) => void;
}) {
  const toast = useToast();
  const [agent, setAgent] = useState("");
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [when, setWhen] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[] | null>(null);

  const balanceOf = (id: string) => partners.find((p) => p.id === id)?.balance ?? 0;

  useEffect(() => {
    if (!open) return;
    setError(null);
    setWarnings(null);
    setBusy(false);
    if (editing) {
      setAgent(editing.agentId);
      setAmount(rupeesInput(editing.amount));
      setNote(editing.note ?? "");
      setWhen(toLocalInput(editing.receivedAt));
    } else {
      const id = agentId ?? partners.find((p) => p.balance > 0)?.id ?? partners[0]?.id ?? "";
      setAgent(id);
      const bal = partners.find((p) => p.id === id)?.balance ?? 0;
      setAmount(bal > 0 ? rupeesInput(bal) : "");
      setNote("");
      setWhen("");
    }
    // Only when the dialog opens: don't clobber what the manager typed when the list refreshes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, editing, agentId]);

  const paise = parseRupees(amount);
  const valid = !!agent && paise != null && paise > 0;
  const partnerName = partners.find((p) => p.id === agent)?.name ?? editing?.agent?.name ?? "partner";

  const save = async () => {
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    try {
      const receivedAt = when ? new Date(when).toISOString() : undefined;
      const res = editing
        ? await api.patch<HandoverResult>(`/delivery/cash/handovers/${editing.id}`, { amount: paise, note: note.trim() || null, ...(receivedAt && { receivedAt }) })
        : await api.post<HandoverResult>("/delivery/cash/handovers", { agentId: agent, amount: paise, ...(note.trim() && { note: note.trim() }), ...(receivedAt && { receivedAt }) });
      toast(
        editing
          ? `Handover updated · ${partnerName} now holds ${formatINR(Math.max(0, res.balance))}`
          : `Received ${formatINR(paise!)} from ${partnerName} · ${res.balance > 0 ? `${formatINR(res.balance)} still to receive` : "all cash received"}`,
        "success",
      );
      onSaved({ balance: res.balance, agentId: agent });
      if (res.warnings?.length) setWarnings(res.warnings);
      else onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const bal = balanceOf(agent);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      dismissible={!busy}
      title={editing ? "Edit cash handover" : "Record cash received"}
      description={editing ? `Correct the entry for ${partnerName}` : "Count the cash first. Partial amounts are fine."}
      footer={
        warnings ? (
          <Button onClick={onClose}>Done</Button>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" form="handover-form" loading={busy} disabled={!valid} data-testid="handover-save">
              {editing ? "Save changes" : paise ? `Record ${formatINR(paise)}` : "Record"}
            </Button>
          </>
        )
      }
    >
      {warnings ? (
        <div className="space-y-2" data-testid="handover-warnings">
          {warnings.map((w) => (
            <Alert key={w} tone="warning">
              {w}
            </Alert>
          ))}
          <p className="text-sm text-muted">The handover was saved. Edit or delete it from the history if it was a mistake.</p>
        </div>
      ) : (
        <form
          id="handover-form"
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          {error && <Alert>{error}</Alert>}
          <Select
            label="Delivery partner"
            value={agent}
            disabled={!!editing}
            onChange={(e) => {
              setAgent(e.target.value);
              const b = balanceOf(e.target.value);
              setAmount(b > 0 ? rupeesInput(b) : "");
            }}
          >
            {editing && !partners.some((p) => p.id === editing.agentId) && <option value={editing.agentId}>{editing.agent?.name ?? "Partner"}</option>}
            {partners.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} · holds {formatINR(p.balance)}
              </option>
            ))}
          </Select>
          <Input
            label="Amount received (₹)"
            inputMode="decimal"
            prefix="₹"
            value={amount}
            onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ""))}
            hint={!editing && bal > 0 ? `${partnerName} holds ${formatINR(bal)} now` : undefined}
            className="tabular text-lg font-bold"
            data-autofocus
            data-testid="handover-amount"
          />
          <Textarea label="Note (optional)" placeholder="e.g. Evening handover, ₹500 notes" value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} />
          <Input
            type="datetime-local"
            label="Received at (optional)"
            hint={editing ? "Change only to correct the time" : "Leave empty for now. Set it to record an earlier handover."}
            value={when}
            max={toLocalInput(new Date().toISOString())}
            onChange={(e) => setWhen(e.target.value)}
          />
        </form>
      )}
    </Dialog>
  );
}
