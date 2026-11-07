"use client";

import { useEffect, useState } from "react";
import clsx from "clsx";
import { Plus, Trash } from "@phosphor-icons/react";
import {
  OFFER_TYPES,
  formatINR,
  offerCreateSchema,
  type BillDiscountConfig,
  type BuyXGetYConfig,
  type ComboConfig,
  type ItemDiscountConfig,
  type OfferCreateInput,
  type OfferTarget,
  type OfferTypeName,
} from "@canavo/shared";
import { api, errorMessage } from "@/lib/api";
import { parseRupees, rupeesInput } from "@/lib/format";
import type { Menu } from "@/lib/types";
import type { DiscountType, Offer } from "@/lib/types-crm";
import { useSession } from "@/components/providers/SessionProvider";
import { useToast } from "@/components/providers/ToastProvider";
import { Dialog } from "@/components/ui/Dialog";
import { Button, IconButton } from "@/components/ui/Button";
import { Field, Input, Select, Toggle } from "@/components/ui/Input";
import { Segmented } from "@/components/ui/Segmented";
import { Alert } from "@/components/ui/States";
import { MenuTargetPicker } from "./MenuTargetPicker";
import { WEEKDAYS, decimalOnly, digitsOnly, isoToLocalInput, issuesToErrors, localInputToIso, signedDigits } from "./shared";

export const OFFER_TYPE_LABELS: Record<OfferTypeName, string> = {
  HAPPY_HOUR: "Happy hour",
  ITEM_DISCOUNT: "Item discount",
  BUY_X_GET_Y: "Buy X get Y",
  COMBO: "Combo",
  BILL_DISCOUNT: "Bill discount",
};

export const OFFER_TYPE_HELP: Record<OfferTypeName, string> = {
  HAPPY_HOUR: "Discount on selected items during a daily time window.",
  ITEM_DISCOUNT: "Percent or flat ₹ off each unit of selected items.",
  BUY_X_GET_Y: "Buy a quantity of some items, get others free or discounted.",
  COMBO: "A fixed price when all the listed items are ordered together.",
  BILL_DISCOUNT: "Percent or flat ₹ off the whole bill above a minimum.",
};

// ---------- Form state (strings for inputs; converted on submit) ----------
interface ItemDiscountState {
  target: OfferTarget;
  discountType: DiscountType;
  value: string;
}
interface BxgyState {
  buy: OfferTarget;
  buyQty: string;
  get: OfferTarget;
  getQty: string;
  getDiscountPercent: string;
  maxSets: string;
}
interface ComboState {
  items: { menuItemId: string; quantity: string }[];
  price: string;
}
interface BillState {
  minOrder: string;
  discountType: DiscountType;
  value: string;
  maxDiscount: string;
}
interface FormState {
  name: string;
  type: OfferTypeName;
  active: boolean;
  outletIds: string[];
  startsAt: string;
  endsAt: string;
  daysOfWeek: number[];
  startTime: string;
  endTime: string;
  priority: string;
  combinable: boolean;
  item: ItemDiscountState;
  bxgy: BxgyState;
  combo: ComboState;
  bill: BillState;
}

const discountValueInput = (type: DiscountType, value: number) => (type === "FLAT" ? rupeesInput(value) : String(value));
const targetOf = (t: OfferTarget | undefined): OfferTarget => ({ menuItemIds: t?.menuItemIds ?? [], categoryIds: t?.categoryIds ?? [] });

function initialState(offer: Offer | undefined): FormState {
  const s: FormState = {
    name: offer?.name ?? "",
    type: offer?.type ?? "BILL_DISCOUNT",
    active: offer?.active ?? true,
    outletIds: offer?.outletIds ?? [],
    startsAt: isoToLocalInput(offer?.startsAt),
    endsAt: isoToLocalInput(offer?.endsAt),
    daysOfWeek: offer?.daysOfWeek ?? [],
    startTime: offer?.startTime ?? "",
    endTime: offer?.endTime ?? "",
    priority: String(offer?.priority ?? 0),
    combinable: offer?.combinable ?? false,
    item: { target: targetOf(undefined), discountType: "PERCENT", value: "" },
    bxgy: { buy: targetOf(undefined), buyQty: "2", get: targetOf(undefined), getQty: "1", getDiscountPercent: "100", maxSets: "" },
    combo: { items: [{ menuItemId: "", quantity: "1" }], price: "" },
    bill: { minOrder: "", discountType: "PERCENT", value: "", maxDiscount: "" },
  };
  if (!offer) return s;
  try {
    switch (offer.type) {
      case "HAPPY_HOUR":
      case "ITEM_DISCOUNT": {
        const c = offer.config as ItemDiscountConfig;
        s.item = { target: targetOf(c.target), discountType: c.discountType, value: discountValueInput(c.discountType, c.value) };
        break;
      }
      case "BUY_X_GET_Y": {
        const c = offer.config as BuyXGetYConfig;
        s.bxgy = {
          buy: targetOf(c.buy),
          buyQty: String(c.buy.quantity),
          get: targetOf(c.get),
          getQty: String(c.get.quantity),
          getDiscountPercent: String(c.getDiscountPercent ?? 100),
          maxSets: c.maxSets ? String(c.maxSets) : "",
        };
        break;
      }
      case "COMBO": {
        const c = offer.config as ComboConfig;
        s.combo = { items: c.items.map((i) => ({ menuItemId: i.menuItemId, quantity: String(i.quantity) })), price: rupeesInput(c.price) };
        break;
      }
      case "BILL_DISCOUNT": {
        const c = offer.config as BillDiscountConfig;
        s.bill = {
          minOrder: c.minOrder ? rupeesInput(c.minOrder) : "",
          discountType: c.discountType,
          value: discountValueInput(c.discountType, c.value),
          maxDiscount: c.maxDiscount ? rupeesInput(c.maxDiscount) : "",
        };
        break;
      }
    }
  } catch {
    /* malformed stored config — start that editor blank */
  }
  return s;
}

const num = (v: string) => (v.trim() === "" ? NaN : Number(v));
const rupees = (v: string) => parseRupees(v) ?? NaN;
const cleanTarget = (t: OfferTarget): OfferTarget => ({
  ...(t.menuItemIds?.length ? { menuItemIds: t.menuItemIds } : {}),
  ...(t.categoryIds?.length ? { categoryIds: t.categoryIds } : {}),
});
const discount = (type: DiscountType, v: string) => (type === "FLAT" ? rupees(v) : num(v));

function buildConfig(f: FormState): unknown {
  switch (f.type) {
    case "HAPPY_HOUR":
    case "ITEM_DISCOUNT":
      return { target: cleanTarget(f.item.target), discountType: f.item.discountType, value: discount(f.item.discountType, f.item.value) };
    case "BUY_X_GET_Y":
      return {
        buy: { ...cleanTarget(f.bxgy.buy), quantity: num(f.bxgy.buyQty) },
        get: { ...cleanTarget(f.bxgy.get), quantity: num(f.bxgy.getQty) },
        getDiscountPercent: num(f.bxgy.getDiscountPercent),
        ...(f.bxgy.maxSets.trim() ? { maxSets: num(f.bxgy.maxSets) } : {}),
      };
    case "COMBO":
      return { items: f.combo.items.map((i) => ({ menuItemId: i.menuItemId, quantity: num(i.quantity) })), price: rupees(f.combo.price) };
    case "BILL_DISCOUNT":
      return {
        minOrder: f.bill.minOrder.trim() ? rupees(f.bill.minOrder) : 0,
        discountType: f.bill.discountType,
        value: discount(f.bill.discountType, f.bill.value),
        ...(f.bill.maxDiscount.trim() ? { maxDiscount: rupees(f.bill.maxDiscount) } : {}),
      };
  }
}

/** `offer` undefined = create, object = edit, null = closed. */
export function OfferForm({
  offer,
  menu,
  onClose,
  onSaved,
}: {
  offer: Offer | null | undefined;
  menu: Menu | undefined;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { me } = useSession();
  const toast = useToast();
  const open = offer !== null;
  const [form, setForm] = useState<FormState | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setForm(initialState(offer ?? undefined));
    setErrors({});
    setError(null);
  }, [open, offer]);

  if (!open || !form) return null;
  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setForm((f) => (f ? { ...f, [k]: v } : f));
  const patch = <K extends "item" | "bxgy" | "combo" | "bill">(k: K, v: Partial<FormState[K]>) =>
    setForm((f) => (f ? { ...f, [k]: { ...f[k], ...v } } : f));

  const save = async () => {
    const payload: OfferCreateInput = {
      name: form.name.trim(),
      type: form.type,
      active: form.active,
      outletIds: form.outletIds,
      startsAt: localInputToIso(form.startsAt),
      endsAt: localInputToIso(form.endsAt),
      daysOfWeek: [...form.daysOfWeek].sort(),
      startTime: form.startTime || null,
      endTime: form.endTime || null,
      priority: num(form.priority || "0"),
      combinable: form.combinable,
      config: buildConfig(form),
    };
    const parsed = offerCreateSchema.safeParse(payload);
    const errs = parsed.success ? {} : issuesToErrors(parsed.error.issues);
    if (form.type === "COMBO") form.combo.items.forEach((i, idx) => !i.menuItemId && (errs[`config.items.${idx}.menuItemId`] ??= "Pick an item"));
    if (!parsed.success || Object.keys(errs).length) {
      setErrors(errs);
      setError("Please fix the highlighted fields.");
      return;
    }
    setErrors({});
    setError(null);
    setSaving(true);
    try {
      if (offer) await api.patch<Offer>(`/offers/${offer.id}`, parsed.data);
      else await api.post<Offer>("/offers", parsed.data);
      toast(offer ? "Offer updated" : "Offer created", "success");
      onSaved();
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const e = (k: string) => errors[k];

  return (
    <Dialog
      open
      onClose={onClose}
      size="xl"
      dismissible={!saving}
      title={offer ? `Edit offer` : "New offer"}
      description={offer ? offer.name : OFFER_TYPE_HELP[form.type]}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={save} loading={saving}>
            {offer ? "Save offer" : "Create offer"}
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        {error && <Alert>{error}</Alert>}

        <div className="grid gap-4 md:grid-cols-[1fr_auto]">
          <Input label="Offer name" maxLength={100} value={form.name} error={e("name")} onChange={(ev) => set("name", ev.target.value)} placeholder="e.g. Evening chai happy hour" data-autofocus />
          <div className="flex items-end pb-0.5">
            <Toggle checked={form.active} onChange={(v) => set("active", v)} label="Active" />
          </div>
        </div>

        {!offer && (
          <Field label="Offer type">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5" role="radiogroup" aria-label="Offer type">
              {OFFER_TYPES.map((t) => (
                <button
                  key={t}
                  type="button"
                  role="radio"
                  aria-checked={form.type === t}
                  onClick={() => set("type", t)}
                  className={clsx(
                    "min-h-tap rounded-xl border px-3 py-2 text-left text-sm font-semibold transition-colors",
                    form.type === t ? "border-primary bg-primary-50 text-primary-700 dark:bg-primary/15 dark:text-primary-200" : "border-line hover:bg-surface-2",
                  )}
                >
                  {OFFER_TYPE_LABELS[t]}
                </button>
              ))}
            </div>
          </Field>
        )}

        {/* Type-specific configuration */}
        <section className="rounded-2xl border border-line bg-surface-2/50 p-4">
          <h3 className="mb-3 text-sm font-bold uppercase tracking-wide text-muted">{OFFER_TYPE_LABELS[form.type]} rules</h3>
          {(form.type === "HAPPY_HOUR" || form.type === "ITEM_DISCOUNT") && (
            <div className="space-y-4">
              <MenuTargetPicker label="Applies to" menu={menu} value={form.item.target} onChange={(t) => patch("item", { target: t })} />
              <DiscountFields
                type={form.item.discountType}
                value={form.item.value}
                flatLabel="₹ off each unit"
                onType={(t) => patch("item", { discountType: t, value: "" })}
                onValue={(v) => patch("item", { value: v })}
                error={e("config.value") ?? e("config")}
              />
              {form.type === "HAPPY_HOUR" && !form.startTime && <Alert tone="info">Set a daily time window under Schedule for this happy hour.</Alert>}
            </div>
          )}

          {form.type === "BUY_X_GET_Y" && (
            <div className="grid gap-4 lg:grid-cols-2">
              <div className="space-y-3 rounded-xl border border-line bg-surface p-3">
                <p className="text-sm font-bold">Customer buys</p>
                <Input label="Quantity" inputMode="numeric" value={form.bxgy.buyQty} error={e("config.buy.quantity")} onChange={(ev) => patch("bxgy", { buyQty: digitsOnly(ev.target.value) })} />
                <MenuTargetPicker label="Of these items" menu={menu} value={form.bxgy.buy} onChange={(t) => patch("bxgy", { buy: t })} emptyHint="Any item counts" />
              </div>
              <div className="space-y-3 rounded-xl border border-line bg-surface p-3">
                <p className="text-sm font-bold">Customer gets</p>
                <Input label="Quantity" inputMode="numeric" value={form.bxgy.getQty} error={e("config.get.quantity")} onChange={(ev) => patch("bxgy", { getQty: digitsOnly(ev.target.value) })} />
                <MenuTargetPicker label="Of these items" menu={menu} value={form.bxgy.get} onChange={(t) => patch("bxgy", { get: t })} emptyHint="Any item (cheapest discounted first)" />
              </div>
              <Input
                label="Discount on the free items (%)"
                inputMode="numeric"
                hint="100 = free"
                value={form.bxgy.getDiscountPercent}
                error={e("config.getDiscountPercent")}
                onChange={(ev) => patch("bxgy", { getDiscountPercent: digitsOnly(ev.target.value) })}
              />
              <Input
                label="Max sets per bill (optional)"
                inputMode="numeric"
                hint="Blank = no limit"
                value={form.bxgy.maxSets}
                error={e("config.maxSets")}
                onChange={(ev) => patch("bxgy", { maxSets: digitsOnly(ev.target.value) })}
              />
            </div>
          )}

          {form.type === "COMBO" && (
            <ComboEditor
              state={form.combo}
              menu={menu}
              errors={errors}
              onChange={(v) => patch("combo", v)}
            />
          )}

          {form.type === "BILL_DISCOUNT" && (
            <div className="grid gap-4 md:grid-cols-2">
              <Input
                label="Minimum order"
                prefix="₹"
                inputMode="decimal"
                hint="Blank = any bill"
                value={form.bill.minOrder}
                error={e("config.minOrder")}
                onChange={(ev) => patch("bill", { minOrder: decimalOnly(ev.target.value) })}
              />
              <div />
              <DiscountFields
                type={form.bill.discountType}
                value={form.bill.value}
                flatLabel="₹ off the bill"
                onType={(t) => patch("bill", { discountType: t, value: "" })}
                onValue={(v) => patch("bill", { value: v })}
                error={e("config.value") ?? e("config")}
              />
              {form.bill.discountType === "PERCENT" && (
                <Input
                  label="Maximum discount (optional)"
                  prefix="₹"
                  inputMode="decimal"
                  hint="Blank = no cap"
                  value={form.bill.maxDiscount}
                  error={e("config.maxDiscount")}
                  onChange={(ev) => patch("bill", { maxDiscount: decimalOnly(ev.target.value) })}
                />
              )}
            </div>
          )}
        </section>

        {/* Schedule */}
        <section className="space-y-4">
          <h3 className="text-sm font-bold uppercase tracking-wide text-muted">Schedule</h3>
          <div className="grid gap-4 md:grid-cols-2">
            <Input label="Starts" type="datetime-local" value={form.startsAt} error={e("startsAt")} hint="Blank = starts now" onChange={(ev) => set("startsAt", ev.target.value)} />
            <Input label="Ends" type="datetime-local" value={form.endsAt} error={e("endsAt")} hint="Blank = no end date" onChange={(ev) => set("endsAt", ev.target.value)} />
          </div>
          <Field label="Days of week" hint={form.daysOfWeek.length ? undefined : "None selected — runs every day"} error={e("daysOfWeek")}>
            <div className="flex flex-wrap gap-2" role="group" aria-label="Days of week">
              {WEEKDAYS.map((d, i) => {
                const on = form.daysOfWeek.includes(i);
                return (
                  <button
                    key={d}
                    type="button"
                    aria-pressed={on}
                    onClick={() => set("daysOfWeek", on ? form.daysOfWeek.filter((x) => x !== i) : [...form.daysOfWeek, i])}
                    className={clsx(
                      "min-h-tap min-w-[56px] rounded-xl border px-3 text-sm font-semibold transition-colors",
                      on ? "border-primary bg-primary text-primary-fg" : "border-line hover:bg-surface-2",
                    )}
                  >
                    {d}
                  </button>
                );
              })}
            </div>
          </Field>
          <div className="grid gap-4 sm:grid-cols-3">
            <Input label="Daily from" type="time" value={form.startTime} error={e("startTime")} onChange={(ev) => set("startTime", ev.target.value)} />
            <Input label="Daily until" type="time" value={form.endTime} error={e("endTime")} hint="Both or neither; may cross midnight" onChange={(ev) => set("endTime", ev.target.value)} />
            <div className="flex items-end">
              {(form.startTime || form.endTime) && (
                <Button variant="ghost" size="sm" onClick={() => setForm((f) => (f ? { ...f, startTime: "", endTime: "" } : f))}>
                  Clear time window
                </Button>
              )}
            </div>
          </div>
        </section>

        {/* Scope */}
        <section className="grid gap-4 md:grid-cols-[1fr_200px]">
          <Field label="Outlets" hint={form.outletIds.length ? undefined : "None selected — applies at all outlets"}>
            <div className="flex flex-wrap gap-2">
              {(me?.outlets ?? []).map((o) => {
                const on = form.outletIds.includes(o.id);
                return (
                  <label key={o.id} className={clsx("flex min-h-tap cursor-pointer items-center gap-2 rounded-xl border px-3", on ? "border-primary bg-primary-50 dark:bg-primary/15" : "border-line")}>
                    <input
                      type="checkbox"
                      className="h-5 w-5 accent-primary"
                      checked={on}
                      onChange={() => set("outletIds", on ? form.outletIds.filter((x) => x !== o.id) : [...form.outletIds, o.id])}
                    />
                    <span className="font-medium">{o.name}</span>
                  </label>
                );
              })}
            </div>
          </Field>
          <Input
            label="Priority"
            inputMode="numeric"
            hint="Higher runs first"
            value={form.priority}
            error={e("priority")}
            onChange={(ev) => set("priority", signedDigits(ev.target.value))}
          />
          <Toggle
            label="Can combine with other offers"
            description="Off (default): one offer per bill, the one that saves most. On: this offer also applies on top, on items no other offer has discounted."
            checked={form.combinable}
            onChange={(v) => set("combinable", v)}
          />
        </section>
      </div>
    </Dialog>
  );
}

function DiscountFields({
  type,
  value,
  flatLabel,
  onType,
  onValue,
  error,
}: {
  type: DiscountType;
  value: string;
  flatLabel: string;
  onType: (t: DiscountType) => void;
  onValue: (v: string) => void;
  error?: string;
}) {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <div className="flex flex-col gap-1.5">
        <span className="text-sm font-semibold">Discount type</span>
        <Segmented
          value={type}
          onChange={onType}
          options={[
            { value: "PERCENT", label: "Percent %" },
            { value: "FLAT", label: "Flat ₹" },
          ]}
        />
      </div>
      <Input
        label={type === "PERCENT" ? "Percent off" : flatLabel}
        prefix={type === "PERCENT" ? "%" : "₹"}
        inputMode="decimal"
        value={value}
        error={error}
        onChange={(ev) => onValue(decimalOnly(ev.target.value))}
      />
    </div>
  );
}

function ComboEditor({
  state,
  menu,
  errors,
  onChange,
}: {
  state: ComboState;
  menu: Menu | undefined;
  errors: Record<string, string>;
  onChange: (v: Partial<ComboState>) => void;
}) {
  const items = menu?.items ?? [];
  const byId = new Map(items.map((i) => [i.id, i]));
  const menuTotal = state.items.reduce((s, r) => s + (byId.get(r.menuItemId)?.price ?? 0) * (Number(r.quantity) || 0), 0);
  const price = parseRupees(state.price);
  const setRow = (idx: number, v: Partial<ComboState["items"][number]>) => onChange({ items: state.items.map((r, i) => (i === idx ? { ...r, ...v } : r)) });

  return (
    <div className="space-y-3">
      {errors["config.items"] && <Alert>{errors["config.items"]}</Alert>}
      {state.items.map((row, idx) => (
        <div key={idx} className="flex items-start gap-2">
          <Select
            aria-label={`Combo item ${idx + 1}`}
            wrapperClassName="flex-1"
            value={row.menuItemId}
            error={errors[`config.items.${idx}.menuItemId`]}
            onChange={(ev) => setRow(idx, { menuItemId: ev.target.value })}
          >
            <option value="">{menu ? "Choose an item" : "Loading menu…"}</option>
            {items.map((i) => (
              <option key={i.id} value={i.id}>
                {i.name} — {formatINR(i.price)}
              </option>
            ))}
          </Select>
          <Input
            aria-label={`Quantity of combo item ${idx + 1}`}
            inputMode="numeric"
            wrapperClassName="w-20"
            value={row.quantity}
            error={errors[`config.items.${idx}.quantity`]}
            onChange={(ev) => setRow(idx, { quantity: digitsOnly(ev.target.value) })}
          />
          <IconButton label={`Remove combo item ${idx + 1}`} disabled={state.items.length <= 1} onClick={() => onChange({ items: state.items.filter((_, i) => i !== idx) })}>
            <Trash size={20} />
          </IconButton>
        </div>
      ))}
      <Button variant="outline" size="sm" icon={<Plus size={18} />} onClick={() => onChange({ items: [...state.items, { menuItemId: "", quantity: "1" }] })} disabled={state.items.length >= 20}>
        Add item
      </Button>
      <div className="grid gap-4 sm:grid-cols-2">
        <Input
          label="Combo price"
          prefix="₹"
          inputMode="decimal"
          value={state.price}
          error={errors["config.price"]}
          hint={menuTotal ? `Menu total ${formatINR(menuTotal)}${price !== null && price < menuTotal ? ` · saves ${formatINR(menuTotal - price)}` : ""}` : undefined}
          onChange={(ev) => onChange({ price: decimalOnly(ev.target.value) })}
        />
      </div>
    </div>
  );
}
