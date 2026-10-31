"use client";

import { useEffect, useState } from "react";
import { ShieldStar, UserPlus } from "@phosphor-icons/react";
import { platformAdminCreateSchema } from "@canavo/shared";
import { errorMessage } from "@/lib/api";
import { formatDate } from "@/lib/format";
import { platformApi } from "@/lib/platform";
import type { PlatformUser } from "@/lib/types-platform";
import { useApiQuery } from "@/hooks/useApiQuery";
import { useSession } from "@/components/providers/SessionProvider";
import { useToast } from "@/components/providers/ToastProvider";
import { PageContainer, PageHeader } from "@/components/layout/PageHeader";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Input } from "@/components/ui/Input";
import { Table, THead, Th, Td } from "@/components/ui/Table";
import { Alert, EmptyState, ErrorState, LoadingState } from "@/components/ui/States";

/** CANAVO operators (super admins outside any business). */
export default function PlatformAdminsPage() {
  const { me } = useSession();
  const toast = useToast();
  const admins = useApiQuery<PlatformUser[]>("platform-admins", () => platformApi.get<PlatformUser[]>("/platform/admins"));
  const [creating, setCreating] = useState(false);

  return (
    <PageContainer>
      <PageHeader
        title="Platform admins"
        subtitle="People who can onboard businesses, change modules and manage owner accounts. They never see hotel data."
        actions={
          <Button icon={<UserPlus size={20} />} onClick={() => setCreating(true)}>
            Add admin
          </Button>
        }
      />
      <Card>
        {admins.loading && !admins.data ? (
          <LoadingState />
        ) : admins.error ? (
          <ErrorState message={admins.error} onRetry={admins.reload} />
        ) : !admins.data?.length ? (
          <EmptyState title="No platform admins" />
        ) : (
          <Table>
            <THead>
              <tr>
                <Th>Name</Th>
                <Th>Email</Th>
                <Th>Phone</Th>
                <Th>Status</Th>
                <Th>Added</Th>
              </tr>
            </THead>
            <tbody>
              {admins.data.map((a) => (
                <tr key={a.id}>
                  <Td>
                    <span className="flex items-center gap-2 font-semibold">
                      <ShieldStar size={18} className="text-primary" weight="fill" />
                      {a.name}
                      {a.id === me?.id && <Badge tone="primary">You</Badge>}
                    </span>
                  </Td>
                  <Td className="text-muted">{a.email ?? "—"}</Td>
                  <Td className="tabular text-muted">+91 {a.phone}</Td>
                  <Td>
                    <Badge tone={a.status === "ACTIVE" ? "success" : "neutral"}>{a.status.toLowerCase()}</Badge>
                  </Td>
                  <Td className="whitespace-nowrap text-muted">{formatDate(a.createdAt)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
      <CreateAdminDialog
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(a) => {
          toast(`${a.name} can now sign in as a platform admin`, "success");
          void admins.reload();
        }}
      />
    </PageContainer>
  );
}

function CreateAdminDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (a: PlatformUser) => void }) {
  const [form, setForm] = useState({ name: "", phone: "", email: "", password: "" });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setForm({ name: "", phone: "", email: "", password: "" });
      setError(null);
    }
  }, [open]);

  const set = (k: keyof typeof form, v: string) => setForm((f) => ({ ...f, [k]: v }));

  const save = async () => {
    const parsed = platformAdminCreateSchema.safeParse({ name: form.name.trim(), phone: form.phone.trim(), email: form.email.trim(), password: form.password });
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return setError(`${issue.path.join(".")}: ${issue.message}`);
    }
    setSaving(true);
    setError(null);
    try {
      onCreated(await platformApi.post<PlatformUser>("/platform/admins", parsed.data));
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
      title="Add platform admin"
      description="Platform admins have full access to every business. Add only trusted CANAVO staff."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} loading={saving}>
            Add admin
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {error && <Alert>{error}</Alert>}
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
        <Input label="Email (login)" type="email" value={form.email} onChange={(e) => set("email", e.target.value)} />
        <Input label="Password" type="password" autoComplete="new-password" placeholder="Min. 8 characters" value={form.password} onChange={(e) => set("password", e.target.value)} />
      </div>
    </Dialog>
  );
}
