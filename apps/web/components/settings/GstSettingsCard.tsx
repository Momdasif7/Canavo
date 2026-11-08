"use client";

import { useEffect, useRef, useState } from "react";
import { GST_STATES, gstinProblem } from "@canavo/shared";
import { FloppyDisk, Receipt, ReceiptX } from "@phosphor-icons/react";
import { api, errorMessage } from "@/lib/api";
import type { Outlet } from "@/lib/types";
import { useApiQuery } from "@/hooks/useApiQuery";
import { useSession } from "@/components/providers/SessionProvider";
import { useToast } from "@/components/providers/ToastProvider";
import { Card, CardHeader } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { Input, Toggle } from "@/components/ui/Input";
import { Alert, ErrorState, LoadingState } from "@/components/ui/States";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";


interface GstForm {
  gstEnabled: boolean;
  legalName: string;
  gstin: string;
  stateCode: string;
  compositionScheme: boolean;
  pricesIncludeTax: boolean;
  invoicePrefix: string;
}

const toForm = (o: Outlet): GstForm => ({
  gstEnabled: o.gstEnabled !== false,
  legalName: o.legalName ?? "",
  gstin: o.gstin ?? "",
  stateCode: o.stateCode,
  compositionScheme: o.compositionScheme,
  pricesIncludeTax: o.pricesIncludeTax,
  invoicePrefix: o.invoicePrefix,
});

type OutletWriteResult = Outlet & { warnings?: string[] };

function validate(f: GstForm): string | null {
  if (!GST_STATES[f.stateCode]) return "State code must be a two-digit GST state code, e.g. 29 for Karnataka";
  if (!/^[A-Z0-9]{1,5}$/.test(f.invoicePrefix)) return "Invoice prefix must be 1–5 letters or digits";
  if (f.gstin) {
    const problem = gstinProblem(f.gstin);
    if (problem) return problem;
    if (f.gstin.slice(0, 2) !== f.stateCode) return `This GSTIN is registered in state ${f.gstin.slice(0, 2)}, not ${f.stateCode}`;
  }
  return null;
}

/** GST registration and invoice settings of the active outlet (PATCH /outlets/current). */
export function GstSettingsCard() {
  const { outletId, can, reloadOutlet, me } = useSession();
  const toast = useToast();
  const editable = can("settings:billing") && can("settings:outlet");
  const outlet = useApiQuery<Outlet>(outletId ? `outlet-gst:${outletId}` : null, () => api.get<Outlet>("/outlets/current"));
  const [form, setForm] = useState<GstForm | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  /** GST switch awaiting confirmation (it saves immediately, so we ask first) */
  const [confirmGst, setConfirmGst] = useState<boolean | null>(null);
  /** Unsaved edits to keep when the server copy refreshes after the GST switch saves */
  const keepEdits = useRef<Partial<GstForm>>({});

  useEffect(() => {
    if (outlet.data) {
      setForm({ ...toForm(outlet.data), ...keepEdits.current });
      keepEdits.current = {};
    }
  }, [outlet.data]);

  if (outlet.loading && !outlet.data) return <Card><LoadingState /></Card>;
  if (outlet.error) return <Card><ErrorState message={outlet.error} onRetry={outlet.reload} /></Card>;
  if (!form || !outlet.data) return null;

  const set = <K extends keyof GstForm>(k: K, v: GstForm[K]) => setForm((f) => (f ? { ...f, [k]: v } : f));
  const original = toForm(outlet.data);
  const dirty = (Object.keys(form) as (keyof GstForm)[]).some((k) => form[k] !== original[k]);
  const stateMismatch = form.gstEnabled && form.gstin.length >= 2 && /^\d{2}$/.test(form.stateCode) && form.gstin.slice(0, 2) !== form.stateCode;

  const save = async () => {
    const invalid = validate(form);
    if (invalid) return setError(invalid);
    // Send only what changed (the invoice prefix in particular is audited separately).
    const payload: Record<string, unknown> = {};
    for (const k of Object.keys(form) as (keyof GstForm)[]) {
      if (form[k] === original[k]) continue;
      payload[k] = typeof form[k] === "string" ? (form[k] as string).trim() : form[k];
    }
    if (!Object.keys(payload).length) return;
    setSaving(true);
    setError(null);
    try {
      const updated = await api.patch<OutletWriteResult>("/outlets/current", payload);
      const { warnings: w = [], ...rest } = updated;
      const notes = [...w];
      if ("gstEnabled" in payload && updated.gstEnabled === undefined) {
        notes.push("This server doesn't support switching GST off yet — the GST registration setting was not saved.");
      }
      setWarnings(notes);
      outlet.setData(rest);
      await reloadOutlet();
      toast("GST settings saved", "success");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  /**
   * The GST switch saves on its own — a switch that only takes effect after a
   * separate Save click is easy to miss, and then bills keep charging GST.
   */
  const saveGst = async (enabled: boolean) => {
    const pending: Partial<GstForm> = {};
    for (const k of Object.keys(form) as (keyof GstForm)[]) {
      if (k !== "gstEnabled" && k !== "compositionScheme" && form[k] !== original[k]) (pending as Record<string, unknown>)[k] = form[k];
    }
    setError(null);
    const updated = await api.patch<OutletWriteResult>("/outlets/current", { gstEnabled: enabled });
    const { warnings: w = [], ...rest } = updated;
    setWarnings(w);
    keepEdits.current = pending;
    outlet.setData(rest);
    await reloadOutlet();
    toast(enabled ? "GST turned on — new bills are tax invoices" : "GST turned off — new bills have no tax", "success");
  };

  const outletName = me?.outlets.find((o) => o.id === outletId)?.name ?? "this outlet";

  return (
    <Card>
      <CardHeader
        title="GST registration"
        subtitle={`Applies to ${outletName}. Changes affect new bills immediately.`}
        action={
          editable && (
            <Button icon={<FloppyDisk size={20} />} onClick={save} loading={saving} disabled={!dirty}>
              Save
            </Button>
          )
        }
      />
      <fieldset disabled={!editable} className="space-y-5 p-5">
        {error && <Alert>{error}</Alert>}
        {warnings.length > 0 && (
          <Alert tone="warning">
            <ul className="list-disc space-y-0.5 pl-4">
              {warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          </Alert>
        )}

        <div className={`rounded-2xl border p-4 ${form.gstEnabled ? "border-secondary/40 bg-secondary-50 dark:bg-secondary/15" : "border-line bg-surface-2"}`}>
          <Toggle
            label={<span className="text-base">GST registered</span>}
            description={form.gstEnabled ? "Bills are GST tax invoices with CGST / SGST lines and your GSTIN." : "Not registered: plain bills titled “BILL” — no tax lines and no GSTIN."}
            checked={form.gstEnabled}
            onChange={(v) => setConfirmGst(v)}
            disabled={!editable}
          />
          <div className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
            <div className={`flex gap-2 rounded-xl p-3 ${form.gstEnabled ? "bg-surface" : "opacity-60"}`}>
              <Receipt size={22} className="shrink-0 text-secondary" weight="duotone" />
              <p>
                <b>On</b> — tax is worked out per item from its tax rate (CGST + SGST, cess, extra taxes) and printed on a TAX INVOICE.
              </p>
            </div>
            <div className={`flex gap-2 rounded-xl p-3 ${!form.gstEnabled ? "bg-surface" : "opacity-60"}`}>
              <ReceiptX size={22} className="shrink-0 text-primary" weight="duotone" />
              <p>
                <b>Off</b> — for small shops below the GST threshold. Menu prices are charged as-is; receipts say BILL and show no GST details.
              </p>
            </div>
          </div>
        </div>

        <section className="grid gap-4 md:grid-cols-2">
          <Input
            label="Legal name"
            placeholder="As registered, e.g. Sharma Foods Pvt Ltd"
            maxLength={200}
            value={form.legalName}
            onChange={(e) => set("legalName", e.target.value)}
            hint="Printed on tax invoices above the outlet name"
          />
          <Input
            label="GSTIN"
            maxLength={15}
            value={form.gstin}
            onChange={(e) => set("gstin", e.target.value.toUpperCase().replace(/[^0-9A-Z]/g, ""))}
            placeholder="29ABCDE1234F1ZW"
            disabled={!editable || !form.gstEnabled}
            hint={form.gstEnabled ? "15 characters" : "Not used while GST is off"}
          />
          <Input
            label="State code"
            maxLength={2}
            inputMode="numeric"
            value={form.stateCode}
            onChange={(e) => set("stateCode", e.target.value.replace(/\D/g, ""))}
            hint="Place of supply — e.g. 29 Karnataka, 27 Maharashtra, 07 Delhi"
          />
          <Input
            label="Invoice prefix"
            maxLength={5}
            value={form.invoicePrefix}
            onChange={(e) => set("invoicePrefix", e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""))}
            hint="1–5 letters/digits, e.g. INV → INV-2026-00001"
          />
        </section>
        {stateMismatch && <Alert tone="warning">The GSTIN starts with {form.gstin.slice(0, 2)} but the state code is {form.stateCode}. They normally match.</Alert>}

        <section className="grid gap-x-8 md:grid-cols-2">
          <Toggle
            label="Menu prices include tax"
            description={form.gstEnabled ? "Typical for canteens: ₹20 chai means ₹20 total" : "Not used while GST is off — menu prices are charged as they are"}
            checked={form.pricesIncludeTax}
            onChange={(v) => set("pricesIncludeTax", v)}
            disabled={!editable || !form.gstEnabled}
          />
          <Toggle
            label="Composition scheme"
            description={form.gstEnabled ? "Issue a Bill of Supply with no GST lines" : "Only applies when GST registered"}
            checked={form.compositionScheme && form.gstEnabled}
            onChange={(v) => set("compositionScheme", v)}
            disabled={!editable || !form.gstEnabled}
          />
        </section>
      </fieldset>
      <ConfirmDialog
        open={confirmGst !== null}
        tone={confirmGst ? "primary" : "danger"}
        title={confirmGst ? `Turn GST on for ${outletName}?` : `Turn GST off for ${outletName}?`}
        description={
          confirmGst
            ? "New bills will be GST tax invoices: tax is added per item and printed with your GSTIN."
            : "New bills will be plain bills with no GST charged and no tax lines or GSTIN printed. Bills already raised are not changed."
        }
        confirmLabel={confirmGst ? "Turn GST on" : "Turn GST off"}
        onConfirm={async () => {
          await saveGst(confirmGst!);
          setConfirmGst(null);
        }}
        onClose={() => setConfirmGst(null)}
      />
    </Card>
  );
}
