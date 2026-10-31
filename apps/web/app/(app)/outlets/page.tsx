"use client";

import { useEffect, useState } from "react";
import { ArrowsLeftRight, Plus, Storefront } from "@phosphor-icons/react";
import { outletSchema } from "@canavo/shared";
import { api, errorMessage } from "@/lib/api";
import type { Outlet } from "@/lib/types";
import { useApiQuery } from "@/hooks/useApiQuery";
import { useSession } from "@/components/providers/SessionProvider";
import { useToast } from "@/components/providers/ToastProvider";
import { PageContainer, PageHeader } from "@/components/layout/PageHeader";
import { SettingsTabs } from "@/components/settings/SettingsTabs";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Input, Textarea, Toggle } from "@/components/ui/Input";
import { Table, THead, Th, Td } from "@/components/ui/Table";
import { Alert, EmptyState, ErrorState, LoadingState } from "@/components/ui/States";

/** Business owners (outlet:manage): every outlet of the business, and add new ones. */
export default function OutletsPage() {
  const { me, outletId, setOutlet, can } = useSession();
  const toast = useToast();
  const businessKey = me?.business?.id ?? "none";
  const outlets = useApiQuery<Outlet[]>(`outlets:${businessKey}`, () => api.get<Outlet[]>("/outlets"));
  const [creating, setCreating] = useState(false);

  const switchTo = async (o: Outlet) => {
    try {
      await setOutlet(o.id);
      toast(`Now working in ${o.name}`, "success");
    } catch (e) {
      toast(errorMessage(e), "error");
    }
  };

  const list = outlets.data ?? [];

  return (
    <PageContainer>
      <PageHeader
        title="Outlets"
        subtitle={me?.business ? `${me.business.name} · ${list.length} outlet${list.length === 1 ? "" : "s"}` : undefined}
        actions={
          can("outlet:manage") && (
            <Button icon={<Plus size={20} />} onClick={() => setCreating(true)}>
              New outlet
            </Button>
          )
        }
      />
      <SettingsTabs />
      <Card>
        {outlets.loading && !outlets.data ? (
          <LoadingState />
        ) : outlets.error ? (
          <ErrorState message={outlets.error} onRetry={outlets.reload} />
        ) : list.length === 0 ? (
          <EmptyState title="No outlets yet" description="Add your first outlet to start billing." />
        ) : (
          <Table>
            <THead>
              <tr>
                <Th>Outlet</Th>
                <Th>State</Th>
                <Th>GST</Th>
                <Th>Invoice prefix</Th>
                <Th />
              </tr>
            </THead>
            <tbody>
              {list.map((o) => (
                <tr key={o.id}>
                  <Td>
                    <p className="flex items-center gap-2 font-semibold">
                      {o.name}
                      {o.id === outletId && <Badge tone="primary">Current</Badge>}
                    </p>
                    <p className="max-w-[380px] truncate text-xs text-muted">{o.address || "No address"}</p>
                  </Td>
                  <Td className="tabular">{o.stateCode}</Td>
                  <Td>
                    {o.gstEnabled === false ? (
                      <Badge>Not registered</Badge>
                    ) : (
                      <span className="flex flex-col">
                        <Badge tone="success" className="w-fit">
                          GST registered
                        </Badge>
                        {o.gstin && <span className="tabular mt-0.5 text-xs text-muted">{o.gstin}</span>}
                      </span>
                    )}
                  </Td>
                  <Td className="tabular">{o.invoicePrefix}</Td>
                  <Td className="text-right">
                    {o.id !== outletId && me?.outlets.some((x) => x.id === o.id) && (
                      <Button variant="outline" size="sm" icon={<ArrowsLeftRight size={18} />} onClick={() => void switchTo(o)}>
                        Switch
                      </Button>
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
      <OutletCreateDialog
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={async () => {
          await outlets.reload();
        }}
      />
    </PageContainer>
  );
}

interface FormState {
  name: string;
  address: string;
  phone: string;
  stateCode: string;
  gstEnabled: boolean;
  legalName: string;
  gstin: string;
  invoicePrefix: string;
}

const blank: FormState = { name: "", address: "", phone: "", stateCode: "", gstEnabled: true, legalName: "", gstin: "", invoicePrefix: "INV" };

function OutletCreateDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: () => Promise<void> }) {
  const { refreshMe, setOutlet, outlet: current } = useSession();
  const toast = useToast();
  const [form, setForm] = useState<FormState>(blank);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<Outlet | null>(null);

  useEffect(() => {
    if (!open) return;
    setForm({ ...blank, stateCode: current?.stateCode ?? "" });
    setError(null);
    setCreated(null);
  }, [open, current?.stateCode]);

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setForm((f) => ({ ...f, [k]: v }));

  const save = async () => {
    const parsed = outletSchema.safeParse({
      name: form.name.trim(),
      address: form.address.trim(),
      phone: form.phone.trim() || undefined,
      stateCode: form.stateCode,
      gstin: form.gstEnabled ? form.gstin.trim() : "",
      invoicePrefix: form.invoicePrefix || "INV",
    });
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return setError(`${issue.path.join(".") || "Outlet"}: ${issue.message}`);
    }
    setSaving(true);
    setError(null);
    try {
      const outlet = await api.post<Outlet>("/outlets", { ...parsed.data, gstEnabled: form.gstEnabled, legalName: form.legalName.trim() || undefined });
      await Promise.all([onCreated(), refreshMe()]);
      setCreated(outlet);
      toast(`${outlet.name} created`, "success");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  if (created) {
    return (
      <Dialog
        open={open}
        onClose={onClose}
        size="sm"
        title="Outlet created"
        footer={
          <>
            <Button variant="ghost" onClick={onClose}>
              Stay here
            </Button>
            <Button
              icon={<ArrowsLeftRight size={18} />}
              onClick={async () => {
                try {
                  await setOutlet(created.id);
                  onClose();
                } catch (e) {
                  toast(errorMessage(e), "error");
                }
              }}
            >
              Switch to {created.name}
            </Button>
          </>
        }
      >
        <div className="flex items-start gap-3 text-sm">
          <Storefront size={32} className="shrink-0 text-secondary" weight="duotone" />
          <p>
            <b>{created.name}</b> is ready. Add its menu prices, staff and printer settings after switching to it.
          </p>
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      title="New outlet"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} loading={saving}>
            Create outlet
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {error && <Alert>{error}</Alert>}
        <div className="grid gap-4 sm:grid-cols-2">
          <Input label="Outlet name" maxLength={120} value={form.name} onChange={(e) => set("name", e.target.value)} placeholder="e.g. MG Road branch" data-autofocus />
          <Input label="Phone" maxLength={20} value={form.phone} onChange={(e) => set("phone", e.target.value)} />
        </div>
        <Textarea label="Address" maxLength={500} value={form.address} onChange={(e) => set("address", e.target.value)} />
        <div className="grid gap-4 sm:grid-cols-2">
          <Input
            label="State code"
            maxLength={2}
            inputMode="numeric"
            value={form.stateCode}
            onChange={(e) => set("stateCode", e.target.value.replace(/\D/g, ""))}
            hint="Two-digit GST state code, e.g. 29 Karnataka"
          />
          <Input
            label="Invoice prefix"
            maxLength={5}
            value={form.invoicePrefix}
            onChange={(e) => set("invoicePrefix", e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))}
            hint="e.g. MGR → MGR-2026-00001"
          />
        </div>
        <div className="rounded-xl border border-line p-4">
          <Toggle
            label="GST registered"
            description={form.gstEnabled ? "Bills are tax invoices with GST lines." : "Plain bills (“BILL”) with no tax and no GSTIN."}
            checked={form.gstEnabled}
            onChange={(v) => set("gstEnabled", v)}
          />
          {form.gstEnabled && (
            <div className="mt-3 grid gap-4 sm:grid-cols-2">
              <Input label="GSTIN" maxLength={15} value={form.gstin} onChange={(e) => set("gstin", e.target.value.toUpperCase().replace(/[^0-9A-Z]/g, ""))} placeholder="29ABCDE1234F1Z5" />
              <Input label="Legal name" maxLength={200} value={form.legalName} onChange={(e) => set("legalName", e.target.value)} hint="Printed on tax invoices" />
            </div>
          )}
        </div>
      </div>
    </Dialog>
  );
}
