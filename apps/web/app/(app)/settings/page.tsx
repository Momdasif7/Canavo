"use client";

import { useEffect, useState } from "react";
import { Crosshair, FloppyDisk, Plus, Printer, Trash } from "@phosphor-icons/react";
import { outletSchema, shiftSchema, type PaperWidth, toPaise } from "@canavo/shared";
import { api, errorMessage } from "@/lib/api";
import { getKotPaperWidth, getPaperWidth, setKotPaperWidth, setPaperWidth } from "@/lib/prefs";
import type { Outlet, Shift } from "@/lib/types";
import { useApiQuery } from "@/hooks/useApiQuery";
import { useSession } from "@/components/providers/SessionProvider";
import { useToast } from "@/components/providers/ToastProvider";
import { PageContainer, PageHeader } from "@/components/layout/PageHeader";
import { Card, CardHeader } from "@/components/ui/Card";
import { Button, IconButton } from "@/components/ui/Button";
import { Input, Textarea, Toggle } from "@/components/ui/Input";
import { Segmented } from "@/components/ui/Segmented";
import { ImageUpload } from "@/components/ui/ImageUpload";
import { Table, THead, Th, Td } from "@/components/ui/Table";
import { Alert, EmptyState, ErrorState, LoadingState } from "@/components/ui/States";
import { SettingsTabs } from "@/components/settings/SettingsTabs";
import { MoneyControlsCard } from "@/components/settings/MoneyControlsCard";
import Link from "next/link";
import { ArrowRight } from "@phosphor-icons/react";

export default function SettingsPage() {
  const { can } = useSession();
  return (
    <PageContainer>
      <PageHeader title="Settings" />
      <SettingsTabs />
      <div className="grid gap-5 xl:grid-cols-[1fr_420px]">
        <OutletSettings />
        <div className="space-y-5">
          <PrinterSettings />
          <MoneyControlsCard />
          {can("staff:view") && <Shifts />}
        </div>
      </div>
    </PageContainer>
  );
}

type OutletForm = {
  name: string;
  address: string;
  phone: string;
  fssai: string;
  latitude: string;
  longitude: string;
  geofenceMeters: string;
  serviceChargeEnabled: boolean;
  serviceChargePercent: string;
  roundOff: boolean;
  /** Rupees as typed */
  packagingCharge: string;
  maxDeliveriesPerPartner: string;
  upiVpa: string;
  logoUrl: string;
  posShowImages: boolean;
  backgroundTracking: boolean;
};

const toForm = (o: Outlet): OutletForm => ({
  name: o.name,
  address: o.address,
  phone: o.phone ?? "",
  fssai: o.fssai ?? "",
  latitude: o.latitude?.toString() ?? "",
  longitude: o.longitude?.toString() ?? "",
  geofenceMeters: String(o.geofenceMeters),
  serviceChargeEnabled: o.serviceChargeEnabled,
  serviceChargePercent: String(o.serviceChargePercent),
  roundOff: o.roundOff,
  packagingCharge: o.packagingCharge ? String(o.packagingCharge / 100) : "0",
  maxDeliveriesPerPartner: String(o.maxDeliveriesPerPartner ?? 2),
  upiVpa: o.upiVpa ?? "",
  logoUrl: o.logoUrl ?? "",
  posShowImages: o.posShowImages !== false,
  backgroundTracking: Boolean(o.backgroundTracking),
});

const optNum = (s: string) => (s.trim() === "" ? undefined : Number(s));

function OutletSettings() {
  const { outletId, can, reloadOutlet, outlet: sessionOutlet } = useSession();
  const toast = useToast();
  const editable = can("settings:outlet");
  const billing = can("settings:billing");
  const gstOn = sessionOutlet?.gstEnabled !== false;
  const outlet = useApiQuery<Outlet>(outletId ? `outlet:${outletId}` : null, () => api.get<Outlet>("/outlets/current"));
  const [form, setForm] = useState<OutletForm | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (outlet.data) setForm(toForm(outlet.data));
  }, [outlet.data]);

  if (outlet.loading && !outlet.data) return <Card><LoadingState /></Card>;
  if (outlet.error) return <Card><ErrorState message={outlet.error} onRetry={outlet.reload} /></Card>;
  if (!form || !outlet.data) return null;

  const set = <K extends keyof OutletForm>(k: K, v: OutletForm[K]) => setForm((f) => (f ? { ...f, [k]: v } : f));

  const locate = () => {
    if (!navigator.geolocation) return toast("Location is not available on this device", "error");
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        set("latitude", pos.coords.latitude.toFixed(6));
        set("longitude", pos.coords.longitude.toFixed(6));
      },
      (err) => toast(err.message || "Could not get location", "error"),
      { enableHighAccuracy: true, timeout: 10_000 },
    );
  };

  const save = async () => {
    const payload = {
      name: form.name.trim(),
      address: form.address.trim(),
      phone: form.phone.trim() || undefined,
      fssai: form.fssai.trim(),
      latitude: optNum(form.latitude),
      longitude: optNum(form.longitude),
      geofenceMeters: Number(form.geofenceMeters),
      serviceChargeEnabled: form.serviceChargeEnabled,
      serviceChargePercent: Number(form.serviceChargePercent) || 0,
      roundOff: form.roundOff,
      packagingCharge: toPaise(Number(form.packagingCharge) || 0),
      maxDeliveriesPerPartner: form.maxDeliveriesPerPartner.trim() === "" ? 2 : Number(form.maxDeliveriesPerPartner),
      upiVpa: form.upiVpa.trim() || undefined,
      logoUrl: form.logoUrl,
      posShowImages: form.posShowImages,
      backgroundTracking: form.backgroundTracking,
    };
    const maxOrders = payload.maxDeliveriesPerPartner;
    if (!Number.isInteger(maxOrders) || maxOrders < 1 || maxOrders > 10) return setError("Max orders per delivery partner must be between 1 and 10");
    const parsed = outletSchema.partial().safeParse(payload);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return setError(`${issue.path.join(".")}: ${issue.message}`);
    }
    setSaving(true);
    setError(null);
    try {
      const updated = await api.patch<Outlet>("/outlets/current", parsed.data);
      outlet.setData(updated);
      await reloadOutlet();
      toast("Outlet settings saved", "success");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader
        title="Outlet profile"
        subtitle={editable ? "Changes apply to new bills immediately." : "Only managers can change these settings."}
        action={
          editable && (
            <Button icon={<FloppyDisk size={20} />} onClick={save} loading={saving}>
              Save
            </Button>
          )
        }
      />
      <fieldset disabled={!editable} className="space-y-6 p-5">
        {error && <Alert>{error}</Alert>}
        <section className="grid gap-4 md:grid-cols-2">
          <Input label="Outlet name" value={form.name} onChange={(e) => set("name", e.target.value)} />
          <Input label="Phone" value={form.phone} onChange={(e) => set("phone", e.target.value)} />
          <div className="md:col-span-2">
            <Textarea label="Address" value={form.address} maxLength={500} onChange={(e) => set("address", e.target.value)} />
          </div>
          <ImageUpload
            label="Logo"
            value={form.logoUrl}
            onChange={(url) => set("logoUrl", url)}
            disabled={!editable}
            hint="Outlet branding. PNG, JPG or WebP, up to 5 MB."
          />
        </section>

        <section>
          <h3 className="mb-3 text-sm font-bold uppercase tracking-wide text-muted">Billing & compliance</h3>
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line bg-surface-2 px-4 py-3">
            <div className="text-sm">
              <p className="font-semibold">GST {gstOn ? "registered" : "not registered"}</p>
              <p className="text-muted">GSTIN, tax rates, composition scheme and invoice prefix live under GST &amp; Taxes.</p>
            </div>
            {billing && (
              <Link href="/settings/taxes" className="inline-flex min-h-[40px] items-center gap-1.5 rounded-xl border border-line bg-surface px-3 text-sm font-semibold hover:bg-surface-2">
                GST &amp; Taxes <ArrowRight size={16} />
              </Link>
            )}
          </div>
          <div className="grid gap-4 md:grid-cols-3">
            <Input label="FSSAI licence" maxLength={14} inputMode="numeric" value={form.fssai} onChange={(e) => set("fssai", e.target.value.replace(/\D/g, ""))} />
          </div>
          <div className="mt-4 grid gap-x-8 md:grid-cols-2">
            <Toggle label="Round off to nearest rupee" checked={form.roundOff} onChange={(v) => set("roundOff", v)} disabled={!editable} />
            <Toggle label="Service charge (dine-in only)" checked={form.serviceChargeEnabled} onChange={(v) => set("serviceChargeEnabled", v)} disabled={!editable} />
          </div>
          {form.serviceChargeEnabled && (
            <Input
              wrapperClassName="mt-3 max-w-[200px]"
              label="Service charge %"
              type="number"
              min={0}
              max={20}
              step="0.5"
              value={form.serviceChargePercent}
              onChange={(e) => set("serviceChargePercent", e.target.value)}
            />
          )}
          <Input
            wrapperClassName="mt-4 max-w-[260px]"
            label="Packaging charge (₹)"
            type="number"
            min={0}
            max={1000}
            step="0.5"
            inputMode="decimal"
            value={form.packagingCharge}
            onChange={(e) => set("packagingCharge", e.target.value)}
            hint={
              gstOn
                ? "Added to every takeaway and delivery bill; GST applies at the items' rate. 0 = no charge."
                : "Added to every takeaway and delivery bill. 0 = no charge."
            }
          />
        </section>

        <section>
          <h3 className="mb-3 text-sm font-bold uppercase tracking-wide text-muted">POS screen</h3>
          <div className="max-w-md">
            <Toggle
              label="Show item photos on POS"
              description="Turn off for faster text-only cards on slow devices"
              checked={form.posShowImages}
              onChange={(v) => set("posShowImages", v)}
              disabled={!editable}
            />
          </div>
        </section>

        <section>
          <h3 className="mb-3 text-sm font-bold uppercase tracking-wide text-muted">Delivery dispatch</h3>
          <Input
            wrapperClassName="max-w-[260px]"
            label="Max orders per delivery partner"
            type="number"
            min={1}
            max={10}
            step={1}
            inputMode="numeric"
            value={form.maxDeliveriesPerPartner}
            onChange={(e) => set("maxDeliveriesPerPartner", e.target.value.replace(/\D/g, ""))}
            hint="A partner can't get new orders until they deliver and come back to the outlet."
          />
          <div className="mt-4 max-w-md">
            <Toggle
              label="Track partners in the background while on a run"
              description="The partner app keeps sharing GPS with the screen locked, only between pickup and the return to the outlet, and only for partners who allow it. Off: tracking pauses when the app is closed."
              checked={form.backgroundTracking}
              onChange={(v) => set("backgroundTracking", v)}
              disabled={!editable}
            />
          </div>
        </section>

        <section>
          <h3 className="mb-3 text-sm font-bold uppercase tracking-wide text-muted">Payments</h3>
          <div className="grid gap-4 md:grid-cols-2">
            <Input label="UPI VPA" placeholder="canteen@okaxis" value={form.upiVpa} onChange={(e) => set("upiVpa", e.target.value)} hint="Used for UPI QR codes when no gateway is configured" />
          </div>
        </section>

        <section>
          <div className="mb-3 flex items-center justify-between">
            <h3 className="text-sm font-bold uppercase tracking-wide text-muted">Attendance geofence</h3>
            {editable && (
              <Button variant="ghost" size="sm" icon={<Crosshair size={18} />} onClick={locate}>
                Use my location
              </Button>
            )}
          </div>
          <div className="grid gap-4 md:grid-cols-3">
            <Input label="Latitude" inputMode="decimal" value={form.latitude} onChange={(e) => set("latitude", e.target.value)} />
            <Input label="Longitude" inputMode="decimal" value={form.longitude} onChange={(e) => set("longitude", e.target.value)} />
            <Input label="Radius (metres)" type="number" min={20} max={5000} value={form.geofenceMeters} onChange={(e) => set("geofenceMeters", e.target.value)} />
          </div>
        </section>
      </fieldset>
    </Card>
  );
}

function PrinterSettings() {
  const toast = useToast();
  const [paper, setPaper] = useState<PaperWidth>(58);
  const [kotPaper, setKotPaper] = useState<PaperWidth>(58);
  useEffect(() => {
    setPaper(getPaperWidth());
    setKotPaper(getKotPaperWidth());
  }, []);
  return (
    <Card>
      <CardHeader title="Receipt printer" subtitle="Saved on this device" action={<Printer size={24} className="text-muted" />} />
      <div className="space-y-2 p-5">
        <span className="text-sm font-semibold">Receipt paper</span>
        <Segmented
          className="w-full"
          value={String(paper) as "58" | "80"}
          onChange={(v) => {
            const w: PaperWidth = v === "80" ? 80 : 58;
            setPaper(w);
            setPaperWidth(w);
            toast(`Receipts will print on ${w} mm paper`, "success");
          }}
          options={[
            { value: "58", label: "58 mm (2 inch)" },
            { value: "80", label: "80 mm (3 inch)" },
          ]}
        />
        <span className="block pt-3 text-sm font-semibold">Kitchen ticket (KOT) paper</span>
        <Segmented
          className="w-full"
          value={String(kotPaper) as "58" | "80"}
          onChange={(v) => {
            const w: PaperWidth = v === "80" ? 80 : 58;
            setKotPaper(w);
            setKotPaperWidth(w);
            toast(`Kitchen tickets will print on ${w} mm paper`, "success");
          }}
          options={[
            { value: "58", label: "58 mm (2 inch)" },
            { value: "80", label: "80 mm (3 inch)" },
          ]}
        />
        <p className="text-xs text-muted">In the browser print dialog, pick the thermal printer and set margins to “None”.</p>
      </div>
    </Card>
  );
}

function Shifts() {
  const { outletId, can } = useSession();
  const toast = useToast();
  const manage = can("staff:manage");
  const shifts = useApiQuery<Shift[]>(outletId ? `shifts:${outletId}` : null, () => api.get<Shift[]>("/outlets/current/shifts"));
  const [draft, setDraft] = useState({ name: "", startTime: "09:00", endTime: "17:00", graceMinutes: "10" });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const add = async () => {
    const parsed = shiftSchema.safeParse({ ...draft, name: draft.name.trim(), graceMinutes: Number(draft.graceMinutes) || 0 });
    if (!parsed.success) return setError(parsed.error.issues[0].message);
    setSaving(true);
    setError(null);
    try {
      await api.post("/outlets/current/shifts", parsed.data);
      setDraft({ name: "", startTime: "09:00", endTime: "17:00", graceMinutes: "10" });
      await shifts.reload();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (s: Shift) => {
    if (!window.confirm(`Delete the ${s.name} shift?`)) return;
    try {
      await api.del(`/outlets/current/shifts/${s.id}`);
      shifts.setData((l) => l?.filter((x) => x.id !== s.id));
    } catch (e) {
      toast(errorMessage(e), "error");
    }
  };

  return (
    <Card>
      <CardHeader title="Shifts" subtitle="Used for late / early / overtime calculation" />
      {shifts.loading && !shifts.data ? (
        <LoadingState />
      ) : shifts.error ? (
        <ErrorState message={shifts.error} onRetry={shifts.reload} />
      ) : !shifts.data?.length ? (
        <EmptyState title="No shifts yet" />
      ) : (
        <Table>
          <THead>
            <tr>
              <Th>Name</Th>
              <Th>Time</Th>
              <Th className="text-right">Grace</Th>
              {manage && <Th />}
            </tr>
          </THead>
          <tbody>
            {shifts.data.map((s) => (
              <tr key={s.id}>
                <Td className="font-semibold">{s.name}</Td>
                <Td className="tabular">
                  {s.startTime}–{s.endTime}
                </Td>
                <Td className="tabular text-right">{s.graceMinutes}m</Td>
                {manage && (
                  <Td className="text-right">
                    <IconButton label={`Delete ${s.name}`} className="text-red-600" onClick={() => remove(s)}>
                      <Trash size={20} />
                    </IconButton>
                  </Td>
                )}
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      {manage && (
        <div className="space-y-3 border-t border-line p-5">
          {error && <Alert>{error}</Alert>}
          <div className="grid grid-cols-2 gap-3">
            <Input wrapperClassName="col-span-2" label="New shift" placeholder="e.g. Lunch" maxLength={50} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
            <Input label="Start" type="time" value={draft.startTime} onChange={(e) => setDraft({ ...draft, startTime: e.target.value })} />
            <Input label="End" type="time" value={draft.endTime} onChange={(e) => setDraft({ ...draft, endTime: e.target.value })} />
            <Input label="Grace (min)" type="number" min={0} max={120} value={draft.graceMinutes} onChange={(e) => setDraft({ ...draft, graceMinutes: e.target.value })} />
            <div className="flex items-end">
              <Button block variant="secondary" icon={<Plus size={18} />} loading={saving} onClick={add}>
                Add shift
              </Button>
            </div>
          </div>
          <p className="text-xs text-muted">Shifts can&apos;t be edited after creation (API limitation) — delete and re-create instead.</p>
        </div>
      )}
    </Card>
  );
}
