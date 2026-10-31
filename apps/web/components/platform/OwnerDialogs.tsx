"use client";

import { useEffect, useState } from "react";
import { ownerPasswordResetSchema, platformUserCreateSchema } from "@canavo/shared";
import { errorMessage } from "@/lib/api";
import { platformApi } from "@/lib/platform";
import type { BusinessOwner } from "@/lib/types-platform";
import { Dialog } from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Alert } from "@/components/ui/States";

interface OwnerForm {
  name: string;
  phone: string;
  email: string;
  password: string;
}

const EMPTY: OwnerForm = { name: "", phone: "", email: "", password: "" };

/**
 * Platform admin: add an owner login to a business (POST /platform/businesses/:id/users).
 * The platform creates owners only — owners create their managers and staff.
 */
export function AddOwnerDialog({
  open,
  businessId,
  businessName,
  onClose,
  onCreated,
}: {
  open: boolean;
  businessId: string;
  businessName: string;
  onClose: () => void;
  onCreated: (u: BusinessOwner) => void;
}) {
  const [form, setForm] = useState<OwnerForm>(EMPTY);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setForm(EMPTY);
  }, [open]);

  const set = <K extends keyof OwnerForm>(k: K, v: OwnerForm[K]) => setForm((f) => ({ ...f, [k]: v }));

  const save = async () => {
    const parsed = platformUserCreateSchema.safeParse({
      name: form.name.trim(),
      phone: form.phone.trim(),
      email: form.email.trim() || undefined,
      password: form.password || undefined,
    });
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return setError(`${issue.path.join(".") || "Owner"}: ${issue.message}`);
    }
    if (!parsed.data.email) return setError("The owner signs in with an email address");
    if (!parsed.data.password) return setError("Set a password so the owner can sign in");
    setSaving(true);
    setError(null);
    try {
      const { name, phone, email, password } = parsed.data;
      const user = await platformApi.post<BusinessOwner>(`/platform/businesses/${businessId}/users`, { name, phone, email, password });
      onCreated(user);
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Add owner"
      description={`New owner login for ${businessName}. Owners manage every outlet, staff account and setting of the business.`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} loading={saving}>
            Add owner
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {error && <Alert>{error}</Alert>}
        <div className="grid gap-4 sm:grid-cols-2">
          <Input label="Full name" maxLength={100} value={form.name} onChange={(e) => set("name", e.target.value)} />
          <Input
            label="Mobile"
            inputMode="numeric"
            maxLength={10}
            prefix={<span className="text-sm font-semibold">+91</span>}
            className="pl-12"
            value={form.phone}
            onChange={(e) => set("phone", e.target.value.replace(/\D/g, ""))}
          />
          <Input label="Email (login)" type="email" autoComplete="off" value={form.email} onChange={(e) => set("email", e.target.value)} />
          <Input label="Temporary password" type="password" autoComplete="new-password" placeholder="Min. 8 characters" value={form.password} onChange={(e) => set("password", e.target.value)} />
        </div>
        <p className="text-xs text-muted">The owner creates managers, cashiers, kitchen, delivery and inventory staff from their own login.</p>
      </div>
    </Dialog>
  );
}

/** Platform admin: set a new password for a locked-out owner (signs them out everywhere). */
export function ResetOwnerPasswordDialog({
  businessId,
  owner,
  onClose,
  onDone,
}: {
  businessId: string;
  owner: BusinessOwner | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setPassword("");
    setConfirm("");
    setError(null);
  }, [owner]);

  const save = async () => {
    if (!owner) return;
    const parsed = ownerPasswordResetSchema.safeParse({ password });
    if (!parsed.success) return setError(parsed.error.issues[0].message);
    if (password !== confirm) return setError("The passwords don't match");
    setSaving(true);
    setError(null);
    try {
      await platformApi.post<{ ok: true }>(`/platform/businesses/${businessId}/owners/${owner.id}/reset-password`, parsed.data);
      onDone();
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open={owner !== null}
      onClose={onClose}
      size="sm"
      title="Reset password"
      description={owner ? `Set a new password for ${owner.name}. They're signed out on every device and sign in again with it.` : undefined}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} loading={saving} disabled={!password || !confirm}>
            Reset password
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {error && <Alert>{error}</Alert>}
        <Input label="New password" type="password" autoComplete="new-password" placeholder="Min. 8 characters" value={password} onChange={(e) => setPassword(e.target.value)} />
        <Input label="Confirm password" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
      </div>
    </Dialog>
  );
}
