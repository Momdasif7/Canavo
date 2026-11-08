"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Archive, ArrowCounterClockwise, ArrowLeft, FloppyDisk, Key, Pause, Play, UserPlus } from "@phosphor-icons/react";
import { businessUpdateSchema, type ModuleKey } from "@canavo/shared";
import { errorMessage } from "@/lib/api";
import { formatDate } from "@/lib/format";
import { platformApi } from "@/lib/platform";
import type { BusinessDetail, BusinessOwner } from "@/lib/types-platform";
import { useApiQuery } from "@/hooks/useApiQuery";
import { useSession } from "@/components/providers/SessionProvider";
import { canManagePlatform } from "@/lib/roles";
import { useToast } from "@/components/providers/ToastProvider";
import { PageContainer, PageHeader } from "@/components/layout/PageHeader";
import { Card, CardHeader } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { Toggle, Input, Textarea } from "@/components/ui/Input";
import { Table, THead, Th, Td } from "@/components/ui/Table";
import { Alert, EmptyState, ErrorState, LoadingState } from "@/components/ui/States";
import { BusinessStatusBadge, ModuleChips, ModulePicker } from "@/components/platform/modules";
import { AddOwnerDialog, SendResetLinkDialog } from "@/components/platform/OwnerDialogs";

type BusinessMeta = Pick<BusinessDetail, "id" | "name" | "legalName" | "phone" | "email" | "notes" | "status" | "modules" | "createdAt" | "updatedAt"> & {
  features?: BusinessDetail["features"];
};

export default function BusinessDetailPage() {
  const { id } = useParams<{ id: string }>();
  const toast = useToast();
  const { me } = useSession();
  // Platform support users see everything here read-only (Phase 4.2).
  const readOnly = !canManagePlatform(me);
  const detail = useApiQuery<BusinessDetail>(`platform-business:${id}`, () => platformApi.get<BusinessDetail>(`/platform/businesses/${id}`));
  const [statusOpen, setStatusOpen] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [restoreOpen, setRestoreOpen] = useState(false);
  const [confirmName, setConfirmName] = useState("");
  const [creating, setCreating] = useState(false);
  const [resetting, setResetting] = useState<BusinessOwner | null>(null);
  const [resetting2fa, setResetting2fa] = useState<BusinessOwner | null>(null);
  const b = detail.data;

  /** Merge a PATCH response (business columns only) into the loaded detail. */
  const applyUpdate = (u: BusinessMeta) => detail.setData((d) => (d ? { ...d, ...u } : d));

  if (detail.loading && !b) return <LoadingState />;
  if (detail.error || !b) return <ErrorState message={detail.error ?? "Business not found"} onRetry={detail.reload} />;

  const suspended = b.status === "SUSPENDED";
  const archived = b.status === "ARCHIVED";

  const toggleStatus = async () => {
    const updated = await platformApi.patch<BusinessMeta>(`/platform/businesses/${b.id}`, { status: suspended ? "ACTIVE" : "SUSPENDED" });
    applyUpdate(updated);
    toast(suspended ? `${b.name} reactivated` : `${b.name} suspended — everyone was signed out`, "success");
  };

  return (
    <PageContainer>
      <Link data-nav="back" href="/platform/businesses" className="mb-3 inline-flex items-center gap-1 text-sm font-semibold text-muted hover:text-fg">
        <ArrowLeft size={16} /> Businesses
      </Link>
      <PageHeader
        title={b.name}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <BusinessStatusBadge status={b.status} />
            <span>
              {b.outlets.length} outlet{b.outlets.length === 1 ? "" : "s"} · {b.owners.length} owner{b.owners.length === 1 ? "" : "s"} · client since {formatDate(b.createdAt)}
            </span>
          </span>
        }
        actions={
          readOnly ? undefined : archived ? (
            <Button variant="secondary" icon={<ArrowCounterClockwise size={20} />} onClick={() => setRestoreOpen(true)}>
              Restore
            </Button>
          ) : (
            <span className="flex flex-wrap gap-2">
              <Button variant={suspended ? "secondary" : "danger"} icon={suspended ? <Play size={20} /> : <Pause size={20} />} onClick={() => setStatusOpen(true)}>
                {suspended ? "Reactivate" : "Suspend"}
              </Button>
              <Button
                variant="secondary"
                icon={<Archive size={20} />}
                onClick={() => {
                  setConfirmName("");
                  setArchiveOpen(true);
                }}
              >
                Archive
              </Button>
            </span>
          )
        }
      />
      {archived && (
        <div className="mb-5">
          <Alert tone="warning">
            Archived {b.archivedAt ? formatDate(b.archivedAt) : ""}
            {b.archiveReason ? ` (${b.archiveReason})` : ""}. Nobody in this business can sign in. Its records are kept
            {b.deleteAfter ? ` until at least ${formatDate(b.deleteAfter)}` : ""} for GST and income-tax retention.
          </Alert>
        </div>
      )}
      {suspended && (
        <div className="mb-5">
          <Alert tone="warning">This business is suspended. Its users can&apos;t sign in and its outlets can&apos;t bill until you reactivate it.</Alert>
        </div>
      )}

      <div className="grid gap-5 xl:grid-cols-[1fr_440px]">
        <div className="space-y-5">
          <ModulesCard business={b} onSaved={applyUpdate} readOnly={readOnly} />
          <FeaturesCard business={b} onSaved={applyUpdate} readOnly={readOnly} />
          <OwnersCard business={b} onCreate={() => setCreating(true)} onReset={setResetting} onReset2fa={setResetting2fa} readOnly={readOnly} />
        </div>
        <div className="space-y-5">
          <DetailsCard business={b} onSaved={applyUpdate} readOnly={readOnly} />
          <OutletsCard business={b} />
        </div>
      </div>

      <ConfirmDialog
        open={statusOpen}
        onClose={() => setStatusOpen(false)}
        title={suspended ? `Reactivate ${b.name}?` : `Suspend ${b.name}?`}
        description={
          suspended
            ? "Users can sign in again and outlets can resume billing."
            : "Everyone in this business is signed out immediately and can't sign in until you reactivate it. Their data is kept."
        }
        confirmLabel={suspended ? "Reactivate" : "Suspend & sign everyone out"}
        tone={suspended ? "primary" : "danger"}
        onConfirm={async () => {
          try {
            await toggleStatus();
          } catch (e) {
            throw new Error(errorMessage(e));
          }
        }}
      />
      <ConfirmDialog
        open={archiveOpen}
        onClose={() => setArchiveOpen(false)}
        title={`Archive ${b.name}?`}
        description={
          <span className="block space-y-3">
            <span className="block">
              For a business that has left CANAVO. Everyone is signed out and can&apos;t sign in, and its storefront and scheduled jobs stop. Ask the owner
              to export their data (Settings → Data export) first. Records are kept for the statutory retention period and can be restored.
            </span>
            <Input label="Type the business name to confirm" value={confirmName} onChange={(e) => setConfirmName(e.target.value)} placeholder={b.name} />
          </span>
        }
        confirmLabel="Archive & sign everyone out"
        tone="danger"
        reason={{ label: "Reason", placeholder: "e.g. Contract ended", minLength: 3, required: true }}
        onConfirm={async (reason) => {
          try {
            const updated = await platformApi.post<Partial<BusinessMeta>>(`/platform/businesses/${b.id}/archive`, { confirmName, reason });
            detail.setData((d) => (d ? { ...d, ...updated } : d));
            toast(`${b.name} archived — everyone was signed out`, "success");
          } catch (e) {
            throw new Error(errorMessage(e));
          }
        }}
      />
      <ConfirmDialog
        open={restoreOpen}
        onClose={() => setRestoreOpen(false)}
        title={`Restore ${b.name}?`}
        description="The business becomes active again and its users can sign in with their existing passwords."
        confirmLabel="Restore"
        tone="primary"
        onConfirm={async () => {
          try {
            const updated = await platformApi.post<Partial<BusinessMeta>>(`/platform/businesses/${b.id}/restore`, {});
            detail.setData((d) => (d ? { ...d, ...updated } : d));
            toast(`${b.name} restored`, "success");
          } catch (e) {
            throw new Error(errorMessage(e));
          }
        }}
      />
      <AddOwnerDialog
        open={creating}
        businessId={b.id}
        businessName={b.name}
        onClose={() => setCreating(false)}
        onCreated={(u) => {
          toast(`Owner ${u.name} added`, "success");
          void detail.reload();
        }}
      />
      <SendResetLinkDialog businessId={b.id} owner={resetting} onClose={() => setResetting(null)} />
      <ConfirmDialog
        open={resetting2fa !== null}
        title="Reset two-step login"
        description={
          resetting2fa
            ? `Only when ${resetting2fa.name} has lost both their phone and their recovery codes. Their two-step login is turned off and they're signed out everywhere; they sign in with their password and can turn it on again.`
            : undefined
        }
        confirmLabel="Reset two-step login"
        onClose={() => setResetting2fa(null)}
        onConfirm={async () => {
          try {
            await platformApi.post(`/platform/businesses/${b.id}/owners/${resetting2fa!.id}/reset-2fa`, {});
          } catch (e) {
            throw new Error(errorMessage(e));
          }
          toast(`Two-step login reset for ${resetting2fa!.name}`, "success");
          setResetting2fa(null);
          void detail.reload();
        }}
      />
    </PageContainer>
  );
}

function ModulesCard({ business, onSaved, readOnly }: { business: BusinessDetail; onSaved: (u: BusinessMeta) => void; readOnly: boolean }) {
  const toast = useToast();
  const [modules, setModules] = useState<ModuleKey[]>(business.modules);
  const [note, setNote] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setModules(business.modules), [business.modules]);
  const dirty = modules.join() !== business.modules.join();

  const save = async () => {
    if (!modules.length) return setError("Enable at least one module");
    setSaving(true);
    setError(null);
    try {
      const updated = await platformApi.patch<BusinessMeta>(`/platform/businesses/${business.id}`, { modules });
      onSaved(updated);
      setNote(null);
      toast("Modules saved — users see the change on their next reload", "success");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader
        title="Modules"
        subtitle="Features this business pays for. Turning one off hides it for every user immediately."
        action={
          readOnly ? undefined : <div className="flex gap-2">
            {dirty && (
              <Button variant="ghost" onClick={() => setModules(business.modules)} disabled={saving}>
                Reset
              </Button>
            )}
            <Button icon={<FloppyDisk size={20} />} onClick={save} loading={saving} disabled={!dirty}>
              Save modules
            </Button>
          </div>
        }
      />
      <div className="space-y-3 p-5">
        {error && <Alert>{error}</Alert>}
        {readOnly ? (
          <ModuleChips modules={business.modules} />
        ) : (
          <ModulePicker
            value={modules}
            note={note}
            onChange={(m, n) => {
              setModules(m);
              setNote(n);
            }}
          />
        )}
      </div>
    </Card>
  );
}

/** Per-hotel feature flags: new capabilities stay off until switched on here. */
function FeaturesCard({ business, onSaved, readOnly }: { business: BusinessDetail; onSaved: (u: BusinessMeta) => void; readOnly: boolean }) {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const entries = Object.entries(business.featureCatalog ?? {});
  if (!entries.length) return null;
  const flip = async (key: string, on: boolean) => {
    setBusy(key);
    try {
      const updated = await platformApi.patch<BusinessMeta>(`/platform/businesses/${business.id}`, { features: { [key]: on } });
      onSaved(updated);
      toast(`${business.featureCatalog[key]!.label} ${on ? "switched on" : "switched off"}`, "success");
    } catch (e) {
      toast(errorMessage(e), "error");
    } finally {
      setBusy(null);
    }
  };
  return (
    <Card>
      <CardHeader title="Feature switches" subtitle="New capabilities are off for existing hotels until you switch them on. A switch only works when its modules are enabled." />
      <ul className="divide-y divide-line">
        {entries.map(([key, f]) => {
          const missing = f.requires.filter((m) => !business.modules.includes(m));
          const on = Boolean(business.features?.[key]);
          return (
            <li key={key} className="flex items-start justify-between gap-4 p-5">
              <div className="min-w-0">
                <p className="font-semibold">{f.label}</p>
                <p className="mt-0.5 text-sm text-muted">{f.description}</p>
                {missing.length > 0 && <p className="mt-1 text-xs font-semibold text-amber-700 dark:text-amber-300">Needs the {missing.join(", ")} module — no effect until it&apos;s enabled.</p>}
              </div>
              <Toggle checked={on} disabled={readOnly || busy === key} onChange={(v) => void flip(key, v)} label={f.label} />
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

function DetailsCard({ business, onSaved, readOnly }: { business: BusinessDetail; onSaved: (u: BusinessMeta) => void; readOnly: boolean }) {
  const toast = useToast();
  const init = () => ({
    name: business.name,
    legalName: business.legalName ?? "",
    phone: business.phone ?? "",
    email: business.email ?? "",
    notes: business.notes ?? "",
  });
  const [form, setForm] = useState(init);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setForm({ name: business.name, legalName: business.legalName ?? "", phone: business.phone ?? "", email: business.email ?? "", notes: business.notes ?? "" });
  }, [business.name, business.legalName, business.phone, business.email, business.notes]);

  const original = init();
  const dirty = (Object.keys(form) as (keyof typeof form)[]).some((k) => form[k] !== original[k]);
  const set = (k: keyof typeof form, v: string) => setForm((f) => ({ ...f, [k]: v }));

  const save = async () => {
    const nul = (s: string) => (s.trim() ? s.trim() : null);
    const parsed = businessUpdateSchema.safeParse({
      name: form.name.trim(),
      legalName: nul(form.legalName),
      phone: nul(form.phone),
      email: nul(form.email),
      notes: nul(form.notes),
    });
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return setError(`${issue.path.join(".")}: ${issue.message}`);
    }
    setSaving(true);
    setError(null);
    try {
      onSaved(await platformApi.patch<BusinessMeta>(`/platform/businesses/${business.id}`, parsed.data));
      toast("Business details saved", "success");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader
        title="Details"
        action={
          readOnly ? undefined : <Button size="sm" icon={<FloppyDisk size={18} />} onClick={save} loading={saving} disabled={!dirty}>
            Save
          </Button>
        }
      />
      <fieldset disabled={readOnly} className="space-y-4 p-5">
        {error && <Alert>{error}</Alert>}
        <Input label="Business name" maxLength={120} value={form.name} onChange={(e) => set("name", e.target.value)} />
        <Input label="Legal name" maxLength={200} value={form.legalName} onChange={(e) => set("legalName", e.target.value)} />
        <div className="grid gap-4 sm:grid-cols-2">
          <Input label="Phone" maxLength={20} value={form.phone} onChange={(e) => set("phone", e.target.value)} />
          <Input label="Email" type="email" value={form.email} onChange={(e) => set("email", e.target.value)} />
        </div>
        <Textarea label="Notes (internal)" maxLength={1000} value={form.notes} onChange={(e) => set("notes", e.target.value)} />
      </fieldset>
    </Card>
  );
}

function OutletsCard({ business }: { business: BusinessDetail }) {
  return (
    <Card>
      <CardHeader title="Outlets" subtitle="Owners add outlets from their Outlets screen." />
      {business.outlets.length === 0 ? (
        <EmptyState title="No outlets yet" description="The owner adds outlets from their own login." />
      ) : (
        <ul className="divide-y divide-line">
          {business.outlets.map((o) => (
            <li key={o.id} className="px-5 py-3">
              <p className="font-semibold">{o.name}</p>
              <p className="truncate text-xs text-muted">{o.address || "No address"}</p>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function OwnersCard({
  business,
  onCreate,
  onReset,
  onReset2fa,
  readOnly,
}: {
  business: BusinessDetail;
  onCreate: () => void;
  onReset: (o: BusinessOwner) => void;
  onReset2fa: (o: BusinessOwner) => void;
  readOnly: boolean;
}) {
  return (
    <Card>
      <CardHeader
        title="Owners"
        subtitle="The owner creates managers, cashiers, kitchen, delivery and inventory staff from their own login."
        action={
          readOnly ? undefined : (
            <Button icon={<UserPlus size={20} />} onClick={onCreate}>
              Add owner
            </Button>
          )
        }
      />
      {business.owners.length === 0 ? (
        <EmptyState title="No owner yet" description="Add an owner so the business can sign in." />
      ) : (
        <Table>
          <THead>
            <tr>
              <Th>Name</Th>
              <Th>Status</Th>
              <Th>Since</Th>
              {!readOnly && <Th className="text-right">Actions</Th>}
            </tr>
          </THead>
          <tbody>
            {business.owners.map((u) => (
              <tr key={u.id}>
                <Td>
                  <p className="font-semibold">{u.name}</p>
                  <p className="text-xs text-muted">
                    +91 {u.phone}
                    {u.email && ` · ${u.email}`}
                  </p>
                </Td>
                <Td>
                  <div className="flex flex-wrap gap-1">
                    <Badge tone={u.status === "ACTIVE" ? "success" : "neutral"}>{u.status.toLowerCase()}</Badge>
                    {u.totpEnabledAt && <Badge tone="info">2-step on</Badge>}
                  </div>
                </Td>
                <Td className="whitespace-nowrap text-muted">{formatDate(u.createdAt)}</Td>
                {!readOnly && (
                  <Td className="text-right">
                    <div className="flex flex-wrap justify-end gap-2">
                      {u.totpEnabledAt && (
                        <Button size="sm" variant="ghost" onClick={() => onReset2fa(u)}>
                          Reset 2-step
                        </Button>
                      )}
                      <Button size="sm" variant="outline" icon={<Key size={18} />} onClick={() => onReset(u)}>
                        Send reset link
                      </Button>
                    </div>
                  </Td>
                )}
              </tr>
            ))}
          </tbody>
        </Table>
      )}
    </Card>
  );
}
