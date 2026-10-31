"use client";

import { useEffect, useState } from "react";
import { Dialog } from "./Dialog";
import { Button } from "./Button";
import { Textarea } from "./Input";
import { Alert } from "./States";

/**
 * Confirmation dialog with an optional free-text reason (void, cancel, reject…).
 * `onConfirm` may throw; the error is shown inline and the dialog stays open.
 */
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = "Confirm",
  tone = "danger",
  reason,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: React.ReactNode;
  description?: React.ReactNode;
  confirmLabel?: string;
  tone?: "danger" | "primary";
  /** Ask for a reason; `minLength` enforces a minimum (e.g. 3 to match the API) */
  reason?: { label: string; placeholder?: string; minLength?: number; required?: boolean };
  onConfirm: (reason: string) => Promise<void> | void;
  onClose: () => void;
}) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setText("");
      setError(null);
      setBusy(false);
    }
  }, [open]);

  const min = reason?.minLength ?? 0;
  const invalid = !!reason && (reason.required ?? min > 0) && text.trim().length < Math.max(1, min);

  const confirm = async () => {
    if (busy || invalid) return;
    setBusy(true);
    setError(null);
    try {
      await onConfirm(text.trim());
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="sm"
      dismissible={!busy}
      title={title}
      description={description}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Back
          </Button>
          <Button variant={tone === "danger" ? "danger" : "primary"} onClick={confirm} loading={busy} disabled={invalid}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      {error && (
        <div className="mb-3">
          <Alert>{error}</Alert>
        </div>
      )}
      {reason ? (
        <Textarea
          label={reason.label}
          placeholder={reason.placeholder}
          value={text}
          maxLength={200}
          onChange={(e) => setText(e.target.value)}
          data-autofocus
        />
      ) : (
        !description && <p className="text-sm text-muted">Are you sure?</p>
      )}
    </Dialog>
  );
}
