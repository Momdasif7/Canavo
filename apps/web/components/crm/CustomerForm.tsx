"use client";

import { useEffect, useState } from "react";
import { customerCreateSchema, customerUpdateSchema, type CustomerCreateInput } from "@canavo/shared";
import { api, errorMessage } from "@/lib/api";
import { parseRupees, rupeesInput } from "@/lib/format";
import type { Customer } from "@/lib/types-crm";
import { useSession } from "@/components/providers/SessionProvider";
import { useToast } from "@/components/providers/ToastProvider";
import { Dialog } from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { Field, Input, Select, Textarea } from "@/components/ui/Input";
import { Alert } from "@/components/ui/States";
import { decimalOnly, digitsOnly, issuesToErrors } from "./shared";

interface FormState {
  phone: string;
  name: string;
  email: string;
  birthday: string;
  anniversary: string;
  khataLimit: string;
  notes: string;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const pad = (n: number) => String(n).padStart(2, "0");

/** Month + day selects producing "MM-DD" ("" when unset). */
function MonthDayInput({ label, value, onChange, error }: { label: string; value: string; onChange: (v: string) => void; error?: string }) {
  const [m, d] = value ? value.split("-").map(Number) : [0, 0];
  const update = (month: number, day: number) => {
    if (!month) return onChange("");
    const safeDay = Math.min(day || 1, DAYS_IN_MONTH[month - 1]);
    onChange(`${pad(month)}-${pad(safeDay)}`);
  };
  return (
    <Field label={label} error={error}>
      <div className="flex gap-2">
        <Select aria-label={`${label} month`} value={m || ""} onChange={(e) => update(Number(e.target.value), d)} className="flex-1">
          <option value="">Month</option>
          {MONTHS.map((name, i) => (
            <option key={name} value={i + 1}>
              {name}
            </option>
          ))}
        </Select>
        <Select aria-label={`${label} day`} value={d || ""} onChange={(e) => update(m, Number(e.target.value))} disabled={!m} className="w-24">
          <option value="">Day</option>
          {Array.from({ length: m ? DAYS_IN_MONTH[m - 1] : 31 }, (_, i) => (
            <option key={i} value={i + 1}>
              {i + 1}
            </option>
          ))}
        </Select>
      </div>
    </Field>
  );
}

/** `customer` undefined = create, object = edit, null = closed. */
export function CustomerForm({
  customer,
  onClose,
  onSaved,
}: {
  customer: Customer | null | undefined;
  onClose: () => void;
  onSaved: (c: Customer) => void;
}) {
  const { me } = useSession();
  const toast = useToast();
  const open = customer !== null;
  const isManager = me?.role === "SUPER_ADMIN" || me?.role === "BUSINESS_OWNER" || me?.role === "OUTLET_MANAGER";
  const [form, setForm] = useState<FormState | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setErrors({});
    setForm({
      phone: customer?.phone ?? "",
      name: customer?.name ?? "",
      email: customer?.email ?? "",
      birthday: customer?.birthday ?? "",
      anniversary: customer?.anniversary ?? "",
      khataLimit: customer?.khataLimit ? rupeesInput(customer.khataLimit) : "",
      notes: customer?.notes ?? "",
    });
  }, [open, customer]);

  if (!form) return null;
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setForm((f) => (f ? { ...f, [k]: v } : f));

  const save = async () => {
    const payload: CustomerCreateInput = {
      phone: form.phone.trim(),
      name: form.name.trim() || undefined,
      email: form.email.trim(),
      birthday: form.birthday || null,
      anniversary: form.anniversary || null,
      notes: form.notes.trim() || null,
    };
    if (isManager) {
      const limit = form.khataLimit.trim() ? parseRupees(form.khataLimit) : 0;
      if (limit === null) return setErrors({ khataLimit: "Enter a valid amount" });
      // Only send when set (create) or changed (edit) — non-managers can't send it at all.
      if (customer ? limit !== customer.khataLimit : limit > 0) payload.khataLimit = limit;
    }
    const parsed = (customer ? customerUpdateSchema : customerCreateSchema).safeParse(payload);
    if (!parsed.success) {
      setErrors(issuesToErrors(parsed.error.issues));
      return;
    }
    setErrors({});
    setSaving(true);
    setError(null);
    try {
      const saved = customer
        ? await api.patch<Customer>(`/customers/${customer.id}`, parsed.data)
        : await api.post<Customer>("/customers", parsed.data);
      toast(customer ? "Customer updated" : "Customer added", "success");
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
      title={customer ? `Edit ${customer.name || customer.phone}` : "Add customer"}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={save} loading={saving}>
            {customer ? "Save changes" : "Add customer"}
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
        <div className="grid gap-4 sm:grid-cols-2">
          <Input
            label="Mobile"
            inputMode="numeric"
            maxLength={10}
            prefix={<span className="text-sm font-semibold">+91</span>}
            className="pl-12"
            value={form.phone}
            error={errors.phone}
            onChange={(e) => set("phone", digitsOnly(e.target.value))}
            data-autofocus
          />
          <Input label="Name" maxLength={100} value={form.name} error={errors.name} onChange={(e) => set("name", e.target.value)} />
          <Input label="Email" type="email" value={form.email} error={errors.email} onChange={(e) => set("email", e.target.value)} />
          {isManager && (
            <Input
              label="Khata limit"
              hint="Maximum credit outstanding. Blank or 0 = no limit."
              inputMode="decimal"
              prefix="₹"
              value={form.khataLimit}
              error={errors.khataLimit}
              onChange={(e) => set("khataLimit", decimalOnly(e.target.value))}
            />
          )}
          <MonthDayInput label="Birthday" value={form.birthday} onChange={(v) => set("birthday", v)} error={errors.birthday} />
          <MonthDayInput label="Anniversary" value={form.anniversary} onChange={(v) => set("anniversary", v)} error={errors.anniversary} />
        </div>
        <Textarea label="Notes" maxLength={500} value={form.notes} error={errors.notes} onChange={(e) => set("notes", e.target.value)} />
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}
