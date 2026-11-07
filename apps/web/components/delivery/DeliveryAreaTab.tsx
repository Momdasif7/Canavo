"use client";

import { useEffect, useState } from "react";
import { FloppyDisk, MapTrifold, NotePencil, X } from "@phosphor-icons/react";
import { deliveryLocationUpdateSchema, formatINR, PINCODE_RE, type DeliveryLocationMode, type DeliveryLocationSettings } from "@canavo/shared";
import { api, errorMessage } from "@/lib/api";
import { parseRupees, rupeesInput } from "@/lib/format";
import { useApiQuery } from "@/hooks/useApiQuery";
import { useSession } from "@/components/providers/SessionProvider";
import { useToast } from "@/components/providers/ToastProvider";
import { Button } from "@/components/ui/Button";
import { Card, CardHeader } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import { Alert, ErrorState, LoadingState } from "@/components/ui/States";
import { ZonesTab } from "./ZonesTab";

const MODES: { value: DeliveryLocationMode; title: string; text: string; icon: React.ReactNode }[] = [
  { value: "MAP", title: "Map pin and zones", text: "Customers and cashiers put a pin on the map. Fee by distance zone. Partners see the spot.", icon: <MapTrifold size={24} /> },
  { value: "ADDRESS", title: "Typed address, flat fee", text: "No map. Customers type the address, landmark and PIN code. One delivery fee.", icon: <NotePencil size={24} /> },
];

/** Split "600040, 600017 Anna Nagar" style input into PIN codes and area names. */
function splitList(text: string) {
  const parts = text.split(/[\n,;]+/).map((s) => s.trim()).filter(Boolean);
  return { pincodes: parts.filter((p) => /^\d+$/.test(p)), areas: parts.filter((p) => !/^\d+$/.test(p)) };
}

/** Delivery → Delivery area (owner / manager): how addresses are given, and the fee rules. */
export function DeliveryAreaTab() {
  const { outletId, can } = useSession();
  const toast = useToast();
  const canEdit = can("settings:outlet");
  const q = useApiQuery<DeliveryLocationSettings>(outletId ? `delivery-settings:${outletId}` : null, () => api.get<DeliveryLocationSettings>("/delivery/settings"));
  const [mode, setMode] = useState<DeliveryLocationMode>("MAP");
  const [fee, setFee] = useState("");
  const [minOrder, setMinOrder] = useState("");
  const [eta, setEta] = useState("30");
  const [pincodes, setPincodes] = useState<string[]>([]);
  const [areas, setAreas] = useState<string[]>([]);
  const [entry, setEntry] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!q.data) return;
    setMode(q.data.mode);
    setFee(q.data.flatFee ? rupeesInput(q.data.flatFee) : "");
    setMinOrder(q.data.minOrder ? rupeesInput(q.data.minOrder) : "");
    setEta(String(q.data.etaMinutes));
    setPincodes(q.data.pincodes);
    setAreas(q.data.areas);
  }, [q.data]);

  if (q.loading && !q.data) return <LoadingState />;
  if (q.error && !q.data) return <ErrorState message={q.error} onRetry={q.reload} />;

  const addEntries = () => {
    const { pincodes: pins, areas: names } = splitList(entry);
    const bad = pins.find((p) => !PINCODE_RE.test(p));
    if (bad) return setError(`${bad} isn't a 6-digit PIN code`);
    const short = names.find((n) => n.length < 2);
    if (short) return setError("Area names need at least 2 letters");
    setError(null);
    setPincodes((list) => [...new Set([...list, ...pins])]);
    setAreas((list) => [...list, ...names.filter((n) => !list.some((x) => x.toLowerCase() === n.toLowerCase()))]);
    setEntry("");
  };

  const save = async () => {
    setError(null);
    const flatFee = fee.trim() ? parseRupees(fee) : 0;
    const min = minOrder.trim() ? parseRupees(minOrder) : 0;
    if (flatFee === null) return setError("Delivery fee: enter an amount in rupees");
    if (min === null) return setError("Minimum order: enter an amount in rupees");
    const body = { mode, flatFee, minOrder: min, etaMinutes: Math.floor(Number(eta)), pincodes, areas };
    const parsed = deliveryLocationUpdateSchema.safeParse(body);
    if (!parsed.success) {
      const i = parsed.error.issues[0];
      return setError(i.path[0] === "etaMinutes" ? "Delivery time: 5 to 300 minutes" : i.message);
    }
    setSaving(true);
    try {
      q.setData(await api.put<DeliveryLocationSettings>("/delivery/settings", body));
      toast("Delivery settings saved", "success");
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const chips = [...areas.map((a) => ({ kind: "area" as const, v: a })), ...pincodes.map((p) => ({ kind: "pin" as const, v: p }))];
  const dirty = q.data && (mode !== q.data.mode || mode === "ADDRESS");

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader title="How customers give their address" subtitle="Applies to the POS, your online ordering page and the delivery partner screens." />
        <div className="px-5 py-4">
          <div role="radiogroup" aria-label="Delivery address mode" className="grid gap-3 sm:grid-cols-2">
            {MODES.map((m) => (
              <button
                key={m.value}
                type="button"
                role="radio"
                aria-checked={mode === m.value}
                disabled={!canEdit}
                onClick={() => setMode(m.value)}
                className={
                  "flex items-start gap-3 rounded-2xl border-2 p-4 text-left transition-colors disabled:cursor-not-allowed " +
                  (mode === m.value ? "border-primary bg-primary/5" : "border-line hover:border-primary/40")
                }
              >
                <span className={mode === m.value ? "text-primary" : "text-muted"}>{m.icon}</span>
                <span>
                  <span className="block font-bold text-fg">{m.title}</span>
                  <span className="block text-sm text-muted">{m.text}</span>
                </span>
              </button>
            ))}
          </div>

          {mode === "ADDRESS" && (
            <div className="mt-5 space-y-4" data-testid="address-mode-settings">
              <div className="grid gap-3 sm:grid-cols-3">
                <Input label="Delivery fee" prefix="₹" inputMode="decimal" value={fee} disabled={!canEdit} onChange={(e) => setFee(e.target.value.replace(/[^\d.]/g, ""))} hint={fee ? undefined : "Free delivery"} />
                <Input label="Minimum order" prefix="₹" inputMode="decimal" value={minOrder} disabled={!canEdit} onChange={(e) => setMinOrder(e.target.value.replace(/[^\d.]/g, ""))} hint={minOrder ? undefined : "No minimum"} />
                <Input label="Delivery time (minutes)" inputMode="numeric" value={eta} disabled={!canEdit} onChange={(e) => setEta(e.target.value.replace(/\D/g, ""))} />
              </div>
              <div>
                <p className="text-sm font-semibold text-fg">Areas and PIN codes you deliver to</p>
                <p className="mb-2 text-xs text-muted">Empty = anywhere. Orders from other areas are refused with a clear message.</p>
                {canEdit && (
                  <div className="flex gap-2">
                    <Input
                      aria-label="Add areas or PIN codes"
                      placeholder="e.g. Anna Nagar, 600040"
                      value={entry}
                      wrapperClassName="flex-1"
                      onChange={(e) => setEntry(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          addEntries();
                        }
                      }}
                    />
                    <Button variant="outline" onClick={addEntries} disabled={!entry.trim()}>
                      Add
                    </Button>
                  </div>
                )}
                {chips.length > 0 ? (
                  <ul className="mt-3 flex flex-wrap gap-2" aria-label="Allowed areas and PIN codes">
                    {chips.map((c) => (
                      <li key={`${c.kind}:${c.v}`} className="inline-flex items-center gap-1 rounded-full border border-line bg-surface-2 py-1 pl-3 pr-1 text-sm font-semibold">
                        <span className={c.kind === "pin" ? "tabular" : undefined}>{c.v}</span>
                        {canEdit && (
                          <button
                            type="button"
                            aria-label={`Remove ${c.v}`}
                            onClick={() => (c.kind === "pin" ? setPincodes((l) => l.filter((x) => x !== c.v)) : setAreas((l) => l.filter((x) => x !== c.v)))}
                            className="flex h-7 w-7 items-center justify-center rounded-full text-muted hover:bg-line hover:text-fg"
                          >
                            <X size={14} weight="bold" />
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="mt-2 text-sm text-muted">Delivering anywhere.</p>
                )}
              </div>
              <p className="text-sm text-muted">
                Customers pay {fee && parseRupees(fee) ? formatINR(parseRupees(fee)!) : "no"} delivery fee, delivered in about {eta || "30"} min. Partners get an &quot;Open in Google Maps&quot; link for the typed address.
              </p>
            </div>
          )}

          {error && (
            <div className="mt-4">
              <Alert>{error}</Alert>
            </div>
          )}
          {canEdit && dirty && (
            <div className="mt-4 flex justify-end">
              <Button icon={<FloppyDisk size={20} />} loading={saving} onClick={() => void save()}>
                Save
              </Button>
            </div>
          )}
        </div>
      </Card>
      {mode === "MAP" && <ZonesTab />}
    </div>
  );
}
