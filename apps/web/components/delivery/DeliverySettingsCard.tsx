"use client";

import { useEffect, useState } from "react";
import clsx from "clsx";
import { FloppyDisk, MapPinArea, NotePencil, X } from "@phosphor-icons/react";
import { deliverySettingsSchema, formatINR, PINCODE_RE, type DeliveryAddressMode } from "@canavo/shared";
import { api, errorMessage } from "@/lib/api";
import { parseRupees, rupeesInput } from "@/lib/format";
import { useApiQuery } from "@/hooks/useApiQuery";
import { useSession } from "@/components/providers/SessionProvider";
import { useToast } from "@/components/providers/ToastProvider";
import { Button } from "@/components/ui/Button";
import { Card, CardHeader } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import { Alert, ErrorState, LoadingState } from "@/components/ui/States";

export interface DeliverySettingsView {
  addressMode: DeliveryAddressMode;
  flatFee: number;
  minOrder: number;
  areas: string[];
  etaMinutes: number;
  outletLocation: boolean;
}

const MODES: { value: DeliveryAddressMode; title: string; text: string; icon: React.ReactNode }[] = [
  { value: "MAP", title: "Map pin", text: "Customers and cashiers drop a pin. Zones and distance decide the fee and where you deliver.", icon: <MapPinArea size={26} /> },
  { value: "ADDRESS", title: "Address only (no map)", text: "Typed address, landmark and PIN code. One flat fee; optionally only the PIN codes / areas you list.", icon: <NotePencil size={26} /> },
];

/**
 * Delivery → Zones & settings: how delivery addresses are taken (owner / manager change it; others
 * see it read-only). Applies to the online ordering page and to POS delivery orders.
 */
export function DeliverySettingsCard({ onMode }: { onMode?: (mode: DeliveryAddressMode) => void }) {
  const { outletId, can } = useSession();
  const toast = useToast();
  const canEdit = can("settings:outlet");
  const q = useApiQuery<DeliverySettingsView>(outletId ? `delivery-settings:${outletId}` : null, () => api.get<DeliverySettingsView>("/delivery/settings"));
  const [mode, setMode] = useState<DeliveryAddressMode>("MAP");
  const [fee, setFee] = useState("");
  const [minOrder, setMinOrder] = useState("");
  const [eta, setEta] = useState("30");
  const [areas, setAreas] = useState<string[]>([]);
  const [areaInput, setAreaInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!q.data) return;
    setMode(q.data.addressMode);
    setFee(q.data.flatFee ? rupeesInput(q.data.flatFee) : "");
    setMinOrder(q.data.minOrder ? rupeesInput(q.data.minOrder) : "");
    setEta(String(q.data.etaMinutes));
    setAreas(q.data.areas);
    onMode?.(q.data.addressMode);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q.data]);

  if (q.loading && !q.data) return <LoadingState label="Loading delivery settings…" />;
  if (q.error && !q.data) return <ErrorState message={q.error} onRetry={q.reload} />;
  if (!q.data) return null;

  const addAreas = (raw: string) => {
    const next = raw
      .split(/[,\n]/)
      .map((s) => s.trim())
      .filter((s) => s.length >= 2);
    if (!next.length) return;
    const bad = next.find((s) => /^\d+$/.test(s) && !PINCODE_RE.test(s));
    if (bad) return setError(`${bad}: PIN codes are 6 digits`);
    setError(null);
    setAreas((cur) => [...new Map([...cur, ...next].map((x) => [x.toLowerCase(), x])).values()]);
    setAreaInput("");
  };

  const save = async () => {
    const body = {
      addressMode: mode,
      flatFee: fee.trim() ? parseRupees(fee) : 0,
      minOrder: minOrder.trim() ? parseRupees(minOrder) : 0,
      etaMinutes: Math.floor(Number(eta)),
      areas,
    };
    if (body.flatFee === null) return setError("Delivery fee: enter an amount in rupees");
    if (body.minOrder === null) return setError("Minimum order: enter an amount in rupees");
    const parsed = deliverySettingsSchema.safeParse(body);
    if (!parsed.success) {
      const i = parsed.error.issues[0];
      return setError(`${i.path.join(".") || "Settings"}: ${i.message}`);
    }
    setSaving(true);
    setError(null);
    try {
      const r = await api.put<DeliverySettingsView>("/delivery/settings", body);
      q.setData(r);
      toast(r.addressMode === "ADDRESS" ? "Delivery is now address-only (no map)" : "Delivery uses the map pin and zones", "success");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader title="Delivery address" subtitle="How customers (online page) and cashiers (POS) give the delivery address." />
      <div className="space-y-4 px-5 py-4" data-testid="delivery-settings">
        <div role="radiogroup" aria-label="Delivery address" className="grid gap-3 md:grid-cols-2">
          {MODES.map((m) => (
            <label
              key={m.value}
              className={clsx(
                "flex cursor-pointer gap-3 rounded-2xl border-2 p-4 transition-colors",
                mode === m.value ? "border-primary bg-primary-50 dark:bg-primary/10" : "border-line hover:border-primary/40",
                !canEdit && "cursor-default opacity-80",
              )}
            >
              <input type="radio" name="delivery-mode" className="sr-only" checked={mode === m.value} disabled={!canEdit} onChange={() => setMode(m.value)} />
              <span className={clsx("flex h-11 w-11 shrink-0 items-center justify-center rounded-xl", mode === m.value ? "bg-primary text-primary-fg" : "bg-surface-2 text-fg")}>{m.icon}</span>
              <span>
                <span className="block font-bold text-fg">{m.title}</span>
                <span className="block text-sm text-muted">{m.text}</span>
              </span>
            </label>
          ))}
        </div>
        {mode === "MAP" && !q.data.outletLocation && <Alert tone="warning">Set the outlet&apos;s location in Settings → Outlet, or customers will pick an area instead of a pin.</Alert>}
        {mode === "ADDRESS" && (
          <div className="space-y-4 rounded-2xl border border-line p-4">
            <div className="grid gap-3 sm:grid-cols-3">
              <Input label="Delivery fee (flat)" prefix="₹" inputMode="decimal" value={fee} disabled={!canEdit} onChange={(e) => setFee(e.target.value.replace(/[^\d.]/g, ""))} hint={fee ? undefined : "Empty = free delivery"} />
              <Input label="Minimum order" prefix="₹" inputMode="decimal" value={minOrder} disabled={!canEdit} onChange={(e) => setMinOrder(e.target.value.replace(/[^\d.]/g, ""))} hint={minOrder ? undefined : "Empty = no minimum"} />
              <Input label="Delivery time (minutes)" inputMode="numeric" value={eta} disabled={!canEdit} onChange={(e) => setEta(e.target.value.replace(/\D/g, ""))} />
            </div>
            <div>
              <p className="text-sm font-semibold text-fg">Where you deliver</p>
              <p className="mb-2 text-xs text-muted">PIN codes and / or area names. Empty = anywhere. Orders outside the list are refused with a clear message.</p>
              <div className="flex flex-wrap gap-2" aria-label="Allowed areas">
                {areas.map((a) => (
                  <span key={a} className="inline-flex items-center gap-1 rounded-full border border-line bg-surface-2 py-1 pl-3 pr-1 text-sm font-semibold">
                    {a}
                    {canEdit && (
                      <button type="button" aria-label={`Remove ${a}`} onClick={() => setAreas((cur) => cur.filter((x) => x !== a))} className="flex h-6 w-6 items-center justify-center rounded-full hover:bg-line">
                        <X size={14} />
                      </button>
                    )}
                  </span>
                ))}
                {!areas.length && <span className="text-sm text-muted">Anywhere</span>}
              </div>
              {canEdit && (
                <div className="mt-2 flex gap-2">
                  <Input
                    aria-label="Add PIN code or area"
                    placeholder="e.g. 600017, T Nagar"
                    value={areaInput}
                    wrapperClassName="flex-1"
                    onChange={(e) => setAreaInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        addAreas(areaInput);
                      }
                    }}
                  />
                  <Button variant="outline" onClick={() => addAreas(areaInput)} disabled={!areaInput.trim()}>
                    Add
                  </Button>
                </div>
              )}
            </div>
            <p className="text-xs text-muted">
              Customers see: {fee ? `${formatINR(parseRupees(fee) ?? 0)} delivery` : "free delivery"} · ~{eta || "30"} min{minOrder ? ` · minimum ${formatINR(parseRupees(minOrder) ?? 0)}` : ""}. Delivery partners get the typed address with an
              &quot;Open in Google Maps&quot; link.
            </p>
          </div>
        )}
        {error && <Alert>{error}</Alert>}
        {canEdit ? (
          <div className="flex justify-end">
            <Button icon={<FloppyDisk size={20} />} loading={saving} onClick={() => void save()}>
              Save
            </Button>
          </div>
        ) : (
          <p className="text-xs text-muted">Only the owner or a manager can change this.</p>
        )}
      </div>
    </Card>
  );
}
