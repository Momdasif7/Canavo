"use client";

import { useEffect, useState } from "react";
import { Plus, Trash, Warning } from "@phosphor-icons/react";
import { formatINR } from "@canavo/shared";
import { api, errorMessage } from "@/lib/api";
import { describeRate, pct, round2, taxExample, type TaxRateInput, type TaxRateWriteResult } from "@/lib/tax";
import type { TaxRate } from "@/lib/types";
import { Dialog } from "@/components/ui/Dialog";
import { Button, IconButton } from "@/components/ui/Button";
import { Input, Toggle } from "@/components/ui/Input";
import { Alert } from "@/components/ui/States";

interface ExtraRow {
  label: string;
  percent: string;
}

interface FormState {
  name: string;
  cgst: string;
  sgst: string;
  igst: string;
  /** IGST follows CGST + SGST until edited by hand */
  igstAuto: boolean;
  cess: string;
  extras: ExtraRow[];
  isDefault: boolean;
  active: boolean;
}

const PRESETS = [0, 5, 12, 18, 28];

const blank = (): FormState => ({
  name: "",
  cgst: "2.5",
  sgst: "2.5",
  igst: "5",
  igstAuto: true,
  cess: "0",
  extras: [],
  isDefault: false,
  active: true,
});

const fromRate = (r: TaxRate): FormState => ({
  name: r.name,
  cgst: pct(r.cgst),
  sgst: pct(r.sgst),
  igst: pct(r.igst),
  igstAuto: round2(r.cgst + r.sgst) === round2(r.igst),
  cess: pct(r.cess),
  extras: (r.extras ?? []).map((x) => ({ label: x.label, percent: pct(x.percent) })),
  isDefault: r.isDefault,
  active: r.active,
});

const num = (s: string) => (s.trim() === "" ? 0 : Number(s));
const validPct = (n: number) => Number.isFinite(n) && n >= 0 && n <= 100;
const decimal = (v: string) => v.replace(/[^\d.]/g, "").replace(/(\..*)\./g, "$1");

/** Create (`rate` undefined) or edit a tax rate; `null` = closed. */
export function TaxRateDialog({
  rate,
  onClose,
  onSaved,
}: {
  rate: TaxRate | null | undefined;
  onClose: () => void;
  onSaved: (saved: TaxRateWriteResult) => void;
}) {
  const open = rate !== null;
  const [form, setForm] = useState<FormState>(blank);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setForm(rate ? fromRate(rate) : blank());
  }, [open, rate]);

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) =>
    setForm((f) => {
      const next = { ...f, [k]: v };
      if ((k === "cgst" || k === "sgst") && next.igstAuto) next.igst = pct(num(next.cgst) + num(next.sgst));
      return next;
    });

  const applyPreset = (total: number) =>
    setForm((f) => ({
      ...f,
      name: f.name.trim() && !/^GST \d+%/.test(f.name) ? f.name : total === 0 ? "GST 0% (Exempt)" : `GST ${total}%`,
      cgst: pct(total / 2),
      sgst: pct(total / 2),
      igst: pct(total),
      igstAuto: true,
    }));

  const values = {
    cgst: num(form.cgst),
    sgst: num(form.sgst),
    igst: num(form.igst),
    cess: num(form.cess),
    extras: form.extras.filter((x) => x.label.trim() || x.percent.trim()).map((x) => ({ label: x.label.trim(), percent: num(x.percent) })),
  };
  const example = taxExample(values);
  const unequal = values.cgst !== values.sgst;
  const igstOff = round2(values.cgst + values.sgst) !== round2(values.igst);

  const save = async () => {
    if (form.name.trim().length < 1) return setError("Give the rate a name, e.g. GST 5%");
    const all = [values.cgst, values.sgst, values.igst, values.cess, ...values.extras.map((x) => x.percent)];
    if (!all.every(validPct)) return setError("Percentages must be between 0 and 100");
    if (values.extras.some((x) => !x.label)) return setError("Each extra tax needs a label, e.g. VAT");
    const body: TaxRateInput = {
      name: form.name.trim(),
      cgst: values.cgst,
      sgst: values.sgst,
      igst: values.igst,
      cess: values.cess,
      extras: values.extras,
      isDefault: form.isDefault,
      active: form.isDefault ? true : form.active,
    };
    setSaving(true);
    setError(null);
    try {
      const saved = rate ? await api.patch<TaxRateWriteResult>(`/tax-rates/${rate.id}`, body) : await api.post<TaxRateWriteResult>("/tax-rates", body);
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
      title={rate ? `Edit ${rate.name}` : "New tax rate"}
      description="Percentages apply to the taxable value of each item using this rate."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} loading={saving}>
            Save rate
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        {error && <Alert>{error}</Alert>}
        <div className="flex flex-wrap items-end gap-3">
          <Input wrapperClassName="min-w-[220px] flex-1" label="Name" maxLength={60} placeholder="e.g. GST 5% + Cess" value={form.name} onChange={(e) => set("name", e.target.value)} data-autofocus />
          <div className="flex flex-wrap gap-1.5" aria-label="GST slab presets">
            {PRESETS.map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => applyPreset(p)}
                className="min-h-[40px] rounded-lg border border-line px-2.5 text-sm font-semibold text-muted hover:border-primary hover:text-primary"
              >
                {p}%
              </button>
            ))}
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-4">
          <Input label="CGST %" inputMode="decimal" value={form.cgst} onChange={(e) => set("cgst", decimal(e.target.value))} />
          <Input label="SGST %" inputMode="decimal" value={form.sgst} onChange={(e) => set("sgst", decimal(e.target.value))} />
          <Input
            label="IGST %"
            inputMode="decimal"
            value={form.igst}
            onChange={(e) => setForm((f) => ({ ...f, igst: decimal(e.target.value), igstAuto: false }))}
            hint={form.igstAuto ? "Auto: CGST + SGST" : "Inter-state supply"}
          />
          <Input label="Cess %" inputMode="decimal" value={form.cess} onChange={(e) => set("cess", decimal(e.target.value))} hint="Compensation cess" />
        </div>

        {unequal && (
          <Alert tone="warning">
            <span className="flex gap-2">
              <Warning size={18} weight="fill" className="mt-0.5 shrink-0" />
              CGST and SGST are normally equal halves of the GST rate ({pct(values.cgst)}% vs {pct(values.sgst)}%). Double-check before saving.
            </span>
          </Alert>
        )}
        {!unequal && igstOff && <Alert tone="info">IGST ({pct(values.igst)}%) differs from CGST + SGST ({pct(values.cgst + values.sgst)}%).</Alert>}

        <fieldset className="space-y-2">
          <div className="flex items-center justify-between">
            <legend className="text-sm font-semibold">Extra taxes</legend>
            <Button variant="ghost" size="sm" icon={<Plus size={16} />} onClick={() => set("extras", [...form.extras, { label: "", percent: "" }])}>
              Add tax
            </Button>
          </div>
          {form.extras.length === 0 && <p className="text-xs text-muted">None. Use for state levies such as VAT on liquor or a luxury tax.</p>}
          {form.extras.map((x, idx) => (
            <div key={idx} className="flex gap-2">
              <Input
                wrapperClassName="flex-1"
                aria-label="Extra tax label"
                placeholder="Label, e.g. VAT"
                maxLength={40}
                value={x.label}
                onChange={(e) => set("extras", form.extras.map((r, i) => (i === idx ? { ...r, label: e.target.value } : r)))}
              />
              <Input
                wrapperClassName="w-28"
                aria-label="Extra tax percent"
                inputMode="decimal"
                placeholder="%"
                value={x.percent}
                onChange={(e) => set("extras", form.extras.map((r, i) => (i === idx ? { ...r, percent: decimal(e.target.value) } : r)))}
              />
              <IconButton label="Remove extra tax" onClick={() => set("extras", form.extras.filter((_, i) => i !== idx))}>
                <Trash size={20} />
              </IconButton>
            </div>
          ))}
        </fieldset>

        <div className="rounded-xl border border-line bg-surface-2 p-4" aria-live="polite">
          <p className="text-xs font-bold uppercase tracking-wide text-muted">Preview (prices exclusive of tax)</p>
          <p className="tabular mt-1 text-[15px] font-semibold" data-testid="tax-preview">
            {formatINR(example.base)} →{" "}
            {example.parts.length ? example.parts.map((p) => `${p.label} ${formatINR(p.amount)}`).join(" + ") : "no tax"} ={" "}
            <span className="text-primary">{formatINR(example.total)}</span>
          </p>
          <p className="mt-1 text-xs text-muted">{describeRate(values)}</p>
        </div>

        <div className="grid gap-x-8 border-t border-line pt-3 sm:grid-cols-2">
          <Toggle label="Business default" description="Used by items without a specific rate" checked={form.isDefault} onChange={(v) => set("isDefault", v)} />
          <Toggle
            label="Active"
            description={form.isDefault ? "The default rate is always active" : "Inactive rates can't be picked for items"}
            checked={form.isDefault || form.active}
            onChange={(v) => set("active", v)}
            disabled={form.isDefault}
          />
        </div>
      </div>
    </Dialog>
  );
}
