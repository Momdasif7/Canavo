"use client";

import { useEffect, useState } from "react";
import { couponCreateSchema, type CouponCreateInput } from "@canavo/shared";
import { api, errorMessage } from "@/lib/api";
import { parseRupees, rupeesInput } from "@/lib/format";
import type { Coupon, DiscountType } from "@/lib/types-crm";
import { useToast } from "@/components/providers/ToastProvider";
import { Dialog } from "@/components/ui/Dialog";
import { Button } from "@/components/ui/Button";
import { Input, Toggle } from "@/components/ui/Input";
import { Segmented } from "@/components/ui/Segmented";
import { Alert } from "@/components/ui/States";
import { decimalOnly, digitsOnly, intOrNull, isoToLocalInput, issuesToErrors, localInputToIso } from "./shared";

interface FormState {
  code: string;
  description: string;
  discountType: DiscountType;
  value: string;
  maxDiscount: string;
  minOrder: string;
  usageLimit: string;
  perCustomerLimit: string;
  startsAt: string;
  expiresAt: string;
  active: boolean;
}

const toForm = (c: Coupon | undefined): FormState => ({
  code: c?.code ?? "",
  description: c?.description ?? "",
  discountType: c?.discountType ?? "FLAT",
  value: c ? (c.discountType === "FLAT" ? rupeesInput(c.value) : String(c.value)) : "",
  maxDiscount: c?.maxDiscount ? rupeesInput(c.maxDiscount) : "",
  minOrder: c?.minOrder ? rupeesInput(c.minOrder) : "",
  usageLimit: c?.usageLimit ? String(c.usageLimit) : "",
  perCustomerLimit: c?.perCustomerLimit ? String(c.perCustomerLimit) : "",
  startsAt: isoToLocalInput(c?.startsAt),
  expiresAt: isoToLocalInput(c?.expiresAt),
  active: c?.active ?? true,
});

/** `coupon` undefined = create, object = edit, null = closed. */
export function CouponForm({ coupon, onClose, onSaved }: { coupon: Coupon | null | undefined; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const open = coupon !== null;
  const [form, setForm] = useState<FormState | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setForm(toForm(coupon ?? undefined));
    setErrors({});
    setError(null);
  }, [open, coupon]);

  if (!open || !form) return null;
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setForm((f) => (f ? { ...f, [k]: v } : f));

  const save = async () => {
    const flat = form.discountType === "FLAT";
    const value = flat ? parseRupees(form.value) ?? NaN : form.value.trim() ? Number(form.value) : NaN;
    const payload: CouponCreateInput = {
      code: form.code.trim().toUpperCase(),
      description: form.description.trim(),
      discountType: form.discountType,
      value,
      maxDiscount: !flat && form.maxDiscount.trim() ? parseRupees(form.maxDiscount) ?? NaN : null,
      minOrder: form.minOrder.trim() ? parseRupees(form.minOrder) ?? NaN : 0,
      usageLimit: intOrNull(form.usageLimit),
      perCustomerLimit: intOrNull(form.perCustomerLimit),
      startsAt: localInputToIso(form.startsAt),
      expiresAt: localInputToIso(form.expiresAt),
      active: form.active,
    };
    const parsed = couponCreateSchema.safeParse(payload);
    const errs = parsed.success ? {} : issuesToErrors(parsed.error.issues);
    if (payload.startsAt && payload.expiresAt && payload.expiresAt <= payload.startsAt) errs.expiresAt = "Must be after the start";
    if (coupon && payload.usageLimit && payload.usageLimit < coupon.usedCount) errs.usageLimit = `Already used ${coupon.usedCount} times`;
    if (!parsed.success || Object.keys(errs).length) {
      setErrors(errs);
      return;
    }
    setErrors({});
    setError(null);
    setSaving(true);
    try {
      if (coupon) await api.patch<Coupon>(`/offers/coupons/${coupon.id}`, parsed.data);
      else await api.post<Coupon>("/offers/coupons", parsed.data);
      toast(coupon ? `Coupon ${parsed.data.code} updated` : `Coupon ${parsed.data.code} created`, "success");
      onSaved();
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const flat = form.discountType === "FLAT";

  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      dismissible={!saving}
      title={coupon ? `Edit ${coupon.code}` : "New coupon"}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={save} loading={saving}>
            {coupon ? "Save coupon" : "Create coupon"}
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
        {coupon && coupon.usedCount > 0 && <Alert tone="info">Used {coupon.usedCount} time{coupon.usedCount === 1 ? "" : "s"}. Changes apply to future bills only.</Alert>}
        <div className="grid gap-4 sm:grid-cols-[1fr_auto]">
          <Input
            label="Coupon code"
            maxLength={30}
            value={form.code}
            error={errors.code}
            hint="3–30 letters, digits, - or _"
            className="font-mono uppercase tracking-wider"
            onChange={(e) => set("code", e.target.value.toUpperCase().replace(/[^A-Z0-9_-]/g, ""))}
            data-autofocus
          />
          <div className="flex items-start pt-7">
            <Toggle checked={form.active} onChange={(v) => set("active", v)} label="Active" />
          </div>
        </div>
        <Input label="Description" maxLength={200} value={form.description} error={errors.description} placeholder="Shown to the cashier, e.g. ₹50 off on orders over ₹200" onChange={(e) => set("description", e.target.value)} />

        <div className="grid gap-4 sm:grid-cols-3">
          <div className="flex flex-col gap-1.5">
            <span className="text-sm font-semibold">Discount type</span>
            <Segmented
              value={form.discountType}
              onChange={(v) => setForm((f) => (f ? { ...f, discountType: v, value: "", maxDiscount: v === "FLAT" ? "" : f.maxDiscount } : f))}
              options={[
                { value: "FLAT", label: "Flat ₹" },
                { value: "PERCENT", label: "Percent %" },
              ]}
            />
          </div>
          <Input
            label={flat ? "Amount off" : "Percent off"}
            prefix={flat ? "₹" : "%"}
            inputMode={flat ? "decimal" : "numeric"}
            value={form.value}
            error={errors.value}
            onChange={(e) => set("value", flat ? decimalOnly(e.target.value) : digitsOnly(e.target.value))}
          />
          {!flat && (
            <Input
              label="Max discount"
              prefix="₹"
              inputMode="decimal"
              hint="Blank = no cap"
              value={form.maxDiscount}
              error={errors.maxDiscount}
              onChange={(e) => set("maxDiscount", decimalOnly(e.target.value))}
            />
          )}
        </div>

        <div className="grid gap-4 sm:grid-cols-3">
          <Input
            label="Minimum order"
            prefix="₹"
            inputMode="decimal"
            hint="Blank = any bill"
            value={form.minOrder}
            error={errors.minOrder}
            onChange={(e) => set("minOrder", decimalOnly(e.target.value))}
          />
          <Input
            label="Total uses"
            inputMode="numeric"
            hint="Blank = unlimited"
            value={form.usageLimit}
            error={errors.usageLimit}
            onChange={(e) => set("usageLimit", digitsOnly(e.target.value))}
          />
          <Input
            label="Uses per customer"
            inputMode="numeric"
            hint="Requires a phone on the bill"
            value={form.perCustomerLimit}
            error={errors.perCustomerLimit}
            onChange={(e) => set("perCustomerLimit", digitsOnly(e.target.value))}
          />
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Input label="Valid from" type="datetime-local" hint="Blank = immediately" value={form.startsAt} error={errors.startsAt} onChange={(e) => set("startsAt", e.target.value)} />
          <Input label="Expires" type="datetime-local" hint="Blank = never" value={form.expiresAt} error={errors.expiresAt} onChange={(e) => set("expiresAt", e.target.value)} />
        </div>
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}
