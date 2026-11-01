"use client";

import { useEffect, useState } from "react";
import { platformUserCreateSchema } from "@canavo/shared";
import { errorMessage } from "@/lib/api";
import { platformApi } from "@/lib/platform";
import type { BusinessOwner, LinkDelivery } from "@/lib/types-platform";
import { LinkSentNotice } from "@/components/account/LinkSentNotice";

export { LinkSentNotice };
import { Dialog } from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Alert } from "@/components/ui/States";

interface OwnerForm {
  name: string;
  phone: string;
  email: string;
}

const EMPTY: OwnerForm = { name: "", phone: "", email: "" };

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
  const [invite, setInvite] = useState<LinkDelivery | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setForm(EMPTY);
    setInvite(null);
  }, [open]);

  const set = <K extends keyof OwnerForm>(k: K, v: OwnerForm[K]) => setForm((f) => ({ ...f, [k]: v }));

  const save = async () => {
    const parsed = platformUserCreateSchema.safeParse({
      name: form.name.trim(),
      phone: form.phone.trim(),
      email: form.email.trim() || undefined,
    });
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return setError(`${issue.path.join(".") || "Owner"}: ${issue.message}`);
    }
    if (!parsed.data.email) return setError("The owner signs in with an email address");
    setSaving(true);
    setError(null);
    try {
      const { name, phone, email } = parsed.data;
      const { invite: sent, ...user } = await platformApi.post<BusinessOwner & { invite: LinkDelivery }>(`/platform/businesses/${businessId}/users`, { name, phone, email });
      onCreated(user);
      setInvite(sent);
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
        invite ? (
          <Button onClick={onClose}>Done</Button>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button onClick={save} loading={saving}>
              Add owner
            </Button>
          </>
        )
      }
    >
      {invite ? (
        <LinkSentNotice delivery={invite} who={form.email || `+91 ${form.phone}`} />
      ) : (
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
        </div>
        <p className="text-xs text-muted">
          The owner gets a link by email (or SMS) to set their own password; you never see it. Until then they can sign in with an OTP on their mobile. The owner creates managers, cashiers,
          kitchen, delivery and inventory staff from their own login.
        </p>
      </div>
      )}
    </Dialog>
  );
}

/**
 * Platform admin: send a locked-out owner a password reset link. The platform never sets or
 * sees the password; the owner's sessions end when they set the new one.
 */
export function SendResetLinkDialog({ businessId, owner, onClose }: { businessId: string; owner: BusinessOwner | null; onClose: () => void }) {
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<LinkDelivery | null>(null);

  useEffect(() => {
    setError(null);
    setSent(null);
  }, [owner]);

  const send = async () => {
    if (!owner) return;
    setSending(true);
    setError(null);
    try {
      setSent(await platformApi.post<LinkDelivery>(`/platform/businesses/${businessId}/owners/${owner.id}/reset-link`, {}));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSending(false);
    }
  };

  return (
    <Dialog
      open={owner !== null}
      onClose={onClose}
      size="sm"
      title="Send password reset link"
      description={owner ? `${owner.name} gets a one-time link to set a new password. You never see it.` : undefined}
      footer={
        sent ? (
          <Button onClick={onClose}>Done</Button>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button onClick={send} loading={sending}>
              Send link
            </Button>
          </>
        )
      }
    >
      <div className="space-y-4">
        {error && <Alert>{error}</Alert>}
        {sent && owner ? (
          <LinkSentNotice delivery={sent} who={owner.email ?? owner.phone} />
        ) : (
          <p className="text-sm text-muted">
            The link goes to the owner&apos;s email ({owner?.email ?? "none"}) or, without email, by SMS to +91 {owner?.phone}. It expires in 30 minutes. When they set the new password,
            they&apos;re signed out on every other device.
          </p>
        )}
      </div>
    </Dialog>
  );
}
