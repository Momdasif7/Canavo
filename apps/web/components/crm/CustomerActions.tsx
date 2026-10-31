"use client";

import { useCallback, useEffect, useState } from "react";
import { KHATA_SETTLE_MODES, formatINR, khataSettleSchema, loyaltyAdjustSchema } from "@canavo/shared";
import { api, errorMessage } from "@/lib/api";
import { openPendingTab } from "@/lib/download";
import { parseRupees, rupeesInput, titleCase } from "@/lib/format";
import type { KhataRemindResult, KhataSettleResult, LoyaltyAdjustResult } from "@/lib/types-crm";
import { useToast } from "@/components/providers/ToastProvider";
import { Dialog } from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { Input, Select, Textarea } from "@/components/ui/Input";
import { Alert } from "@/components/ui/States";
import { decimalOnly, issuesToErrors, signedDigits } from "./shared";

/** Minimal customer info the action dialogs need. */
export interface CustomerRef {
  id: string;
  name: string | null;
  phone: string;
  khataBalance: number;
  points?: number;
}

const displayName = (c: CustomerRef) => c.name || `+91 ${c.phone}`;

// ---------- Settle khata ----------
export function SettleKhataDialog({
  customer,
  onClose,
  onSettled,
}: {
  customer: CustomerRef | null;
  onClose: () => void;
  onSettled: (r: KhataSettleResult) => void;
}) {
  const toast = useToast();
  const [amount, setAmount] = useState("");
  const [mode, setMode] = useState<(typeof KHATA_SETTLE_MODES)[number]>("CASH");
  const [note, setNote] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!customer) return;
    setAmount(rupeesInput(customer.khataBalance));
    setMode("CASH");
    setNote("");
    setErrors({});
    setError(null);
  }, [customer]);

  if (!customer) return null;

  const save = async () => {
    const paise = parseRupees(amount);
    if (paise === null || paise <= 0) return setErrors({ amount: "Enter an amount greater than ₹0" });
    if (paise > customer.khataBalance) return setErrors({ amount: `Cannot exceed the outstanding ${formatINR(customer.khataBalance)}` });
    const parsed = khataSettleSchema.safeParse({ amount: paise, mode, note: note.trim() || undefined });
    if (!parsed.success) return setErrors(issuesToErrors(parsed.error.issues));
    setErrors({});
    setSaving(true);
    setError(null);
    try {
      const r = await api.post<KhataSettleResult>(`/customers/${customer.id}/khata/settle`, parsed.data);
      toast(`${formatINR(paise)} received from ${displayName(customer)}`, "success");
      onSettled(r);
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      dismissible={!saving}
      title="Settle khata"
      description={`${displayName(customer)} owes ${formatINR(customer.khataBalance)}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button variant="secondary" onClick={save} loading={saving}>
            Record payment
          </Button>
        </>
      }
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        {error && <Alert>{error}</Alert>}
        <Input
          label="Amount received"
          inputMode="decimal"
          prefix="₹"
          value={amount}
          error={errors.amount}
          onChange={(e) => setAmount(decimalOnly(e.target.value))}
          data-autofocus
        />
        <div className="flex flex-wrap gap-2">
          {[0.25, 0.5, 1].map((f) => {
            const v = Math.round((customer.khataBalance * f) / 100) * 100 || customer.khataBalance;
            return (
              <Button key={f} size="sm" variant="outline" onClick={() => setAmount(rupeesInput(f === 1 ? customer.khataBalance : v))}>
                {f === 1 ? "Full" : `${f * 100}%`} · {formatINR(f === 1 ? customer.khataBalance : v)}
              </Button>
            );
          })}
        </div>
        <Select label="Payment mode" value={mode} error={errors.mode} onChange={(e) => setMode(e.target.value as typeof mode)}>
          {KHATA_SETTLE_MODES.map((m) => (
            <option key={m} value={m}>
              {m === "UPI" ? "UPI" : titleCase(m)}
            </option>
          ))}
        </Select>
        <Textarea label="Note (optional)" maxLength={200} value={note} error={errors.note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Paid at counter" />
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}

// ---------- Adjust points ----------
export function AdjustPointsDialog({
  customer,
  onClose,
  onAdjusted,
}: {
  customer: CustomerRef | null;
  onClose: () => void;
  onAdjusted: (r: LoyaltyAdjustResult) => void;
}) {
  const toast = useToast();
  const [points, setPoints] = useState("");
  const [note, setNote] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!customer) return;
    setPoints("");
    setNote("");
    setErrors({});
    setError(null);
  }, [customer]);

  if (!customer) return null;
  const current = customer.points ?? 0;
  const n = Number(points);
  const valid = points !== "" && points !== "-" && Number.isInteger(n);

  const save = async () => {
    const parsed = loyaltyAdjustSchema.safeParse({ points: valid ? n : NaN, note });
    if (!parsed.success) {
      const errs = issuesToErrors(parsed.error.issues);
      if (!valid) errs.points = "Enter a whole number, e.g. 50 or -20";
      return setErrors(errs);
    }
    if (current + parsed.data.points < 0) return setErrors({ points: `Customer has only ${current} points` });
    setErrors({});
    setSaving(true);
    setError(null);
    try {
      const r = await api.post<LoyaltyAdjustResult>(`/customers/${customer.id}/loyalty/adjust`, parsed.data);
      toast(`Points ${parsed.data.points > 0 ? "added" : "removed"} · new balance ${r.customer.points}`, "success");
      onAdjusted(r);
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      dismissible={!saving}
      title="Adjust points"
      description={`${displayName(customer)} has ${current} points`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={save} loading={saving}>
            Apply adjustment
          </Button>
        </>
      }
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        {error && <Alert>{error}</Alert>}
        <Input
          label="Points"
          hint={valid ? `New balance: ${current + n}` : "Positive adds points, negative removes them"}
          inputMode="numeric"
          placeholder="e.g. 50 or -20"
          value={points}
          error={errors.points}
          onChange={(e) => setPoints(signedDigits(e.target.value))}
          data-autofocus
        />
        <Textarea label="Reason" maxLength={200} value={note} error={errors.note} onChange={(e) => setNote(e.target.value)} placeholder="At least 3 characters, e.g. Goodwill for delayed order" />
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}

// ---------- Khata reminder ----------
/**
 * Sends a khata reminder. A blank tab is opened synchronously (so popup
 * blockers allow it) and navigated to the wa.me link when the API returns
 * `method: "link"`; it's closed again when WhatsApp sent it server-side.
 */
export function useKhataReminder() {
  const toast = useToast();
  const [sending, setSending] = useState<string | null>(null);
  const remind = useCallback(
    async (customer: CustomerRef) => {
      const tab = openPendingTab();
      setSending(customer.id);
      try {
        const r = await api.post<KhataRemindResult>(`/customers/${customer.id}/khata/remind`);
        if (r.method === "link" && r.waLink) {
          if (!tab.go(r.waLink)) toast("Allow pop-ups to open WhatsApp", "error");
          else toast("WhatsApp opened with the reminder", "info");
        } else {
          tab.cancel();
          toast(`Reminder sent to ${displayName(customer)} on WhatsApp`, "success");
        }
      } catch (e) {
        tab.cancel();
        toast(errorMessage(e), "error");
      } finally {
        setSending(null);
      }
    },
    [toast],
  );
  return { remind, sending };
}
