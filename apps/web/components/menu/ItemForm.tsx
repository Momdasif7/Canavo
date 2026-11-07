"use client";

import { useEffect, useState } from "react";
import { Plus, Trash } from "@phosphor-icons/react";
import { GST_RATES, menuItemSchema } from "@canavo/shared";
import { api, errorMessage } from "@/lib/api";
import { parseRupees, rupeesInput } from "@/lib/format";
import type { FoodType, ItemStatus, MenuCategory, RawMenuItem, TaxRate } from "@/lib/types";
import { describeRate, fetchTaxRates, round2 } from "@/lib/tax";
import { useApiQuery } from "@/hooks/useApiQuery";
import { useSession } from "@/components/providers/SessionProvider";
import { useToast } from "@/components/providers/ToastProvider";
import { Dialog } from "@/components/ui/Dialog";
import { Button, IconButton } from "@/components/ui/Button";
import { Input, Select, Textarea } from "@/components/ui/Input";
import { Alert, LoadingState } from "@/components/ui/States";
import { FoodMark } from "@/components/ui/FoodMark";
import { ImageUpload } from "@/components/ui/ImageUpload";
import { Segmented } from "@/components/ui/Segmented";
import { ItemIngredients, useCanEditIngredients, useItemIngredients } from "./ItemIngredients";

interface PriceRow {
  name: string;
  price: string;
}

interface FormState {
  name: string;
  description: string;
  categoryId: string;
  price: string;
  foodType: FoodType;
  gstRate: string;
  /** "" = business default */
  taxRateId: string;
  hsnCode: string;
  imageUrl: string;
  status: ItemStatus;
  allergens: string;
  availableFrom: string;
  availableTo: string;
  kitchenStation: string;
  variants: PriceRow[];
  addons: PriceRow[];
}

const blank = (categoryId: string): FormState => ({
  name: "",
  description: "",
  categoryId,
  price: "",
  foodType: "VEG",
  // New items are GST-exempt by default (0%); "" taxRateId = the business default rate ("GST 0% (Exempt)").
  gstRate: "0",
  taxRateId: "",
  hsnCode: "996331",
  imageUrl: "",
  status: "AVAILABLE",
  allergens: "",
  availableFrom: "",
  availableTo: "",
  kitchenStation: "MAIN",
  variants: [],
  addons: [],
});

const fromItem = (i: RawMenuItem): FormState => ({
  name: i.name,
  description: i.description,
  categoryId: i.categoryId,
  price: rupeesInput(i.price),
  foodType: i.foodType,
  gstRate: String(i.gstRate),
  taxRateId: i.taxRateId ?? "",
  hsnCode: i.hsnCode,
  imageUrl: i.imageUrl ?? "",
  status: i.status,
  allergens: i.allergens.join(", "),
  availableFrom: i.availableFrom ?? "",
  availableTo: i.availableTo ?? "",
  kitchenStation: i.kitchenStation,
  variants: i.variants.map((v) => ({ name: v.name, price: rupeesInput(v.price) })),
  addons: i.addons.map((a) => ({ name: a.name, price: rupeesInput(a.price) })),
});

function PriceRows({ label, rows, onChange, namePlaceholder }: { label: string; rows: PriceRow[]; onChange: (r: PriceRow[]) => void; namePlaceholder: string }) {
  return (
    <fieldset className="space-y-2">
      <div className="flex items-center justify-between">
        <legend className="text-sm font-semibold">{label}</legend>
        <Button variant="ghost" size="sm" icon={<Plus size={16} />} onClick={() => onChange([...rows, { name: "", price: "" }])}>
          Add
        </Button>
      </div>
      {rows.length === 0 && <p className="text-xs text-muted">None</p>}
      {rows.map((r, idx) => (
        <div key={idx} className="flex gap-2">
          <Input
            wrapperClassName="flex-1"
            aria-label={`${label} name`}
            placeholder={namePlaceholder}
            value={r.name}
            onChange={(e) => onChange(rows.map((x, i) => (i === idx ? { ...x, name: e.target.value } : x)))}
          />
          <Input
            wrapperClassName="w-32"
            aria-label={`${label} price`}
            inputMode="decimal"
            prefix="₹"
            placeholder="0"
            value={r.price}
            onChange={(e) => onChange(rows.map((x, i) => (i === idx ? { ...x, price: e.target.value.replace(/[^\d.]/g, "") } : x)))}
          />
          <IconButton label="Remove" onClick={() => onChange(rows.filter((_, i) => i !== idx))}>
            <Trash size={20} />
          </IconButton>
        </div>
      ))}
    </fieldset>
  );
}

/** Create / edit a menu item. `itemId` undefined = create; null = closed. */
export function ItemForm({
  itemId,
  categories,
  defaultCategoryId,
  onClose,
  onSaved,
}: {
  itemId: string | null | undefined;
  categories: MenuCategory[];
  defaultCategoryId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const toast = useToast();
  const { me, outletId, outlet } = useSession();
  const open = itemId !== null;
  // Business tax rates; on older servers (404) we fall back to the fixed GST slab select.
  const taxRates = useApiQuery<TaxRate[]>(open && outletId ? `tax-rates:${me?.business?.id ?? outletId}` : null, fetchTaxRates);
  const rates = taxRates.data;
  const defaultRate = rates?.find((r) => r.isDefault);
  const [form, setForm] = useState<FormState>(blank(defaultCategoryId));
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canIngredients = useCanEditIngredients();
  const ingredients = useItemIngredients(open, itemId ?? undefined, canIngredients);

  useEffect(() => {
    if (!open) return;
    setError(null);
    if (!itemId) {
      setForm(blank(defaultCategoryId));
      return;
    }
    setLoading(true);
    api
      .get<RawMenuItem>(`/menu/items/${itemId}`)
      .then((i) => setForm(fromItem(i)))
      .catch((e) => setError(errorMessage(e)))
      .finally(() => setLoading(false));
  }, [open, itemId, defaultCategoryId]);

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) => setForm((f) => ({ ...f, [k]: v }));

  const save = async () => {
    const price = parseRupees(form.price);
    const toRows = (rows: PriceRow[]) =>
      rows.filter((r) => r.name.trim()).map((r) => ({ name: r.name.trim(), price: parseRupees(r.price) ?? 0 }));
    const chosen = rates ? (form.taxRateId ? rates.find((r) => r.id === form.taxRateId) : defaultRate) : undefined;
    // Keep gstRate in step with the chosen rate for older readers (receipts, reports) when it's a standard slab.
    const slab = chosen ? round2(chosen.igst || chosen.cgst + chosen.sgst) : Number(form.gstRate);
    const gstRate = (GST_RATES as readonly number[]).includes(slab) ? slab : Number(form.gstRate);
    const payload = {
      name: form.name.trim(),
      description: form.description.trim(),
      categoryId: form.categoryId,
      price: price ?? -1,
      foodType: form.foodType,
      gstRate,
      hsnCode: form.hsnCode.trim(),
      imageUrl: form.imageUrl.trim(),
      status: form.status,
      allergens: form.allergens.split(",").map((a) => a.trim()).filter(Boolean),
      availableFrom: form.availableFrom || null,
      availableTo: form.availableTo || null,
      kitchenStation: form.kitchenStation.trim().toUpperCase() || "MAIN",
      variants: toRows(form.variants),
      addons: toRows(form.addons),
    };
    if (price === null) return setError("Enter a valid price");
    if (!!payload.availableFrom !== !!payload.availableTo) return setError("Set both 'available from' and 'to', or neither");
    const parsed = menuItemSchema.safeParse(payload);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return setError(`${issue.path.join(".") || "Item"}: ${issue.message}`);
    }
    const ingredientError = ingredients.validate();
    if (ingredientError) return setError(ingredientError);
    setSaving(true);
    setError(null);
    // taxRateId isn't in older shared schemas, so add it after validation (null = business default).
    const body = rates ? { ...parsed.data, taxRateId: form.taxRateId || null } : parsed.data;
    try {
      const saved = itemId ? await api.patch<{ id: string }>(`/menu/items/${itemId}`, body) : await api.post<{ id: string }>("/menu/items", body);
      const savedId = itemId ?? saved?.id;
      let recipeNote = "";
      if (savedId && ingredients.dirty) {
        try {
          if (await ingredients.save(savedId)) recipeNote = " · ingredients saved";
        } catch (e) {
          toast(`Item saved, but the ingredients couldn't be saved: ${errorMessage(e)}`, "error");
        }
      }
      toast(`${itemId ? "Item updated" : "Item created"}${recipeNote}`, "success");
      onSaved();
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!itemId || !window.confirm(`Delete “${form.name}”? Items on past bills are hidden instead.`)) return;
    setSaving(true);
    try {
      await api.del(`/menu/items/${itemId}`);
      toast("Item removed", "success");
      onSaved();
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const parents = categories.filter((c) => !c.parentId);

  // 0% GST safeguard (Phase 3.6): warn on GST-registered outlets.
  const effectiveRate = (() => {
    const r = rates ? (form.taxRateId ? rates.find((x) => x.id === form.taxRateId) : defaultRate) : undefined;
    return r ? (r.igst || r.cgst + r.sgst) : Number(form.gstRate);
  })();
  const zeroGstOnRegisteredOutlet = Boolean(outlet?.gstEnabled !== false && !outlet?.compositionScheme) && effectiveRate === 0;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      title={itemId ? "Edit item" : "New item"}
      footer={
        <>
          {itemId && (
            <Button variant="ghost" className="mr-auto text-red-600" onClick={remove} disabled={saving}>
              Delete
            </Button>
          )}
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} loading={saving} disabled={loading}>
            Save item
          </Button>
        </>
      }
    >
      {loading ? (
        <LoadingState />
      ) : (
        <div className="space-y-4">
          {error && <Alert>{error}</Alert>}
          <div className="grid gap-4 sm:grid-cols-2">
            <Input label="Name" required maxLength={100} value={form.name} onChange={(e) => set("name", e.target.value)} />
            <Select label="Category" value={form.categoryId} onChange={(e) => set("categoryId", e.target.value)}>
              {parents.map((p) => (
                <optgroup key={p.id} label={p.name}>
                  <option value={p.id}>{p.name}</option>
                  {categories
                    .filter((c) => c.parentId === p.id)
                    .map((c) => (
                      <option key={c.id} value={c.id}>
                        {p.name} › {c.name}
                      </option>
                    ))}
                </optgroup>
              ))}
            </Select>
          </div>
          <Textarea label="Description" maxLength={500} value={form.description} onChange={(e) => set("description", e.target.value)} />
          <div className="grid gap-4 sm:grid-cols-3">
            <Input
              label="Base price"
              inputMode="decimal"
              prefix="₹"
              required
              value={form.price}
              onChange={(e) => set("price", e.target.value.replace(/[^\d.]/g, ""))}
              hint="Used when the item has no sizes"
            />
            {rates ? (
              <Select
                label="Tax rate"
                value={form.taxRateId}
                onChange={(e) => set("taxRateId", e.target.value)}
                hint={(() => {
                  const r = form.taxRateId ? rates.find((x) => x.id === form.taxRateId) : defaultRate;
                  return r ? describeRate(r) : undefined;
                })()}
              >
                <option value="">Business default{defaultRate ? ` (${defaultRate.name})` : ""}</option>
                {rates
                  .filter((r) => r.active || r.id === form.taxRateId)
                  .map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                      {r.active ? "" : " (inactive)"}
                    </option>
                  ))}
              </Select>
            ) : (
              <Select label="GST rate" value={form.gstRate} onChange={(e) => set("gstRate", e.target.value)} disabled={taxRates.loading} hint={taxRates.loading ? "Loading tax rates…" : undefined}>
                {GST_RATES.map((r) => (
                  <option key={r} value={r}>
                    {r}%
                  </option>
                ))}
              </Select>
            )}
            <Input label="HSN / SAC" maxLength={8} value={form.hsnCode} onChange={(e) => set("hsnCode", e.target.value)} />
          </div>
          {zeroGstOnRegisteredOutlet && (
            <Alert tone="warning">
              This item will be billed at <b>0% GST</b>, but your outlet is GST-registered. Restaurant food is normally taxed (usually 5%). Keep 0% only if this item is
              really exempt.
            </Alert>
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <span className="text-sm font-semibold">Food type</span>
              <Segmented
                value={form.foodType}
                onChange={(v) => set("foodType", v)}
                options={[
                  { value: "VEG", label: <span className="flex items-center gap-1.5"><FoodMark type="VEG" size={12} /> Veg</span> },
                  { value: "EGG", label: <span className="flex items-center gap-1.5"><FoodMark type="EGG" size={12} /> Egg</span> },
                  { value: "NON_VEG", label: <span className="flex items-center gap-1.5"><FoodMark type="NON_VEG" size={12} /> Non-veg</span> },
                ]}
              />
            </div>
            <Select label="Status (all outlets)" value={form.status} onChange={(e) => set("status", e.target.value as ItemStatus)}>
              <option value="AVAILABLE">Available</option>
              <option value="OUT_OF_STOCK">Out of stock</option>
              <option value="HIDDEN">Hidden</option>
            </Select>
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            <Input label="Available from" type="time" value={form.availableFrom} onChange={(e) => set("availableFrom", e.target.value)} hint="Leave empty for all day" />
            <Input label="Available to" type="time" value={form.availableTo} onChange={(e) => set("availableTo", e.target.value)} />
            <Input label="Kitchen station" maxLength={40} value={form.kitchenStation} onChange={(e) => set("kitchenStation", e.target.value)} hint="e.g. MAIN, BEVERAGE" />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Input label="Allergens" placeholder="milk, nuts, gluten" value={form.allergens} onChange={(e) => set("allergens", e.target.value)} hint="Comma separated" />
            <ImageUpload label="Item photo" value={form.imageUrl} onChange={(url) => set("imageUrl", url)} />
          </div>
          <div className="grid gap-6 border-t border-line pt-4 sm:grid-cols-2">
            <PriceRows label="Sizes / variants" namePlaceholder="e.g. Large" rows={form.variants} onChange={(v) => set("variants", v)} />
            <PriceRows label="Add-ons" namePlaceholder="e.g. Extra cheese" rows={form.addons} onChange={(v) => set("addons", v)} />
          </div>
          <p className="text-xs text-muted">A size&apos;s price replaces the base price. Add-on prices are added on top.</p>
          {canIngredients && <ItemIngredients state={ingredients} />}
        </div>
      )}
    </Dialog>
  );
}
