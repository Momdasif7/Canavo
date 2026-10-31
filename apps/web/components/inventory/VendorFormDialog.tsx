"use client";

import { useEffect, useState } from "react";
import { vendorSchema, vendorUpdateSchema, type VendorInput, type VendorUpdateInput } from "@canavo/shared";
import { api, errorMessage } from "@/lib/api";
import type { Vendor } from "@/lib/types-inventory";
import { useToast } from "@/components/providers/ToastProvider";
import { Dialog } from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { Input, Textarea } from "@/components/ui/Input";
import { Alert } from "@/components/ui/States";

interface FormState {
  name: string;
  contactPerson: string;
  phone: string;
  email: string;
  gstin: string;
  address: string;
  notes: string;
}

/** `vendor` undefined = create, object = edit, null = closed. */
export function VendorFormDialog({ vendor, onClose, onSaved }: { vendor: Vendor | null | undefined; onClose: () => void; onSaved: (v: Vendor) => void }) {
  const toast = useToast();
  const open = vendor !== null;
  const [form, setForm] = useState<FormState | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setForm({
      name: vendor?.name ?? "",
      contactPerson: vendor?.contactPerson ?? "",
      phone: vendor?.phone ?? "",
      email: vendor?.email ?? "",
      gstin: vendor?.gstin ?? "",
      address: vendor?.address ?? "",
      notes: vendor?.notes ?? "",
    });
  }, [open, vendor]);

  if (!form) return null;
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setForm((f) => (f ? { ...f, [k]: v } : f));

  const save = async () => {
    const payload = {
      name: form.name.trim(),
      contactPerson: form.contactPerson.trim() || null,
      phone: form.phone.trim() || null,
      email: form.email.trim(),
      gstin: form.gstin.trim().toUpperCase(),
      address: form.address.trim() || null,
      notes: form.notes.trim() || null,
    };
    const parsed = (vendor ? vendorUpdateSchema : vendorSchema).safeParse(payload);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return setError(`${issue.path.join(".") || "Form"}: ${issue.message}`);
    }
    setSaving(true);
    setError(null);
    try {
      const saved = vendor
        ? await api.patch<Vendor>(`/inventory/vendors/${vendor.id}`, parsed.data as VendorUpdateInput)
        : await api.post<Vendor>("/inventory/vendors", parsed.data as VendorInput);
      toast(vendor ? "Vendor updated" : `${saved.name} added`, "success");
      onSaved(saved);
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
      size="lg"
      dismissible={!saving}
      title={vendor ? `Edit ${vendor.name}` : "New vendor"}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={save} loading={saving}>
            {vendor ? "Save changes" : "Create vendor"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {error && <Alert>{error}</Alert>}
        <div className="grid gap-4 sm:grid-cols-2">
          <Input label="Vendor name" aria-label="Vendor name" maxLength={120} value={form.name} onChange={(e) => set("name", e.target.value)} data-autofocus />
          <Input label="Contact person" maxLength={120} value={form.contactPerson} onChange={(e) => set("contactPerson", e.target.value)} />
          <Input label="Phone" inputMode="tel" maxLength={20} value={form.phone} onChange={(e) => set("phone", e.target.value.replace(/[^\d+\s-]/g, ""))} />
          <Input label="Email" type="email" value={form.email} onChange={(e) => set("email", e.target.value)} />
          <Input
            label="GSTIN"
            maxLength={15}
            value={form.gstin}
            onChange={(e) => set("gstin", e.target.value.toUpperCase().replace(/[^0-9A-Z]/g, ""))}
            placeholder="15 characters"
            className="font-mono"
          />
        </div>
        <Textarea label="Address" maxLength={500} value={form.address} onChange={(e) => set("address", e.target.value)} />
        <Textarea label="Notes" maxLength={500} value={form.notes} onChange={(e) => set("notes", e.target.value)} placeholder="Delivery days, credit terms…" />
      </div>
    </Dialog>
  );
}
